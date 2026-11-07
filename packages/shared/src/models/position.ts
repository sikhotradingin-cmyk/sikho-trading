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
  createdAt: number;
  updatedAt: number;
}
