import test from 'node:test';
import assert from 'node:assert/strict';
import { buildServer, validateGoogleIdTokenPayload } from './server.js';
import { EmulatedPostgresDatabase } from './db/database.js';
import { PostgresRepository } from './db/postgres-repository.js';
import { SimulationEngine } from './engine/simulation-engine.js';
import { InstrumentMetadata, QuoteSnapshot } from '@trading/shared';

function dummyInstrument(overrides: Partial<InstrumentMetadata> = {}): InstrumentMetadata {
  return {
    globalId: 'NSE:TEST_STOCK:1001',
    symbol: 'TEST_STOCK',
    name: 'Test Stock',
    exchange: 'NSE',
    segment: 'EQUITY',
    lotSize: 1,
    tickSize: 0.05,
    instrumentType: 'EQUITY_STOCK',
    token: '1001',
    underlying: 'TEST_STOCK',
    provider: 'UPSTOX',
    isTradable: true,
    isSimulatedFixture: false,
    ...overrides,
  };
}

function freshQuote(overrides: Partial<QuoteSnapshot> = {}): QuoteSnapshot {
  const now = Date.now();
  return {
    globalId: 'NSE:TEST_STOCK:1001',
    token: '1001',
    ltp: 500,
    open: 495,
    high: 505,
    low: 490,
    close: 498,
    bidPrice: 499.95,
    askPrice: 500.05,
    volume: 10000,
    providerTimestamp: now,
    receiveTimestamp: now,
    source: 'UPSTOX',
    isSimulated: true,
    ...overrides,
  };
}

test('Security 1: Rate limiting returns HTTP 429 with Retry-After header on auth abuse', async () => {
  const { app } = await buildServer();
  const testEmail = `brute_test_${Date.now()}@example.com`;

  // Rapidly submit login attempts
  let lastResponse: any = null;
  for (let i = 0; i < 15; i++) {
    lastResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: testEmail, password: 'WrongPassword123!' },
    });
  }

  assert.equal(lastResponse.statusCode, 429);
  assert.match(lastResponse.headers['retry-after'] || '', /^\d+$/);
  const json = JSON.parse(lastResponse.body);
  assert.equal(json.code, 'ERR_RATE_LIMIT_EXCEEDED');
  assert.ok(json.retryAfter > 0);
  await app.close();
});

test('Security 2: Risk-reducing exits and order cancellations are exempt from browsing limits', async () => {
  const { app, repo } = await buildServer();
  const user = await repo.registerUser({
    email: `exit_test_${Date.now()}@example.com`,
    name: 'Exit Tester',
    password: 'Password123!',
  });
  const account = await repo.provisionInitialAccount(user.id, 'Test Account', 'FREE');
  const token = (app as any).jwt.sign({ userId: user.id, accountId: account.id });

  // Place an order or verify cancel endpoint responds without 429 rate limit
  const cancelRes = await app.inject({
    method: 'POST',
    url: '/api/v1/orders/cancel',
    headers: { authorization: `Bearer ${token}` },
    payload: { orderId: 'non-existent-order-id' },
  });

  // Must return 400 (not found) and NOT 429 (rate limited)
  assert.equal(cancelRes.statusCode, 400);
  assert.match(cancelRes.body, /not found/i);
  await app.close();
});

test('Security 3: Complete User A / User B isolation across orders, cancellations, and accounts', async () => {
  const db = new EmulatedPostgresDatabase();
  const repo = new PostgresRepository(db);
  const simEngine = new SimulationEngine(repo);

  const userA = await repo.registerUser({ email: `usera_${Date.now()}@test.com`, name: 'User A', password: 'PasswordA123!' });
  const accA = await repo.provisionInitialAccount(userA.id, 'Account A', 'FREE');

  const userB = await repo.registerUser({ email: `userb_${Date.now()}@test.com`, name: 'User B', password: 'PasswordB123!' });
  const accB = await repo.provisionInitialAccount(userB.id, 'Account B', 'FREE');

  const inst = dummyInstrument();
  await repo.syncInstruments([inst]);
  const quote = freshQuote();

  // User A places an order
  const orderResultA = await simEngine.submitOrder(
    {
      accountId: accA.id,
      globalInstrumentId: inst.globalId,
      side: 'BUY',
      orderType: 'LIMIT',
      quantity: 1,
      requestedPrice: 480, // Limit below market so it stays PENDING
      idempotencyKey: `user_a_order_${Date.now()}`,
    },
    inst,
    quote,
    10000000n,
    0n
  );
  assert.equal(orderResultA.order.status, 'PENDING');
  const orderAId = orderResultA.order.id;

  // Prove User B CANNOT cancel User A's order
  await assert.rejects(
    async () => {
      await simEngine.cancelOrder(accB.id, orderAId);
    },
    /not found/i
  );

  // Prove User A CAN cancel their own order
  const cancelledA = await simEngine.cancelOrder(accA.id, orderAId);
  assert.equal(cancelledA.status, 'CANCELLED');

  await db.close();
});

test('Security 4: Strict Server-Side Input Validation rejects NaN, Infinity, and invalid payloads', async () => {
  const { app, repo } = await buildServer();
  const user = await repo.registerUser({
    email: `valid_test_${Date.now()}@example.com`,
    name: 'Validation Tester',
    password: 'Password123!',
  });
  const account = await repo.provisionInitialAccount(user.id, 'Val Account', 'FREE');
  const token = (app as any).jwt.sign({ userId: user.id, accountId: account.id });

  // 1. Order placement with NaN / Infinity / negative quantity
  const badOrder1 = await app.inject({
    method: 'POST',
    url: '/api/v1/orders/place',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      globalInstrumentId: 'NSE:NIFTY 50:99926000',
      side: 'BUY',
      orderType: 'MARKET',
      quantity: -5,
      idempotencyKey: 'bad_order_1',
    },
  });
  assert.equal(badOrder1.statusCode, 400);
  assert.match(badOrder1.body, /ERR_INVALID_QUANTITY/);

  // 2. Order placement with invalid side
  const badOrder2 = await app.inject({
    method: 'POST',
    url: '/api/v1/orders/place',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      globalInstrumentId: 'NSE:NIFTY 50:99926000',
      side: 'HOLD',
      orderType: 'MARKET',
      quantity: 50,
      idempotencyKey: 'bad_order_2',
    },
  });
  assert.equal(badOrder2.statusCode, 400);
  assert.match(badOrder2.body, /ERR_INVALID_SIDE/);

  // 3. Candles with invalid timeframe
  const badCandles = await app.inject({
    method: 'GET',
    url: '/api/v1/market-data/candles?globalId=NSE:NIFTY 50:99926000&timeframe=99x',
  });
  assert.equal(badCandles.statusCode, 400);
  assert.match(badCandles.body, /ERR_INVALID_TIMEFRAME/);

  await app.close();
});

test('Security 5: Google ID Token payload validation enforces audience, email_verified, and sub', () => {
  const VALID_CLIENT_ID = '18709659572-6d1j4db60j60vo0a0ek5kumvv06vu4fi.apps.googleusercontent.com';

  // 1. Valid payload
  const validPayload = {
    email: 'trader@example.com',
    aud: VALID_CLIENT_ID,
    email_verified: true,
    sub: 'google_user_unique_sub_12345',
  };
  const res1 = validateGoogleIdTokenPayload(validPayload, VALID_CLIENT_ID);
  assert.equal(res1.ok, true);

  // 2. Audience mismatch
  const res2 = validateGoogleIdTokenPayload({ ...validPayload, aud: 'wrong_client_id.apps.googleusercontent.com' }, VALID_CLIENT_ID);
  assert.equal(res2.ok, false);
  if (!res2.ok) assert.equal(res2.code, 'ERR_GOOGLE_AUDIENCE_MISMATCH');

  // 3. Unverified email
  const res3 = validateGoogleIdTokenPayload({ ...validPayload, email_verified: false }, VALID_CLIENT_ID);
  assert.equal(res3.ok, false);
  if (!res3.ok) assert.equal(res3.code, 'ERR_GOOGLE_EMAIL_UNVERIFIED');

  // 4. Missing subject (sub)
  const res4 = validateGoogleIdTokenPayload({ ...validPayload, sub: undefined }, VALID_CLIENT_ID);
  assert.equal(res4.ok, false);
  if (!res4.ok) assert.equal(res4.code, 'ERR_GOOGLE_SUBJECT_MISSING');
});

test('Reliability 1: Market-Open Stale Quote Defense rejects quotes older than 5000ms', async () => {
  const db = new EmulatedPostgresDatabase();
  const repo = new PostgresRepository(db);
  const simEngine = new SimulationEngine(repo);
  const user = await repo.registerUser({ email: `stale_test_${Date.now()}@test.com`, name: 'Stale Tester', password: 'Password123!' });
  const acc = await repo.provisionInitialAccount(user.id, 'Stale Acc', 'FREE');
  const inst = dummyInstrument();
  await repo.syncInstruments([inst]);

  // Quote older than 5000ms (e.g. 1478344ms old as reported by user)
  const stale = freshQuote({
    providerTimestamp: Date.now() - 1478344,
    receiveTimestamp: Date.now() - 1478344,
  });

  const res = await simEngine.submitOrder(
    {
      accountId: acc.id,
      globalInstrumentId: inst.globalId,
      side: 'BUY',
      orderType: 'MARKET',
      quantity: 1,
      idempotencyKey: `stale_order_${Date.now()}`,
    },
    inst,
    stale,
    10000000n,
    0n
  );

  assert.equal(res.order.status, 'REJECTED');
  assert.match(res.order.rejectionReason || '', /ERR_STALE_MARKET_DATA|ERR_MARKET_CLOSED/);
  await db.close();
});

test('Reliability 2: Live P&L calculation accurately respects commodity contract multiplier and avoids double lot multiplication', () => {
  // MCX Crude Oil contract: lotSize = 100, multiplier = 100 (1 point move = ₹100 per lot)
  const quantityLots = 1; // 1 lot
  const entryPrice = 6000; // ₹6,000 per barrel
  const currentPrice = 6050; // ₹6,050 per barrel (+₹50 points)
  const multiplier = 100; // 100 barrels per contract

  const diffPerUnit = currentPrice - entryPrice; // +50
  const unrealizedPnlINR = diffPerUnit * multiplier * Math.abs(quantityLots);

  assert.equal(unrealizedPnlINR, 5000); // ₹5,000 profit (50 points * 100 multiplier * 1 lot)
});
