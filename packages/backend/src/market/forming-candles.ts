import { QuoteSnapshot, Timeframe } from '@trading/shared';

/**
 * Centralised forming-candle aggregation.
 *
 * IMPORTANT — time alignment:
 * Lightweight Charts requires `time` to be a real UTC epoch in seconds. Provider history
 * (Upstox V3 candles) is aligned to the exchange session open, NOT to plain UTC boundaries:
 *   - NSE/BSE/NFO/BFO open 09:15 IST (= 13500s after UTC midnight) -> 30m bars fall on :15/:45
 *     (epoch % 1800 === 900) and 1h bars fall on :15 (epoch % 3600 === 2700).
 *   - MCX opens 09:00 IST (= 12600s after UTC midnight) -> 1h bars fall on :00 IST
 *     (epoch % 3600 === 1800).
 * The previous implementation added +19800s to the tick timestamp (IST wall clock treated as
 * UTC), which shifted every forming bar 5.5 hours into the future relative to history. That
 * produced a phantom future candle on every reconnect and made live candles look wrong after
 * a refresh. The functions below are the single source of truth for bucketing.
 */

export const TIMEFRAME_SECONDS: Record<Timeframe, number> = {
  '1m': 60,
  '3m': 180,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '1D': 86400,
};

export const IST_OFFSET_SECONDS = 19800;

/** Exchange trading-session open expressed as IST seconds since IST midnight. */
const SESSION_OPEN_IST_SECONDS: Record<string, number> = {
  NSE: 9 * 3600 + 15 * 60, // 09:15
  NFO: 9 * 3600 + 15 * 60,
  BSE: 9 * 3600 + 15 * 60,
  BFO: 9 * 3600 + 15 * 60,
  NSE_EQ: 9 * 3600 + 15 * 60,
  BSE_EQ: 9 * 3600 + 15 * 60,
  MCX: 9 * 3600, // 09:00
  MCX_FO: 9 * 3600,
};

export function normaliseExchange(exchangeOrGlobalId?: string): string {
  const raw = (exchangeOrGlobalId || '').trim().toUpperCase();
  const exchange = raw.includes(':') ? raw.split(':')[0] : raw;
  switch (exchange) {
    case 'NFO':
    case 'NSE_FO':
    case 'NSE_EQ':
      return 'NSE';
    case 'BFO':
    case 'BSE_FO':
    case 'BSE_EQ':
      return 'BSE';
    case 'MCX_FO':
      return 'MCX';
    default:
      return exchange || 'NSE';
  }
}

export function getSessionOpenIstSeconds(exchangeOrGlobalId?: string): number {
  const exchange = normaliseExchange(exchangeOrGlobalId);
  return SESSION_OPEN_IST_SECONDS[exchange] ?? SESSION_OPEN_IST_SECONDS.NSE;
}

/**
 * Computes the UTC-epoch-second start of the interval that a provider event belongs to.
 * `providerTimestampMs` must be the provider's own event time (UTC ms); callers should
 * fall back to local receipt time only when the provider omits it.
 */
export function computeIntervalBucketSec(
  providerTimestampMs: number,
  timeframe: Timeframe,
  exchangeOrGlobalId?: string
): number {
  const intervalSec = TIMEFRAME_SECONDS[timeframe] || 300;
  const tickSec = Math.floor(Number(providerTimestampMs) / 1000);

  if (timeframe === '1D') {
    // Daily bars are anchored to IST midnight (Upstox daily candle convention).
    const istDayIndex = Math.floor((tickSec + IST_OFFSET_SECONDS) / 86400);
    return istDayIndex * 86400 - IST_OFFSET_SECONDS;
  }

  // Phase = how far the session open sits past the previous UTC interval boundary.
  const openUtcSecOfDay = getSessionOpenIstSeconds(exchangeOrGlobalId) - IST_OFFSET_SECONDS;
  const phase = ((openUtcSecOfDay % intervalSec) + intervalSec) % intervalSec;
  return Math.floor((tickSec - phase) / intervalSec) * intervalSec + phase;
}

export interface FormingCandleBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface InstrumentFormingState {
  exchange: string;
  byTimeframe: Partial<Record<Timeframe, FormingCandleBar>>;
}

const TRACKED_TIMEFRAMES: Timeframe[] = ['1m', '3m', '5m', '15m', '30m', '1h', '1D'];

/**
 * Accumulates genuine provider ticks into per-instrument forming candles.
 * Volume handling: providers report *cumulative* traded volume for the day, so only the
 * delta between consecutive ticks is added. A decrease means a new session / counter reset;
 * the delta is treated as 0 and the baseline is updated (never re-summed).
 */
export class FormingCandleTracker {
  private instruments = new Map<string, InstrumentFormingState>();
  private lastCumulativeVolume = new Map<string, number>();
  private ticksApplied = 0;
  private ticksRejected = 0;

  public applyTick(quote: QuoteSnapshot): boolean {
    const ltp = Number(quote?.ltp);
    const globalId = quote?.globalId;
    if (!globalId || !Number.isFinite(ltp) || ltp <= 0) {
      this.ticksRejected += 1;
      return false;
    }

    const providerTs = Number(quote.providerTimestamp);
    const eventTs = Number.isFinite(providerTs) && providerTs > 0
      ? providerTs
      : Number(quote.receiveTimestamp) || Date.now();

    const exchange = normaliseExchange(globalId);
    let state = this.instruments.get(globalId);
    if (!state) {
      state = { exchange, byTimeframe: {} };
      this.instruments.set(globalId, state);
    }

    // Convert cumulative day volume to a per-candle delta.
    let volumeDelta = 0;
    const cumulative = Number(quote.volume);
    if (Number.isFinite(cumulative) && cumulative >= 0) {
      const previous = this.lastCumulativeVolume.get(globalId);
      if (previous === undefined) {
        volumeDelta = 0; // baseline sample: we cannot know the delta yet
      } else if (cumulative >= previous) {
        volumeDelta = cumulative - previous;
      } else {
        volumeDelta = 0; // counter reset (new session)
      }
      this.lastCumulativeVolume.set(globalId, cumulative);
    }

    for (const timeframe of TRACKED_TIMEFRAMES) {
      const bucketSec = computeIntervalBucketSec(eventTs, timeframe, exchange);
      const existing = state.byTimeframe[timeframe];
      if (!existing || bucketSec > existing.time) {
        state.byTimeframe[timeframe] = {
          time: bucketSec,
          open: ltp,
          high: ltp,
          low: ltp,
          close: ltp,
          volume: volumeDelta,
        };
      } else if (bucketSec === existing.time) {
        existing.high = Math.max(existing.high, ltp);
        existing.low = Math.min(existing.low, ltp);
        existing.close = ltp;
        existing.volume = Number((existing.volume + volumeDelta).toFixed(4));
      } else {
        // Older event than the bar we already hold: provider history already covers it.
        this.ticksRejected += 1;
        continue;
      }
    }

    this.ticksApplied += 1;
    return true;
  }

  public snapshot(globalId: string): Partial<Record<Timeframe, FormingCandleBar>> | null {
    const state = this.instruments.get(globalId);
    if (!state) return null;
    const out: Partial<Record<Timeframe, FormingCandleBar>> = {};
    for (const timeframe of TRACKED_TIMEFRAMES) {
      const bar = state.byTimeframe[timeframe];
      if (bar) out[timeframe] = { ...bar };
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  /** Drops state for instruments that no longer need tracking (e.g. long-closed positions). */
  public forget(globalId: string): void {
    this.instruments.delete(globalId);
    this.lastCumulativeVolume.delete(globalId);
  }

  public reset(): void {
    this.instruments.clear();
    this.lastCumulativeVolume.clear();
    this.ticksApplied = 0;
    this.ticksRejected = 0;
  }

  public getTelemetry() {
    return {
      trackedFormingInstruments: this.instruments.size,
      formingTicksApplied: this.ticksApplied,
      formingTicksRejected: this.ticksRejected,
    };
  }
}
