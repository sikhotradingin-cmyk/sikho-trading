import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from './server.js';
import { FastifyInstance } from 'fastify';

describe('Prompt 3 Features: Tier Gating, Watchlists, Ads, Journal & Security', () => {
  let app: FastifyInstance;
  let authToken: string;

  before(async () => {
    const s = await buildServer();
    app = s.app;
    await app.ready();

    // Dev login
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/dev-login',
      payload: { userId: 'p3-tester-01', name: 'Prompt 3 Tester' },
    });
    const body = JSON.parse(loginRes.body);
    authToken = body.token;
  });

  after(async () => {
    await app.close();
  });

  test('Free tier user is restricted from non-NIFTY instruments (ERR_PRO_TIER_REQUIRED)', async () => {
    // Attempt to order RELIANCE equity (Pro-only)
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/place',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        globalInstrumentId: 'NSE:RELIANCE:2885',
        side: 'BUY',
        orderType: 'MARKET',
        quantity: 1,
        idempotencyKey: 'pro-gate-test-1',
      },
    });

    assert.equal(res.statusCode, 403);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'ERR_PRO_TIER_REQUIRED');
  });

  test('Free tier user can successfully practice on NIFTY Current Month Futures', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/place',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        globalInstrumentId: 'NFO:NIFTY26OCTFUT:999001',
        side: 'BUY',
        orderType: 'MARKET',
        quantity: 25,
        idempotencyKey: 'nifty-practice-order',
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.success, true);
    assert.equal(body.order.status, 'EXECUTED');
  });

  test('Search and pagination returns filtered instrument slice', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/instruments?q=nifty&page=1&limit=10',
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.instruments.length >= 1);
    for (const inst of body.instruments) {
      assert.match(inst.symbol.toLowerCase(), /nifty/);
    }
  });

  test('Multi-watchlist enforces tier limits (Free tier allowed max 1 watchlist)', async () => {
    // 1st watchlist creation succeeds
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/v1/watchlists',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { name: 'My Indices', instruments: ['NFO:NIFTY26OCTFUT:999001'] },
    });
    assert.equal(res1.statusCode, 200);

    // 2nd watchlist creation must be rejected with 403
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/v1/watchlists',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { name: 'My Equities', instruments: ['NSE:RELIANCE:2885'] },
    });
    assert.equal(res2.statusCode, 403);
  });

  test('App Open Ad coordinates 1 impression per rolling 24-hour limit', async () => {
    // 1st opportunity reservation succeeds
    const oppRes1 = await app.inject({
      method: 'POST',
      url: '/api/v1/ads/app-open/opportunity',
      headers: { authorization: `Bearer ${authToken}` },
    });
    assert.equal(oppRes1.statusCode, 200);
    const oppBody1 = JSON.parse(oppRes1.body);
    assert.equal(oppBody1.isEligible, true);
    assert.ok(oppBody1.opportunityToken);

    // Confirm impression rendered
    const impRes = await app.inject({
      method: 'POST',
      url: '/api/v1/ads/app-open/impression',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { opportunityToken: oppBody1.opportunityToken },
    });
    assert.equal(impRes.statusCode, 200);
    assert.equal(JSON.parse(impRes.body).recorded, true);

    // Subsequent opportunity within 24h must be rejected (FREQUENCY_CAPPED)
    const oppRes2 = await app.inject({
      method: 'POST',
      url: '/api/v1/ads/app-open/opportunity',
      headers: { authorization: `Bearer ${authToken}` },
    });
    assert.equal(oppRes2.statusCode, 200);
    const oppBody2 = JSON.parse(oppRes2.body);
    assert.equal(oppBody2.isEligible, false);
    assert.match(oppBody2.reason, /FREQUENCY_CAPPED/);
  });

  test('Journal notes and CSV export return valid performance data without tax terms', async () => {
    // Add journal note
    const noteRes = await app.inject({
      method: 'POST',
      url: '/api/v1/journal/notes',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { strategyTag: 'Opening Range Breakout', notes: 'Clean breakout above 24,500.' },
    });
    assert.equal(noteRes.statusCode, 200);

    // Fetch CSV
    const csvRes = await app.inject({
      method: 'GET',
      url: '/api/v1/journal/export.csv',
      headers: { authorization: `Bearer ${authToken}` },
    });
    assert.equal(csvRes.statusCode, 200);
    assert.match(csvRes.body, /SIMULATED PAPER-TRADING EDUCATIONAL PERFORMANCE EXPORT/);
    assert.doesNotMatch(csvRes.body, /tax report|tax statement/i);
  });
});
