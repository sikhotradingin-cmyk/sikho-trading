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
});
