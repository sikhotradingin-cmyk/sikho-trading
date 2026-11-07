import {
  InstrumentMetadata,
  Money,
  OrderSide,
  OrderType,
  Paise,
  PlaceOrderRequest,
  QuoteSnapshot,
  SimulatedOrder,
  SimulatedPosition,
  getExchangeSessionStatus,
} from '@trading/shared';
import { randomUUID } from 'node:crypto';
import { SecurityAirGap } from './security-airgap.js';
import { PostgresRepository } from '../db/postgres-repository.js';

export interface ExecutionResult {
  order: SimulatedOrder;
  position?: SimulatedPosition;
  realizedPnlPaise?: Paise;
  chargesPaise?: Paise;
}

export class SimulationEngine {
  private pendingOrders: SimulatedOrder[] = [];
  private lockedOrderMargins: Map<string, Paise> = new Map();

  constructor(private repo: PostgresRepository) {}

  /**
   * Submit and evaluate a simulated order with PostgreSQL persistence.
   */
  public async submitOrder(
    request: PlaceOrderRequest,
    _instrument: InstrumentMetadata,
    quote: QuoteSnapshot,
    requiredMarginPaise: Paise,
    estimatedChargesPaise: Paise
  ): Promise<ExecutionResult> {
    // 1. Air-gap assertion: Prove zero broker execution routing
    SecurityAirGap.verifySimulatedActionExclusivity('MARKET');

    // 2. Account-scoped Idempotency Check in PostgreSQL
    const existingOrder = await this.repo.getOrderByAccountAndIdempotency(
      request.accountId,
      request.idempotencyKey
    );

    if (existingOrder) {
      const match =
        existingOrder.side === request.side &&
        existingOrder.orderType === request.orderType &&
        existingOrder.quantity === request.quantity &&
        existingOrder.requestedPrice === request.requestedPrice;

      if (!match) {
        throw new Error('ERR_IDEMPOTENCY_MISMATCH: Idempotency key reused with different order payload.');
      }
      return { order: existingOrder };
    }

    const defaultProduct =
      request.productType || (_instrument.instrumentType === 'EQUITY_STOCK' ? 'INTRADAY' : 'MARGIN');

    // 3. Stale, Closed-Market, or Unsuitable Quote Defense (5.0 seconds maximum allowable age; no live-feed fills when exchange is closed)
    const quoteAgeMs = Math.max(
      Date.now() - quote.receiveTimestamp,
      !quote.isSimulated && quote.providerTimestamp > 0 ? Date.now() - quote.providerTimestamp : 0
    );
    const sessionStatus = getExchangeSessionStatus(_instrument.exchange, new Date());
    const isClosedMarketLiveQuote = !quote.isSimulated && !sessionStatus.isOpen;
    if (
      !Number.isFinite(quote.ltp) ||
      quote.ltp <= 0 ||
      isClosedMarketLiveQuote ||
      quoteAgeMs > 5000
    ) {
      const rejectedOrder: SimulatedOrder = {
        id: randomUUID(),
        accountId: request.accountId,
        globalInstrumentId: request.globalInstrumentId,
        side: request.side,
        orderType: request.orderType,
        productType: defaultProduct,
        quantity: request.quantity,
        requestedPrice: request.requestedPrice,
        triggerPrice: request.triggerPrice,
        status: 'REJECTED',
        idempotencyKey: request.idempotencyKey,
        rejectionReason:
          !Number.isFinite(quote.ltp) || quote.ltp <= 0
            ? 'ERR_UNSUITABLE_MARKET_DATA: Quote price is invalid or zero.'
            : isClosedMarketLiveQuote
              ? `ERR_MARKET_CLOSED: ${_instrument.exchange} market is currently closed (${sessionStatus.sessionName}: ${sessionStatus.nextEventDescription}). Normal paper market orders cannot execute against last-session quotes.`
              : `ERR_STALE_MARKET_DATA: Market quote age is ${quoteAgeMs}ms (threshold 5000ms). Execution prevented.`,
        estimatedChargesPaise: 0n,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await this.repo.saveOrder(rejectedOrder);
      return { order: rejectedOrder };
    }

    // 4. Create Order Object
    const orderId = randomUUID();
    const order: SimulatedOrder = {
      id: orderId,
      accountId: request.accountId,
      globalInstrumentId: request.globalInstrumentId,
      side: request.side,
      orderType: request.orderType,
      productType: defaultProduct,
      quantity: request.quantity,
      requestedPrice: request.requestedPrice,
      triggerPrice: request.triggerPrice,
      status: 'PENDING',
      idempotencyKey: request.idempotencyKey,
      estimatedChargesPaise,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // 5. Margin Reservation in PostgreSQL (ensure account has requiredMarginPaise + estimatedChargesPaise)
    const acc = await this.repo.getAccount(request.accountId);
    if (!acc || acc.availableBalancePaise < requiredMarginPaise + estimatedChargesPaise) {
      order.status = 'REJECTED';
      order.rejectionReason = 'ERR_INSUFFICIENT_MARGIN: Account cannot lock required margin and estimated charges.';
      order.updatedAt = Date.now();
      await this.repo.saveOrder(order);
      return { order };
    }

    const marginLocked = await this.repo.lockMargin(request.accountId, requiredMarginPaise);
    if (!marginLocked) {
      order.status = 'REJECTED';
      order.rejectionReason = 'ERR_INSUFFICIENT_MARGIN: Account cannot lock required margin.';
      order.updatedAt = Date.now();
      await this.repo.saveOrder(order);
      return { order };
    }

    // 6. Immediate Execution vs. Pending Queue
    if (request.orderType === 'MARKET') {
      const executedPrice = this.computeFillPrice(order.side, quote, request.orderType, undefined, _instrument.tickSize);
      const res = await this.executeFill(
        order,
        executedPrice,
        quote,
        requiredMarginPaise,
        _instrument,
        request.stopLossPrice,
        request.targetPrice
      );
      await this.repo.saveOrder(res.order);
      if (res.position) {
        await this.repo.saveOrUpdatePosition(res.position);
      }
      return res;
    } else {
      await this.repo.saveOrder(order);
      this.pendingOrders.push(order);
      if (requiredMarginPaise > 0n) {
        this.lockedOrderMargins.set(order.id, requiredMarginPaise);
      }
      return { order };
    }
  }

  private computeFillPrice(
    side: OrderSide,
    quote: QuoteSnapshot,
    _type: OrderType,
    gapPrice?: number,
    tickSize: number = 0.05
  ): number {
    if (gapPrice !== undefined) {
      return gapPrice;
    }
    if (side === 'BUY') {
      if (quote.askPrice !== undefined) return quote.askPrice;
      const raw = quote.ltp * 1.0005;
      return tickSize > 0 ? Number((Math.ceil(raw / tickSize - 1e-9) * tickSize).toFixed(2)) : Number(raw.toFixed(2));
    } else {
      if (quote.bidPrice !== undefined) return quote.bidPrice;
      const raw = quote.ltp * 0.9995;
      return tickSize > 0 ? Number((Math.floor(raw / tickSize + 1e-9) * tickSize).toFixed(2)) : Number(raw.toFixed(2));
    }
  }

  private calculateReleasedMarginRupees(
    position: SimulatedPosition,
    closedQty: number,
    instrument?: InstrumentMetadata
  ): number {
    const multiplier =
      instrument?.exchange === 'MCX' && instrument?.priceQuoteMultiplier
        ? instrument.priceQuoteMultiplier / (instrument.lotSize || 1)
        : 1;
    const entryVal = position.averageEntryPrice * closedQty * multiplier;
    if (position.productType === 'DELIVERY') {
      return entryVal * 1.0;
    }
    if (
      instrument?.instrumentType === 'OPTIDX' ||
      instrument?.instrumentType === 'OPTSTK' ||
      instrument?.instrumentType === 'OPTCOM'
    ) {
      if (position.quantity > 0) {
        return entryVal * 1.0;
      } else {
        const refUnderlying = (instrument.strikePrice || position.averageEntryPrice * 50) * multiplier;
        return entryVal + refUnderlying * closedQty * 0.15;
      }
    }
    if (instrument?.instrumentType === 'FUTCOM') {
      const rate = instrument.marginMultiplier ?? 0.05;
      return entryVal * rate;
    }
    if (instrument?.instrumentType === 'FUTSTK') {
      const rate = instrument.marginMultiplier ?? 0.2;
      return entryVal * rate;
    }
    const marginRate =
      instrument?.marginMultiplier ??
      (instrument?.instrumentType === 'EQUITY_STOCK' ? 0.2 : 0.12);
    return entryVal * marginRate;
  }

  private async executeFill(
    order: SimulatedOrder,
    fillPrice: number,
    quote: QuoteSnapshot,
    lockedForThisOrderPaise: Paise,
    instrument?: InstrumentMetadata,
    stopLossPrice?: number,
    targetPrice?: number
  ): Promise<ExecutionResult> {
    order.status = 'EXECUTED';
    order.executedPrice = fillPrice;
    order.executedAt = Date.now();
    order.updatedAt = Date.now();

    const existingPositions = await this.repo.getPositions(order.accountId);
    let position = existingPositions.find((p) => p.globalInstrumentId === order.globalInstrumentId);
    let realizedPnlPaise = 0n;

    const deltaQty = order.side === 'BUY' ? order.quantity : -order.quantity;

    if (!position || position.quantity === 0) {
      position = {
        id: position?.id || randomUUID(),
        accountId: order.accountId,
        globalInstrumentId: order.globalInstrumentId,
        productType: order.productType || 'INTRADAY',
        quantity: deltaQty,
        averageEntryPrice: fillPrice,
        realizedPnlPaise: position?.realizedPnlPaise || 0n,
        unrealizedPnlPaise: 0n,
        currentPrice: quote.ltp,
        stopLossPrice,
        targetPrice,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      // Deduct opening order charges once from cash_balance_paise and record SIMULATED_CHARGES ledger entry
      await this.repo.applyOrderCharges(
        order.accountId,
        order.estimatedChargesPaise,
        order.id,
        `${order.side} ${order.quantity} @ ₹${fillPrice}`
      );
    } else {
      const isSameSide = (position.quantity > 0 && deltaQty > 0) || (position.quantity < 0 && deltaQty < 0);

      if (isSameSide) {
        const totalQty = position.quantity + deltaQty;
        const totalValue =
          Math.abs(position.quantity) * position.averageEntryPrice + Math.abs(deltaQty) * fillPrice;
        position.averageEntryPrice = Number((totalValue / Math.abs(totalQty)).toFixed(2));
        position.quantity = totalQty;
        if (stopLossPrice !== undefined) position.stopLossPrice = stopLossPrice;
        if (targetPrice !== undefined) position.targetPrice = targetPrice;
        position.updatedAt = Date.now();

        // Deduct scale-in order charges once from cash_balance_paise and record SIMULATED_CHARGES ledger entry
        await this.repo.applyOrderCharges(
          order.accountId,
          order.estimatedChargesPaise,
          order.id,
          `${order.side} ${order.quantity} @ ₹${fillPrice}`
        );
      } else {
        const closedQty = Math.min(Math.abs(position.quantity), Math.abs(deltaQty));
        const priceDiff =
          position.quantity > 0 ? fillPrice - position.averageEntryPrice : position.averageEntryPrice - fillPrice;
        const multiplier =
          instrument?.exchange === 'MCX' && instrument?.priceQuoteMultiplier
            ? instrument.priceQuoteMultiplier / (instrument.lotSize || 1)
            : 1;
        const pnlRupees = priceDiff * multiplier * closedQty;
        realizedPnlPaise = Money.fromRupees(pnlRupees);

        const releasedMarginRupees = this.calculateReleasedMarginRupees(position, closedQty, instrument);
        const releasedMarginPaise = Money.fromRupees(releasedMarginRupees) + lockedForThisOrderPaise;

        position.realizedPnlPaise += realizedPnlPaise;
        position.quantity += deltaQty;
        if (position.quantity === 0) {
          position.stopLossPrice = undefined;
          position.targetPrice = undefined;
        }
        position.updatedAt = Date.now();

        await this.repo.releaseMargin(order.accountId, releasedMarginPaise);

        // Settle realized P&L and deduct closing order charges once
        await this.repo.applyTradeSettlement(
          order.accountId,
          realizedPnlPaise,
          order.estimatedChargesPaise,
          order.id,
          `${order.side} ${closedQty} @ ₹${fillPrice}`
        );
      }
    }

    this.updatePositionUnrealized(position, quote.ltp, instrument);

    return {
      order,
      position,
      realizedPnlPaise,
      chargesPaise: order.estimatedChargesPaise,
    };
  }

  public async onMarketTick(quote: QuoteSnapshot): Promise<ExecutionResult[]> {
    const results: ExecutionResult[] = [];
    const remainingPending: SimulatedOrder[] = [];

    for (const order of this.pendingOrders) {
      if (order.globalInstrumentId !== quote.globalId) {
        remainingPending.push(order);
        continue;
      }

      let shouldTrigger = false;
      let gapPrice: number | undefined;

      if (order.orderType === 'LIMIT' && order.requestedPrice !== undefined) {
        if (order.side === 'BUY' && quote.ltp <= order.requestedPrice) {
          shouldTrigger = true;
        } else if (order.side === 'SELL' && quote.ltp >= order.requestedPrice) {
          shouldTrigger = true;
        }
      }

      if (order.orderType === 'STOP_MARKET' && order.triggerPrice !== undefined) {
        if (order.side === 'SELL' && quote.ltp <= order.triggerPrice) {
          shouldTrigger = true;
          if (quote.ltp < order.triggerPrice) gapPrice = quote.ltp;
        } else if (order.side === 'BUY' && quote.ltp >= order.triggerPrice) {
          shouldTrigger = true;
          if (quote.ltp > order.triggerPrice) gapPrice = quote.ltp;
        }
      }

      if (shouldTrigger) {
        if (order.ocoCompanionOrderId) {
          const comp = this.pendingOrders.find((o) => o.id === order.ocoCompanionOrderId);
          if (comp && comp.status === 'PENDING') {
            comp.status = 'CANCELLED';
            comp.rejectionReason = `OCO_TRIGGERED: Cancelled because companion order ${order.id} executed.`;
            await this.repo.updateOrder(comp);
          }
        }

        const fillPrice = this.computeFillPrice(order.side, quote, order.orderType, gapPrice);
        this.lockedOrderMargins.delete(order.id);
        const res = await this.executeFill(order, fillPrice, quote, 0n);
        await this.repo.updateOrder(res.order);
        if (res.position) {
          await this.repo.saveOrUpdatePosition(res.position);
        }
        results.push(res);
      } else {
        remainingPending.push(order);
      }
    }

    this.pendingOrders = remainingPending;
    return results;
  }

  public async squareOffPosition(
    accountId: string,
    globalInstrumentId: string,
    quote: QuoteSnapshot,
    instrument?: InstrumentMetadata
  ): Promise<ExecutionResult> {
    SecurityAirGap.verifySimulatedActionExclusivity('SQUARE_OFF');

    const quoteAgeMs = Date.now() - quote.receiveTimestamp;
    const exchange = instrument?.exchange || (globalInstrumentId.startsWith('MCX') ? 'MCX' : 'NSE');
    const sessionStatus = getExchangeSessionStatus(exchange, new Date());
    const isClosedMarketLiveQuote = !quote.isSimulated && !sessionStatus.isOpen;
    if (!Number.isFinite(quote.ltp) || quote.ltp <= 0) {
      throw new Error('ERR_UNSUITABLE_MARKET_DATA: Quote price is invalid or zero.');
    }
    if (isClosedMarketLiveQuote) {
      throw new Error(
        `ERR_MARKET_CLOSED: ${exchange} market is currently closed (${sessionStatus.sessionName}: ${sessionStatus.nextEventDescription}). Cannot execute market square-off against last-session quotes.`
      );
    }
    if (quoteAgeMs > 5000) {
      throw new Error(`ERR_STALE_MARKET_DATA: Market quote age is ${quoteAgeMs}ms (threshold 5000ms). Execution prevented.`);
    }

    const positions = await this.repo.getPositions(accountId);
    const position = positions.find((p) => p.globalInstrumentId === globalInstrumentId && p.quantity !== 0);
    if (!position) {
      throw new Error(`No open position found to square off for ${globalInstrumentId}`);
    }

    const side: OrderSide = position.quantity > 0 ? 'SELL' : 'BUY';
    const quantity = Math.abs(position.quantity);

    const closeOrder: SimulatedOrder = {
      id: randomUUID(),
      accountId,
      globalInstrumentId,
      side,
      orderType: 'MARKET',
      productType: position.productType || 'INTRADAY',
      quantity,
      status: 'PENDING',
      idempotencyKey: `sqoff-${Date.now()}-${randomUUID()}`,
      estimatedChargesPaise: Money.fromRupees(Math.max(20, quote.ltp * quantity * 0.0002)),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const fillPrice = this.computeFillPrice(side, quote, 'MARKET', undefined, instrument?.tickSize);
    const res = await this.executeFill(closeOrder, fillPrice, quote, 0n, instrument);
    await this.repo.saveOrder(res.order);
    if (res.position) {
      await this.repo.saveOrUpdatePosition(res.position);
    }
    return res;
  }

  public async cancelOrder(accountId: string, orderId: string): Promise<SimulatedOrder> {
    SecurityAirGap.verifySimulatedActionExclusivity('CANCEL');

    const orders = await this.repo.getOrders(accountId);
    const order = orders.find((o) => o.id === orderId);
    if (!order) throw new Error(`Order ${orderId} not found.`);
    if (order.status !== 'PENDING') {
      throw new Error(`Cannot cancel order in status ${order.status}.`);
    }

    order.status = 'CANCELLED';
    order.rejectionReason = 'USER_CANCELLED: Cancelled by user.';
    order.updatedAt = Date.now();
    await this.repo.updateOrder(order);
    this.pendingOrders = this.pendingOrders.filter((o) => o.id !== orderId);

    const lockedMargin = this.lockedOrderMargins.get(orderId);
    if (lockedMargin && lockedMargin > 0n) {
      await this.repo.releaseMargin(accountId, lockedMargin);
      this.lockedOrderMargins.delete(orderId);
    }

    return order;
  }

  private updatePositionUnrealized(pos: SimulatedPosition, currentLtp: number, instrument?: InstrumentMetadata): void {
    pos.currentPrice = currentLtp;
    if (pos.quantity === 0) {
      pos.unrealizedPnlPaise = 0n;
      return;
    }
    const multiplier =
      instrument?.exchange === 'MCX' && instrument?.priceQuoteMultiplier
        ? instrument.priceQuoteMultiplier / (instrument.lotSize || 1)
        : 1;
    const diff = pos.quantity > 0 ? currentLtp - pos.averageEntryPrice : pos.averageEntryPrice - currentLtp;
    const unrealizedRupees = diff * multiplier * Math.abs(pos.quantity);
    pos.unrealizedPnlPaise = Money.fromRupees(unrealizedRupees);
    pos.updatedAt = Date.now();
  }
}
