import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGoogleIdTokenPayload } from './server.js';

const CLIENT_ID = '18709659572-test.apps.googleusercontent.com';

test('accepts a verified Google payload for this audience only', () => {
  const result = validateGoogleIdTokenPayload(
    {
      aud: CLIENT_ID,
      sub: '109876543210987654321',
      email: 'trader@example.com',
      email_verified: true,
      name: 'Trader',
    },
    CLIENT_ID
  );
  assert.deepEqual(result, { ok: true });
});

test('rejects a token minted for a different OAuth client (audience mismatch)', () => {
  const result = validateGoogleIdTokenPayload(
    { aud: 'someone-else.apps.googleusercontent.com', sub: '1', email: 'a@b.com', email_verified: true },
    CLIENT_ID
  );
  assert.equal(result.ok, false);
  assert.equal((result as any).code, 'ERR_GOOGLE_AUDIENCE_MISMATCH');
});

test('rejects unverified Google email addresses so entitlements cannot bind to them', () => {
  const result = validateGoogleIdTokenPayload(
    { aud: CLIENT_ID, sub: '1', email: 'a@b.com', email_verified: false },
    CLIENT_ID
  );
  assert.equal(result.ok, false);
  assert.equal((result as any).code, 'ERR_GOOGLE_EMAIL_UNVERIFIED');
});

test('rejects a payload without the immutable Google subject identifier', () => {
  const result = validateGoogleIdTokenPayload(
    { aud: CLIENT_ID, email: 'a@b.com', email_verified: true },
    CLIENT_ID
  );
  assert.equal(result.ok, false);
  assert.equal((result as any).code, 'ERR_GOOGLE_SUBJECT_MISSING');
});

test('rejects an empty payload', () => {
  const result = validateGoogleIdTokenPayload(null, CLIENT_ID);
  assert.equal(result.ok, false);
  assert.equal((result as any).code, 'ERR_INVALID_GOOGLE_TOKEN');
});
