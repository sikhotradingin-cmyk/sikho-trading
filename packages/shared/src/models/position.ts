import { Paise } from './money.js';
import { ProductType } from './order.js';

export interface SimulatedPosition {
  id: string;
  accountId: string;
  globalInstrumentId: string;
  productType?: ProductType;
  quantity: number; // Positive = Long, Negative = Short, 0 = Closed
  averageEntryPrice: number;
  realizedPnlPaise: Paise;
  unrealizedPnlPaise: Paise;
  currentPrice: number;
  stopLossPrice?: number;
  targetPrice?: number;
  stopOrderId?: string;
  targetOrderId?: string;
  protectionVersion?: number;
  createdAt: number;
  updatedAt: number;
}

export interface UpdatePositionProtectionRequest {
  accountId: string;
  positionId: string;
  stopLossPrice?: number | null;
  targetPrice?: number | null;
  removeStopLoss?: boolean;
  removeTarget?: boolean;
  expectedVersion?: number;
  idempotencyKey: string;
  source?: 'MANUAL_EDIT' | 'CHART_DRAG';
}

export interface PositionProtectionAuditEntry {
  id: string;
  accountId: string;
  positionId: string;
  globalInstrumentId: string;
  previousSl?: number;
  newSl?: number;
  previousTp?: number;
  newTp?: number;
  quantity: number;
  entryPrice: number;
  referenceLtp: number;
  protectionVersion: number;
  source: string;
  idempotencyKey?: string;
  createdAt: number;
}
