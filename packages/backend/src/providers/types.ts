import { Candle, ChartRange, InstrumentMetadata, QuoteSnapshot, Timeframe } from '@trading/shared';

export type FeedStatus =
  | 'CONNECTING'
  | 'LIVE'
  | 'DELAYED'
  | 'STALE'
  | 'MARKET_CLOSED'
  | 'RECONNECTING'
  | 'CONFIGURATION_REQUIRED'
  | 'DISCONNECTED'
  | 'NOT_LIVE_VERIFIED';

export interface FeedHealth {
  source: 'DEMO' | 'SMARTAPI' | 'UPSTOX';
  status: FeedStatus;
  latencyMs: number;
  lastTickTimestamp: number;
  lastProviderEventTime?: number;
  lastServerReceiveTime?: number;
  isSimulated: boolean;
  activeSubscriptionsCount: number;
  uiBannerLabel: string; // e.g. "DEMO DATA — NOT LIVE MARKET"
  message?: string;
  marketSession?: {
    isMarketOpen: boolean;
    sessionName: string;
    nextTransitionIST: string;
    message: string;
  };
  supportedSegments?: {
    equity: boolean;
    fno: boolean;
    commodities: boolean;
  };
}

export interface CandleQueryOptions {
  before?: number; // Unix seconds: load candles strictly prior to this timestamp
  from?: number;   // Unix seconds: start of custom range
  to?: number;     // Unix seconds: end of custom range
  limit?: number;  // Max bars to return (optional)
  range?: ChartRange; // '1D' | '5D' | '1M' | '3M' | '6M' | '1Y' | 'ALL'
}

export interface CandlePageResult {
  candles: Candle[];
  hasMore: boolean;
  earliestTime: number | null;
  latestTime: number | null;
  sessionDateIST: string | null;
  prevSessionClose: number | null;
  providerError: string | null;
}

export interface InstrumentSearchOptions {
  q?: string;
  exchange?: string;
  segment?: string;
  underlying?: string;
  expiry?: string;
  optionType?: string;
  strike?: number;
  page?: number;
  limit?: number;
}

export interface InstrumentSearchResult {
  instruments: InstrumentMetadata[];
  totalCount: number;
  page: number;
  limit: number;
  availableFilters?: {
    exchanges: string[];
    segments: string[];
    underlyings: string[];
    expiries: string[];
  };
}

export interface OptionChainContractSide {
  instrument: InstrumentMetadata;
  ltp: number | null;
  changePct: number | null;
  openInterest: number | null; // Null when unavailable from provider (never assumed zero)
  volume: number | null;
  bidPrice: number | null;
  askPrice: number | null;
  quoteTimestamp?: number | null;
  source?: string;
}

export interface OptionChainRow {
  strikePrice: number;
  call: OptionChainContractSide | null;
  put: OptionChainContractSide | null;
}

export interface OptionChainResult {
  underlying: string;
  underlyingSpotInstrument?: InstrumentMetadata;
  underlyingSpotLtp: number | null;
  selectedExpiry: string;
  availableExpiries: string[];
  rows: OptionChainRow[];
  providerSource: 'UPSTOX' | 'SMARTAPI' | 'DEMO';
  deliveryMode: 'POLLED' | 'STREAMED';
  provenance: {
    spotSource: string;
    spotTimestamp?: number | null;
    contractsTotal: number;
    contractsWithRealQuotes: number;
    note: string;
  };
}

export interface IMarketDataProvider {
  readonly providerId: 'DEMO' | 'SMARTAPI' | 'UPSTOX';
  init(): Promise<void>;
  getInstruments(): Promise<InstrumentMetadata[]>;
  getInstrumentById?(globalId: string): Promise<InstrumentMetadata | undefined>;
  searchInstruments?(opts: InstrumentSearchOptions): Promise<InstrumentSearchResult>;
  getIndices?(): Promise<InstrumentMetadata[]>;
  getOptionChain?(underlying: string, expiry?: string): Promise<OptionChainResult>;
  getCandles(globalId: string, timeframe: Timeframe, count?: number): Promise<Candle[]>;
  getCandlesPaginated?(globalId: string, timeframe: Timeframe, opts?: CandleQueryOptions): Promise<CandlePageResult>;
  getQuote(globalId: string): Promise<QuoteSnapshot | null>;
  subscribe(globalId: string, listener: (quote: QuoteSnapshot) => void): () => void;
  getFeedHealth(): FeedHealth;
  dispose(): Promise<void>;
}
