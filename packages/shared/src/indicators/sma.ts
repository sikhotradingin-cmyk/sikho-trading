import { Candle } from '../models/candle.js';

export interface IndicatorPoint {
  time: number;
  value: number;
}

/**
 * Simple Moving Average (SMA)
 *
 * Formula:
 * SMA_t = (1 / period) * Sum(P_{t-i}, i=0..period-1)
 *
 * Warm-up requirement:
 * Exactly `period` candles are required before the first valid SMA output is emitted.
 * Points prior to the warm-up threshold yield null and are omitted from the calculated output.
 */
export function calculateSMA(candles: Candle[], period: number): IndicatorPoint[] {
  if (period <= 0) {
    throw new Error(`SMA period must be > 0. Received: ${period}`);
  }
  if (candles.length < period) {
    return [];
  }

  const result: IndicatorPoint[] = [];
  let windowSum = 0;

  for (let i = 0; i < candles.length; i++) {
    windowSum += candles[i].close;

    if (i >= period) {
      windowSum -= candles[i - period].close;
    }

    if (i >= period - 1) {
      result.push({
        time: candles[i].time,
        value: Number((windowSum / period).toFixed(2)),
      });
    }
  }

  return result;
}
