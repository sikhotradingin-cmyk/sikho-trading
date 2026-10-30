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

    // 3. Stale Quote Defense (5.0 seconds maximum allowable age)
    const quoteAgeMs = Date.now() - quote.receiveTimestamp;
    if (quoteAgeMs > 5000) {
      const rejectedOrder: SimulatedOrder = {
        id: randomUUID(),
        accountId: request.accountId,
        globalInstrumentId: request.globalInstrumentId,
        side: request.side,
        orderType: request.orderType,
        quantity: request.quantity,
        requestedPrice: request.requestedPrice,
        triggerPrice: request.triggerPrice,
        status: 'REJECTED',
        idempotencyKey: request.idempotencyKey,
        rejectionReason: `ERR_STALE_MARKET_DATA: Market quote age is ${quoteAgeMs}ms (threshold 5000ms). Execution prevented.`,
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
      quantity: request.quantity,
      requestedPrice: request.requestedPrice,
      triggerPrice: request.triggerPrice,
      status: 'PENDING',
      idempotencyKey: request.idempotencyKey,
      estimatedChargesPaise,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // 5. Margin Reservation in PostgreSQL
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
      const executedPrice = this.computeFillPrice(order.side, quote, request.orderType);
      const res = await this.executeFill(order, executedPrice, quote, requiredMarginPaise);
      await this.repo.saveOrder(res.order);
      if (res.position) {
        await this.repo.saveOrUpdatePosition(res.position);
      }
      return res;
    } else {
      await this.repo.saveOrder(order);
      this.pendingOrders.push(order);
      return { order };
    }
  }

  private computeFillPrice(side: OrderSide, quote: QuoteSnapshot, _type: OrderType, gapPrice?: number): number {
    if (gapPrice !== undefined) {
      return gapPrice;
    }
    if (side === 'BUY') {
      return quote.askPrice ?? Number((quote.ltp * 1.0005).toFixed(2));
    } else {
      return quote.bidPrice ?? Number((quote.ltp * 0.9995).toFixed(2));
    }
  }

  private async executeFill(
    order: SimulatedOrder,
    fillPrice: number,
    quote: QuoteSnapshot,
    _marginPaise: Paise
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
        quantity: deltaQty,
        averageEntryPrice: fillPrice,
        realizedPnlPaise: 0n,
        unrealizedPnlPaise: 0n,
        currentPrice: quote.ltp,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    } else {
      const isSameSide = (position.quantity > 0 && deltaQty > 0) || (position.quantity < 0 && deltaQty < 0);

      if (isSameSide) {
        const totalQty = position.quantity + deltaQty;
        const totalValue =
          Math.abs(position.quantity) * position.averageEntryPrice + Math.abs(deltaQty) * fillPrice;
        position.averageEntryPrice = Number((totalValue / Math.abs(totalQty)).toFixed(2));
        position.quantity = totalQty;
        position.updatedAt = Date.now();
      } else {
        const closedQty = Math.min(Math.abs(position.quantity), Math.abs(deltaQty));
        const priceDiff =
          position.quantity > 0 ? fillPrice - position.averageEntryPrice : position.averageEntryPrice - fillPrice;
        const pnlRupees = priceDiff * closedQty;
        realizedPnlPaise = Money.fromRupees(pnlRupees);

        position.realizedPnlPaise += realizedPnlPaise;
        position.quantity += deltaQty;
        position.updatedAt = Date.now();

        // Futures Margin collateral release (Collateral is not cash equity debit)
        const marginRate = 0.12; // 12% for Index Futures
        const releasedMarginRupees = position.averageEntryPrice * closedQty * marginRate;
        const releasedMarginPaise = Money.fromRupees(releasedMarginRupees);
        await this.repo.releaseMargin(order.accountId, releasedMarginPaise);

        await this.repo.applyTradeSettlement(
          order.accountId,
          realizedPnlPaise,
          order.estimatedChargesPaise,
          order.id,
          `${order.side} ${closedQty} @ ₹${fillPrice}`
        );
      }
    }

    this.updatePositionUnrealized(position, quote.ltp);

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
    quote: QuoteSnapshot
  ): Promise<ExecutionResult> {
    SecurityAirGap.verifySimulatedActionExclusivity('SQUARE_OFF');

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
      quantity,
      status: 'PENDING',
      idempotencyKey: `sqoff-${Date.now()}-${randomUUID()}`,
      estimatedChargesPaise: Money.fromRupees(Math.max(20, quote.ltp * quantity * 0.0002)),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const fillPrice = this.computeFillPrice(side, quote, 'MARKET');
    const res = await this.executeFill(closeOrder, fillPrice, quote, 0n);
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
    order.updatedAt = Date.now();
    await this.repo.updateOrder(order);
    this.pendingOrders = this.pendingOrders.filter((o) => o.id !== orderId);

    return order;
  }

  private updatePositionUnrealized(pos: SimulatedPosition, currentLtp: number): void {
    pos.currentPrice = currentLtp;
    if (pos.quantity === 0) {
      pos.unrealizedPnlPaise = 0n;
      return;
    }
    const diff = pos.quantity > 0 ? currentLtp - pos.averageEntryPrice : pos.averageEntryPrice - currentLtp;
    const unrealizedRupees = diff * Math.abs(pos.quantity);
    pos.unrealizedPnlPaise = Money.fromRupees(unrealizedRupees);
    pos.updatedAt = Date.now();
  }
}
