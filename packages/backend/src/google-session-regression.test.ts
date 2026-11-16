import test from 'node:test';
import assert from 'node:assert/strict';
import { OAuth2Client } from 'google-auth-library';
import { config } from './config.js';
import { buildServer } from './server.js';
import { EmulatedPostgresDatabase } from './db/database.js';

test('controlled Google verification issues only FREE sessions, correlates requests and distinguishes persistence failure', async () => {
  const previousId = config.googleClientId;
  const previousVerify = OAuth2Client.prototype.verifyIdToken;
  config.googleClientId = 'isolated-test.apps.googleusercontent.com';
  const bundle = await buildServer(new EmulatedPostgresDatabase(), 'DEMO');
  const { app, repo } = bundle;
  try {
    (OAuth2Client.prototype as any).verifyIdToken = async (args: any) => {
      assert.equal(args.audience, config.googleClientId);
      return { getPayload: () => ({ aud: config.googleClientId, sub: 'isolated-google-sub',
        email: 'unpaid-google@example.test', email_verified: true, name: 'Unpaid Google QA' }) };
    };
    const request = () => app.inject({ method: 'POST', url: '/api/v1/auth/google',
      headers: { 'x-auth-request-id': 'g_isolated_regression' }, payload: { idToken: 'controlled-fixture-only' } });
    const first = await request();
    assert.equal(first.statusCode, 200);
    assert.equal(first.headers['x-auth-request-id'], 'g_isolated_regression');
    const auth = first.json();
    assert.equal(auth.user.tier, 'FREE');
    assert.equal(auth.entitlement.tier, 'FREE');
    assert.ok(auth.token);
    assert.ok(await repo.getAccount(auth.account.id));
    const again = (await request()).json();
    assert.equal(again.user.userId, auth.user.userId);
    assert.equal(again.user.tier, 'FREE');
    const upsert = repo.upsertGoogleUser;
    repo.upsertGoogleUser = async () => { throw new Error('SENSITIVE_FIXTURE_MARKER'); };
    const persistenceFailure = await request();
    assert.equal(persistenceFailure.statusCode, 503);
    assert.equal(persistenceFailure.json().code, 'ERR_GOOGLE_SESSION_UNAVAILABLE');
    assert.ok(!persistenceFailure.body.includes('SENSITIVE_FIXTURE_MARKER'));
    repo.upsertGoogleUser = upsert;
    (OAuth2Client.prototype as any).verifyIdToken = async () => { throw new Error('SENSITIVE_FIXTURE_MARKER'); };
    const invalid = await request();
    assert.equal(invalid.statusCode, 401);
    assert.equal(invalid.json().code, 'ERR_GOOGLE_AUTH_ERROR');
    assert.ok(!invalid.body.includes('SENSITIVE_FIXTURE_MARKER'));
  } finally {
    OAuth2Client.prototype.verifyIdToken = previousVerify;
    config.googleClientId = previousId;
    await app.close();
  }
});
