import { Candle } from '../models/candle.js';
import { IndicatorPoint } from './sma.js';

/**
 * Exponential Moving Average (EMA)
 *
 * Mathematical Formula:
 * 1. Multiplier: k = 2 / (period + 1)
 * 2. Initial Seed: EMA_period = SMA of first `period` candles
 * 3. Recursive Form: EMA_t = (Price_t * k) + (EMA_{t-1} * (1 - k))
 *
 * Warm-up requirement:
 * Requires `period` historical candles to initialize the seed value.
 * Values prior to period - 1 are omitted.
 */
export function calculateEMA(candles: Candle[], period: number): IndicatorPoint[] {
  if (period <= 0) {
    throw new Error(`EMA period must be > 0. Received: ${period}`);
  }
  if (candles.length < period) {
    return [];
  }

  const result: IndicatorPoint[] = [];
  const k = 2 / (period + 1);

  // 1. Initial SMA seed
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += candles[i].close;
  }
  let prevEMA = sum / period;

  result.push({
    time: candles[period - 1].time,
    value: Number(prevEMA.toFixed(2)),
  });

  // 2. Recursive EMA updates
  for (let i = period; i < candles.length; i++) {
    const currentClose = candles[i].close;
    const currentEMA = currentClose * k + prevEMA * (1 - k);
    result.push({
      time: candles[i].time,
      value: Number(currentEMA.toFixed(2)),
    });
    prevEMA = currentEMA;
  }

  return result;
}
