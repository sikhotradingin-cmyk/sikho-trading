import test from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from './server.js';
import { EmulatedPostgresDatabase } from './db/database.js';

test('State 18: GET /api/v1/orders/by-idempotency/:key resolves accepted order safely and enforces User A/B isolation', async () => {
  const prevMode = process.env.SIKHO_ACCESS_MODE;
  process.env.SIKHO_ACCESS_MODE = 'FREE_LAUNCH';
  const built = await buildServer(new EmulatedPostgresDatabase(), 'DEMO');
  await built.app.ready();
  try {
    const regA = await built.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { name: 'User A', email: 'idem-a@example.test', password: 'password123' },
    });
    const regB = await built.app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { name: 'User B', email: 'idem-b@example.test', password: 'password123' },
    });
    const tokenA = regA.json().token;
    const tokenB = regB.json().token;

    const instRes = await built.app.inject({ url: '/api/v1/instruments?limit=20', headers: { authorization: `Bearer ${tokenA}` } });
    const tradable = instRes.json().instruments.find((i: any) => i.isTradable && i.instrumentType !== 'INDEX_SPOT');
    assert.ok(tradable, 'Need a tradable DEMO instrument');

    const key = `idem-timeout-${Date.now()}`;
    const placeRes = await built.app.inject({
      method: 'POST',
      url: '/api/v1/orders/place',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        globalInstrumentId: tradable.globalId,
        side: 'BUY',
        orderType: 'MARKET',
        quantity: tradable.lotSize || 1,
        idempotencyKey: key,
      },
    });
    assert.equal(placeRes.statusCode, 200);

    // User A resolves timed-out order by idempotency key
    const lookupA = await built.app.inject({
      url: `/api/v1/orders/by-idempotency/${encodeURIComponent(key)}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(lookupA.statusCode, 200);
    assert.equal(lookupA.json().found, true);
    assert.equal(lookupA.json().order.idempotencyKey, key);
    assert.equal(lookupA.json().order.status, 'EXECUTED');

    // Unknown key returns found: false
    const unknownA = await built.app.inject({
      url: '/api/v1/orders/by-idempotency/never-sent-key',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(unknownA.statusCode, 200);
    assert.equal(unknownA.json().found, false);

    // User B cannot inspect User A's idempotency key
    const lookupB = await built.app.inject({
      url: `/api/v1/orders/by-idempotency/${encodeURIComponent(key)}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    assert.equal(lookupB.statusCode, 200);
    assert.equal(lookupB.json().found, false);
  } finally {
    if (prevMode === undefined) delete process.env.SIKHO_ACCESS_MODE;
    else process.env.SIKHO_ACCESS_MODE = prevMode;
    await built.app.close();
  }
});

test('States 23 & 35: /health exposes maintenance and clientVersion only when explicitly configured', async () => {
  const built = await buildServer(new EmulatedPostgresDatabase(), 'DEMO');
  await built.app.ready();
  const prevMaint = process.env.SIKHO_MAINTENANCE_MODE;
  const prevLatest = process.env.SIKHO_LATEST_VERSION_CODE;
  try {
    delete process.env.SIKHO_MAINTENANCE_MODE;
    delete process.env.SIKHO_LATEST_VERSION_CODE;
    const normal = (await built.app.inject({ url: '/health' })).json();
    assert.equal(normal.status, 'ok');
    assert.equal(normal.maintenance.active, false);
    assert.equal(normal.clientVersion, null);

    process.env.SIKHO_MAINTENANCE_MODE = 'true';
    process.env.SIKHO_LATEST_VERSION_CODE = '27';
    const maint = (await built.app.inject({ url: '/health' })).json();
    assert.equal(maint.status, 'maintenance');
    assert.equal(maint.maintenance.active, true);
    assert.equal(maint.clientVersion.latestCode, 27);
    assert.equal(maint.clientVersion.updateUrl, 'https://sikhotrading.in/');
  } finally {
    if (prevMaint === undefined) delete process.env.SIKHO_MAINTENANCE_MODE;
    else process.env.SIKHO_MAINTENANCE_MODE = prevMaint;
    if (prevLatest === undefined) delete process.env.SIKHO_LATEST_VERSION_CODE;
    else process.env.SIKHO_LATEST_VERSION_CODE = prevLatest;
    await built.app.close();
  }
});
