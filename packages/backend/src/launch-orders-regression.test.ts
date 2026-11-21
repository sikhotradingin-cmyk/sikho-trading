import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { buildServer } from './server.js';
import { EmulatedPostgresDatabase } from './db/database.js';
import { PostgresRepository } from './db/postgres-repository.js';
import { SimulationEngine } from './engine/simulation-engine.js';
import { InstrumentMetadata, Money, OrderValidator, QuoteSnapshot } from '@trading/shared';

const makeInst = (overrides: Partial<InstrumentMetadata> = {}): InstrumentMetadata => ({
  globalId: 'NFO:NIFTY_TEST_FUT',
  exchange: 'NFO',
  symbol: 'NIFTY_TEST_FUT',
  name: 'NIFTY Test Futures',
  instrumentType: 'FUTIDX',
  token: '99999',
  lotSize: 25,
  tickSize: 0.05,
  marginMultiplier: 0.12,
  isTradable: true,
  isSimulatedFixture: true,
  provider: 'DEMO',
  ...overrides,
});

const makeQuote = (globalId: string, ltp: number, overrides: Partial<QuoteSnapshot> = {}): QuoteSnapshot => {
  const now = Date.now();
  return {
    globalId,
    token: '99999',
    ltp,
    open: ltp,
    high: ltp,
    low: ltp,
    close: ltp,
    bidPrice: ltp,
    askPrice: ltp,
    providerTimestamp: now,
    receiveTimestamp: now,
    source: 'DEMO',
    isSimulated: true,
    ...overrides,
  };
};

test('Priority 1: FREE_LAUNCH remains unlocked during transient billing DB errors without faking PRO', async () => {
  const prevMode = process.env.SIKHO_ACCESS_MODE;
  process.env.SIKHO_ACCESS_MODE = 'FREE_LAUNCH';
  const built = await buildServer(new EmulatedPostgresDatabase(), 'DEMO');
  await built.app.ready();
  try {
    const reg = await built.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { name: 'Free Launch User', email: 'fl-resilience@example.test', password: 'password123' },
    });
    assert.equal(reg.statusCode, 200);
    const { token } = reg.json();
    const headers = { authorization: `Bearer ${token}` };

    // Simulate transient DB outage in billingService
    const origResolve = built.billingService.resolveEntitlement.bind(built.billingService);
    const origTier = built.billingService.getAccountTier.bind(built.billingService);
    built.billingService.resolveEntitlement = async () => { throw new Error('Simulated Postgres timeout'); };
    built.billingService.getAccountTier = async () => { throw new Error('Simulated Postgres timeout'); };

    const accessRes = await built.app.inject({ url: '/api/v1/access', headers });
    assert.equal(accessRes.statusCode, 200);
    const accessBody = accessRes.json();
    assert.equal(accessBody.access.accessMode, 'FREE_LAUNCH');
    assert.equal(accessBody.access.fullFeatureAccess, true);
    assert.equal(accessBody.access.adsRequired, true);
    assert.equal(accessBody.entitlementResolved, false);

    // Candles endpoint for a non-NIFTY stock must NOT return 403 ERR_PRO_TIER_REQUIRED
    const candleRes = await built.app.inject({
      url: '/api/v1/market-data/candles?globalId=NSE:RELIANCE&timeframe=5m',
      headers,
    });
    assert.notEqual(candleRes.statusCode, 403);

    // Restore and confirm STANDARD mode returns 503 instead of fake 200 downgrade on DB outage
    process.env.SIKHO_ACCESS_MODE = 'STANDARD';
    const stdOutage = await built.app.inject({ url: '/api/v1/access', headers });
    assert.equal(stdOutage.statusCode, 503);
    assert.equal(stdOutage.json().code, 'ERR_ENTITLEMENT_UNAVAILABLE');

    built.billingService.resolveEntitlement = origResolve;
    built.billingService.getAccountTier = origTier;
  } finally {
    if (prevMode === undefined) delete process.env.SIKHO_ACCESS_MODE;
    else process.env.SIKHO_ACCESS_MODE = prevMode;
    await built.app.close();
  }
});

test('Priority 1: WS AUTH immediately followed by SUBSCRIBE never races into RESTRICTED_ACCESS under FREE_LAUNCH', async () => {
  const prevMode = process.env.SIKHO_ACCESS_MODE;
  process.env.SIKHO_ACCESS_MODE = 'FREE_LAUNCH';
  const built = await buildServer(new EmulatedPostgresDatabase(), 'DEMO');
  const address = await built.app.listen({ port: 0, host: '127.0.0.1' });
  let ws: WebSocket | undefined;
  try {
    const reg = await built.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { name: 'WS Race User', email: 'ws-race@example.test', password: 'password123' },
    });
    const { token } = reg.json();

    // Artificially delay getAccountTier by 60ms to provoke the classic AUTH vs SUBSCRIBE race
    const origTier = built.billingService.getAccountTier.bind(built.billingService);
    built.billingService.getAccountTier = async (uid: string) => {
      await new Promise((r) => setTimeout(r, 60));
      return origTier(uid);
    };

    const messages: any[] = [];
    ws = new WebSocket(address.replace('http', 'ws') + '/ws');
    await new Promise<void>((resolve, reject) => {
      ws!.once('open', () => resolve());
      ws!.once('error', reject);
    });
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));

    // Send AUTH and SUBSCRIBE in the exact same tick without waiting
    ws.send(JSON.stringify({ type: 'AUTH', token }));
    ws.send(JSON.stringify({ type: 'SUBSCRIBE', symbols: ['NSE:RELIANCE', 'MCX:CRUDEOIL'] }));

    await new Promise((r) => setTimeout(r, 300));
    assert.equal(messages.some((m) => m.type === 'RESTRICTED_ACCESS'), false, 'SUBSCRIBE must not race ahead of AUTH');
    assert.ok(messages.some((m) => m.type === 'AUTH_SUCCESS' && m.access.fullFeatureAccess === true));
    assert.ok(messages.some((m) => m.type === 'SUBSCRIBED'));
  } finally {
    ws?.close();
    if (prevMode === undefined) delete process.env.SIKHO_ACCESS_MODE;
    else process.env.SIKHO_ACCESS_MODE = prevMode;
    await built.app.close();
  }
});

test('Priority 2: Market BUY with attached SL/TP spawns OCO orders; TP fill cancels SL atomically', async () => {
  const db = new EmulatedPostgresDatabase();
  const repo = new PostgresRepository(db);
  const engine = new SimulationEngine(repo);
  const inst = makeInst();
  await repo.syncInstruments([inst]);
  const acc = await repo.provisionInitialAccount('user-oco-long');

  const q0 = makeQuote(inst.globalId, 24000);
  const res = await engine.submitOrder(
    {
      accountId: acc.id,
      globalInstrumentId: inst.globalId,
      side: 'BUY',
      orderType: 'MARKET',
      quantity: 25,
      stopLossPrice: 23900,
      targetPrice: 24200,
      idempotencyKey: 'long-bracket-1',
    },
    inst,
    q0,
    Money.fromRupees(72000),
    Money.fromRupees(20)
  );

  assert.equal(res.order.status, 'EXECUTED');
  assert.equal(res.attachedOrders?.length, 2);
  const sl = res.attachedOrders!.find((o) => o.orderType === 'STOP_MARKET')!;
  const tp = res.attachedOrders!.find((o) => o.orderType === 'LIMIT')!;
  assert.equal(sl.side, 'SELL');
  assert.equal(tp.side, 'SELL');
  assert.equal(sl.ocoCompanionOrderId, tp.id);
  assert.equal(tp.ocoCompanionOrderId, sl.id);

  // Tick crosses above TP (24220): TP must fill at >= 24200 and SL must cancel atomically
  const fills = await engine.onMarketTick(makeQuote(inst.globalId, 24220, { providerTimestamp: Date.now() + 10 }));
  assert.equal(fills.length, 1);
  assert.equal(fills[0].order.id, tp.id);
  assert.equal(fills[0].order.status, 'EXECUTED');
  assert.ok((fills[0].order.executedPrice || 0) >= 24200, 'Sell Limit TP must fill at limit or better');

  const allOrders = await repo.getOrders(acc.id);
  assert.equal(allOrders.find((o) => o.id === sl.id)?.status, 'CANCELLED');
  assert.match(allOrders.find((o) => o.id === sl.id)?.rejectionReason || '', /OCO_TRIGGERED/);

  const positions = await repo.getPositions(acc.id);
  assert.equal(positions[0].quantity, 0);
  const accAfter = await repo.getAccount(acc.id);
  assert.equal(accAfter!.lockedMarginPaise, 0n);

  // Subsequent tick below SL must NOT trigger the cancelled SL
  const secondFills = await engine.onMarketTick(makeQuote(inst.globalId, 23800, { providerTimestamp: Date.now() + 20 }));
  assert.equal(secondFills.length, 0);
  await db.close();
});

test('Priority 2: Short SELL with attached SL/TP executes SL on gap beyond trigger and cancels TP', async () => {
  const db = new EmulatedPostgresDatabase();
  const repo = new PostgresRepository(db);
  const engine = new SimulationEngine(repo);
  const inst = makeInst();
  await repo.syncInstruments([inst]);
  const acc = await repo.provisionInitialAccount('user-oco-short');

  const q0 = makeQuote(inst.globalId, 24000);
  const res = await engine.submitOrder(
    {
      accountId: acc.id,
      globalInstrumentId: inst.globalId,
      side: 'SELL',
      orderType: 'MARKET',
      quantity: 25,
      stopLossPrice: 24100,
      targetPrice: 23800,
      idempotencyKey: 'short-bracket-1',
    },
    inst,
    q0,
    Money.fromRupees(72000),
    Money.fromRupees(20)
  );
  assert.equal(res.attachedOrders?.length, 2);
  const sl = res.attachedOrders!.find((o) => o.orderType === 'STOP_MARKET')!;
  const tp = res.attachedOrders!.find((o) => o.orderType === 'LIMIT')!;
  assert.equal(sl.side, 'BUY');
  assert.equal(tp.side, 'BUY');

  // Price jumps straight across SL trigger 24100 to 24135
  const fills = await engine.onMarketTick(makeQuote(inst.globalId, 24135, { providerTimestamp: Date.now() + 10 }));
  assert.equal(fills.length, 1);
  assert.equal(fills[0].order.id, sl.id);
  assert.equal(fills[0].order.executedPrice, 24135, 'Stop-Market executes at gap price beyond trigger');

  const allOrders = await repo.getOrders(acc.id);
  assert.equal(allOrders.find((o) => o.id === tp.id)?.status, 'CANCELLED');
  assert.equal((await repo.getPositions(acc.id))[0].quantity, 0);
  await db.close();
});

test('Priority 2: Buy Limit fills at limit or better, spawns attached SL/TP, and survives backend restart', async () => {
  const db = new EmulatedPostgresDatabase();
  const repo = new PostgresRepository(db);
  const engine1 = new SimulationEngine(repo);
  const inst = makeInst({ lotSize: 1, instrumentType: 'EQUITY_STOCK', exchange: 'NSE', globalId: 'NSE:TESTEQ', symbol: 'TESTEQ' });
  await repo.syncInstruments([inst]);
  const acc = await repo.provisionInitialAccount('user-limit-restart');

  const q0 = makeQuote(inst.globalId, 105);
  const placed = await engine1.submitOrder(
    {
      accountId: acc.id,
      globalInstrumentId: inst.globalId,
      side: 'BUY',
      orderType: 'LIMIT',
      quantity: 10,
      requestedPrice: 100,
      stopLossPrice: 95,
      targetPrice: 112,
      idempotencyKey: 'limit-with-sltp-1',
    },
    inst,
    q0,
    Money.fromRupees(200),
    Money.fromRupees(20)
  );
  assert.equal(placed.order.status, 'PENDING');
  assert.ok((await repo.getAllOpenPositionInstrumentIds()).includes(inst.globalId));

  // Simulate backend restart
  const engine2 = new SimulationEngine(repo);
  await engine2.restorePendingOrders();

  // Stale tick below limit must NOT trigger
  const stale = await engine2.onMarketTick(makeQuote(inst.globalId, 98, { providerTimestamp: Date.now() - 10000, receiveTimestamp: Date.now() - 10000 }));
  assert.equal(stale.length, 0);

  // Fresh tick jumps down to 98 (better than limit 100)
  const fills = await engine2.onMarketTick(makeQuote(inst.globalId, 98, { providerTimestamp: Date.now() + 10 }));
  assert.equal(fills.length, 1);
  assert.equal(fills[0].order.executedPrice, 98, 'Buy Limit must fill at 98 (limit or better, never worse than 100)');
  assert.equal(fills[0].attachedOrders?.length, 2, 'Attached SL/TP must spawn after pending limit fills post-restart');

  // Duplicate tick must not double-fill
  const dup = await engine2.onMarketTick(makeQuote(inst.globalId, 98, { providerTimestamp: Date.now() + 10 }));
  assert.equal(dup.length, 0);
  await db.close();
});

test('Priority 2: STOP_LIMIT triggers to TRIGGERED without fabricating fill when price gaps past limit', async () => {
  const db = new EmulatedPostgresDatabase();
  const repo = new PostgresRepository(db);
  const engine = new SimulationEngine(repo);
  const inst = makeInst({ lotSize: 1, instrumentType: 'EQUITY_STOCK', exchange: 'NSE', globalId: 'NSE:SLIM', symbol: 'SLIM' });
  await repo.syncInstruments([inst]);
  const acc = await repo.provisionInitialAccount('user-stop-limit');

  const q0 = makeQuote(inst.globalId, 105);
  const placed = await engine.submitOrder(
    {
      accountId: acc.id,
      globalInstrumentId: inst.globalId,
      side: 'SELL',
      orderType: 'STOP_LIMIT',
      quantity: 5,
      triggerPrice: 100,
      requestedPrice: 99,
      idempotencyKey: 'stop-limit-1',
    },
    inst,
    q0,
    Money.fromRupees(100),
    Money.fromRupees(20)
  );
  assert.equal(placed.order.status, 'PENDING');

  // Price gaps straight to 97 (breaches trigger 100, but below limit 99 -> must NOT fill!)
  const gapRes = await engine.onMarketTick(makeQuote(inst.globalId, 97, { providerTimestamp: Date.now() + 10 }));
  assert.equal(gapRes.length, 0);
  assert.equal((await repo.getOrders(acc.id)).find((o) => o.id === placed.order.id)?.status, 'TRIGGERED');

  // Price rebounds to 99.50 (>= limit 99) -> fills at 99.50!
  const fillRes = await engine.onMarketTick(makeQuote(inst.globalId, 99.5, { providerTimestamp: Date.now() + 20 }));
  assert.equal(fillRes.length, 1);
  assert.equal(fillRes[0].order.status, 'EXECUTED');
  assert.equal(fillRes[0].order.executedPrice, 99.5);
  await db.close();
});

test('Priority 2: Protective SL clamps to remaining position quantity (no reverse exposure) and square-off cancels pending SL/TP', async () => {
  const db = new EmulatedPostgresDatabase();
  const repo = new PostgresRepository(db);
  const engine = new SimulationEngine(repo);
  const inst = makeInst({ lotSize: 1, instrumentType: 'EQUITY_STOCK', exchange: 'NSE', globalId: 'NSE:CLAMP', symbol: 'CLAMP' });
  await repo.syncInstruments([inst]);
  const acc = await repo.provisionInitialAccount('user-clamp');

  // Open Long 10 with SL=95, TP=110
  await engine.submitOrder(
    {
      accountId: acc.id,
      globalInstrumentId: inst.globalId,
      side: 'BUY',
      orderType: 'MARKET',
      quantity: 10,
      stopLossPrice: 95,
      targetPrice: 110,
      idempotencyKey: 'clamp-open',
    },
    inst,
    makeQuote(inst.globalId, 100),
    Money.fromRupees(200),
    Money.fromRupees(20)
  );

  // Manually reduce 4 shares -> remaining Long 6
  await engine.submitOrder(
    {
      accountId: acc.id,
      globalInstrumentId: inst.globalId,
      side: 'SELL',
      orderType: 'MARKET',
      quantity: 4,
      idempotencyKey: 'clamp-partial-exit',
    },
    inst,
    makeQuote(inst.globalId, 101, { providerTimestamp: Date.now() + 10 }),
    0n,
    Money.fromRupees(20)
  );
  assert.equal((await repo.getPositions(acc.id))[0].quantity, 6);

  // SL triggers at 94 -> must clamp exit to 6 (NOT 10 -> no -4 short flip!)
  const slFills = await engine.onMarketTick(makeQuote(inst.globalId, 94, { providerTimestamp: Date.now() + 20 }));
  assert.equal(slFills.length, 1);
  assert.equal(slFills[0].order.quantity, 6);
  assert.equal((await repo.getPositions(acc.id))[0].quantity, 0);

  // Now test manual square-off cancels attached SL/TP
  await engine.submitOrder(
    {
      accountId: acc.id,
      globalInstrumentId: inst.globalId,
      side: 'BUY',
      orderType: 'MARKET',
      quantity: 5,
      stopLossPrice: 90,
      targetPrice: 115,
      idempotencyKey: 'sqoff-open',
    },
    inst,
    makeQuote(inst.globalId, 100, { providerTimestamp: Date.now() + 30 }),
    Money.fromRupees(100),
    Money.fromRupees(20)
  );
  await engine.squareOffPosition(acc.id, inst.globalId, makeQuote(inst.globalId, 102, { providerTimestamp: Date.now() + 40 }), inst);
  const pendingAfterSqoff = (await repo.getOrders(acc.id)).filter((o) => o.status === 'PENDING' || o.status === 'TRIGGERED');
  assert.equal(pendingAfterSqoff.length, 0, 'Manual square-off must cancel all pending protective SL/TP orders');

  // Validate invalid SL/TP direction rejection in OrderValidator
  const badSl = OrderValidator.validate(
    { accountId: acc.id, globalInstrumentId: inst.globalId, side: 'BUY', orderType: 'MARKET', quantity: 1, stopLossPrice: 105, idempotencyKey: 'bad-sl' },
    inst,
    Money.fromRupees(10000),
    100
  );
  assert.equal(badSl.isValid, false);
  assert.equal(badSl.errorCode, 'ERR_INVALID_STOP_LOSS');
  await db.close();
});
