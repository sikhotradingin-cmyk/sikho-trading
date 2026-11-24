import test from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from './server.js';
import { UpstoxAdapter } from './providers/upstox-adapter.js';

test('Post-Execution TP/SL Editing, Profit-Protecting Stops, Partial Exit OCO Sync, Race Safety & User Isolation', async (t) => {
  const { app, provider, simEngine, repo } = await buildServer(undefined, 'DEMO');
  t.after(async () => {
    await app.close();
  });

  // Authenticate User A and User B
  const loginA = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/dev-login',
    payload: { userId: 'trader-tpsl-a', name: 'Trader A', tier: 'PRO' },
  });
  assert.equal(loginA.statusCode, 200);
  const { token: tokenA, account: accountA } = loginA.json();

  const loginB = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/dev-login',
    payload: { userId: 'trader-tpsl-b', name: 'Trader B', tier: 'PRO' },
  });
  assert.equal(loginB.statusCode, 200);
  const { token: tokenB } = loginB.json();

  // Resolve a tradable futures contract from the active provider
  const allInstruments = await provider.getInstruments();
  const futInst = allInstruments.find((i: any) => i.instrumentType === 'FUTIDX' && i.lotSize > 0);
  assert.ok(futInst, 'Expected a tradable FUTIDX contract');
  const gid = futInst.globalId;
  const lot = futInst.lotSize;

  // Ensure account A has plenty of capital for multi-lot futures testing
  await repo.resetAccount(accountA.id, [], new Map(), 2500000, 'PRO');

  const tick = futInst.tickSize || 0.05;
  const align = (p: number) => Number((Math.round(p / tick) * tick).toFixed(2));
  if ((provider as any).timer) {
    clearInterval((provider as any).timer);
    (provider as any).timer = null;
  }
  const baseLtp = 25000.0;
  const initialQuote = {
    globalId: gid,
    token: futInst.token,
    ltp: baseLtp,
    open: 24950,
    high: 25050,
    low: 24920,
    close: 24940,
    bidPrice: align(baseLtp - tick),
    askPrice: align(baseLtp + tick),
    providerTimestamp: Date.now(),
    receiveTimestamp: Date.now(),
    source: 'DEMO' as const,
    isSimulated: true,
  };
  (provider as any).quotes?.set(gid, initialQuote);

  // 1. Place market LONG entry of 2 lots WITHOUT initial TP/SL
  const entryRes = await app.inject({
    method: 'POST',
    url: '/api/v1/orders/place',
    headers: { authorization: `Bearer ${tokenA}` },
    payload: {
      globalInstrumentId: gid,
      side: 'BUY',
      orderType: 'MARKET',
      productType: 'MARGIN',
      quantity: lot * 2,
      idempotencyKey: 'entry-long-no-prot-1',
    },
  });
  assert.equal(entryRes.statusCode, 200);
  const posId = entryRes.json().position.id;
  assert.equal(entryRes.json().position.quantity, lot * 2);
  assert.equal(entryRes.json().position.stopLossPrice, undefined);
  assert.equal(entryRes.json().position.targetPrice, undefined);

  // 2. Add TP and SL after execution
  const tp1 = align(baseLtp + 100);
  const sl1 = align(baseLtp - 60);
  const addProtRes = await app.inject({
    method: 'PUT',
    url: `/api/v1/positions/${posId}/protection`,
    headers: { authorization: `Bearer ${tokenA}` },
    payload: {
      targetPrice: tp1,
      stopLossPrice: sl1,
      expectedVersion: 1,
      idempotencyKey: 'prot-add-both-1',
      source: 'MANUAL_EDIT',
    },
  });
  assert.equal(addProtRes.statusCode, 200, JSON.stringify(addProtRes.json()));
  const addProtBody = addProtRes.json();
  assert.equal(addProtBody.success, true);
  assert.equal(addProtBody.position.targetPrice, tp1);
  assert.equal(addProtBody.position.stopLossPrice, sl1);
  assert.equal(addProtBody.position.protectionVersion, 2);
  assert.equal(addProtBody.attachedOrders.length, 2);

  // 3. Idempotent retry with same key returns same result and does not duplicate orders or bump version
  const retrySameKey = await app.inject({
    method: 'PUT',
    url: `/api/v1/positions/${posId}/protection`,
    headers: { authorization: `Bearer ${tokenA}` },
    payload: {
      targetPrice: tp1,
      stopLossPrice: sl1,
      expectedVersion: 1,
      idempotencyKey: 'prot-add-both-1',
      source: 'MANUAL_EDIT',
    },
  });
  assert.equal(retrySameKey.statusCode, 200);
  assert.equal(retrySameKey.json().position.protectionVersion, 2);

  // Verify timeout idempotency lookup endpoint
  const lookupRes = await app.inject({
    method: 'GET',
    url: '/api/v1/positions/protection-by-idempotency/prot-add-both-1',
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(lookupRes.statusCode, 200);
  assert.equal(lookupRes.json().found, true);
  assert.equal(lookupRes.json().currentPosition.targetPrice, tp1);

  // 4. Modify TP only via CHART_DRAG while preserving existing SL
  const tp2 = align(baseLtp + 140);
  const dragTpRes = await app.inject({
    method: 'PUT',
    url: `/api/v1/positions/${posId}/protection`,
    headers: { authorization: `Bearer ${tokenA}` },
    payload: {
      targetPrice: tp2,
      expectedVersion: 2,
      idempotencyKey: 'prot-drag-tp-2',
      source: 'CHART_DRAG',
    },
  });
  assert.equal(dragTpRes.statusCode, 200);
  assert.equal(dragTpRes.json().position.targetPrice, tp2);
  assert.equal(dragTpRes.json().position.stopLossPrice, sl1, 'SL must remain preserved when only TP is modified');
  assert.equal(dragTpRes.json().position.protectionVersion, 3);

  // 5. Reject stale expectedVersion (optimistic concurrency control)
  const conflictRes = await app.inject({
    method: 'PUT',
    url: `/api/v1/positions/${posId}/protection`,
    headers: { authorization: `Bearer ${tokenA}` },
    payload: {
      targetPrice: align(baseLtp + 160),
      expectedVersion: 1, // stale version
      idempotencyKey: 'prot-stale-ver-1',
    },
  });
  assert.equal(conflictRes.statusCode, 409);
  assert.equal(conflictRes.json().code, 'ERR_PROTECTION_VERSION_CONFLICT');

  // 6. Reject off-tick price and already-crossed TP/SL levels
  const offTickRes = await app.inject({
    method: 'PUT',
    url: `/api/v1/positions/${posId}/protection`,
    headers: { authorization: `Bearer ${tokenA}` },
    payload: {
      targetPrice: Number((baseLtp + 50 + tick * 0.3).toFixed(3)),
      idempotencyKey: 'prot-off-tick-1',
    },
  });
  assert.equal(offTickRes.statusCode, 400);
  assert.equal(offTickRes.json().code, 'ERR_OFF_TICK_PRICE');

  const crossedSlRes = await app.inject({
    method: 'PUT',
    url: `/api/v1/positions/${posId}/protection`,
    headers: { authorization: `Bearer ${tokenA}` },
    payload: {
      stopLossPrice: align(baseLtp + 50), // above current LTP for a LONG position -> already crossed
      idempotencyKey: 'prot-crossed-sl-1',
    },
  });
  assert.equal(crossedSlRes.statusCode, 400);
  assert.equal(crossedSlRes.json().code, 'ERR_PROTECTION_ALREADY_CROSSED');

  // 7. Profit-protecting Stop Loss moved ABOVE entry price for a LONG position when market price advances
  const higherLtp = align(baseLtp + 90);
  (provider as any).quotes?.set(gid, {
    ...initialQuote,
    ltp: higherLtp,
    bidPrice: align(higherLtp - tick),
    askPrice: align(higherLtp + tick),
    providerTimestamp: Date.now(),
    receiveTimestamp: Date.now(),
    isSimulated: true,
  });
  const profitLockSl = align(baseLtp + 45); // Above entry (~baseLtp), below current LTP (baseLtp + 90)
  const profitSlRes = await app.inject({
    method: 'PUT',
    url: `/api/v1/positions/${posId}/protection`,
    headers: { authorization: `Bearer ${tokenA}` },
    payload: {
      stopLossPrice: profitLockSl,
      idempotencyKey: 'prot-profit-lock-sl-1',
      source: 'CHART_DRAG',
    },
  });
  assert.equal(profitSlRes.statusCode, 200, 'Stop Loss above entry for LONG must be allowed when below current LTP');
  assert.equal(profitSlRes.json().position.stopLossPrice, profitLockSl);

  // 8. User B must never be able to read or modify User A's position protection
  const crossUserEdit = await app.inject({
    method: 'PUT',
    url: `/api/v1/positions/${posId}/protection`,
    headers: { authorization: `Bearer ${tokenB}` },
    payload: {
      targetPrice: align(higherLtp + 100),
      idempotencyKey: 'prot-cross-user-attack',
    },
  });
  assert.equal(crossUserEdit.statusCode, 404);
  assert.equal(crossUserEdit.json().code, 'ERR_POSITION_NOT_FOUND');

  const crossUserAudit = await app.inject({
    method: 'GET',
    url: `/api/v1/positions/${posId}/protection-audit`,
    headers: { authorization: `Bearer ${tokenB}` },
  });
  assert.equal(crossUserAudit.statusCode, 404);

  // 9. Explicit remove of TP keeps SL intact
  const removeTpRes = await app.inject({
    method: 'PUT',
    url: `/api/v1/positions/${posId}/protection`,
    headers: { authorization: `Bearer ${tokenA}` },
    payload: {
      removeTarget: true,
      targetPrice: null,
      idempotencyKey: 'prot-remove-tp-explicit',
    },
  });
  assert.equal(removeTpRes.statusCode, 200);
  assert.equal(removeTpRes.json().position.targetPrice, undefined);
  assert.equal(removeTpRes.json().position.stopLossPrice, profitLockSl);

  // Re-add TP so both OCO siblings exist before partial exit
  const reAddTpRes = await app.inject({
    method: 'PUT',
    url: `/api/v1/positions/${posId}/protection`,
    headers: { authorization: `Bearer ${tokenA}` },
    payload: {
      targetPrice: tp2,
      idempotencyKey: 'prot-readd-tp',
    },
  });
  assert.equal(reAddTpRes.statusCode, 200);

  // 10. Partial exit (reduce LONG 2 lots -> 1 lot) syncs remaining protective order quantities to 1 lot
  const partialExitRes = await app.inject({
    method: 'POST',
    url: '/api/v1/orders/place',
    headers: { authorization: `Bearer ${tokenA}` },
    payload: {
      globalInstrumentId: gid,
      side: 'SELL',
      orderType: 'MARKET',
      productType: 'MARGIN',
      quantity: lot,
      idempotencyKey: 'partial-exit-1-lot',
    },
  });
  assert.equal(partialExitRes.statusCode, 200);
  assert.equal(partialExitRes.json().position.quantity, lot);

  const pendingOrdersAfterPartial = (await repo.getOrders(accountA.id)).filter(
    (o) => o.status === 'PENDING' && o.globalInstrumentId === gid
  );
  assert.equal(pendingOrdersAfterPartial.length, 2);
  for (const po of pendingOrdersAfterPartial) {
    assert.equal(po.quantity, lot, 'Protective SL/TP orders must sync to remaining position quantity after partial exit');
  }

  // 11. Triggering market tick hits profit-protecting SL -> closes remaining 1 lot once and cancels OCO TP sibling atomically
  const triggerResults = await simEngine.onMarketTick({
    globalId: gid,
    token: futInst.token,
    ltp: align(profitLockSl - 5),
    open: baseLtp,
    high: higherLtp,
    low: align(profitLockSl - 5),
    close: baseLtp,
    providerTimestamp: Date.now(),
    receiveTimestamp: Date.now(),
    source: 'DEMO',
    isSimulated: true,
  });
  assert.equal(triggerResults.length, 1);
  assert.equal(triggerResults[0].position?.quantity, 0, 'Position must close completely to 0 without flipping short');

  const remainingPending = (await repo.getOrders(accountA.id)).filter(
    (o) => (o.status === 'PENDING' || o.status === 'TRIGGERED') && o.globalInstrumentId === gid
  );
  assert.equal(remainingPending.length, 0, 'OCO sibling must be atomically cancelled when SL triggers');

  // 12. Attempting to modify protection after position closed returns 409 ERR_POSITION_CLOSED
  const editClosedRes = await app.inject({
    method: 'PUT',
    url: `/api/v1/positions/${posId}/protection`,
    headers: { authorization: `Bearer ${tokenA}` },
    payload: {
      targetPrice: align(baseLtp + 200),
      idempotencyKey: 'prot-after-close',
    },
  });
  assert.equal(editClosedRes.statusCode, 409);
  assert.equal(editClosedRes.json().code, 'ERR_POSITION_CLOSED');

  // 13. Verify protection audit trail recorded every confirmed change
  const auditRes = await app.inject({
    method: 'GET',
    url: `/api/v1/positions/${posId}/protection-audit`,
    headers: { authorization: `Bearer ${tokenA}` },
  });
  assert.equal(auditRes.statusCode, 200);
  assert.ok(auditRes.json().audits.length >= 4);
});

test('Recurring Chart Outage Fixes: 3m/1D Timeframes, 09:15 Forming-Bar Merge, and Upstox Last-Good Candle Fallback Cache', async (t) => {
  const { app } = await buildServer(undefined, 'DEMO');
  t.after(async () => {
    await app.close();
  });

  // 1. Verify all UI timeframes (1m, 3m, 5m, 15m, 30m, 1h, 1D, 1d) succeed on /api/v1/market-data/candles
  for (const tf of ['1m', '3m', '5m', '15m', '30m', '1h', '1D', '1d']) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/market-data/candles?globalId=${encodeURIComponent('NSE:NIFTY 50:99926000')}&timeframe=${tf}&limit=50`,
    });
    assert.equal(res.statusCode, 200, `Timeframe ${tf} must return HTTP 200 on /api/v1/market-data/candles`);
    const body = res.json();
    assert.ok(Array.isArray(body.candles) && body.candles.length > 0, `Timeframe ${tf} must return valid candles`);
    assert.ok(body.diagnostics && body.diagnostics.requestId, 'Sanitized diagnostics must be attached');
  }

  // 2. Verify UpstoxAdapter last-good candle cache serves staleFallback during transient HTTP 429/5xx without cross-instrument contamination
  const upstox = new UpstoxAdapter({ analyticsToken: 'test-only-synthetic-placeholder' });
  await upstox.init();
  t.after(async () => {
    await upstox.dispose();
  });

  const niftyKey = 'NSE:NIFTY 50:99926000';
  const sensexKey = 'BSE:SENSEX:99919000';
  let shouldFailUpstream = false;

  (upstox as any).fetchUpstoxIntraday = async () => {
    if (shouldFailUpstream) throw new Error('Upstox intraday HTTP 429');
    return {
      candles: [
        { time: 1700020500, open: 25100, high: 25130, low: 25090, close: 25120, volume: 0 },
        { time: 1700020800, open: 25120, high: 25150, low: 25110, close: 25145, volume: 0 },
      ],
    };
  };
  (upstox as any).fetchUpstoxHistoricalChunk = async () => {
    if (shouldFailUpstream) throw new Error('Upstox history HTTP 429');
    return [
      { time: 1699934100, open: 24950, high: 25020, low: 24930, close: 25010, volume: 0 },
    ];
  };

  // Initial load succeeds and populates NIFTY 5m cache
  const initialPage = await upstox.getCandlesPaginated(niftyKey, '5m', { limit: 200 });
  assert.equal(initialPage.candles.length, 3);
  assert.equal(initialPage.providerError, null);
  assert.equal(initialPage.prevSessionClose, 25010);

  // Simulate transient 5-10 min Upstox HTTP 429 outage at 09:15 / noon / 15:30
  shouldFailUpstream = true;
  const fallbackPage = await upstox.getCandlesPaginated(niftyKey, '5m', { limit: 200 });
  assert.equal(fallbackPage.candles.length, 3, 'NIFTY must retain its last-known-good candles during transient 429');
  assert.equal((fallbackPage as any).staleFallback, true);
  assert.match(String(fallbackPage.providerError), /429/);

  // SENSEX (which has not been loaded yet) must NOT receive NIFTY's cached candles
  const sensexPage = await upstox.getCandlesPaginated(sensexKey, '5m', { limit: 200 });
  assert.equal(sensexPage.candles.length, 0, 'Uncached instrument must never display another instrument candles');
});
