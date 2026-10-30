import { Candle, InstrumentMetadata, QuoteSnapshot, Timeframe } from '@trading/shared';

export type FeedStatus = 'LIVE' | 'STALE' | 'DISCONNECTED' | 'NOT_LIVE_VERIFIED';

export interface FeedHealth {
  source: 'DEMO' | 'SMARTAPI';
  status: FeedStatus;
  latencyMs: number;
  lastTickTimestamp: number;
  isSimulated: boolean;
  activeSubscriptionsCount: number;
  uiBannerLabel: string; // e.g. "DEMO DATA — NOT LIVE MARKET"
  message?: string;
}

export interface IMarketDataProvider {
  readonly providerId: 'DEMO' | 'SMARTAPI';
  init(): Promise<void>;
  getInstruments(): Promise<InstrumentMetadata[]>;
  getCandles(globalId: string, timeframe: Timeframe, count?: number): Promise<Candle[]>;
  getQuote(globalId: string): Promise<QuoteSnapshot | null>;
  subscribe(globalId: string, listener: (quote: QuoteSnapshot) => void): () => void;
  getFeedHealth(): FeedHealth;
  dispose(): Promise<void>;
}
