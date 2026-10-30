import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { calculateSMA } from './sma.js';
import { calculateEMA } from './ema.js';
import { calculateRSI } from './rsi.js';
import { Candle } from '../models/candle.js';

describe('Technical Indicators & Warm-up Verification', () => {
  // 5 simple test candles
  const candles: Candle[] = [
    { time: 1000, open: 10, high: 12, low: 9, close: 10 },
    { time: 1060, open: 10, high: 14, low: 10, close: 12 },
    { time: 1120, open: 12, high: 15, low: 11, close: 14 },
    { time: 1180, open: 14, high: 16, low: 13, close: 16 },
    { time: 1240, open: 16, high: 20, low: 15, close: 18 },
  ];

  test('SMA respects warm-up window and computes exact mean', () => {
    // Period = 3.
    // Candles: 10, 12, 14 -> mean = 12.0
    // Next: 12, 14, 16 -> mean = 14.0
    // Next: 14, 16, 18 -> mean = 16.0
    const sma = calculateSMA(candles, 3);
    assert.equal(sma.length, 3);
    assert.equal(sma[0].time, 1120);
    assert.equal(sma[0].value, 12.0);
    assert.equal(sma[1].value, 14.0);
    assert.equal(sma[2].value, 16.0);
  });

  test('SMA returns empty if candle count is less than period', () => {
    assert.deepEqual(calculateSMA(candles, 10), []);
  });

  test('EMA initializes with SMA seed and applies smoothing multiplier', () => {
    // Period = 3, k = 2 / (3 + 1) = 0.5
    // Seed at idx 2: (10 + 12 + 14) / 3 = 12.0
    // At idx 3 (close 16): 16 * 0.5 + 12.0 * 0.5 = 14.0
    // At idx 4 (close 18): 18 * 0.5 + 14.0 * 0.5 = 16.0
    const ema = calculateEMA(candles, 3);
    assert.equal(ema.length, 3);
    assert.equal(ema[0].value, 12.0);
    assert.equal(ema[1].value, 14.0);
    assert.equal(ema[2].value, 16.0);
  });

  test('RSI requires period + 1 candles for warm-up and computes Wilder smoothing', () => {
    // 15 candles for period = 14
    const rsiCandles: Candle[] = [];
    for (let i = 0; i <= 15; i++) {
      rsiCandles.push({
        time: 1000 + i * 60,
        open: 100 + i,
        high: 105 + i,
        low: 95 + i,
        close: 100 + i * 2, // monotonically increasing -> only gains, 0 loss
      });
    }

    const rsi = calculateRSI(rsiCandles, 14);
    assert.equal(rsi.length, 2);
    // All gains -> RSI should be 100
    assert.equal(rsi[0].value, 100.0);
    assert.equal(rsi[1].value, 100.0);
  });
});
