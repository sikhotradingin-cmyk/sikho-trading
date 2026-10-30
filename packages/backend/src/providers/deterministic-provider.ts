import {
  Candle,
  InstrumentMetadata,
  QuoteSnapshot,
  Timeframe,
  makeGlobalInstrumentId,
} from '@trading/shared';
import { FeedHealth, IMarketDataProvider } from './types.js';

export class DeterministicProvider implements IMarketDataProvider {
  public readonly providerId = 'DEMO';
  private instruments: Map<string, InstrumentMetadata> = new Map();
  private quotes: Map<string, QuoteSnapshot> = new Map();
  private candles1m: Map<string, Candle[]> = new Map();
  private candles5m: Map<string, Candle[]> = new Map();
  private listeners: Map<string, Set<(q: QuoteSnapshot) => void>> = new Map();
  private timer: NodeJS.Timeout | null = null;
  private lastTickTime = Date.now();

  constructor() {
    this.setupFixtures();
  }

  private setupFixtures(): void {
    // 1. Non-tradable Spot Index Reference
    const spotNifty: InstrumentMetadata = {
      globalId: makeGlobalInstrumentId('NSE', 'NIFTY50', '999000'),
      provider: 'DEMO',
      exchange: 'NSE',
      token: '999000',
      symbol: 'NIFTY 50',
      name: 'NIFTY 50 Spot Index (Reference Only)',
      instrumentType: 'INDEX_SPOT',
      isTradable: false,
      lotSize: 1,
      tickSize: 0.05,
      isSimulatedFixture: true,
    };

    // 2. Tradable Current Month Futures (dynamic lot size 25 from metadata)
    const futureNifty: InstrumentMetadata = {
      globalId: makeGlobalInstrumentId('NFO', 'NIFTY26OCTFUT', '999001'),
      provider: 'DEMO',
      exchange: 'NFO',
      token: '999001',
      symbol: 'NIFTY26OCTFUT',
      name: 'NIFTY Futures Current Month (Simulated)',
      instrumentType: 'FUTIDX',
      isTradable: true,
      lotSize: 25, // Dynamic from metadata
      tickSize: 0.05,
      expiry: '2026-11-26',
      underlying: 'NIFTY',
      isSimulatedFixture: true,
    };

    // 3. Tradable Equity Stock
    const relianceStock: InstrumentMetadata = {
      globalId: makeGlobalInstrumentId('NSE', 'RELIANCE', '2885'),
      provider: 'DEMO',
      exchange: 'NSE',
      token: '2885',
      symbol: 'RELIANCE',
      name: 'Reliance Industries Ltd (Equity)',
      instrumentType: 'EQUITY_STOCK',
      isTradable: true,
      lotSize: 1,
      tickSize: 0.05,
      isSimulatedFixture: true,
    };

    this.instruments.set(spotNifty.globalId, spotNifty);
    this.instruments.set(futureNifty.globalId, futureNifty);
    this.instruments.set(relianceStock.globalId, relianceStock);

    // Seed base prices
    this.seedQuotesAndCandles(spotNifty.globalId, 24500.0);
    this.seedQuotesAndCandles(futureNifty.globalId, 24535.0);
    this.seedQuotesAndCandles(relianceStock.globalId, 2920.0);
  }

  private seedQuotesAndCandles(globalId: string, basePrice: number): void {
    const nowSec = Math.floor(Date.now() / 1000);
    const minuteSec = Math.floor(nowSec / 60) * 60;

    // Generate past 150 1-minute candles
    const c1m: Candle[] = [];
    let currentClose = basePrice;
    for (let i = 150; i >= 0; i--) {
      const time = minuteSec - i * 60;
      const step = (Math.sin(i / 5) * 4 + (Math.random() - 0.49) * 6);
      const open = Number(currentClose.toFixed(2));
      const close = Number((open + step).toFixed(2));
      const high = Number((Math.max(open, close) + Math.random() * 2).toFixed(2));
      const low = Number((Math.min(open, close) - Math.random() * 2).toFixed(2));
      const volume = Math.floor(500 + Math.random() * 1500);
      c1m.push({ time, open, high, low, close, volume });
      currentClose = close;
    }
    this.candles1m.set(globalId, c1m);

    // Aggregate into 5-minute candles
    const c5m: Candle[] = [];
    for (let i = 0; i < c1m.length; i += 5) {
      const chunk = c1m.slice(i, i + 5);
      if (chunk.length === 0) continue;
      c5m.push({
        time: chunk[0].time,
        open: chunk[0].open,
        high: Math.max(...chunk.map((c) => c.high)),
        low: Math.min(...chunk.map((c) => c.low)),
        close: chunk[chunk.length - 1].close,
        volume: chunk.reduce((sum, c) => sum + (c.volume || 0), 0),
      });
    }
    this.candles5m.set(globalId, c5m);

    const latest = c1m[c1m.length - 1];
    this.quotes.set(globalId, {
      globalId,
      token: globalId.split(':')[2],
      ltp: latest.close,
      open: latest.open,
      high: latest.high,
      low: latest.low,
      close: latest.close,
      bidPrice: Number((latest.close - 0.05).toFixed(2)),
      bidQty: 150,
      askPrice: Number((latest.close + 0.05).toFixed(2)),
      askQty: 200,
      volume: 125000,
      openInterest: 84000,
      providerTimestamp: Date.now(),
      receiveTimestamp: Date.now(),
      source: 'DEMO',
      isSimulated: true,
    });
  }

  public async init(): Promise<void> {
    if (this.timer) return;
    // Generate micro-ticks every 400ms to simulate live exchange streaming
    this.timer = setInterval(() => {
      this.generateNextTicks();
    }, 400);
  }

  private generateNextTicks(): void {
    const now = Date.now();
    this.lastTickTime = now;
    const nowSec = Math.floor(now / 1000);
    const minuteSec = Math.floor(nowSec / 60) * 60;

    for (const [globalId, quote] of this.quotes.entries()) {
      // Deterministic random walk bounded around recent price
      const delta = (Math.random() - 0.495) * 1.5;
      const newLtp = Number((quote.ltp + delta).toFixed(2));
      const bid = Number((newLtp - 0.05).toFixed(2));
      const ask = Number((newLtp + 0.05).toFixed(2));

      const updatedQuote: QuoteSnapshot = {
        ...quote,
        ltp: newLtp,
        high: Math.max(quote.high, newLtp),
        low: Math.min(quote.low, newLtp),
        close: newLtp,
        bidPrice: bid,
        askPrice: ask,
        providerTimestamp: now,
        receiveTimestamp: now,
      };
      this.quotes.set(globalId, updatedQuote);

      // Update current 1m candle
      const c1mList = this.candles1m.get(globalId);
      if (c1mList && c1mList.length > 0) {
        const last1m = c1mList[c1mList.length - 1];
        if (last1m.time === minuteSec) {
          last1m.high = Math.max(last1m.high, newLtp);
          last1m.low = Math.min(last1m.low, newLtp);
          last1m.close = newLtp;
          last1m.volume = (last1m.volume || 0) + 1;
        } else if (minuteSec > last1m.time) {
          c1mList.push({
            time: minuteSec,
            open: newLtp,
            high: newLtp,
            low: newLtp,
            close: newLtp,
            volume: 1,
          });
        }
      }

      // Notify any active subscribers
      const subs = this.listeners.get(globalId);
      if (subs) {
        subs.forEach((cb) => cb(updatedQuote));
      }
    }
  }

  public async getInstruments(): Promise<InstrumentMetadata[]> {
    return Array.from(this.instruments.values());
  }

  public async getCandles(globalId: string, timeframe: Timeframe, count: number = 100): Promise<Candle[]> {
    const list = timeframe === '5m' ? this.candles5m.get(globalId) : this.candles1m.get(globalId);
    if (!list) return [];
    return list.slice(-count);
  }

  public async getQuote(globalId: string): Promise<QuoteSnapshot | null> {
    return this.quotes.get(globalId) || null;
  }

  public subscribe(globalId: string, listener: (quote: QuoteSnapshot) => void): () => void {
    if (!this.listeners.has(globalId)) {
      this.listeners.set(globalId, new Set());
    }
    this.listeners.get(globalId)!.add(listener);
    return () => {
      this.listeners.get(globalId)?.delete(listener);
    };
  }

  public getFeedHealth(): FeedHealth {
    const now = Date.now();
    const age = now - this.lastTickTime;
    return {
      source: 'DEMO',
      status: age > 5000 ? 'STALE' : 'LIVE',
      latencyMs: 12,
      lastTickTimestamp: this.lastTickTime,
      isSimulated: true,
      activeSubscriptionsCount: Array.from(this.listeners.values()).reduce((sum, s) => sum + s.size, 0),
      uiBannerLabel: 'DEMO DATA — NOT LIVE MARKET',
      message: 'Running local deterministic simulation engine.',
    };
  }

  public async dispose(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.listeners.clear();
  }
}
