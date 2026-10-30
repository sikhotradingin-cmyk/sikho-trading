import { Candle } from '../models/candle.js';
import { IndicatorPoint } from './sma.js';

/**
 * Relative Strength Index (RSI) using J. Welles Wilder's original smoothed moving average.
 *
 * Mathematical Formula:
 * 1. Change: delta = Close_t - Close_{t-1}
 * 2. Gain = max(delta, 0), Loss = max(-delta, 0)
 * 3. Seed Average Gain / Loss: Simple arithmetic mean over first `period` changes.
 * 4. Smoothed Average:
 *    AvgGain_t = (AvgGain_{t-1} * (period - 1) + Gain_t) / period
 *    AvgLoss_t = (AvgLoss_{t-1} * (period - 1) + Loss_t) / period
 * 5. Relative Strength (RS): AvgGain_t / AvgLoss_t
 * 6. RSI:
 *    If AvgLoss == 0: RSI = 100
 *    Otherwise: RSI = 100 - (100 / (1 + RS))
 *
 * Warm-up requirement:
 * Exactly `period + 1` candles (yielding `period` price deltas) are required before
 * the first valid RSI point is emitted.
 */
export function calculateRSI(candles: Candle[], period: number = 14): IndicatorPoint[] {
  if (period <= 0) {
    throw new Error(`RSI period must be > 0. Received: ${period}`);
  }
  if (candles.length <= period) {
    return [];
  }

  const result: IndicatorPoint[] = [];

  let sumGain = 0;
  let sumLoss = 0;

  // 1. Initial seed over first `period` changes
  for (let i = 1; i <= period; i++) {
    const delta = candles[i].close - candles[i - 1].close;
    if (delta >= 0) {
      sumGain += delta;
    } else {
      sumLoss += Math.abs(delta);
    }
  }

  let avgGain = sumGain / period;
  let avgLoss = sumLoss / period;

  const firstRS = avgLoss === 0 ? 100 : avgGain / avgLoss;
  const firstRSI = avgLoss === 0 ? 100 : 100 - 100 / (1 + firstRS);

  result.push({
    time: candles[period].time,
    value: Number(firstRSI.toFixed(2)),
  });

  // 2. Wilder's smoothed RSI for remaining candles
  for (let i = period + 1; i < candles.length; i++) {
    const delta = candles[i].close - candles[i - 1].close;
    const gain = delta >= 0 ? delta : 0;
    const loss = delta < 0 ? Math.abs(delta) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    let rsi: number;
    if (avgLoss === 0) {
      rsi = 100;
    } else {
      const rs = avgGain / avgLoss;
      rsi = 100 - 100 / (1 + rs);
    }

    result.push({
      time: candles[i].time,
      value: Number(rsi.toFixed(2)),
    });
  }

  return result;
}
