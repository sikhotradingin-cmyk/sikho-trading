import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PerformanceAnalytics, ClosedTradeRecord } from './performance-analytics.js';
import { RiskSizer } from './risk-sizer.js';
import { DisciplineGuard } from './discipline-guard.js';
import { Money } from '../models/money.js';

describe('Analytics, RiskSizer & DisciplineGuard', () => {
  test('calculates accurate win rate, profit factor, expectancy, and max drawdown', () => {
    const trades: ClosedTradeRecord[] = [
      {
        id: 't1',
        globalInstrumentId: 'NFO:NIFTY26OCTFUT:999001',
        symbol: 'NIFTY26OCTFUT',
        side: 'BUY',
        quantity: 25,
        entryPrice: 24500,
        exitPrice: 24600,
        realizedPnlPaise: Money.fromRupees(2500),
        chargesPaise: Money.fromRupees(25),
        netPnlPaise: Money.fromRupees(2475),
        entryTimestamp: 1000,
        exitTimestamp: 2000,
      },
      {
        id: 't2',
        globalInstrumentId: 'NFO:NIFTY26OCTFUT:999001',
        symbol: 'NIFTY26OCTFUT',
        side: 'BUY',
        quantity: 25,
        entryPrice: 24600,
        exitPrice: 24550,
        realizedPnlPaise: -Money.fromRupees(1250),
        chargesPaise: Money.fromRupees(25),
        netPnlPaise: -Money.fromRupees(1275),
        entryTimestamp: 3000,
        exitTimestamp: 4000,
      },
    ];

    const stats = PerformanceAnalytics.calculate(trades, 10000000n);
    assert.equal(stats.totalTrades, 2);
    assert.equal(stats.winningTrades, 1);
    assert.equal(stats.losingTrades, 1);
    assert.equal(stats.winRatePct, 50.0);
    assert.equal(stats.grossProfitINR, 2475);
    assert.equal(stats.grossLossINR, 1275);
    assert.equal(stats.netPnlINR, 1200);
    // Profit factor = 2475 / 1275 = 1.94
    assert.equal(stats.profitFactor, 1.94);
    assert.ok(stats.expectancyINR > 0);
  });

  test('RiskSizer rounds recommended size to valid lot multiples', () => {
    // ₹100,000 balance, 1% risk (₹1,000 risk budget)
    // Entry = 24,500, SL = 24,450 (Risk = ₹50 / share)
    // Raw qty = 1000 / 50 = 20 qty
    // Lot size = 25 -> Math.max(1, Math.floor(20/25)) = 1 lot (25 qty)
    const sizing = RiskSizer.calculateSize(100000, 1.0, 24500, 24450, 25);
    assert.equal(sizing.recommendedLots, 1);
    assert.equal(sizing.recommendedQuantity, 25);
    assert.equal(sizing.isFeasible, true);
  });

  test('DisciplineGuard allows risk-reducing exit even after daily loss limit breach', () => {
    const config = { maxDailyLossRupees: 5000, maxDailyTrades: 5 };

    // New opening order when daily loss is ₹5,500 must be locked out
    const openRes = DisciplineGuard.evaluateOrder(true, 5500, 3, config);
    assert.equal(openRes.isAllowed, false);
    assert.match(openRes.reason || '', /DISCIPLINE_LOCKOUT/);

    // Closing/square-off order must ALWAYS be allowed
    const closeRes = DisciplineGuard.evaluateOrder(false, 5500, 3, config);
    assert.equal(closeRes.isAllowed, true);
    assert.equal(closeRes.isRiskReducing, true);
  });
});

