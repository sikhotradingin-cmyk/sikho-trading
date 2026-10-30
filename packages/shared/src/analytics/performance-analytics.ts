import { Paise } from '../models/money.js';

export interface ClosedTradeRecord {
  id: string;
  globalInstrumentId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  realizedPnlPaise: Paise;
  chargesPaise: Paise;
  netPnlPaise: Paise;
  entryTimestamp: number;
  exitTimestamp: number;
  strategyTag?: string;
  notes?: string;
}

export interface PerformanceMetrics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  breakevenTrades: number;
  winRatePct: number;
  grossProfitINR: number;
  grossLossINR: number;
  netPnlINR: number;
  profitFactor: number | null; // null if grossLoss == 0 (undefined)
  avgWinINR: number;
  avgLossINR: number;
  expectancyINR: number;
  maxDrawdownINR: number;
  maxDrawdownPct: number;
  totalChargesINR: number;
}

export class PerformanceAnalytics {
  /**
   * Calculates trading performance edge metrics from closed trade records.
   * Clearly separates trading performance from deposits, resets, or cash adjustments.
   */
  public static calculate(trades: ClosedTradeRecord[], startingCapitalPaise: Paise = 10000000n): PerformanceMetrics {
    if (trades.length === 0) {
      return {
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        breakevenTrades: 0,
        winRatePct: 0,
        grossProfitINR: 0,
        grossLossINR: 0,
        netPnlINR: 0,
        profitFactor: null,
        avgWinINR: 0,
        avgLossINR: 0,
        expectancyINR: 0,
        maxDrawdownINR: 0,
        maxDrawdownPct: 0,
        totalChargesINR: 0,
      };
    }

    let wins = 0;
    let losses = 0;
    let breakeven = 0;

    let grossProfitPaise = 0n;
    let grossLossPaise = 0n;
    let totalChargesPaise = 0n;
    let netPnlPaise = 0n;

    let peakEquityPaise = startingCapitalPaise;
    let currentEquityPaise = startingCapitalPaise;
    let maxDrawdownPaise = 0n;

    for (const trade of trades) {
      const net = trade.netPnlPaise;
      netPnlPaise += net;
      totalChargesPaise += trade.chargesPaise;

      if (net > 0n) {
        wins++;
        grossProfitPaise += net;
      } else if (net < 0n) {
        losses++;
        grossLossPaise += -net; // positive absolute
      } else {
        breakeven++;
      }

      // Continuous equity drawdown tracking
      currentEquityPaise += net;
      if (currentEquityPaise > peakEquityPaise) {
        peakEquityPaise = currentEquityPaise;
      }
      const dd = peakEquityPaise - currentEquityPaise;
      if (dd > maxDrawdownPaise) {
        maxDrawdownPaise = dd;
      }
    }

    const total = trades.length;
    const winRatePct = Number(((wins / total) * 100).toFixed(2));
    const lossRate = losses / total;
    const winRate = wins / total;

    const grossProfitINR = Number(grossProfitPaise) / 100;
    const grossLossINR = Number(grossLossPaise) / 100;
    const netPnlINR = Number(netPnlPaise) / 100;
    const totalChargesINR = Number(totalChargesPaise) / 100;

    const avgWinINR = wins > 0 ? grossProfitINR / wins : 0;
    const avgLossINR = losses > 0 ? grossLossINR / losses : 0;

    const expectancyINR = Number((winRate * avgWinINR - lossRate * avgLossINR).toFixed(2));

    // Profit factor = gross profit / gross loss. If gross loss == 0, profit factor is mathematically undefined (null)
    const profitFactor = grossLossINR > 0 ? Number((grossProfitINR / grossLossINR).toFixed(2)) : null;

    const maxDrawdownINR = Number(maxDrawdownPaise) / 100;
    const peakINR = Number(peakEquityPaise) / 100;
    const maxDrawdownPct = peakINR > 0 ? Number(((maxDrawdownINR / peakINR) * 100).toFixed(2)) : 0;

    return {
      totalTrades: total,
      winningTrades: wins,
      losingTrades: losses,
      breakevenTrades: breakeven,
      winRatePct,
      grossProfitINR,
      grossLossINR,
      netPnlINR,
      profitFactor,
      avgWinINR: Number(avgWinINR.toFixed(2)),
      avgLossINR: Number(avgLossINR.toFixed(2)),
      expectancyINR,
      maxDrawdownINR,
      maxDrawdownPct,
      totalChargesINR,
    };
  }

  /**
   * Generates a CSV string representation of closed trades.
   * Labeled strictly as a simulated performance log, NEVER a tax statement.
   */
  public static exportToCSV(trades: ClosedTradeRecord[]): string {
    const headers = [
      'Trade ID',
      'Instrument',
      'Side',
      'Quantity',
      'Entry Price (INR)',
      'Exit Price (INR)',
      'Realized P&L (INR)',
      'Estimated Charges (INR)',
      'Net P&L (INR)',
      'Entry Time (UTC)',
      'Exit Time (UTC)',
      'Strategy Tag',
      'Notes',
    ];

    const rows = trades.map((t) => [
      t.id,
      t.symbol,
      t.side,
      t.quantity,
      t.entryPrice.toFixed(2),
      t.exitPrice.toFixed(2),
      (Number(t.realizedPnlPaise) / 100).toFixed(2),
      (Number(t.chargesPaise) / 100).toFixed(2),
      (Number(t.netPnlPaise) / 100).toFixed(2),
      new Date(t.entryTimestamp).toISOString(),
      new Date(t.exitTimestamp).toISOString(),
      `"${t.strategyTag || 'Untagged'}"`,
      `"${(t.notes || '').replace(/"/g, '""')}"`,
    ]);

    const banner = '# SIMULATED PAPER-TRADING EDUCATIONAL PERFORMANCE EXPORT (NOT AN OFFICIAL BROKERAGE DOCUMENT)\n';
    return banner + [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  }
}
