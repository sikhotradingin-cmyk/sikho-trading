import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from './server.js';
import { FastifyInstance } from 'fastify';

describe('End-to-End Server Integration & API Flow', () => {
  let app: FastifyInstance;
  let authToken: string;

  before(async () => {
    const s = await buildServer();
    app = s.app;
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  test('POST /api/v1/auth/dev-login generates JWT and provisions ₹100,000 virtual balance', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/dev-login',
      payload: { userId: 'e2e-tester-01', name: 'Tester One' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.token);
    assert.equal(body.account.startingBalanceINR, 100000);
    assert.equal(body.account.cashBalanceINR, 100000);
    authToken = body.token;
  });

  test('GET /api/v1/feed-health returns active provider and demo banner label', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/feed-health',
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.activeProvider.source, 'DEMO');
    assert.equal(body.activeProvider.uiBannerLabel, 'DEMO DATA — NOT LIVE MARKET');
    assert.equal(body.smartApiStatus.status, 'NOT_LIVE_VERIFIED');
  });

  test('GET /api/v1/instruments returns Spot and NIFTY Futures with dynamic metadata', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/instruments',
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.instruments));
    const fut = body.instruments.find((i: any) => i.instrumentType === 'FUTIDX');
    assert.ok(fut);
    assert.equal(fut.symbol, 'DEMO-NIFTY-FUT');
    assert.equal(fut.isTradable, true);
    assert.equal(fut.lotSize, 25); // Dynamically verified from metadata
  });

  test('POST /api/v1/orders/place executes market trade and updates account and positions', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/place',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        globalInstrumentId: 'NFO:NIFTY26OCTFUT:999001',
        side: 'BUY',
        orderType: 'MARKET',
        quantity: 25,
        idempotencyKey: 'e2e-order-1',
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.success, true);
    assert.equal(body.order.status, 'EXECUTED');
    assert.ok(body.position);
    assert.equal(body.position.quantity, 25);
  });

  test('POST /api/v1/positions/square-off closes position and records P&L in ledger', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/positions/square-off',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { globalInstrumentId: 'NFO:NIFTY26OCTFUT:999001' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.success, true);
    assert.equal(body.position.quantity, 0);

    // Verify ledger has entries
    const ledgerRes = await app.inject({
      method: 'GET',
      url: '/api/v1/account/ledger',
      headers: { authorization: `Bearer ${authToken}` },
    });
    assert.equal(ledgerRes.statusCode, 200);
    const ledgerBody = JSON.parse(ledgerRes.body);
    assert.ok(ledgerBody.ledger.length >= 2);
  });
});
