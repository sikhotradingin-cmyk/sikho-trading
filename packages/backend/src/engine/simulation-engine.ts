import {
  InstrumentMetadata,
  Money,
  OrderSide,
  OrderType,
  OrderValidator,
  Paise,
  PlaceOrderRequest,
  PositionProtectionAuditEntry,
  QuoteSnapshot,
  SimulatedOrder,
  SimulatedPosition,
  UpdatePositionProtectionRequest,
  getExchangeSessionStatus,
  quoteFreshnessAgeMs,
} from '@trading/shared';
import { randomUUID } from 'node:crypto';
import { SecurityAirGap } from './security-airgap.js';
import { PostgresRepository } from '../db/postgres-repository.js';

export interface ExecutionResult {
  order: SimulatedOrder;
  position?: SimulatedPosition;
  realizedPnlPaise?: Paise;
  chargesPaise?: Paise;
  attachedOrders?: SimulatedOrder[];
}

export interface ProtectionModificationResult {
  position: SimulatedPosition;
  attachedOrders: SimulatedOrder[];
  audit: PositionProtectionAuditEntry;
}

export class SimulationEngine {
  private pendingOrders: SimulatedOrder[] = [];
  private lockedOrderMargins: Map<string, Paise> = new Map();
  private latestTickTimestamps: Map<string, number> = new Map();
  private pendingInstruments = new Map<string, InstrumentMetadata>();
  public async restorePendingOrders() {
    for (const { order, context } of await this.repo.getPendingExecutionContexts()) {
      if (this.pendingOrders.some((o) => o.id === order.id)) continue;
      if (context.stopLossPrice !== undefined) order.stopLossPrice = Number(context.stopLossPrice);
      if (context.targetPrice !== undefined) order.targetPrice = Number(context.targetPrice);
      if (context.isProtectiveExit) order.isProtectiveExit = true;
      this.pendingOrders.push(order);
      this.lockedOrderMargins.set(order.id, BigInt(context.requiredMarginPaise || '0'));
      if (context.instrument) this.pendingInstruments.set(order.id, context.instrument);
    }
  }

  private mutationQueue: Promise<unknown> = Promise.resolve();
  private serialized<T>(fn:()=>Promise<T>):Promise<T>{const work=this.mutationQueue.then(fn,fn);this.mutationQueue=work.catch(()=>{});return work;}
  constructor(private repo: PostgresRepository) {}

  /**
   * Submit and evaluate a simulated order with PostgreSQL persistence.
   */
  public submitOrder(...args: Parameters<SimulationEngine['submitOrderNow']>) {return this.serialized(()=>this.submitOrderNow(...args));}
  private async submitOrderNow(
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
    const quoteAgeMs = quoteFreshnessAgeMs(quote);
    const sessionStatus = getExchangeSessionStatus(_instrument.exchange, new Date());
    const isClosedMarketLiveQuote = !quote.isSimulated && !sessionStatus.isOpen;
    if (
      quote.globalId!==_instrument.globalId ||
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
          quote.globalId!==_instrument.globalId || !Number.isFinite(quote.ltp) || quote.ltp <= 0
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
      stopLossPrice: request.stopLossPrice,
      targetPrice: request.targetPrice,
      status: 'PENDING',
      idempotencyKey: request.idempotencyKey,
      estimatedChargesPaise,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // 5. Margin Reservation in PostgreSQL (ensure account has requiredMarginPaise + estimatedChargesPaise)
    Object.defineProperty(order, 'executionContext', {
      value: {
        instrument: _instrument,
        requiredMarginPaise: requiredMarginPaise.toString(),
        stopLossPrice: request.stopLossPrice,
        targetPrice: request.targetPrice,
        isProtectiveExit: false,
      },
      configurable: true,
    });
    this.pendingInstruments.set(order.id, _instrument);
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
        if (res.position.quantity === 0) {
          res.position.stopLossPrice = undefined;
          res.position.targetPrice = undefined;
          res.position.stopOrderId = undefined;
          res.position.targetOrderId = undefined;
          res.position.protectionVersion = (res.position.protectionVersion || 1) + 1;
          await this.cancelProtectiveOrdersForPosition(
            request.accountId,
            request.globalInstrumentId,
            'POSITION_CLOSED: Protective order cancelled because position closed.'
          );
        } else if (request.stopLossPrice !== undefined || request.targetPrice !== undefined) {
          await this.cancelProtectiveOrdersForPosition(
            request.accountId,
            request.globalInstrumentId,
            'PROTECTION_REPLACED: Replaced by new entry protection.'
          );
          res.position.protectionVersion = (res.position.protectionVersion || 1) + 1;
          res.attachedOrders = await this.spawnProtectiveOrders(
            res.order,
            res.position,
            _instrument,
            request.stopLossPrice,
            request.targetPrice
          );
          await this.repo.recordProtectionAudit({
            accountId: request.accountId,
            positionId: res.position.id,
            globalInstrumentId: res.position.globalInstrumentId,
            previousSl: undefined,
            newSl: res.position.stopLossPrice,
            previousTp: undefined,
            newTp: res.position.targetPrice,
            quantity: res.position.quantity,
            entryPrice: res.position.averageEntryPrice,
            referenceLtp: quote.ltp,
            protectionVersion: res.position.protectionVersion,
            source: 'ORDER_ENTRY',
            idempotencyKey: request.idempotencyKey,
          });
        } else {
          await this.syncProtectiveOrdersQuantityForPosition(res.position, _instrument);
        }
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

  private async spawnProtectiveOrders(
    entryOrder: SimulatedOrder,
    position: SimulatedPosition,
    instrument: InstrumentMetadata,
    stopLossPrice?: number,
    targetPrice?: number
  ): Promise<SimulatedOrder[]> {
    return this.spawnProtectiveOrdersForPosition(
      position,
      instrument,
      stopLossPrice,
      targetPrice,
      entryOrder.id
    );
  }

  private async spawnProtectiveOrdersForPosition(
    position: SimulatedPosition,
    instrument: InstrumentMetadata,
    stopLossPrice?: number,
    targetPrice?: number,
    refKeyPrefix: string = randomUUID()
  ): Promise<SimulatedOrder[]> {
    const exitSide: OrderSide = position.quantity > 0 ? 'SELL' : 'BUY';
    const exitQty = Math.abs(position.quantity);
    if (exitQty <= 0) return [];

    const now = Date.now();
    const quoteRatio =
      instrument.exchange === 'MCX' && instrument.priceQuoteMultiplier
        ? instrument.priceQuoteMultiplier / (instrument.lotSize || 1)
        : 1;
    const spawned: SimulatedOrder[] = [];
    let slOrder: SimulatedOrder | undefined;
    let tpOrder: SimulatedOrder | undefined;

    if (stopLossPrice !== undefined && Number.isFinite(stopLossPrice) && stopLossPrice > 0) {
      const estCharges = Money.fromRupees(Math.max(20, stopLossPrice * quoteRatio * exitQty * 0.0002));
      slOrder = {
        id: randomUUID(),
        accountId: position.accountId,
        globalInstrumentId: position.globalInstrumentId,
        side: exitSide,
        orderType: 'STOP_MARKET',
        productType: position.productType || 'INTRADAY',
        quantity: exitQty,
        triggerPrice: stopLossPrice,
        status: 'PENDING',
        idempotencyKey: `sl-${refKeyPrefix.slice(0, 28)}-${now}-${randomUUID().slice(0, 6)}`,
        positionId: position.id,
        isProtectiveExit: true,
        estimatedChargesPaise: estCharges,
        createdAt: now,
        updatedAt: now,
      };
      position.stopLossPrice = stopLossPrice;
      position.stopOrderId = slOrder.id;
    } else {
      position.stopLossPrice = undefined;
      position.stopOrderId = undefined;
    }

    if (targetPrice !== undefined && Number.isFinite(targetPrice) && targetPrice > 0) {
      const estCharges = Money.fromRupees(Math.max(20, targetPrice * quoteRatio * exitQty * 0.0002));
      tpOrder = {
        id: randomUUID(),
        accountId: position.accountId,
        globalInstrumentId: position.globalInstrumentId,
        side: exitSide,
        orderType: 'LIMIT',
        productType: position.productType || 'INTRADAY',
        quantity: exitQty,
        requestedPrice: targetPrice,
        status: 'PENDING',
        idempotencyKey: `tp-${refKeyPrefix.slice(0, 28)}-${now}-${randomUUID().slice(0, 6)}`,
        positionId: position.id,
        isProtectiveExit: true,
        estimatedChargesPaise: estCharges,
        createdAt: now,
        updatedAt: now,
      };
      position.targetPrice = targetPrice;
      position.targetOrderId = tpOrder.id;
    } else {
      position.targetPrice = undefined;
      position.targetOrderId = undefined;
    }

    if (slOrder && tpOrder) {
      slOrder.ocoCompanionOrderId = tpOrder.id;
      tpOrder.ocoCompanionOrderId = slOrder.id;
    }

    for (const child of [slOrder, tpOrder]) {
      if (!child) continue;
      Object.defineProperty(child, 'executionContext', {
        value: {
          instrument,
          requiredMarginPaise: '0',
          isProtectiveExit: true,
        },
        configurable: true,
      });
      await this.repo.saveOrder(child);
      if (!this.pendingOrders.some((o) => o.id === child.id)) {
        this.pendingOrders.push(child);
      }
      this.pendingInstruments.set(child.id, instrument);
      spawned.push(child);
    }

    return spawned;
  }

  private async syncProtectiveOrdersQuantityForPosition(
    position: SimulatedPosition,
    instrument?: InstrumentMetadata
  ): Promise<void> {
    if (position.quantity === 0) return;
    const expectedSide: OrderSide = position.quantity > 0 ? 'SELL' : 'BUY';
    const expectedQty = Math.abs(position.quantity);
    const activeProtective = this.pendingOrders.filter(
      (o) =>
        o.accountId === position.accountId &&
        o.globalInstrumentId === position.globalInstrumentId &&
        (o.status === 'PENDING' || o.status === 'TRIGGERED') &&
        Boolean(o.isProtectiveExit || o.ocoCompanionOrderId || o.positionId === position.id)
    );
    for (const o of activeProtective) {
      if (o.side !== expectedSide) {
        // Position flipped direction -> cancel previous-direction protective order
        o.status = 'CANCELLED';
        o.rejectionReason = 'POSITION_REVERSED: Cancelled because position flipped direction.';
        o.updatedAt = Date.now();
        await this.repo.updateOrder(o);
        this.pendingInstruments.delete(o.id);
        if (position.stopOrderId === o.id) {
          position.stopOrderId = undefined;
          position.stopLossPrice = undefined;
        }
        if (position.targetOrderId === o.id) {
          position.targetOrderId = undefined;
          position.targetPrice = undefined;
        }
      } else if (o.quantity !== expectedQty) {
        o.quantity = expectedQty;
        const quoteRatio =
          instrument?.exchange === 'MCX' && instrument?.priceQuoteMultiplier
            ? instrument.priceQuoteMultiplier / (instrument.lotSize || 1)
            : 1;
        const refPrice = o.triggerPrice || o.requestedPrice || position.averageEntryPrice;
        o.estimatedChargesPaise = Money.fromRupees(Math.max(20, refPrice * quoteRatio * expectedQty * 0.0002));
        o.updatedAt = Date.now();
        await this.repo.updateOrder(o);
      }
    }
    this.pendingOrders = this.pendingOrders.filter((o) => o.status === 'PENDING' || o.status === 'TRIGGERED');
  }

  private async cancelProtectiveOrdersForPosition(
    accountId: string,
    globalInstrumentId: string,
    reason: string
  ): Promise<void> {
    const toCancel = this.pendingOrders.filter(
      (o) =>
        o.accountId === accountId &&
        o.globalInstrumentId === globalInstrumentId &&
        (o.status === 'PENDING' || o.status === 'TRIGGERED') &&
        Boolean(o.isProtectiveExit || o.ocoCompanionOrderId || o.positionId)
    );
    for (const o of toCancel) {
      o.status = 'CANCELLED';
      o.rejectionReason = reason;
      o.updatedAt = Date.now();
      await this.repo.updateOrder(o);
      const locked = this.lockedOrderMargins.get(o.id);
      if (locked && locked > 0n) {
        await this.repo.releaseMargin(accountId, locked);
        this.lockedOrderMargins.delete(o.id);
      }
      this.pendingInstruments.delete(o.id);
    }
    if (toCancel.length > 0) {
      this.pendingOrders = this.pendingOrders.filter((o) => o.status === 'PENDING' || o.status === 'TRIGGERED');
    }
  }

  private computeFillPrice(
    side: OrderSide,
    quote: QuoteSnapshot,
    type: OrderType,
    gapPrice?: number,
    tickSize: number = 0.05,
    limitPrice?: number
  ): number {
    if ((type === 'LIMIT' || type === 'TARGET' || type === 'STOP_LIMIT') && limitPrice !== undefined && limitPrice > 0) {
      if (side === 'BUY') {
        const bestAsk = quote.askPrice !== undefined && quote.askPrice > 0 ? quote.askPrice : quote.ltp;
        return Number(Math.min(limitPrice, bestAsk).toFixed(2));
      } else {
        const bestBid = quote.bidPrice !== undefined && quote.bidPrice > 0 ? quote.bidPrice : quote.ltp;
        return Number(Math.max(limitPrice, bestBid).toFixed(2));
      }
    }
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
    const historyBefore = { previousQuantity: position?.quantity || 0, averageEntryPrice: position?.averageEntryPrice ?? null };
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
        if (position.quantity && Math.sign(position.quantity) !== Math.sign(position.quantity - deltaQty)) { position.averageEntryPrice = fillPrice; position.createdAt = Date.now(); }
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

    Object.defineProperty(order, 'historySnapshot', {value:{...historyBefore,quantity:position.quantity,realizedPnlPaise:realizedPnlPaise.toString(),instrument:instrument || null},configurable:true});
    this.updatePositionUnrealized(position, quote.ltp, instrument);

    return {
      order,
      position,
      realizedPnlPaise,
      chargesPaise: order.estimatedChargesPaise,
    };
  }

  public onMarketTick(quote: QuoteSnapshot): Promise<ExecutionResult[]> {return this.serialized(()=>this.onMarketTickNow(quote));}
  private async onMarketTickNow(quote: QuoteSnapshot): Promise<ExecutionResult[]> {
    const results: ExecutionResult[] = [];
    if (!Number.isFinite(quote.ltp) || quote.ltp <= 0) return results;
    if (quoteFreshnessAgeMs(quote) > 5000) return results;

    // Monotonic quote sequencing: discard duplicate or out-of-order ticks to prevent stale triggers
    const quoteTime = quote.providerTimestamp || (quote as any).timestamp || 0;
    const lastTimestamp = this.latestTickTimestamps.get(quote.globalId) || 0;
    if (quoteTime && lastTimestamp && quoteTime < lastTimestamp) {
      return results;
    }
    if (quoteTime) {
      this.latestTickTimestamps.set(quote.globalId, quoteTime);
    }

    const snapshotOrders = [...this.pendingOrders];
    const newlySpawned: SimulatedOrder[] = [];

    for (const order of snapshotOrders) {
      if (order.status !== 'PENDING' && order.status !== 'TRIGGERED') {
        continue;
      }
      if (order.globalInstrumentId !== quote.globalId) {
        continue;
      }
      const pendingInstrument = this.pendingInstruments.get(order.id);
      if (!quote.isSimulated && !getExchangeSessionStatus(pendingInstrument?.exchange || 'NSE').isOpen) {
        continue;
      }

      let shouldFill = false;
      let gapPrice: number | undefined;

      if ((order.orderType === 'LIMIT' || order.orderType === 'TARGET') && order.requestedPrice !== undefined) {
        if (order.side === 'BUY' && quote.ltp <= order.requestedPrice) {
          shouldFill = true;
        } else if (order.side === 'SELL' && quote.ltp >= order.requestedPrice) {
          shouldFill = true;
        }
      } else if (order.orderType === 'STOP_MARKET' && order.triggerPrice !== undefined) {
        if (order.side === 'SELL' && quote.ltp <= order.triggerPrice) {
          shouldFill = true;
          if (quote.ltp < order.triggerPrice) gapPrice = quote.ltp;
        } else if (order.side === 'BUY' && quote.ltp >= order.triggerPrice) {
          shouldFill = true;
          if (quote.ltp > order.triggerPrice) gapPrice = quote.ltp;
        }
      } else if (order.orderType === 'STOP_LIMIT' && order.triggerPrice !== undefined && order.requestedPrice !== undefined) {
        if (order.status === 'PENDING') {
          const breached =
            (order.side === 'SELL' && quote.ltp <= order.triggerPrice) ||
            (order.side === 'BUY' && quote.ltp >= order.triggerPrice);
          if (breached) {
            order.status = 'TRIGGERED';
            order.updatedAt = Date.now();
            await this.repo.updateOrder(order);
          }
        }
        if (order.status === 'TRIGGERED') {
          if (order.side === 'BUY' && quote.ltp <= order.requestedPrice) {
            shouldFill = true;
          } else if (order.side === 'SELL' && quote.ltp >= order.requestedPrice) {
            shouldFill = true;
          }
        }
      }

      if (!shouldFill) continue;

      // Protective exit safety: never flip into reverse exposure if position was already reduced/closed
      if (order.isProtectiveExit || order.ocoCompanionOrderId) {
        const positions = await this.repo.getPositions(order.accountId);
        const openPos = positions.find((p) => p.globalInstrumentId === order.globalInstrumentId && p.quantity !== 0);
        const isValidExit =
          openPos &&
          ((openPos.quantity > 0 && order.side === 'SELL') || (openPos.quantity < 0 && order.side === 'BUY'));
        if (!isValidExit) {
          order.status = 'CANCELLED';
          order.rejectionReason = 'POSITION_CLOSED: Protective order cancelled because position is already closed.';
          order.updatedAt = Date.now();
          await this.repo.updateOrder(order);
          const locked = this.lockedOrderMargins.get(order.id);
          if (locked && locked > 0n) {
            await this.repo.releaseMargin(order.accountId, locked);
            this.lockedOrderMargins.delete(order.id);
          }
          this.pendingInstruments.delete(order.id);
          continue;
        }
        if (Math.abs(openPos.quantity) < order.quantity) {
          order.quantity = Math.abs(openPos.quantity);
        }
      }

      // Atomically cancel OCO sibling before executing fill
      if (order.ocoCompanionOrderId) {
        const comp = this.pendingOrders.find((o) => o.id === order.ocoCompanionOrderId);
        if (comp && (comp.status === 'PENDING' || comp.status === 'TRIGGERED')) {
          comp.status = 'CANCELLED';
          comp.rejectionReason = `OCO_TRIGGERED: Cancelled because companion order ${order.id} executed.`;
          comp.updatedAt = Date.now();
          await this.repo.updateOrder(comp);
          const compLocked = this.lockedOrderMargins.get(comp.id);
          if (compLocked && compLocked > 0n) {
            await this.repo.releaseMargin(comp.accountId, compLocked);
            this.lockedOrderMargins.delete(comp.id);
          }
          this.pendingInstruments.delete(comp.id);
        }
      }

      const instrument = this.pendingInstruments.get(order.id);
      const fillPrice = this.computeFillPrice(
        order.side,
        quote,
        order.orderType,
        gapPrice,
        instrument?.tickSize,
        order.requestedPrice
      );
      const lockedForOrder = this.lockedOrderMargins.get(order.id) || 0n;
      this.lockedOrderMargins.delete(order.id);
      const res = await this.executeFill(
        order,
        fillPrice,
        quote,
        lockedForOrder,
        instrument,
        order.stopLossPrice,
        order.targetPrice
      );
      this.pendingInstruments.delete(order.id);
      await this.repo.updateOrder(res.order);

      if (res.position) {
        if (res.position.quantity === 0) {
          res.position.stopLossPrice = undefined;
          res.position.targetPrice = undefined;
          res.position.stopOrderId = undefined;
          res.position.targetOrderId = undefined;
          res.position.protectionVersion = (res.position.protectionVersion || 1) + 1;
          await this.cancelProtectiveOrdersForPosition(
            order.accountId,
            order.globalInstrumentId,
            'POSITION_CLOSED: Protective order cancelled because position closed.'
          );
        } else if (instrument && (order.stopLossPrice !== undefined || order.targetPrice !== undefined)) {
          await this.cancelProtectiveOrdersForPosition(
            order.accountId,
            order.globalInstrumentId,
            'PROTECTION_REPLACED: Replaced by new entry protection.'
          );
          res.position.protectionVersion = (res.position.protectionVersion || 1) + 1;
          const spawned = await this.spawnProtectiveOrders(
            res.order,
            res.position,
            instrument,
            order.stopLossPrice,
            order.targetPrice
          );
          res.attachedOrders = spawned;
          newlySpawned.push(...spawned);
          await this.repo.recordProtectionAudit({
            accountId: order.accountId,
            positionId: res.position.id,
            globalInstrumentId: res.position.globalInstrumentId,
            previousSl: undefined,
            newSl: res.position.stopLossPrice,
            previousTp: undefined,
            newTp: res.position.targetPrice,
            quantity: res.position.quantity,
            entryPrice: res.position.averageEntryPrice,
            referenceLtp: quote.ltp,
            protectionVersion: res.position.protectionVersion,
            source: 'ORDER_ENTRY',
            idempotencyKey: order.idempotencyKey,
          });
        } else {
          await this.syncProtectiveOrdersQuantityForPosition(res.position, instrument);
        }
        await this.repo.saveOrUpdatePosition(res.position);
      }
      results.push(res);
    }

    this.pendingOrders = this.pendingOrders.filter((o) => o.status === 'PENDING' || o.status === 'TRIGGERED');
    for (const s of newlySpawned) {
      if (!this.pendingOrders.some((o) => o.id === s.id)) {
        this.pendingOrders.push(s);
      }
    }
    return results;
  }

  public squareOffPosition(...args: Parameters<SimulationEngine['squareOffPositionNow']>): Promise<ExecutionResult> {
    return this.serialized(() => this.squareOffPositionNow(...args));
  }
  private async squareOffPositionNow(
    accountId: string,
    globalInstrumentId: string,
    quote: QuoteSnapshot,
    instrument?: InstrumentMetadata
  ): Promise<ExecutionResult> {
    SecurityAirGap.verifySimulatedActionExclusivity('SQUARE_OFF');

    const quoteAgeMs = quoteFreshnessAgeMs(quote);
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
      res.position.stopOrderId = undefined;
      res.position.targetOrderId = undefined;
      await this.cancelProtectiveOrdersForPosition(
        accountId,
        globalInstrumentId,
        'POSITION_SQUARED_OFF: Cancelled because position was squared off manually.'
      );
      await this.repo.saveOrUpdatePosition(res.position);
    }
    return res;
  }

  public cancelOrder(accountId: string, orderId: string): Promise<SimulatedOrder> {
    return this.serialized(() => this.cancelOrderNow(accountId, orderId));
  }
  private async cancelOrderNow(accountId: string, orderId: string): Promise<SimulatedOrder> {
    SecurityAirGap.verifySimulatedActionExclusivity('CANCEL');

    const orders = await this.repo.getOrders(accountId);
    const order = orders.find((o) => o.id === orderId);
    if (!order) throw new Error(`Order ${orderId} not found.`);
    if (order.status !== 'PENDING' && order.status !== 'TRIGGERED') {
      throw new Error(`Cannot cancel order in status ${order.status}.`);
    }

    order.status = 'CANCELLED';
    order.rejectionReason = 'USER_CANCELLED: Cancelled by user.';
    order.updatedAt = Date.now();
    await this.repo.updateOrder(order);
    this.pendingOrders = this.pendingOrders.filter((o) => o.id !== orderId);
    this.pendingInstruments.delete(orderId);

    const lockedMargin = this.lockedOrderMargins.get(orderId);
    if (lockedMargin && lockedMargin > 0n) {
      await this.repo.releaseMargin(accountId, lockedMargin);
      this.lockedOrderMargins.delete(orderId);
    }

    // If the cancelled order was a protective SL/TP order on an open position, reconcile position fields & OCO sibling
    if (order.isProtectiveExit || order.positionId || order.ocoCompanionOrderId) {
      const positions = await this.repo.getPositions(accountId);
      const pos = positions.find(
        (p) =>
          (order.positionId && p.id === order.positionId) ||
          p.globalInstrumentId === order.globalInstrumentId
      );
      if (pos) {
        let changed = false;
        if (pos.stopOrderId === order.id || (order.orderType === 'STOP_MARKET' && pos.stopLossPrice !== undefined)) {
          pos.stopOrderId = undefined;
          pos.stopLossPrice = undefined;
          changed = true;
        }
        if (pos.targetOrderId === order.id || (order.orderType === 'LIMIT' && pos.targetPrice !== undefined && order.isProtectiveExit)) {
          pos.targetOrderId = undefined;
          pos.targetPrice = undefined;
          changed = true;
        }
        if (order.ocoCompanionOrderId) {
          const sibling = this.pendingOrders.find((o) => o.id === order.ocoCompanionOrderId);
          if (sibling) {
            sibling.ocoCompanionOrderId = undefined;
            sibling.updatedAt = Date.now();
            await this.repo.updateOrder(sibling);
          }
        }
        if (changed) {
          pos.protectionVersion = (pos.protectionVersion || 1) + 1;
          pos.updatedAt = Date.now();
          await this.repo.saveOrUpdatePosition(pos);
        }
      }
    }

    return order;
  }

  public updatePositionProtection(
    request: UpdatePositionProtectionRequest,
    instrument: InstrumentMetadata,
    quote: QuoteSnapshot
  ): Promise<ProtectionModificationResult> {
    return this.serialized(() => this.updatePositionProtectionNow(request, instrument, quote));
  }

  private async updatePositionProtectionNow(
    request: UpdatePositionProtectionRequest,
    instrument: InstrumentMetadata,
    quote: QuoteSnapshot
  ): Promise<ProtectionModificationResult> {
    SecurityAirGap.verifySimulatedActionExclusivity('MARKET');

    const idempotencyKey = String(request.idempotencyKey || '').trim();
    if (!idempotencyKey || idempotencyKey.length > 128) {
      throw new Error('ERR_INVALID_IDEMPOTENCY_KEY: A valid idempotencyKey (1..128 chars) is required.');
    }

    const payloadSignature = JSON.stringify({
      positionId: request.positionId,
      stopLossPrice: request.stopLossPrice === undefined ? '__KEEP__' : request.stopLossPrice,
      targetPrice: request.targetPrice === undefined ? '__KEEP__' : request.targetPrice,
      removeStopLoss: Boolean(request.removeStopLoss),
      removeTarget: Boolean(request.removeTarget),
    });

    const existingReq = await this.repo.getProtectionRequestByIdempotency(request.accountId, idempotencyKey);
    if (existingReq) {
      if (existingReq.payloadSignature !== payloadSignature) {
        throw new Error('ERR_IDEMPOTENCY_MISMATCH: Idempotency key reused with different protection modification payload.');
      }
      const currentPos = await this.repo.getPositionById(request.accountId, existingReq.positionId);
      return {
        position: currentPos || existingReq.response.position,
        attachedOrders: existingReq.response.attachedOrders || [],
        audit: existingReq.response.audit,
      };
    }

    const position = await this.repo.getPositionById(request.accountId, request.positionId);
    if (!position) {
      throw new Error('ERR_POSITION_NOT_FOUND: Position not found or does not belong to this account.');
    }
    if (position.quantity === 0) {
      throw new Error('ERR_POSITION_CLOSED: Cannot modify TP/SL because this position is already closed.');
    }

    const currentVersion = Number(position.protectionVersion || 1);
    if (request.expectedVersion !== undefined && Number(request.expectedVersion) !== currentVersion) {
      throw new Error(
        `ERR_PROTECTION_VERSION_CONFLICT: Position protection was updated (expected version ${request.expectedVersion}, actual ${currentVersion}). Refresh and review current levels.`
      );
    }

    if (instrument.globalId !== position.globalInstrumentId) {
      throw new Error(
        `ERR_INSTRUMENT_MISMATCH: Protection for ${position.globalInstrumentId} must be evaluated against its own traded contract, not ${instrument.globalId}.`
      );
    }

    // Validate fresh executable quote on the actual traded contract
    const quoteAgeMs = quoteFreshnessAgeMs(quote);
    const sessionStatus = getExchangeSessionStatus(instrument.exchange, new Date());
    const isClosedMarketLiveQuote = !quote.isSimulated && !sessionStatus.isOpen;
    if (
      !quote ||
      quote.globalId !== instrument.globalId ||
      !Number.isFinite(quote.ltp) ||
      quote.ltp <= 0
    ) {
      throw new Error('ERR_UNSUITABLE_MARKET_DATA: Executable market quote is invalid or unavailable for this contract.');
    }
    if (isClosedMarketLiveQuote) {
      throw new Error(
        `ERR_MARKET_CLOSED: ${instrument.exchange} market is currently closed (${sessionStatus.sessionName}). TP/SL modifications require an active session with a fresh executable quote.`
      );
    }
    if (quoteAgeMs > 5000) {
      throw new Error(
        `ERR_STALE_MARKET_DATA: Market quote age is ${quoteAgeMs}ms (threshold 5000ms). TP/SL modification requires a fresh live quote.`
      );
    }

    const previousSl = position.stopLossPrice;
    const previousTp = position.targetPrice;
    let nextSl: number | undefined = previousSl;
    let nextTp: number | undefined = previousTp;
    let slTouched = false;
    let tpTouched = false;

    if (request.removeStopLoss === true || request.stopLossPrice === null) {
      nextSl = undefined;
      slTouched = true;
    } else if (request.stopLossPrice !== undefined) {
      const rawSl = typeof request.stopLossPrice === 'number' ? request.stopLossPrice : Number(request.stopLossPrice);
      if (request.stopLossPrice === ('' as any) || !Number.isFinite(rawSl) || rawSl <= 0) {
        throw new Error('ERR_INVALID_STOP_LOSS: Stop Loss price must be a valid number strictly greater than zero.');
      }
      nextSl = rawSl;
      slTouched = true;
    }

    if (request.removeTarget === true || request.targetPrice === null) {
      nextTp = undefined;
      tpTouched = true;
    } else if (request.targetPrice !== undefined) {
      const rawTp = typeof request.targetPrice === 'number' ? request.targetPrice : Number(request.targetPrice);
      if (request.targetPrice === ('' as any) || !Number.isFinite(rawTp) || rawTp <= 0) {
        throw new Error('ERR_INVALID_TARGET: Take Profit price must be a valid number strictly greater than zero.');
      }
      nextTp = rawTp;
      tpTouched = true;
    }

    if (!slTouched && !tpTouched) {
      throw new Error('ERR_NO_PROTECTION_CHANGE: Specify a Stop Loss or Take Profit change (or explicit removal).');
    }

    const tick = Number(instrument.tickSize) > 0 ? Number(instrument.tickSize) : 0.05;
    const isLong = position.quantity > 0;
    const currentLtp = Number(quote.ltp);

    if (nextSl !== undefined) {
      if (!OrderValidator.isAlignedToTick(nextSl, tick)) {
        throw new Error(`ERR_OFF_TICK_PRICE: Stop Loss price ₹${nextSl} does not align with instrument tick size ${tick}.`);
      }
      // Validate against current executable market price (allows profit-protecting stops beyond entry!)
      if (isLong && nextSl >= currentLtp) {
        throw new Error(
          `ERR_PROTECTION_ALREADY_CROSSED: For a LONG position, Stop Loss (₹${nextSl}) must be strictly below the current market price (₹${currentLtp}).`
        );
      }
      if (!isLong && nextSl <= currentLtp) {
        throw new Error(
          `ERR_PROTECTION_ALREADY_CROSSED: For a SHORT position, Stop Loss (₹${nextSl}) must be strictly above the current market price (₹${currentLtp}).`
        );
      }
    }

    if (nextTp !== undefined) {
      if (!OrderValidator.isAlignedToTick(nextTp, tick)) {
        throw new Error(`ERR_OFF_TICK_PRICE: Take Profit price ₹${nextTp} does not align with instrument tick size ${tick}.`);
      }
      if (isLong && nextTp <= currentLtp) {
        throw new Error(
          `ERR_PROTECTION_ALREADY_CROSSED: For a LONG position, Take Profit (₹${nextTp}) must be strictly above the current market price (₹${currentLtp}).`
        );
      }
      if (!isLong && nextTp >= currentLtp) {
        throw new Error(
          `ERR_PROTECTION_ALREADY_CROSSED: For a SHORT position, Take Profit (₹${nextTp}) must be strictly below the current market price (₹${currentLtp}).`
        );
      }
    }

    if (nextSl !== undefined && nextTp !== undefined) {
      if (isLong && nextSl >= nextTp) {
        throw new Error(
          `ERR_INVALID_PROTECTION_RANGE: For a LONG position, Stop Loss (₹${nextSl}) must be strictly below Take Profit (₹${nextTp}).`
        );
      }
      if (!isLong && nextTp >= nextSl) {
        throw new Error(
          `ERR_INVALID_PROTECTION_RANGE: For a SHORT position, Take Profit (₹${nextTp}) must be strictly below Stop Loss (₹${nextSl}).`
        );
      }
    }

    // Atomically cancel any previous protective orders for this position
    await this.cancelProtectiveOrdersForPosition(
      request.accountId,
      position.globalInstrumentId,
      'PROTECTION_UPDATED: Replaced by updated position TP/SL protection.'
    );

    position.protectionVersion = currentVersion + 1;
    position.updatedAt = Date.now();

    const attachedOrders = await this.spawnProtectiveOrdersForPosition(
      position,
      instrument,
      nextSl,
      nextTp,
      `prot-${position.id}-v${position.protectionVersion}`
    );

    this.updatePositionUnrealized(position, currentLtp, instrument);
    await this.repo.saveOrUpdatePosition(position);

    const audit = await this.repo.recordProtectionAudit({
      accountId: request.accountId,
      positionId: position.id,
      globalInstrumentId: position.globalInstrumentId,
      previousSl,
      newSl: nextSl,
      previousTp,
      newTp: nextTp,
      quantity: position.quantity,
      entryPrice: position.averageEntryPrice,
      referenceLtp: currentLtp,
      protectionVersion: position.protectionVersion,
      source: request.source || 'MANUAL_EDIT',
      idempotencyKey,
    });

    await this.repo.saveProtectionRequest({
      accountId: request.accountId,
      positionId: position.id,
      idempotencyKey,
      payloadSignature,
      response: {
        position: {
          ...position,
          realizedPnlPaise: position.realizedPnlPaise.toString(),
          unrealizedPnlPaise: position.unrealizedPnlPaise.toString(),
        },
        attachedOrders: attachedOrders.map((o) => ({
          ...o,
          estimatedChargesPaise: o.estimatedChargesPaise.toString(),
        })),
        audit,
      },
    });

    return {
      position,
      attachedOrders,
      audit,
    };
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
