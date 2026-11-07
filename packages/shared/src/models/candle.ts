export type Timeframe = '1m' | '3m' | '5m' | '15m' | '30m' | '1h' | '1D';

export type ChartRange = '1D' | '5D' | '1M' | '3M' | '6M' | '1Y' | 'ALL';

export interface Candle {
  time: number; // Unix timestamp in seconds (TradingView Lightweight Charts requirement)
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface QuoteSnapshot {
  globalId: string;
  token: string;
  ltp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  bidPrice?: number;
  bidQty?: number;
  askPrice?: number;
  askQty?: number;
  volume?: number;
  openInterest?: number;
  providerTimestamp: number; // UTC ms when source emitted
  receiveTimestamp: number; // UTC ms when our server ingested
  source: 'DEMO' | 'SMARTAPI' | 'UPSTOX';
  isSimulated: boolean;
}
