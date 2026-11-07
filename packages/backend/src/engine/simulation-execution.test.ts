import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EmulatedPostgresDatabase } from '../db/database.js';
import { PostgresRepository } from '../db/postgres-repository.js';
import { SimulationEngine } from './simulation-engine.js';
import { InstrumentMetadata, Money, PlaceOrderRequest, QuoteSnapshot } from '@trading/shared';

describe('Simulated Execution Engine (PostgreSQL-backed)', () => {
  const niftyFuture: InstrumentMetadata = {
    globalId: 'NFO:NIFTY26OCTFUT:999001',
    provider: 'DEMO',
    exchange: 'NFO',
    token: '999001',
    symbol: 'NIFTY26OCTFUT',
    name: 'NIFTY Current Month Futures',
    instrumentType: 'FUTIDX',
    isTradable: true,
    lotSize: 25,
    tickSize: 0.05,
    expiry: '2026-11-26',
    isSimulatedFixture: true,
  };

  const freshQuote: QuoteSnapshot = {
    globalId: niftyFuture.globalId,
    token: '999001',
    ltp: 24500.0,
    open: 24450.0,
    high: 24550.0,
    low: 24400.0,
    close: 24500.0,
    bidPrice: 24499.95,
    bidQty: 100,
    askPrice: 24500.05,
    askQty: 150,
    providerTimestamp: Date.now(),
    receiveTimestamp: Date.now(),
    source: 'DEMO',
    isSimulated: true,
  };

  test('executes BUY Market order at Best Ask and opens Long Position in PostgreSQL', async () => {
    const db = new EmulatedPostgresDatabase();
    const repo = new PostgresRepository(db);
    await repo.syncInstruments([niftyFuture]);
    const simEngine = new SimulationEngine(repo);
    const acc = await repo.provisionInitialAccount('trader-1');

    const req: PlaceOrderRequest = {
      accountId: acc.id,
      globalInstrumentId: niftyFuture.globalId,
      side: 'BUY',
      orderType: 'MARKET',
      quantity: 25,
      idempotencyKey: 'idem-101',
    };

    const res = await simEngine.submitOrder(
      req,
      niftyFuture,
      freshQuote,
      Money.fromRupees(73500),
      Money.fromRupees(25)
    );

    assert.equal(res.order.status, 'EXECUTED');
    assert.equal(res.order.executedPrice, 24500.05); // Best Ask fill
    assert.ok(res.position);
    assert.equal(res.position.quantity, 25);
    assert.equal(res.position.averageEntryPrice, 24500.05);
  });

  test('enforces idempotency: identical retry returns same order, different payload throws', async () => {
    const db = new EmulatedPostgresDatabase();
    const repo = new PostgresRepository(db);
    await repo.syncInstruments([niftyFuture]);
    const simEngine = new SimulationEngine(repo);
    const acc = await repo.provisionInitialAccount('trader-2');

    const req: PlaceOrderRequest = {
      accountId: acc.id,
      globalInstrumentId: niftyFuture.globalId,
      side: 'BUY',
      orderType: 'MARKET',
      quantity: 25,
      idempotencyKey: 'idem-fixed',
    };

    const res1 = await simEngine.submitOrder(req, niftyFuture, freshQuote, 1000n, 20n);
    const res2 = await simEngine.submitOrder(req, niftyFuture, freshQuote, 1000n, 20n);

    assert.equal(res1.order.id, res2.order.id);

    const mutatedReq: PlaceOrderRequest = { ...req, quantity: 50 };
    await assert.rejects(
      async () => {
        await simEngine.submitOrder(mutatedReq, niftyFuture, freshQuote, 1000n, 20n);
      },
      /ERR_IDEMPOTENCY_MISMATCH/
    );
  });

  test('rejects execution when quote timestamp is stale (> 5000ms old)', async () => {
    const db = new EmulatedPostgresDatabase();
    const repo = new PostgresRepository(db);
    await repo.syncInstruments([niftyFuture]);
    const simEngine = new SimulationEngine(repo);
    const acc = await repo.provisionInitialAccount('trader-3');

    const staleQuote: QuoteSnapshot = {
      ...freshQuote,
      receiveTimestamp: Date.now() - 6000,
    };

    const req: PlaceOrderRequest = {
      accountId: acc.id,
      globalInstrumentId: niftyFuture.globalId,
      side: 'BUY',
      orderType: 'MARKET',
      quantity: 25,
      idempotencyKey: 'idem-stale',
    };

    const res = await simEngine.submitOrder(req, niftyFuture, staleQuote, 1000n, 20n);
    assert.equal(res.order.status, 'REJECTED');
    assert.match(res.order.rejectionReason || '', /ERR_STALE_MARKET_DATA/);
  });

  test('OCO exit protection: Stop-Market fill automatically cancels companion Target order', async () => {
    const db = new EmulatedPostgresDatabase();
    const repo = new PostgresRepository(db);
    await repo.syncInstruments([niftyFuture]);
    const simEngine = new SimulationEngine(repo);
    const acc = await repo.provisionInitialAccount('trader-4');

    // 1. Enter Long position
    await simEngine.submitOrder(
      {
        accountId: acc.id,
        globalInstrumentId: niftyFuture.globalId,
        side: 'BUY',
        orderType: 'MARKET',
        quantity: 25,
        idempotencyKey: 'buy-entry',
      },
      niftyFuture,
      freshQuote,
      Money.fromRupees(73500),
      Money.fromRupees(25)
    );

    // 2. Submit Stop-Market SELL (trigger 24,450) and Target Limit SELL (limit 24,600)
    const slRes = await simEngine.submitOrder(
      {
        accountId: acc.id,
        globalInstrumentId: niftyFuture.globalId,
        side: 'SELL',
        orderType: 'STOP_MARKET',
        quantity: 25,
        triggerPrice: 24450.0,
        idempotencyKey: 'sl-exit',
      },
      niftyFuture,
      freshQuote,
      0n,
      Money.fromRupees(25)
    );

    const targetRes = await simEngine.submitOrder(
      {
        accountId: acc.id,
        globalInstrumentId: niftyFuture.globalId,
        side: 'SELL',
        orderType: 'LIMIT',
        quantity: 25,
        requestedPrice: 24600.0,
        idempotencyKey: 'tp-exit',
      },
      niftyFuture,
      freshQuote,
      0n,
      Money.fromRupees(25)
    );

    // Link them as OCO companions
    slRes.order.ocoCompanionOrderId = targetRes.order.id;
    targetRes.order.ocoCompanionOrderId = slRes.order.id;

    // 3. Price drops: market tick drops to 24,440 (gapping past trigger 24,450)
    const dropTick: QuoteSnapshot = {
      ...freshQuote,
      ltp: 24440.0,
      bidPrice: 24439.95,
      askPrice: 24440.05,
      receiveTimestamp: Date.now(),
    };

    const triggers = await simEngine.onMarketTick(dropTick);
    assert.equal(triggers.length, 1);
    assert.equal(triggers[0].order.id, slRes.order.id);
    assert.equal(triggers[0].order.status, 'EXECUTED');
    assert.equal(triggers[0].order.executedPrice, 24440.0);

    const orders = await repo.getOrders(acc.id);
    const targetOrder = orders.find((o) => o.id === targetRes.order.id)!;
    assert.equal(targetOrder.status, 'CANCELLED');
    assert.match(targetOrder.rejectionReason || '', /OCO_TRIGGERED/);
  });

  test('rejects live-feed (non-simulated) market order when exchange is closed or quote is from last session', async () => {
    const db = new EmulatedPostgresDatabase();
    const repo = new PostgresRepository(db);
    const smartApiFuture: InstrumentMetadata = {
      globalId: 'NFO:NIFTY23NOV26FUT:61471',
      provider: 'SMARTAPI',
      exchange: 'NFO',
      token: '61471',
      symbol: 'NIFTY23NOV26FUT',
      name: 'NIFTY Futures (23NOV2026)',
      instrumentType: 'FUTIDX',
      isTradable: true,
      lotSize: 65,
      tickSize: 0.1,
      expiry: '23NOV2026',
      marginMultiplier: 0.05,
      isSimulatedFixture: false,
    };
    await repo.syncInstruments([smartApiFuture]);
    const simEngine = new SimulationEngine(repo);
    const acc = await repo.provisionInitialAccount('trader-closed-mkt');

    const lastSessionQuote: QuoteSnapshot = {
      globalId: smartApiFuture.globalId,
      token: '61471',
      ltp: 23970.7,
      open: 23712.0,
      high: 23988.0,
      low: 23700.5,
      close: 23780.5,
      bidPrice: 23970.6,
      askPrice: 23970.8,
      providerTimestamp: Date.now() - 3600000,
      receiveTimestamp: Date.now(), // Even if packet just arrived over WS
      source: 'SMARTAPI',
      isSimulated: false,
    };

    const req: PlaceOrderRequest = {
      accountId: acc.id,
      globalInstrumentId: smartApiFuture.globalId,
      side: 'BUY',
      orderType: 'MARKET',
      quantity: 65,
      idempotencyKey: 'idem-closed-mkt-1',
    };

    const res = await simEngine.submitOrder(
      req,
      smartApiFuture,
      lastSessionQuote,
      Money.fromRupees(77904.78),
      Money.fromRupees(311.62)
    );

    assert.equal(res.order.status, 'REJECTED');
    assert.match(res.order.rejectionReason || '', /ERR_MARKET_CLOSED|ERR_STALE_MARKET_DATA/);

    const postAcc = await repo.getAccount(acc.id);
    assert.equal(postAcc!.cashBalancePaise, 10000000n);
    assert.equal(postAcc!.lockedMarginPaise, 0n);
    assert.equal(postAcc!.availableBalancePaise, 10000000n);
  });

  test('reconciles ₹311.62 entry & exit fees with cash balance, available balance, and ledger entries (charged once per leg)', async () => {
    const db = new EmulatedPostgresDatabase();
    const repo = new PostgresRepository(db);
    const nifty65: InstrumentMetadata = {
      globalId: 'NFO:NIFTY23NOV26FUT:61471',
      provider: 'DEMO',
      exchange: 'NFO',
      token: '61471',
      symbol: 'NIFTY23NOV26FUT',
      name: 'NIFTY Futures (23NOV2026)',
      instrumentType: 'FUTIDX',
      isTradable: true,
      lotSize: 65,
      tickSize: 0.1,
      expiry: '23NOV2026',
      marginMultiplier: 0.05,
      isSimulatedFixture: true,
    };
    await repo.syncInstruments([nifty65]);
    const simEngine = new SimulationEngine(repo);
    const acc = await repo.provisionInitialAccount('trader-fee-reconcile');

    const quote: QuoteSnapshot = {
      globalId: nifty65.globalId,
      token: '61471',
      ltp: 23970.7,
      open: 23712.0,
      high: 23988.0,
      low: 23700.5,
      close: 23780.5,
      bidPrice: 23970.6,
      askPrice: 23970.8,
      providerTimestamp: Date.now(),
      receiveTimestamp: Date.now(),
      source: 'DEMO',
      isSimulated: true,
    };

    const entryMarginPaise = Money.fromRupees(77904.78); // 7,790,478 Paise
    const entryChargesPaise = Money.fromRupees(311.62); // 31,162 Paise

    const buyRes = await simEngine.submitOrder(
      {
        accountId: acc.id,
        globalInstrumentId: nifty65.globalId,
        side: 'BUY',
        orderType: 'MARKET',
        quantity: 65,
        idempotencyKey: 'buy-reconcile-1',
      },
      nifty65,
      quote,
      entryMarginPaise,
      entryChargesPaise
    );

    assert.equal(buyRes.order.status, 'EXECUTED');
    assert.equal(buyRes.order.executedPrice, 23970.8);

    // Verify account after entry:
    // Cash = 10,000,000 - 31,162 = 9,968,838 Paise (₹99,688.38)
    // Locked Margin = 7,790,478 Paise (₹77,904.78)
    // Available = 9,968,838 - 7,790,478 = 2,178,360 Paise (₹21,783.60)
    const accAfterBuy = (await repo.getAccount(acc.id))!;
    assert.equal(accAfterBuy.cashBalancePaise, 9968838n);
    assert.equal(accAfterBuy.lockedMarginPaise, 7790478n);
    assert.equal(accAfterBuy.availableBalancePaise, 2178360n);

    // Verify ledger after entry: INITIAL_GRANT + 1 SIMULATED_CHARGES entry
    const ledgerAfterBuy = await repo.getLedger(acc.id);
    const entryChargeEntries = ledgerAfterBuy.filter((e) => e.entryType === 'SIMULATED_CHARGES');
    assert.equal(entryChargeEntries.length, 1);
    assert.equal(entryChargeEntries[0].amountPaise, -31162n);
    assert.equal(entryChargeEntries[0].balanceAfterPaise, 9968838n);
    assert.equal(entryChargeEntries[0].referenceId, buyRes.order.id);

    // Now Square-Off at bid 23970.60 -> P&L = (23970.60 - 23970.80) * 65 = -₹13.00 (-1300 Paise)
    // Exit charges = 31,162 Paise (₹311.62)
    const sqRes = await simEngine.squareOffPosition(acc.id, nifty65.globalId, quote, nifty65);
    assert.equal(sqRes.order.status, 'EXECUTED');
    assert.equal(sqRes.position?.quantity, 0);

    const accAfterExit = (await repo.getAccount(acc.id))!;
    // Final Cash = 9,968,838 - 1,300 (P&L) - 31,162 (Exit Fee) = 9,936,376 Paise (₹99,363.76)
    assert.equal(accAfterExit.cashBalancePaise, 9936376n);
    assert.equal(accAfterExit.lockedMarginPaise, 0n);
    assert.equal(accAfterExit.availableBalancePaise, 9936376n);

    const ledgerAfterExit = await repo.getLedger(acc.id);
    const allChargeEntries = ledgerAfterExit.filter((e) => e.entryType === 'SIMULATED_CHARGES');
    assert.equal(allChargeEntries.length, 2); // 1 for entry order, 1 for exit order
  });
});
