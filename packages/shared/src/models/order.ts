import { Paise } from './money.js';

export type OrderSide = 'BUY' | 'SELL';

export type OrderType = 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'STOP_LIMIT' | 'TARGET';

export type ProductType = 'INTRADAY' | 'DELIVERY' | 'MARGIN';

export type OrderStatus =
  | 'PENDING' // Awaiting price trigger or match
  | 'TRIGGERED' // Stop breached, converting to active execution
  | 'PARTIALLY_FILLED' // Partially executed
  | 'EXECUTED' // Successfully filled in simulation
  | 'CANCELLED' // Explicitly cancelled by user or OCO companion
  | 'REJECTED' // Rejected (margin, lot size, stale quote, off-tick)
  | 'EXPIRED'; // Session/validity expired without fill

export interface SimulatedOrder {
  id: string;
  accountId: string;
  globalInstrumentId: string;
  side: OrderSide;
  orderType: OrderType;
  productType?: ProductType;
  quantity: number;
  requestedPrice?: number;
  triggerPrice?: number;
  executedPrice?: number;
  status: OrderStatus;
  idempotencyKey: string;
  rejectionReason?: string;
  ocoCompanionOrderId?: string; // Linked OCO companion (SL vs Target race protection)
  positionId?: string; // Target position being reduced / closed
  stopLossPrice?: number; // Attached SL to spawn upon entry fill
  targetPrice?: number; // Attached TP to spawn upon entry fill
  isProtectiveExit?: boolean; // True for SL/TP protective orders (clamped to position, never flips)
  estimatedChargesPaise: Paise;
  executedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface PlaceOrderRequest {
  accountId: string;
  globalInstrumentId: string;
  side: OrderSide;
  orderType: OrderType;
  productType?: ProductType;
  quantity: number;
  requestedPrice?: number;
  triggerPrice?: number;
  stopLossPrice?: number;
  targetPrice?: number;
  idempotencyKey: string;
}
