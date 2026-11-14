import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { FastifyInstance } from 'fastify';
import { buildServer } from './server.js';
import { EmulatedPostgresDatabase, IDatabase } from './db/database.js';
import {
  BillingService,
  PlayPurchaseVerifier,
  PlayVerificationResult,
  createGooglePlayVerifier,
} from './monetization/billing-service.js';

/**
 * Membership integrity: a client-supplied purchase token must never become PRO unless the
 * live Google Play Developer API confirms it. These tests inject a fake verifier to prove the
 * accept/reject plumbing without contacting Google (unconfigured Play credentials can only
 * ever prove fail-closed behaviour, never a successful purchase).
 */
describe('Google Play purchase verification integrity', () => {
  const PACKAGE = 'com.indianpapertrading';
  const SERVICE_ACCOUNT_JSON = JSON.stringify({ client_email: 'svc@test.iam.gserviceaccount.com', private_key: 'x' });

  let db: IDatabase;

  before(() => {
    db = new EmulatedPostgresDatabase();
  });

  after(async () => {
    await db.close();
  });

  function verifierReturning(result: PlayVerificationResult): PlayPurchaseVerifier {
    return async () => result;
  }

  function configuredBilling(verifier: PlayPurchaseVerifier): BillingService {
    return new BillingService(db, SERVICE_ACCOUNT_JSON, verifier);
  }

  async function countSubscriptions(userId: string): Promise<number> {
    const res = await db.query('SELECT COUNT(*) as count FROM subscriptions WHERE user_id = $1', [userId]);
    return Number(res.rows[0].count);
  }

  it('rejects a purchase token when the Play API does not confirm it and writes no entitlement', async () => {
    const userId = `usr_play_reject_${Date.now()}`;
    const billing = configuredBilling(
      verifierReturning({
        verified: false,
        code: 'ERR_PLAY_TOKEN_INVALID',
        error: 'Google Play rejected the purchase token (HTTP 400).',
        verificationSource: 'GOOGLE_PLAY_VERIFIED',
      })
    );
    const res = await billing.verifyPurchaseToken(userId, 'plan_month_100', 'forged-token');
    assert.equal(res.success, false);
    assert.equal(res.code, 'ERR_PLAY_TOKEN_INVALID');
    assert.equal(res.tier, 'FREE');
    assert.equal(await countSubscriptions(userId), 0);
  });

  it('accepts only a Play-verified subscription whose product and expiry match the plan', async () => {
    const userId = `usr_play_accept_${Date.now()}`;
    const expiry = Date.now() + 30 * 24 * 60 * 60 * 1000;
    const billing = configuredBilling(async (params) => {
      assert.equal(params.packageName, PACKAGE);
      assert.equal(params.productId, 'plan_month_100');
      assert.equal(params.isSubscription, true);
      assert.equal(params.purchaseToken, 'real-play-token');
      return {
        verified: true,
        packageName: PACKAGE,
        productId: 'plan_month_100',
        expiryTimeMillis: expiry,
        isAutoRenewing: true,
        verificationSource: 'GOOGLE_PLAY_VERIFIED',
      };
    });

    const res = await billing.verifyPurchaseToken(userId, 'plan_month_100', 'real-play-token');
    assert.equal(res.success, true);
    assert.equal(res.tier, 'PRO');
    assert.equal(res.expiresAt, expiry);

    const row = await db.query('SELECT verification_source, expires_at FROM subscriptions WHERE user_id = $1', [userId]);
    assert.equal(row.rows.length, 1);
    assert.equal(row.rows[0].verification_source, 'GOOGLE_PLAY_VERIFIED');
    assert.equal(Number(row.rows[0].expires_at), expiry);
  });

  it('rejects a verified purchase that has already expired', async () => {
    const userId = `usr_play_expired_${Date.now()}`;
    const billing = configuredBilling(
      verifierReturning({
        verified: true,
        packageName: PACKAGE,
        productId: 'plan_month_100',
        expiryTimeMillis: Date.now() - 1000,
        isAutoRenewing: true,
        verificationSource: 'GOOGLE_PLAY_VERIFIED',
      })
    );
    const res = await billing.verifyPurchaseToken(userId, 'plan_month_100', 'expired-token');
    assert.equal(res.success, false);
    assert.equal(res.code, 'ERR_PLAY_EXPIRED');
    assert.equal(await countSubscriptions(userId), 0);
  });

  it('rejects a verified purchase for a different product or package', async () => {
    const userId = `usr_play_product_${Date.now()}`;
    const wrongProduct = configuredBilling(
      verifierReturning({
        verified: true,
        packageName: PACKAGE,
        productId: 'plan_year_800',
        expiresAt: Date.now() + 86400000,
        expiryTimeMillis: Date.now() + 86400000,
        verificationSource: 'GOOGLE_PLAY_VERIFIED',
      } as any)
    );
    const res = await wrongProduct.verifyPurchaseToken(userId, 'plan_month_100', 'product-token');
    assert.equal(res.success, false);
    assert.equal(res.code, 'ERR_PLAY_PRODUCT_MISMATCH');

    const wrongPackage = configuredBilling(
      verifierReturning({
        verified: true,
        packageName: 'com.indianpapertrading.debug',
        productId: 'plan_month_100',
        expiryTimeMillis: Date.now() + 86400000,
        verificationSource: 'GOOGLE_PLAY_VERIFIED',
      })
    );
    const res2 = await wrongPackage.verifyPurchaseToken(userId, 'plan_month_100', 'package-token');
    assert.equal(res2.success, false);
    assert.equal(res2.code, 'ERR_PLAY_PACKAGE_MISMATCH');
    assert.equal(await countSubscriptions(userId), 0);
  });

  it('same-owner restore returns the existing entitlement without duplicating the token', async () => {
    const userId = `usr_play_restore_${Date.now()}`;
    const expiry = Date.now() + 10 * 24 * 60 * 60 * 1000;
    const billing = configuredBilling(
      verifierReturning({
        verified: true,
        packageName: PACKAGE,
        productId: 'plan_month_100',
        expiryTimeMillis: expiry,
        isAutoRenewing: true,
        verificationSource: 'GOOGLE_PLAY_VERIFIED',
      })
    );
    const first = await billing.verifyPurchaseToken(userId, 'plan_month_100', 'restore-token');
    assert.equal(first.success, true);

    const second = await billing.verifyPurchaseToken(userId, 'plan_month_100', 'restore-token');
    assert.equal(second.success, true);
    assert.equal(second.expiresAt, expiry);
    assert.equal(await countSubscriptions(userId), 1, 'restore must not insert a duplicate subscription row');
  });

  it('blocks cross-user purchase-token replay', async () => {
    const owner = `usr_play_owner_${Date.now()}`;
    const attacker = `usr_play_attacker_${Date.now()}`;
    const billing = configuredBilling(
      verifierReturning({
        verified: true,
        packageName: PACKAGE,
        productId: 'plan_month_100',
        expiryTimeMillis: Date.now() + 86400000,
        verificationSource: 'GOOGLE_PLAY_VERIFIED',
      })
    );
    assert.equal((await billing.verifyPurchaseToken(owner, 'plan_month_100', 'shared-play-token')).success, true);
    const replay = await billing.verifyPurchaseToken(attacker, 'plan_month_100', 'shared-play-token');
    assert.equal(replay.success, false);
    assert.equal(replay.code, 'ERR_TOKEN_REPLAY');
    assert.equal(await countSubscriptions(attacker), 0);
  });

  it('fails closed when the verifier throws (network/credential outage)', async () => {
    const userId = `usr_play_throw_${Date.now()}`;
    const billing = configuredBilling(async () => {
      throw new Error('socket hang up');
    });
    const res = await billing.verifyPurchaseToken(userId, 'plan_month_100', 'token');
    assert.equal(res.success, false);
    assert.equal(res.code, 'ERR_PLAY_VERIFICATION_UNAVAILABLE');
    assert.equal(await countSubscriptions(userId), 0);
  });

  it('the real Play verifier refuses an unparseable service-account key instead of trusting the client', async () => {
    const verifier = createGooglePlayVerifier('not-a-valid-service-account-key');
    const result = await verifier({
      packageName: PACKAGE,
      productId: 'plan_month_100',
      purchaseToken: 'client-token',
      isSubscription: true,
    });
    assert.equal(result.verified, false);
    assert.equal(result.verificationSource, 'GOOGLE_PLAY_VERIFIED');
    assert.ok(result.code);
  });
});

describe('Authentication cannot be obtained without proof of ownership', () => {
  let app: FastifyInstance;
  const email = `authproof.${Date.now()}@example.com`;
  const password = 'SecurePass#2026';

  before(async () => {
    const bundle = await buildServer(undefined, 'UPSTOX');
    app = bundle.app;
    await app.ready();
    const reg = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, name: 'Proof Tester', password },
    });
    assert.equal(reg.statusCode, 200);
  });

  after(async () => {
    await app.close();
  });

  it('login without a password never issues a token and never auto-registers an account', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email },
    });
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'ERR_PASSWORD_REQUIRED');
    assert.equal(body.token, undefined);

    const unknownEmail = `unclaimed.${Date.now()}@example.com`;
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: unknownEmail },
    });
    assert.equal(res2.statusCode, 401);
    assert.equal(JSON.parse(res2.body).token, undefined);

    // The unclaimed address must still be registerable by its real owner.
    const res3 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: unknownEmail, name: 'Real Owner', password },
    });
    assert.equal(res3.statusCode, 200);
  });

  it('password change by bare email is rejected without the current password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/recover',
      payload: { email, newPassword: 'AttackerChosen#123' },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).code, 'ERR_RECOVERY_PROOF_REQUIRED');

    // The original password still works, proving no reset happened.
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password },
    });
    assert.equal(login.statusCode, 200);
  });

  it('password change with a wrong current password is rejected', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/recover',
      payload: { email, newPassword: 'NewPass#2026', currentPassword: 'WrongPass#1' },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).code, 'ERR_INVALID_CREDENTIALS');
  });

  it('password change with the correct current password succeeds and rotates the credential', async () => {
    const newPassword = 'NewPass#2026';
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/recover',
      payload: { email, newPassword, currentPassword: password },
    });
    assert.equal(res.statusCode, 200);

    const oldLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password },
    });
    assert.equal(oldLogin.statusCode, 401);

    const newLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: newPassword },
    });
    assert.equal(newLogin.statusCode, 200);
    assert.equal(JSON.parse(newLogin.body).user.tier, 'FREE');
  });
});
