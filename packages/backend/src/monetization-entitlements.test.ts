import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { FastifyInstance } from 'fastify';
import { buildServer } from './server.js';
import { IDatabase } from './db/database.js';
import { BillingService } from './monetization/billing-service.js';
import { IMarketDataProvider } from './providers/types.js';

describe('Monetization, Billing Authorization, Entitlements & Direct Bypass Protection', () => {
  let app: FastifyInstance;
  let db: IDatabase;
  let provider: IMarketDataProvider;
  let billingService: BillingService;

  before(async () => {
    const serverBundle = await buildServer(undefined, 'UPSTOX');
    app = serverBundle.app;
    db = serverBundle.db;
    provider = serverBundle.provider;
    billingService = new BillingService(db);
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it('1. verifyPurchaseToken fails closed with CONFIGURATION_REQUIRED when Google Play credentials are unconfigured', async () => {
    const userId = `test_user_billing_${Date.now()}`;
    const unconfiguredBilling = new BillingService(db);
    assert.equal(unconfiguredBilling.isGooglePlayConfigured(), false);

    const res = await unconfiguredBilling.verifyPurchaseToken(userId, 'plan_month_100', 'client_submitted_token_123');
    assert.equal(res.success, false);
    assert.equal(res.code, 'CONFIGURATION_REQUIRED');
    assert.equal(res.tier, 'FREE');
    assert.match(res.error || '', /Google Play Developer API service account credentials/);
  });

  it('2. verifyPurchaseToken rejects empty purchase token and invalid plan ID', async () => {
    const userId = `test_user_billing_err_${Date.now()}`;
    const unconfiguredBilling = new BillingService(db);

    const resEmpty = await unconfiguredBilling.verifyPurchaseToken(userId, 'plan_month_100', '');
    assert.equal(resEmpty.success, false);
    assert.equal(resEmpty.code, 'ERR_EMPTY_TOKEN');

    const resInvalidPlan = await unconfiguredBilling.verifyPurchaseToken(userId, 'non_existent_plan', 'token_valid_123');
    assert.equal(resInvalidPlan.success, false);
    assert.equal(resInvalidPlan.code, 'ERR_INVALID_PLAN');
  });

  it('3. verifyPurchaseToken detects and strictly blocks token replay attacks across user accounts', async () => {
    const userA = `user_a_${Date.now()}`;
    const userB = `user_b_${Date.now()}`;

    const loginA = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/dev-login',
      payload: { userId: userA, email: `${userA}@example.com`, name: 'User A', tier: 'FREE' },
    });
    const actualUserA = JSON.parse(loginA.payload).user.userId;

    const loginB = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/dev-login',
      payload: { userId: userB, email: `${userB}@example.com`, name: 'User B', tier: 'FREE' },
    });
    const actualUserB = JSON.parse(loginB.payload).user.userId;

    const sharedToken = `licensed_play_token_${Date.now()}`;

    // Run test billing in test mode to simulate a verified first purchase
    const testBilling = new BillingService(db);
    testBilling.enableTestMode(true);

    const purchaseA = await testBilling.verifyPurchaseToken(actualUserA, 'plan_month_100', sharedToken);
    assert.equal(purchaseA.success, true);
    assert.equal(purchaseA.tier, 'PRO');

    // User B attempts to replay the same purchase token
    const purchaseB = await testBilling.verifyPurchaseToken(actualUserB, 'plan_month_100', sharedToken);
    assert.equal(purchaseB.success, false);
    assert.equal(purchaseB.code, 'ERR_TOKEN_REPLAY');
    assert.match(purchaseB.error || '', /already been associated with another user/);
  });

  it('4. Free tier direct access-control bypass: strictly blocks SENSEX, Equities and Commodities candles and quotes', async () => {
    // 4A. SENSEX spot index candles
    const sensexCandlesRes = await app.inject({
      method: 'GET',
      url: '/api/v1/market-data/candles?globalId=BSE:SENSEX:99919000',
    });
    assert.equal(sensexCandlesRes.statusCode, 403);
    const sensexBody = JSON.parse(sensexCandlesRes.body);
    assert.equal(sensexBody.code, 'UPGRADE_REQUIRED');

    // 4B. SENSEX spot index quote
    const sensexQuoteRes = await app.inject({
      method: 'GET',
      url: '/api/v1/market-data/quote?globalId=BSE:SENSEX:99919000',
    });
    assert.equal(sensexQuoteRes.statusCode, 403);

    // 4C. Equity cash stock candles (RELIANCE)
    const relianceCandlesRes = await app.inject({
      method: 'GET',
      url: '/api/v1/market-data/candles?globalId=NSE:RELIANCE:2885',
    });
    assert.equal(relianceCandlesRes.statusCode, 403);

    // 4D. MCX Commodity candles (CRUDE OIL)
    const mcxCandlesRes = await app.inject({
      method: 'GET',
      url: '/api/v1/market-data/candles?globalId=MCX:CRUDEOIL24NOVFUT:1001',
    });
    assert.equal(mcxCandlesRes.statusCode, 403);

    // 4E. SENSEX option chain
    const sensexOptionChainRes = await app.inject({
      method: 'GET',
      url: '/api/v1/option-chain?underlying=SENSEX',
    });
    assert.equal(sensexOptionChainRes.statusCode, 403);
  });

  it('5. Entitlement auto-downgrade allows viewing and exiting existing restricted positions, but blocks new exposure', async () => {
    const proTraderId = `pro_trader_${Date.now()}`;
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/dev-login',
      payload: { userId: proTraderId, email: `${proTraderId}@example.com`, name: 'Expired Pro Trader', tier: 'PRO' },
    });
    const { token, user, account } = JSON.parse(loginRes.payload);
    const expiredUserId = user.userId;
    const accountId = account.id;

    // Find restricted equity instrument (RELIANCE or first equity stock)
    const instruments = await provider.getInstruments();
    const equityInst = instruments.find((i: any) => i.instrumentType === 'EQUITY_STOCK') || instruments.find((i: any) => i.exchange === 'NSE' && i.lotSize === 1);
    assert.ok(equityInst, 'Should find equity instrument');

    // Seed quote in provider
    (provider as any).quotes?.set(equityInst.globalId, {
      globalId: equityInst.globalId,
      token: equityInst.token,
      ltp: 2920.0,
      open: 2900.0,
      high: 2950.0,
      low: 2890.0,
      close: 2910.0,
      bidPrice: 2919.5,
      askPrice: 2920.5,
      volume: 50000,
      providerTimestamp: Date.now(),
      receiveTimestamp: Date.now(),
      source: 'UPSTOX',
      isSimulated: true,
    });

    // 1. As a PRO user, buy the stock
    const buyOrderRes = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/place',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        globalInstrumentId: equityInst.globalId,
        side: 'BUY',
        productType: 'DELIVERY',
        orderType: 'MARKET',
        quantity: equityInst.lotSize,
        idempotencyKey: `idem_pro_buy_${Date.now()}`,
      },
    });
    if (buyOrderRes.statusCode !== 200) {
      console.error('BUY EQUITY FAILED:', buyOrderRes.statusCode, buyOrderRes.payload);
    }
    assert.equal(buyOrderRes.statusCode, 200);

    // 2. Simulate user's Premium Pro subscription expired
    await db.query(
      "UPDATE virtual_accounts SET tier = 'FREE', subscription_expires_at = $1 WHERE id = $2",
      [Date.now() - 1000, accountId]
    );

    // 5A. Check tier has downgraded to FREE
    const currentTier = await billingService.getAccountTier(expiredUserId);
    assert.equal(currentTier, 'FREE');

    // 5B. Existing restricted positions CAN still be viewed by the user
    const posRes = await app.inject({
      method: 'GET',
      url: '/api/v1/positions',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(posRes.statusCode, 200);
    const posBody = JSON.parse(posRes.body);
    const relPos = posBody.positions.find((p: any) => p.globalInstrumentId === equityInst.globalId);
    assert.ok(relPos, 'Existing restricted position must be viewable upon expiry');
    assert.equal(relPos.quantity, equityInst.lotSize);

    // 5C. Adding new exposure on restricted instrument is strictly blocked
    const newBuyOrderRes = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/place',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        globalInstrumentId: equityInst.globalId,
        side: 'BUY',
        productType: 'DELIVERY',
        orderType: 'MARKET',
        quantity: equityInst.lotSize,
        idempotencyKey: `idem_buy_${Date.now()}`,
      },
    });
    assert.equal(newBuyOrderRes.statusCode, 403);
    const buyBody = JSON.parse(newBuyOrderRes.body);
    assert.equal(buyBody.code, 'ERR_PRO_TIER_REQUIRED');

    // 5D. Risk-reducing exit order on restricted instrument is ALLOWED
    const exitSellOrderRes = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/place',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        globalInstrumentId: equityInst.globalId,
        side: 'SELL',
        productType: 'DELIVERY',
        orderType: 'MARKET',
        quantity: equityInst.lotSize,
        idempotencyKey: `idem_sell_${Date.now()}`,
      },
    });
    assert.equal(exitSellOrderRes.statusCode, 200);
    const sellBody = JSON.parse(exitSellOrderRes.body);
    assert.equal(sellBody.success, true);
    assert.equal(sellBody.position.quantity, 0);
  });

  it('6. Capital Reset rejects reset when open positions exist, and preserves lifetime metrics across resets', async () => {
    const traderId = `usr_reset_${Date.now()}`;
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/dev-login',
      payload: { userId: traderId, email: `${traderId}@example.com`, name: 'Reset Tester', tier: 'FREE' },
    });
    const { token } = JSON.parse(loginRes.payload);

    // Get an allowed instrument for FREE tier (NIFTY future)
    const instruments = await provider.getInstruments();
    const niftyFut = instruments.find((i: any) => i.symbol.includes('NIFTY') && i.symbol.includes('FUT'));
    assert.ok(niftyFut, 'Should find NIFTY FUT contract');

    // Seed quote in provider
    (provider as any).quotes?.set(niftyFut.globalId, {
      globalId: niftyFut.globalId,
      token: niftyFut.token,
      ltp: 24500.0,
      open: 24400.0,
      high: 24600.0,
      low: 24350.0,
      close: 24450.0,
      bidPrice: 24499.0,
      askPrice: 24501.0,
      volume: 100000,
      providerTimestamp: Date.now(),
      receiveTimestamp: Date.now(),
      source: 'UPSTOX',
      isSimulated: true,
    });

    // Place an intraday position on NIFTY FUT
    const buyFutRes = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/place',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        globalInstrumentId: niftyFut.globalId,
        side: 'BUY',
        productType: 'INTRADAY',
        orderType: 'MARKET',
        quantity: niftyFut.lotSize,
        idempotencyKey: `idem_fut_${Date.now()}`,
      },
    });
    if (buyFutRes.statusCode !== 200) {
      console.error('BUY FUT FAILED:', buyFutRes.statusCode, buyFutRes.payload);
    }
    assert.equal(buyFutRes.statusCode, 200);

    // 6A. Reset while position is open MUST be strictly rejected
    const resetAttempt1 = await app.inject({
      method: 'POST',
      url: '/api/v1/account/reset',
      headers: { authorization: `Bearer ${token}` },
      payload: { startingCapitalINR: 100000 },
    });
    assert.equal(resetAttempt1.statusCode, 400);
    const rejBody = JSON.parse(resetAttempt1.body);
    assert.equal(rejBody.code, 'ERR_OPEN_POSITIONS_EXIST');

    // Square off the open position
    const sqOffRes = await app.inject({
      method: 'POST',
      url: '/api/v1/positions/square-off',
      headers: { authorization: `Bearer ${token}` },
      payload: { globalInstrumentId: niftyFut.globalId },
    });
    assert.equal(sqOffRes.statusCode, 200);

    // 6B. Free tier attempting unapproved preset (e.g. ₹50 Lakh) is rejected
    const unapprovedReset = await app.inject({
      method: 'POST',
      url: '/api/v1/account/reset',
      headers: { authorization: `Bearer ${token}` },
      payload: { startingCapitalINR: 5000000 },
    });
    assert.equal(unapprovedReset.statusCode, 403);
    const unapprovedBody = JSON.parse(unapprovedReset.body);
    assert.equal(unapprovedBody.code, 'ERR_PRO_TIER_REQUIRED');

    // 6C. Reset succeeds with allowed ₹100,000 preset and preserves lifetime P&L
    const validReset = await app.inject({
      method: 'POST',
      url: '/api/v1/account/reset',
      headers: { authorization: `Bearer ${token}` },
      payload: { startingCapitalINR: 100000 },
    });
    assert.equal(validReset.statusCode, 200);
    const resetData = JSON.parse(validReset.body);
    assert.equal(resetData.account.startingBalanceINR, 100000);
    assert.equal(resetData.account.cashBalanceINR, 100000);
    assert.ok(resetData.lifetime.lifetimeTradesCount >= 1 || resetData.lifetime.totalSessionsCount >= 1);
  });

  it('7. Real email registration, login, and recovery strictly start and remain FREE (never auto-upgrading to PRO)', async () => {
    const email = `new.free.user.${Date.now()}@sikhotrading.com`;
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: 'Password#123', name: 'New Free Trader' },
    });
    assert.equal(regRes.statusCode, 200);
    const regData = JSON.parse(regRes.body);
    assert.equal(regData.user.tier, 'FREE');
    assert.equal(regData.account.tier, 'FREE');
    assert.equal(regData.entitlement.tier, 'FREE');
    assert.equal(regData.entitlement.entitlementSource, 'NONE');

    // Subsequent login must also remain FREE
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'Password#123' },
    });
    assert.equal(loginRes.statusCode, 200);
    const loginData = JSON.parse(loginRes.body);
    assert.equal(loginData.user.tier, 'FREE');
    assert.equal(loginData.account.tier, 'FREE');

    // Billing status endpoint returns FREE
    const statusRes = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/status',
      headers: { authorization: `Bearer ${loginData.token}` },
    });
    assert.equal(statusRes.statusCode, 200);
    const statusData = JSON.parse(statusRes.body);
    assert.equal(statusData.tier, 'FREE');
    assert.equal(statusData.entitlementSource, 'NONE');

    // Restricted quote is blocked with 403 UPGRADE_REQUIRED
    const quoteRes = await app.inject({
      method: 'GET',
      url: '/api/v1/market-data/quote?globalId=NSE:RELIANCE:2885',
      headers: { authorization: `Bearer ${loginData.token}` },
    });
    assert.equal(quoteRes.statusCode, 403);

    // Even if virtual_accounts.tier is tampered to PRO without a backing purchase or grant, resolveEntitlement heals it to FREE
    await db.query("UPDATE virtual_accounts SET tier = 'PRO' WHERE user_id = $1", [regData.user.userId]);
    const healedStatusRes = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/status',
      headers: { authorization: `Bearer ${loginData.token}` },
    });
    assert.equal(JSON.parse(healedStatusRes.body).tier, 'FREE');
  });

  it('8. Owner-admin complimentary grants bind to immutable userId + verified email, reject unregistered emails, and revoke cleanly', async () => {
    // 8A. Reject pre-granting to an unregistered email
    const unregGrant = await billingService.grantComplimentaryPro({
      email: `nonexistent.${Date.now()}@sikhotrading.com`,
      reason: 'Should fail for unregistered email',
      grantedBy: 'OWNER_ADMIN',
    });
    assert.equal(unregGrant.success, false);
    assert.equal(unregGrant.code, 'ERR_USER_NOT_FOUND');

    // 8B. Register a real user (starts FREE)
    const email = `comp.tester.${Date.now()}@sikhotrading.com`;
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: 'Password#123', name: 'Complimentary Tester' },
    });
    const { token, user } = JSON.parse(regRes.body);
    assert.equal(user.tier, 'FREE');

    // 8C. Reject grant if userId does not match email
    const mismatchGrant = await billingService.grantComplimentaryPro({
      userId: user.userId,
      email: 'wrong.email@sikhotrading.com',
      reason: 'Should fail on identity mismatch',
      grantedBy: 'OWNER_ADMIN',
    });
    assert.equal(mismatchGrant.success, false);
    assert.equal(mismatchGrant.code, 'ERR_USER_IDENTITY_MISMATCH');

    // 8D. Grant complimentary Pro bound to verified account
    const validGrant = await billingService.grantComplimentaryPro({
      userId: user.userId,
      email,
      reason: 'Owner-selected friend test access',
      grantedBy: 'OWNER_ADMIN',
    });
    assert.equal(validGrant.success, true);
    assert.equal(validGrant.entitlement?.tier, 'PRO');
    assert.equal(validGrant.entitlement?.entitlementSource, 'COMPLIMENTARY_GRANT');
    assert.equal(validGrant.entitlement?.statusLabel, 'Premium — complimentary test access');

    // Billing status shows complimentary label, not fabricated purchase receipt
    const statusRes = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/status',
      headers: { authorization: `Bearer ${token}` },
    });
    const statusBody = JSON.parse(statusRes.body);
    assert.equal(statusBody.tier, 'PRO');
    assert.equal(statusBody.isComplimentary, true);
    assert.equal(statusBody.entitlementSource, 'COMPLIMENTARY_GRANT');
    assert.equal(statusBody.statusLabel, 'Premium — complimentary test access');

    // Restricted quote is now accessible (200) and ads are suppressed
    const quoteRes = await app.inject({
      method: 'GET',
      url: '/api/v1/market-data/quote?globalId=NSE:RELIANCE:2885',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(quoteRes.statusCode, 200);

    const adOppRes = await app.inject({
      method: 'POST',
      url: '/api/v1/ads/app-open/opportunity',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(JSON.parse(adOppRes.body).isEligible, false);
    assert.equal(JSON.parse(adOppRes.body).reason, 'PRO_SUBSCRIPTION_ACTIVE');

    // 8E. Revoke complimentary grant -> immediately returns to FREE
    const revokeRes = await billingService.revokeComplimentaryPro({
      userId: user.userId,
      reason: 'Completed test period',
      revokedBy: 'OWNER_ADMIN',
    });
    assert.equal(revokeRes.success, true);
    assert.equal(revokeRes.entitlement?.tier, 'FREE');

    const statusAfterRevoke = await app.inject({
      method: 'GET',
      url: '/api/v1/billing/status',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(JSON.parse(statusAfterRevoke.body).tier, 'FREE');

    const quoteAfterRevoke = await app.inject({
      method: 'GET',
      url: '/api/v1/market-data/quote?globalId=NSE:RELIANCE:2885',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(quoteAfterRevoke.statusCode, 403);
  });
});
