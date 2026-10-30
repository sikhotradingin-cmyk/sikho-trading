export type Timeframe = '1m' | '5m' | '15m' | '1h' | '1D';

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
  source: 'DEMO' | 'SMARTAPI';
  isSimulated: boolean;
}
