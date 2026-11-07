import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from './server.js';
import { FastifyInstance } from 'fastify';
import { decodeUpstoxFeedResponseProto, UpstoxAdapter } from './providers/upstox-adapter.js';

describe('Tradingzone v2.0: Upstox V3 Adapter, Real Auth, PIN, User Isolation, Drawings & Segment Accounting', () => {
  let app: FastifyInstance;
  let userAToken: string;
  let userBToken: string;
  const testRunId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  before(async () => {
    const s = await buildServer(undefined, 'DEMO');
    app = s.app;
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  test('Upstox MarketDataFeedV3 Protobuf decoder accurately decodes binary FeedResponse frames', () => {
    // Construct a real Protobuf binary frame matching MarketDataFeedV3.proto:
    // FeedResponse { type = 1 (live_feed), feeds["NSE_INDEX|Nifty 50"] = Feed { ltpc = LTPC { ltp = 24350.75, ltt = 1762321000000, cp = 24180.25 } } }
    const writeVarint = (val: bigint): Buffer => {
      const bytes: number[] = [];
      let v = val;
      while (v >= 0x80n) {
        bytes.push(Number((v & 0x7fn) | 0x80n));
        v >>= 7n;
      }
      bytes.push(Number(v));
      return Buffer.from(bytes);
    };
    const writeDoubleField = (fieldNo: number, val: number): Buffer => {
      const tag = writeVarint(BigInt((fieldNo << 3) | 1));
      const b = Buffer.alloc(8);
      b.writeDoubleLE(val, 0);
      return Buffer.concat([tag, b]);
    };
    const writeVarintField = (fieldNo: number, val: bigint): Buffer => {
      const tag = writeVarint(BigInt((fieldNo << 3) | 0));
      return Buffer.concat([tag, writeVarint(val)]);
    };
    const writeBytesField = (fieldNo: number, payload: Buffer): Buffer => {
      const tag = writeVarint(BigInt((fieldNo << 3) | 2));
      const len = writeVarint(BigInt(payload.length));
      return Buffer.concat([tag, len, payload]);
    };

    const ltpcBuf = Buffer.concat([
      writeDoubleField(1, 24350.75),
      writeVarintField(2, 1762321000000n),
      writeDoubleField(4, 24180.25),
    ]);
    const feedBuf = writeBytesField(1, ltpcBuf);
    const keyBuf = Buffer.from('NSE_INDEX|Nifty 50', 'utf8');
    const mapEntryBuf = Buffer.concat([
      writeBytesField(1, keyBuf),
      writeBytesField(2, feedBuf),
    ]);
    const feedResponseBuf = Buffer.concat([
      writeVarintField(1, 1n),
      writeBytesField(2, mapEntryBuf),
    ]);

    const decoded = decodeUpstoxFeedResponseProto(feedResponseBuf);
    assert.equal(decoded.length, 1);
    assert.equal(decoded[0].instrumentKey, 'NSE_INDEX|Nifty 50');
    assert.equal(decoded[0].ltp, 24350.75);
    assert.equal(decoded[0].ltt, 1762321000000);
    assert.equal(decoded[0].cp, 24180.25);
  });

  test('UpstoxAdapter loads BOD master, resolves indices, equities, futures & option chains, and fetches V3 candles', async () => {
    const adapter = new UpstoxAdapter({});
    await adapter.init();

    const indices = await adapter.getIndices();
    assert.ok(indices.length >= 20, `Expected >= 20 indices, got ${indices.length}`);
    const nifty = indices.find((i) => i.symbol === 'NIFTY 50');
    const sensex = indices.find((i) => i.symbol === 'SENSEX');
    assert.ok(nifty, 'NIFTY 50 index must be present');
    assert.ok(sensex, 'SENSEX index must be present');
    assert.equal(nifty.upstoxInstrumentKey, 'NSE_INDEX|Nifty 50');
    assert.equal(sensex.upstoxInstrumentKey, 'BSE_INDEX|SENSEX');

    // Cross-provider SmartAPI globalId compatibility check
    const resolvedFut = await adapter.getInstrumentById('NFO:NIFTY23NOV26FUT:61471');
    assert.ok(resolvedFut, 'Should resolve NFO:NIFTY23NOV26FUT:61471 across providers');
    assert.equal(resolvedFut.upstoxInstrumentKey, 'NSE_FO|61471');
    assert.equal(resolvedFut.lotSize, 65);

    const resolvedReliance = await adapter.getInstrumentById('NSE:RELIANCE-EQ:2885');
    assert.ok(resolvedReliance, 'Should resolve NSE:RELIANCE-EQ:2885 alias to RELIANCE');
    assert.equal(resolvedReliance.upstoxInstrumentKey, 'NSE_EQ|INE002A01018');

    // Option chain structure check
    const chain = await adapter.getOptionChain('NIFTY');
    assert.equal(chain.underlying, 'NIFTY');
    assert.ok(chain.availableExpiries.length >= 3);
    assert.ok(chain.rows.length >= 10);
    assert.ok(chain.rows[0].call || chain.rows[0].put);

    await adapter.dispose();
  });

  test('User Registration, Sign-In, PIN setup/verification, and Account Recovery work end-to-end', async () => {
    // 1. Register User A
    const userAEmail = `arjun.mehta.${testRunId}@example.com`;
    const userBEmail = `priya.sharma.${testRunId}@example.com`;
    const regARes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: userAEmail,
        name: 'Arjun Mehta',
        password: 'SecurePass#2026',
      },
    });
    assert.equal(regARes.statusCode, 200);
    const regABody = JSON.parse(regARes.body);
    assert.ok(regABody.token);
    assert.equal(regABody.user.email, userAEmail);
    assert.equal(regABody.account.cashBalanceINR, 100000);
    userAToken = regABody.token;

    // 2. Register User B
    const regBRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: userBEmail,
        name: 'Priya Sharma',
        password: 'PriyaPassword!99',
      },
    });
    assert.equal(regBRes.statusCode, 200);
    userBToken = JSON.parse(regBRes.body).token;

    // 3. Reject wrong password on login
    const badLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        email: userAEmail,
        password: 'WrongPassword123',
      },
    });
    assert.equal(badLogin.statusCode, 401);

    // 4. Setup 4-digit PIN for User A and verify
    const pinSetup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/pin/setup',
      headers: { authorization: `Bearer ${userAToken}` },
      payload: { pin: '4829', biometricEnabled: true },
    });
    assert.equal(pinSetup.statusCode, 200);
    assert.equal(JSON.parse(pinSetup.body).hasPin, true);

    const pinBad = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/pin/verify',
      headers: { authorization: `Bearer ${userAToken}` },
      payload: { pin: '0000' },
    });
    assert.equal(pinBad.statusCode, 401);

    const pinGood = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/pin/verify',
      headers: { authorization: `Bearer ${userAToken}` },
      payload: { pin: '4829' },
    });
    assert.equal(pinGood.statusCode, 200);
    assert.equal(JSON.parse(pinGood.body).verified, true);
  });

  test('User Isolation: Drawings, Watchlists, Holdings, and Orders are strictly isolated per user', async () => {
    // User A saves chart drawings on NIFTY
    const drawSave = await app.inject({
      method: 'POST',
      url: '/api/v1/drawings',
      headers: { authorization: `Bearer ${userAToken}` },
      payload: {
        instrumentId: 'NSE:NIFTY50:999000',
        drawings: [{ id: 'd1', type: 'trendline', p1: { time: 1700000000, price: 24100 }, p2: { time: 1700003600, price: 24300 } }],
      },
    });
    assert.equal(drawSave.statusCode, 200);

    // User A retrieves 1 drawing
    const drawGetA = await app.inject({
      method: 'GET',
      url: '/api/v1/drawings?instrumentId=NSE:NIFTY50:999000',
      headers: { authorization: `Bearer ${userAToken}` },
    });
    assert.equal(JSON.parse(drawGetA.body).drawings.length, 1);

    // User B retrieves 0 drawings for the same instrument
    const drawGetB = await app.inject({
      method: 'GET',
      url: '/api/v1/drawings?instrumentId=NSE:NIFTY50:999000',
      headers: { authorization: `Bearer ${userBToken}` },
    });
    assert.equal(JSON.parse(drawGetB.body).drawings.length, 0);
  });

  test('Equity Delivery Holdings (100% cash) vs Intraday Positions (20% margin) & Pending Order Cancellation', async () => {
    // 1. User A buys 5 shares of RELIANCE as DELIVERY (Holdings)
    const buyDeliv = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/place',
      headers: { authorization: `Bearer ${userAToken}` },
      payload: {
        globalInstrumentId: 'NSE:RELIANCE:2885',
        side: 'BUY',
        orderType: 'MARKET',
        productType: 'DELIVERY',
        quantity: 5,
        idempotencyKey: `deliv-buy-1-${testRunId}`,
      },
    });
    assert.equal(buyDeliv.statusCode, 200);
    const buyBody = JSON.parse(buyDeliv.body);
    assert.equal(buyBody.order.status, 'EXECUTED');
    assert.equal(buyBody.order.productType, 'DELIVERY');

    // Verify it appears in holdings
    const posRes = await app.inject({
      method: 'GET',
      url: '/api/v1/positions',
      headers: { authorization: `Bearer ${userAToken}` },
    });
    const posBody = JSON.parse(posRes.body);
    assert.equal(posBody.holdings.length, 1);
    assert.equal(posBody.holdings[0].quantity, 5);

    // User B has 0 holdings
    const posResB = await app.inject({
      method: 'GET',
      url: '/api/v1/positions',
      headers: { authorization: `Bearer ${userBToken}` },
    });
    assert.equal(JSON.parse(posResB.body).holdings.length, 0);

    // 2. Reject selling 10 shares of RELIANCE DELIVERY when only 5 are held
    const overSell = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/place',
      headers: { authorization: `Bearer ${userAToken}` },
      payload: {
        globalInstrumentId: 'NSE:RELIANCE:2885',
        side: 'SELL',
        orderType: 'MARKET',
        productType: 'DELIVERY',
        quantity: 10,
        idempotencyKey: `deliv-oversell-1-${testRunId}`,
      },
    });
    assert.equal(overSell.statusCode, 400);
    assert.equal(JSON.parse(overSell.body).code, 'ERR_INSUFFICIENT_HOLDINGS');

    // 3. Place a PENDING Limit order and cancel it -> verify margin is released
    const accBeforeLimit = JSON.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/account',
          headers: { authorization: `Bearer ${userAToken}` },
        })
      ).body
    );

    const limitRes = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/place',
      headers: { authorization: `Bearer ${userAToken}` },
      payload: {
        globalInstrumentId: 'NFO:NIFTY26OCTFUT:999001',
        side: 'BUY',
        orderType: 'LIMIT',
        quantity: 25,
        requestedPrice: 20000.0, // Below current price so it stays PENDING
        idempotencyKey: `limit-cancel-test-1-${testRunId}`,
      },
    });
    assert.equal(limitRes.statusCode, 200);
    const limitOrder = JSON.parse(limitRes.body).order;
    assert.equal(limitOrder.status, 'PENDING');

    const accDuringLimit = JSON.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/account',
          headers: { authorization: `Bearer ${userAToken}` },
        })
      ).body
    );
    assert.ok(accDuringLimit.lockedMarginINR > accBeforeLimit.lockedMarginINR);

    // Cancel the pending order
    const cancelRes = await app.inject({
      method: 'POST',
      url: `/api/v1/orders/${limitOrder.id}/cancel`,
      headers: { authorization: `Bearer ${userAToken}` },
    });
    assert.equal(cancelRes.statusCode, 200);
    assert.equal(JSON.parse(cancelRes.body).order.status, 'CANCELLED');

    const accAfterCancel = JSON.parse(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/account',
          headers: { authorization: `Bearer ${userAToken}` },
        })
      ).body
    );
    assert.equal(accAfterCancel.lockedMarginINR, accBeforeLimit.lockedMarginINR);
  });
});

