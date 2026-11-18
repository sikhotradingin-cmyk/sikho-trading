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
  lastTradeTimestamp?: number; // UTC ms of actual last trade; distinct from quote/feed event
  timestampSource?: 'UPSTOX_WS_CURRENT_TS' | 'UPSTOX_REST_TIMESTAMP' | 'LAST_TRADE_FALLBACK';
  isTradeEvent?: boolean; // false for depth-only/feed refresh; never fabricate candle motion
  isSnapshot?: boolean;
  source: 'DEMO' | 'SMARTAPI' | 'UPSTOX';
  isSimulated: boolean;
}

export function quoteFreshnessAgeMs(quote: QuoteSnapshot, now=Date.now()):number {
  const received=Number(quote.receiveTimestamp),event=Number(quote.providerTimestamp);
  if(!Number.isFinite(received)||received<=0||received>now+1000)return Infinity;
  if(!quote.isSimulated&&(!Number.isFinite(event)||event<=0||event>now+1000))return Infinity;
  return Math.max(0,now-received,quote.isSimulated?0:now-event);
}
