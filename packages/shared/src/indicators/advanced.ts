import { Candle } from '../models/candle.js';
import { IndicatorPoint } from './sma.js';

export interface BollingerBandPoint {
  time: number;
  upper: number;
  middle: number;
  lower: number;
}

export interface MACDPoint {
  time: number;
  macd: number;
  signal: number;
  histogram: number;
}

/**
 * Bollinger Bands (BB)
 * Computes basis SMA(period) and population standard deviation * stdDevMultiplier.
 */
export function calculateBollingerBands(
  candles: Candle[],
  period: number = 20,
  stdDevMultiplier: number = 2
): BollingerBandPoint[] {
  if (period <= 0 || candles.length < period) return [];
  const result: BollingerBandPoint[] = [];

  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += candles[j].close;
    }
    const mean = sum / period;
    let sqDiffSum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const diff = candles[j].close - mean;
      sqDiffSum += diff * diff;
    }
    const stdDev = Math.sqrt(sqDiffSum / period);
    result.push({
      time: candles[i].time,
      upper: Number((mean + stdDevMultiplier * stdDev).toFixed(2)),
      middle: Number(mean.toFixed(2)),
      lower: Number((mean - stdDevMultiplier * stdDev).toFixed(2)),
    });
  }
  return result;
}

/**
 * Moving Average Convergence Divergence (MACD 12, 26, 9)
 */
export function calculateMACD(
  candles: Candle[],
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9
): MACDPoint[] {
  if (fastPeriod <= 0 || slowPeriod <= fastPeriod || signalPeriod <= 0) return [];
  if (candles.length < slowPeriod + signalPeriod - 1) return [];

  const kFast = 2 / (fastPeriod + 1);
  const kSlow = 2 / (slowPeriod + 1);
  const kSig = 2 / (signalPeriod + 1);

  let fastSum = 0;
  for (let i = 0; i < fastPeriod; i++) fastSum += candles[i].close;
  let fastEma = fastSum / fastPeriod;

  const fastEmaByIdx = new Array<number>(candles.length).fill(0);
  fastEmaByIdx[fastPeriod - 1] = fastEma;
  for (let i = fastPeriod; i < candles.length; i++) {
    fastEma = candles[i].close * kFast + fastEma * (1 - kFast);
    fastEmaByIdx[i] = fastEma;
  }

  let slowSum = 0;
  for (let i = 0; i < slowPeriod; i++) slowSum += candles[i].close;
  let slowEma = slowSum / slowPeriod;

  const macdSeries: { time: number; macd: number }[] = [];
  for (let i = slowPeriod - 1; i < candles.length; i++) {
    if (i >= slowPeriod) {
      slowEma = candles[i].close * kSlow + slowEma * (1 - kSlow);
    }
    macdSeries.push({
      time: candles[i].time,
      macd: fastEmaByIdx[i] - slowEma,
    });
  }

  if (macdSeries.length < signalPeriod) return [];

  let sigSum = 0;
  for (let i = 0; i < signalPeriod; i++) sigSum += macdSeries[i].macd;
  let sigEma = sigSum / signalPeriod;

  const result: MACDPoint[] = [];
  for (let i = signalPeriod - 1; i < macdSeries.length; i++) {
    if (i >= signalPeriod) {
      sigEma = macdSeries[i].macd * kSig + sigEma * (1 - kSig);
    }
    const m = macdSeries[i].macd;
    const h = m - sigEma;
    result.push({
      time: macdSeries[i].time,
      macd: Number(m.toFixed(2)),
      signal: Number(sigEma.toFixed(2)),
      histogram: Number(h.toFixed(2)),
    });
  }

  return result;
}

/**
 * Average True Range (ATR) using Wilder's smoothing.
 */
export function calculateATR(candles: Candle[], period: number = 14): IndicatorPoint[] {
  if (period <= 0 || candles.length < period + 1) return [];

  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const cur = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prevClose),
      Math.abs(cur.low - prevClose)
    );
    trs.push(tr);
  }

  let atr = 0;
  for (let i = 0; i < period; i++) atr += trs[i];
  atr /= period;

  const result: IndicatorPoint[] = [
    { time: candles[period].time, value: Number(atr.toFixed(2)) },
  ];

  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    result.push({
      time: candles[i + 1].time,
      value: Number(atr.toFixed(2)),
    });
  }

  return result;
}

/**
 * Intraday Session VWAP (Volume-Weighted Average Price).
 * Resets at the start of each IST trading day.
 * Returns [] if candles have no positive traded volume (e.g. Spot Indices).
 */
export function calculateVWAP(candles: Candle[]): IndicatorPoint[] {
  const hasRealVolume = candles.some((c) => (c.volume || 0) > 0);
  if (!hasRealVolume) return [];

  const result: IndicatorPoint[] = [];
  let currentSessionDate = '';
  let cumPV = 0;
  let cumVol = 0;

  for (const c of candles) {
    const vol = c.volume || 0;
    if (vol <= 0) continue;

    // Determine IST calendar date (UTC + 5h30m)
    const istDate = new Date((c.time + 19800) * 1000).toISOString().slice(0, 10);
    if (istDate !== currentSessionDate) {
      currentSessionDate = istDate;
      cumPV = 0;
      cumVol = 0;
    }

    const typicalPrice = (c.high + c.low + c.close) / 3;
    cumPV += typicalPrice * vol;
    cumVol += vol;

    if (cumVol > 0) {
      result.push({
        time: c.time,
        value: Number((cumPV / cumVol).toFixed(2)),
      });
    }
  }

  return result;
}

