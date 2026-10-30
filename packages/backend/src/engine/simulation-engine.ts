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
import { VirtualAccountEngine } from './virtual-account-engine.js';

export interface ExecutionResult {
  order: SimulatedOrder;
  position?: SimulatedPosition;
  realizedPnlPaise?: Paise;
  chargesPaise?: Paise;
}

export class SimulationEngine {
  private orders: Map<string, SimulatedOrder> = new Map();
  // AccountId + IdempotencyKey -> OrderId
  private idempotencyRegistry: Map<string, { orderId: string; requestHash: string }> = new Map();
  // AccountId + GlobalInstrumentId -> Position
  private positions: Map<string, SimulatedPosition> = new Map();
  private pendingOrders: SimulatedOrder[] = [];

  constructor(private accountEngine: VirtualAccountEngine) {}

  /**
   * Submit and evaluate a simulated order.
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

    // 2. Account-scoped Idempotency Check
    const idemCompositeKey = `${request.accountId}:${request.idempotencyKey}`;
    const requestHash = JSON.stringify({
      accountId: request.accountId,
      globalInstrumentId: request.globalInstrumentId,
      side: request.side,
      orderType: request.orderType,
      quantity: request.quantity,
      requestedPrice: request.requestedPrice,
      triggerPrice: request.triggerPrice,
    });

    const existingIdem = this.idempotencyRegistry.get(idemCompositeKey);
    if (existingIdem) {
      if (existingIdem.requestHash !== requestHash) {
        throw new Error('ERR_IDEMPOTENCY_MISMATCH: Idempotency key reused with different order payload.');
      }
      const existingOrder = this.orders.get(existingIdem.orderId);
      if (!existingOrder) throw new Error('Existing idempotent order not found in memory.');
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
      this.orders.set(rejectedOrder.id, rejectedOrder);
      this.idempotencyRegistry.set(idemCompositeKey, { orderId: rejectedOrder.id, requestHash });
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

    this.orders.set(orderId, order);
    this.idempotencyRegistry.set(idemCompositeKey, { orderId, requestHash });

    // 5. Margin Reservation
    const marginLocked = this.accountEngine.lockMargin(request.accountId, requiredMarginPaise);
    if (!marginLocked) {
      order.status = 'REJECTED';
      order.rejectionReason = 'ERR_INSUFFICIENT_MARGIN: Account cannot lock required margin.';
      order.updatedAt = Date.now();
      return { order };
    }

    // 6. Immediate Execution vs. Pending Queue
    if (request.orderType === 'MARKET') {
      const executedPrice = this.computeFillPrice(order.side, quote, request.orderType);
      return this.executeFill(order, executedPrice, quote, requiredMarginPaise);
    } else {
      // LIMIT or STOP order placed into server-side order book
      this.pendingOrders.push(order);
      return { order };
    }
  }

  /**
   * Deterministic fill price calculation:
   * Uses Ask (for Buy) / Bid (for Sell) when available,
   * falling back to LTP with explicit labeled simulated slippage.
   */
  private computeFillPrice(side: OrderSide, quote: QuoteSnapshot, _type: OrderType, gapPrice?: number): number {
    if (gapPrice !== undefined) {
      return gapPrice; // Gap open handling: fill at actual gap tick
    }
    if (side === 'BUY') {
      return quote.askPrice ?? Number((quote.ltp * 1.0005).toFixed(2));
    } else {
      return quote.bidPrice ?? Number((quote.ltp * 0.9995).toFixed(2));
    }
  }

  /**
   * Execute fill on an order and update positions and ledger atomically.
   */
  private executeFill(
    order: SimulatedOrder,
    fillPrice: number,
    quote: QuoteSnapshot,
    _marginPaise: Paise
  ): ExecutionResult {
    order.status = 'EXECUTED';
    order.executedPrice = fillPrice;
    order.executedAt = Date.now();
    order.updatedAt = Date.now();

    const posKey = `${order.accountId}:${order.globalInstrumentId}`;
    let position = this.positions.get(posKey);
    let realizedPnlPaise = 0n;

    const deltaQty = order.side === 'BUY' ? order.quantity : -order.quantity;

    if (!position || position.quantity === 0) {
      // New Position Opened
      position = {
        id: randomUUID(),
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
      this.positions.set(posKey, position);
    } else {
      const isSameSide = (position.quantity > 0 && deltaQty > 0) || (position.quantity < 0 && deltaQty < 0);

      if (isSameSide) {
        // Position Addition (weighted average entry price)
        const totalQty = position.quantity + deltaQty;
        const totalValue =
          Math.abs(position.quantity) * position.averageEntryPrice + Math.abs(deltaQty) * fillPrice;
        position.averageEntryPrice = Number((totalValue / Math.abs(totalQty)).toFixed(2));
        position.quantity = totalQty;
        position.updatedAt = Date.now();
      } else {
        // Position Reduction or Closure
        const closedQty = Math.min(Math.abs(position.quantity), Math.abs(deltaQty));
        // P&L = (Exit - Entry) * Qty for Longs, (Entry - Exit) * Qty for Shorts
        const priceDiff = position.quantity > 0 ? fillPrice - position.averageEntryPrice : position.averageEntryPrice - fillPrice;
        const pnlRupees = priceDiff * closedQty;
        realizedPnlPaise = Money.fromRupees(pnlRupees);

        position.realizedPnlPaise += realizedPnlPaise;
        position.quantity += deltaQty; // Moves toward zero or reverses
        position.updatedAt = Date.now();

        // Release margin proportional to closed quantity
        const releasedMargin = Money.multiply(order.estimatedChargesPaise * 50n, closedQty / order.quantity);
        this.accountEngine.releaseMargin(order.accountId, releasedMargin);

        // Apply realized P&L and charges to ledger
        this.accountEngine.applyTradeSettlement(
          order.accountId,
          realizedPnlPaise,
          order.estimatedChargesPaise,
          order.id,
          `${order.side} ${closedQty} @ ₹${fillPrice}`
        );
      }
    }

    // Recompute unrealized P&L
    this.updatePositionUnrealized(position, quote.ltp);

    return {
      order,
      position,
      realizedPnlPaise,
      chargesPaise: order.estimatedChargesPaise,
    };
  }

  /**
   * Server-Side Ticking Engine: Evaluates pending Limit, Stop-Loss, and Target orders on every market tick.
   * Runs independently of client connection status.
   */
  public onMarketTick(quote: QuoteSnapshot): ExecutionResult[] {
    const results: ExecutionResult[] = [];
    const remainingPending: SimulatedOrder[] = [];

    for (const order of this.pendingOrders) {
      if (order.globalInstrumentId !== quote.globalId) {
        remainingPending.push(order);
        continue;
      }

      let shouldTrigger = false;
      let gapPrice: number | undefined;

      // 1. Limit Order Evaluation
      if (order.orderType === 'LIMIT' && order.requestedPrice !== undefined) {
        if (order.side === 'BUY' && quote.ltp <= order.requestedPrice) {
          shouldTrigger = true;
        } else if (order.side === 'SELL' && quote.ltp >= order.requestedPrice) {
          shouldTrigger = true;
        }
      }

      // 2. Stop-Market Evaluation (with Gap handling)
      if (order.orderType === 'STOP_MARKET' && order.triggerPrice !== undefined) {
        if (order.side === 'SELL' && quote.ltp <= order.triggerPrice) {
          shouldTrigger = true;
          // If price gapped below trigger, fill at gap price (quote.ltp)
          if (quote.ltp < order.triggerPrice) {
            gapPrice = quote.ltp;
          }
        } else if (order.side === 'BUY' && quote.ltp >= order.triggerPrice) {
          shouldTrigger = true;
          if (quote.ltp > order.triggerPrice) {
            gapPrice = quote.ltp;
          }
        }
      }

      if (shouldTrigger) {
        // OCO Race Protection: Cancel companion order if linked
        if (order.ocoCompanionOrderId) {
          const companion = this.orders.get(order.ocoCompanionOrderId);
          if (companion && companion.status === 'PENDING') {
            companion.status = 'CANCELLED';
            companion.rejectionReason = `OCO_TRIGGERED: Cancelled because companion order ${order.id} executed.`;
            companion.updatedAt = Date.now();
          }
        }

        const fillPrice = this.computeFillPrice(order.side, quote, order.orderType, gapPrice);
        const res = this.executeFill(order, fillPrice, quote, 0n);
        results.push(res);
      } else {
        remainingPending.push(order);
      }
    }

    this.pendingOrders = remainingPending;

    // Update unrealized P&L for open positions of this instrument
    for (const pos of this.positions.values()) {
      if (pos.globalInstrumentId === quote.globalId && pos.quantity !== 0) {
        this.updatePositionUnrealized(pos, quote.ltp);
      }
    }

    return results;
  }

  /**
   * Square-off an open position at prevailing market price.
   */
  public squareOffPosition(
    accountId: string,
    globalInstrumentId: string,
    quote: QuoteSnapshot
  ): ExecutionResult {
    SecurityAirGap.verifySimulatedActionExclusivity('SQUARE_OFF');

    const posKey = `${accountId}:${globalInstrumentId}`;
    const position = this.positions.get(posKey);
    if (!position || position.quantity === 0) {
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
    return this.executeFill(closeOrder, fillPrice, quote, 0n);
  }

  /**
   * Cancel a pending order.
   */
  public cancelOrder(accountId: string, orderId: string): SimulatedOrder {
    SecurityAirGap.verifySimulatedActionExclusivity('CANCEL');

    const order = this.orders.get(orderId);
    if (!order) throw new Error(`Order ${orderId} not found.`);
    if (order.accountId !== accountId) throw new Error('Unauthorized order access.');
    if (order.status !== 'PENDING') {
      throw new Error(`Cannot cancel order in status ${order.status}.`);
    }

    order.status = 'CANCELLED';
    order.updatedAt = Date.now();
    this.pendingOrders = this.pendingOrders.filter((o) => o.id !== orderId);

    // Cancel OCO companion if linked
    if (order.ocoCompanionOrderId) {
      const companion = this.orders.get(order.ocoCompanionOrderId);
      if (companion && companion.status === 'PENDING') {
        companion.status = 'CANCELLED';
        companion.updatedAt = Date.now();
      }
    }

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

  public getOrders(accountId: string): SimulatedOrder[] {
    return Array.from(this.orders.values()).filter((o) => o.accountId === accountId);
  }

  public getPositions(accountId: string): SimulatedPosition[] {
    return Array.from(this.positions.values()).filter((p) => p.accountId === accountId);
  }
}
