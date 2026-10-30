import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTradingStore } from './tradingStore.js';
import { QuoteSnapshot } from '@trading/shared';

describe('Mobile TradingStore & State Flow', () => {
  test('initializes with dark theme defaults and DEMO label', () => {
    const state = useTradingStore.getState();
    assert.equal(state.selectedTimeframe, '5m');
    assert.equal(state.feedHealth?.uiBannerLabel, 'DEMO DATA — NOT LIVE MARKET');
  });

  test('updates quote and latest price on incoming market tick', () => {
    const tick: QuoteSnapshot = {
      globalId: 'NFO:NIFTY26OCTFUT:999001',
      token: '999001',
      ltp: 24560.50,
      open: 24500.0,
      high: 24570.0,
      low: 24490.0,
      close: 24560.50,
      bidPrice: 24560.45,
      askPrice: 24560.55,
      providerTimestamp: Date.now(),
      receiveTimestamp: Date.now(),
      source: 'DEMO',
      isSimulated: true,
    };

    useTradingStore.getState().handleIncomingTick(tick);

    const updated = useTradingStore.getState().quotes[tick.globalId];
    assert.ok(updated);
    assert.equal(updated.ltp, 24560.50);
  });

  test('persists drawings per instrument globally', () => {
    const drawing = { type: 'HLINE', price: 24500.0 };
    useTradingStore.getState().addDrawing('NFO:NIFTY26OCTFUT:999001', drawing);

    const saved = useTradingStore.getState().savedDrawings['NFO:NIFTY26OCTFUT:999001'];
    assert.ok(saved);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].price, 24500.0);
  });
});
