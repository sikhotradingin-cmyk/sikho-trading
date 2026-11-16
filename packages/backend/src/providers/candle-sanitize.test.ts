import test from 'node:test';
import assert from 'node:assert/strict';
import { Candle } from '@trading/shared';
import { sanitizeCandleSeries } from './upstox-adapter.js';

function candle(time: number, close: number, open = close, high = close, low = close): Candle {
  return { time, open, high, low, close, volume: 0 };
}

test('removes pre-listing placeholder bars that compress the chart scale', () => {
  // Real-world case: NIFTY23NOV26FUT daily history contained 75 rows at 12.45 before the
  // contract traded near 25,000. One such row forced a 0-based price axis.
  const series = [
    candle(1761676200, 12.45),
    candle(1761762600, 12.45),
    candle(1761849000, 12.45),
    candle(1794000000, 25000),
    candle(1794100000, 25100),
    candle(1794508200, 25296.1),
  ];
  const cleaned = sanitizeCandleSeries(series);
  assert.equal(cleaned.length, 3);
  assert.deepEqual(
    cleaned.map((c) => c.close),
    [25000, 25100, 25296.1]
  );
});

test('keeps legitimate moves within an order of magnitude', () => {
  const series = [
    candle(1, 20000),
    candle(2, 23500),
    candle(3, 20500),
    candle(4, 25000),
  ];
  assert.equal(sanitizeCandleSeries(series).length, 4);
});

test('drops structurally invalid rows (zero/negative/NaN and high<low)', () => {
  const series = [
    candle(1, 25000),
    { ...candle(2, 0), close: 0 },
    candle(3, -5),
    { time: 4, open: 25000, high: 24000, low: 25000, close: 25000 } as Candle,
    candle(5, Number.NaN),
    candle(6, 25100),
  ];
  const cleaned = sanitizeCandleSeries(series);
  assert.deepEqual(
    cleaned.map((c) => c.time),
    [1, 6]
  );
});

test('empty input and all-invalid input never crash the chart pipeline', () => {
  assert.deepEqual(sanitizeCandleSeries([]), []);
  assert.deepEqual(sanitizeCandleSeries([candle(1, 0)]), []);
});
