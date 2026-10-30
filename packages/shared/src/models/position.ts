import { Paise } from './money.js';

export interface SimulatedPosition {
  id: string;
  accountId: string;
  globalInstrumentId: string;
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
