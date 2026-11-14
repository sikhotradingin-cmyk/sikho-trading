import test from 'node:test';
import assert from 'node:assert/strict';
import { QuoteSnapshot } from '@trading/shared';
import {
  IST_OFFSET_SECONDS,
  computeIntervalBucketSec,
  getSessionOpenIstSeconds,
  normaliseExchange,
  FormingCandleTracker,
} from './forming-candles.js';

/** 2026-11-13 (Friday) 10:02:31 IST == 04:32:31 UTC */
const TICK_MS = Date.UTC(2026, 10, 13, 4, 32, 31);

function quote(overrides: Partial<QuoteSnapshot> = {}): QuoteSnapshot {
  return {
    globalId: 'NSE:NIFTY 50:99926000',
    token: '99926000',
    ltp: 25100,
    open: 25000,
    high: 25200,
    low: 24900,
    close: 25150,
    volume: 0,
    providerTimestamp: TICK_MS,
    receiveTimestamp: TICK_MS + 5,
    source: 'UPSTOX',
    isSimulated: false,
    ...overrides,
  };
}

test('bucket timestamps are true UTC epochs aligned to the exchange session open', () => {
  // NSE 09:15 IST open == 13_500s after UTC midnight. Historic 30m bars observed from the
  // provider had epoch % 1800 === 900 and 1h bars epoch % 3600 === 2700 - not plain UTC bounds.
  const openIst = getSessionOpenIstSeconds('NSE');
  assert.equal(openIst, 9 * 3600 + 15 * 60);
  assert.equal((openIst - IST_OFFSET_SECONDS) % 1800, 900);
  assert.equal((openIst - IST_OFFSET_SECONDS) % 3600, 2700);

  const fiveMin = computeIntervalBucketSec(TICK_MS, '5m', 'NSE');
  const thirtyMin = computeIntervalBucketSec(TICK_MS, '30m', 'NSE');
  const oneHour = computeIntervalBucketSec(TICK_MS, '1h', 'NSE');

  assert.equal(fiveMin % 300, 0);
  assert.equal(thirtyMin % 1800, 900);
  assert.equal(oneHour % 3600, 2700);

  // The forming bar must never be in the future relative to the provider event.
  assert.ok(fiveMin <= TICK_MS / 1000);
  assert.ok(TICK_MS / 1000 - fiveMin < 300);
});

test('the previous IST-shifted epoch bug is not reintroduced', () => {
  const bucket = computeIntervalBucketSec(TICK_MS, '5m', 'NSE');
  const istShifted = Math.floor((Math.floor(TICK_MS / 1000) + IST_OFFSET_SECONDS) / 300) * 300;
  assert.notEqual(bucket, istShifted);
  assert.equal(istShifted - bucket, IST_OFFSET_SECONDS);
});

test('MCX session open (09:00 IST) uses its own phase', () => {
  const mcx = computeIntervalBucketSec(TICK_MS, '1h', 'MCX');
  assert.equal((getSessionOpenIstSeconds('MCX') - IST_OFFSET_SECONDS) % 3600, 1800);
  assert.equal(mcx % 3600, 1800);
});

test('daily bars are anchored to IST midnight, not UTC midnight', () => {
  const bucket = computeIntervalBucketSec(TICK_MS, '1D', 'NSE');
  assert.equal(bucket % 86400, (86400 - IST_OFFSET_SECONDS) % 86400);
  assert.equal(bucket + IST_OFFSET_SECONDS, Math.floor((TICK_MS / 1000 + IST_OFFSET_SECONDS) / 86400) * 86400);
});

test('formula/commodity exchanges normalise to their parent exchange', () => {
  assert.equal(normaliseExchange('NFO:NIFTY26NOVFUT:61471'), 'NSE');
  assert.equal(normaliseExchange('BFO:SENSEX26NOVFUT:1'), 'BSE');
  assert.equal(normaliseExchange('MCX_FO:GOLD:1'), 'MCX');
  assert.equal(normaliseExchange('NSE:RELIANCE:2885'), 'NSE');
});

test('tracker keeps OHLC per interval and rolls over at the exact boundary', () => {
  const tracker = new FormingCandleTracker();
  tracker.applyTick(quote({ ltp: 25100 }));
  tracker.applyTick(quote({ ltp: 25120, providerTimestamp: TICK_MS + 1000 }));
  tracker.applyTick(quote({ ltp: 25090, providerTimestamp: TICK_MS + 2000 }));

  const bar = tracker.snapshot('NSE:NIFTY 50:99926000')!['5m']!;
  assert.equal(bar.open, 25100);
  assert.equal(bar.high, 25120);
  assert.equal(bar.low, 25090);
  assert.equal(bar.close, 25090);

  // Next 5m bucket: a brand new candle starts with the tick as its open.
  tracker.applyTick(quote({ ltp: 25200, providerTimestamp: TICK_MS + 5 * 60 * 1000 }));
  const next = tracker.snapshot('NSE:NIFTY 50:99926000')!['5m']!;
  assert.equal(next.time, bar.time + 300);
  assert.equal(next.open, 25200);
  assert.equal(next.high, 25200);
  assert.equal(next.volume, 0);
});

test('cumulative provider volume is converted to deltas once, never re-summed', () => {
  const tracker = new FormingCandleTracker();
  tracker.applyTick(quote({ volume: 1000, providerTimestamp: TICK_MS }));
  tracker.applyTick(quote({ volume: 1500, providerTimestamp: TICK_MS + 1000 }));
  tracker.applyTick(quote({ volume: 1500, providerTimestamp: TICK_MS + 2000 }));
  const bar = tracker.snapshot('NSE:NIFTY 50:99926000')!['5m']!;
  assert.equal(bar.volume, 500, 'only the cumulative delta is added');

  // Counter reset (new session) must not add a negative or re-summed volume.
  tracker.applyTick(quote({ volume: 200, providerTimestamp: TICK_MS + 3000 }));
  const after = tracker.snapshot('NSE:NIFTY 50:99926000')!['5m']!;
  assert.equal(after.volume, 500);
});

test('equal provider timestamps with distinct prices are both applied', () => {
  const tracker = new FormingCandleTracker();
  tracker.applyTick(quote({ ltp: 25100, providerTimestamp: TICK_MS }));
  tracker.applyTick(quote({ ltp: 25140, providerTimestamp: TICK_MS }));
  const bar = tracker.snapshot('NSE:NIFTY 50:99926000')!['5m']!;
  assert.equal(bar.high, 25140);
  assert.equal(bar.close, 25140);
});

test('invalid quotes are rejected without corrupting state', () => {
  const tracker = new FormingCandleTracker();
  assert.equal(tracker.applyTick(quote({ ltp: 0 })), false);
  assert.equal(tracker.applyTick(quote({ ltp: NaN })), false);
  assert.equal(tracker.snapshot('NSE:NIFTY 50:99926000'), null);
  assert.equal(tracker.getTelemetry().formingTicksRejected, 2);
});
