import test from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from './server.js';
import { resolveAccessPolicy } from './monetization/access-policy.js';

test('Version Policy, Device Registration & Access Policy Control', async (t) => {
  process.env.ADMIN_GRANT_SECRET = 'a_very_secure_admin_secret_phrase_12345';
  process.env.JWT_SECRET = 'test_jwt_secret_must_be_long_enough_for_security';
  process.env.NODE_ENV = 'test';

  const { app } = await buildServer(undefined, 'DEMO');
  t.after(async () => {
    await app.close();
  });

  await t.test('GET /api/v1/app/version-policy returns active policy with defaults', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/app/version-policy',
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.latestVersionCode, 36);
    assert.equal(body.minimumSupportedVersionCode, 35);
    assert.equal(body.latestVersionName, 'v1.0.1');
    assert.equal(body.isActive, true);
    assert.ok(body.updateMessage);
    assert.ok(body.playStoreUrl);
  });

  await t.test('PUT /api/v1/admin/app/version-policy updates and supports emergency rollback', async () => {
    // Attempt without admin secret
    const unauth = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/app/version-policy',
      payload: { minimumSupportedVersionCode: 36 },
    });
    assert.equal(unauth.statusCode, 403);

    // Update with admin secret
    const updateRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/app/version-policy',
      headers: {
        'x-admin-secret': 'a_very_secure_admin_secret_phrase_12345',
      },
      payload: {
        minimumSupportedVersionCode: 36,
        updateMessage: 'Mandatory update required: build 36 is now enforced.',
      },
    });
    assert.equal(updateRes.statusCode, 200);
    const updated = updateRes.json();
    assert.equal(updated.success, true);
    assert.equal(updated.policy.minimumSupportedVersionCode, 36);

    // Verify GET reflects the update
    const getRes = await app.inject({
      method: 'GET',
      url: '/api/v1/app/version-policy',
    });
    const fetched = getRes.json();
    assert.equal(fetched.minimumSupportedVersionCode, 36);
    assert.equal(fetched.updateMessage, 'Mandatory update required: build 36 is now enforced.');

    // Rollback test: reset minimumSupportedVersionCode to 35
    const rollbackRes = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/app/version-policy',
      headers: {
        'x-admin-secret': 'a_very_secure_admin_secret_phrase_12345',
      },
      payload: {
        minimumSupportedVersionCode: 35,
        isActive: true,
      },
    });
    assert.equal(rollbackRes.statusCode, 200);
  });

  await t.test('POST /api/v1/devices/register registers anonymous and authenticated devices', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/register',
      payload: {
        token: 'fcm_token_sample_abc1234567890_test_device',
        platform: 'android',
        appVersionCode: 35,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.success, true);
    assert.ok(body.installationId);
  });

  await t.test('POST /api/v1/admin/notifications/release-announcement supports dry-run and deduplication', async () => {
    // Dry-run
    const dryRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/notifications/release-announcement',
      headers: {
        'x-admin-secret': 'a_very_secure_admin_secret_phrase_12345',
      },
      payload: {
        dryRun: true,
        targetVersionCode: 36,
        title: 'Sikho Trading Update v1.0.1 (36)',
        message: 'A new Sikho Trading update is available. Please update to continue.',
      },
    });
    assert.equal(dryRes.statusCode, 200);
    const dryBody = dryRes.json();
    assert.equal(dryBody.success, true);
    assert.equal(dryBody.dryRun, true);
    assert.equal(dryBody.recipientCount, 1);

    // Send real announcement
    const sendRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/notifications/release-announcement',
      headers: {
        'x-admin-secret': 'a_very_secure_admin_secret_phrase_12345',
      },
      payload: {
        dryRun: false,
        targetVersionCode: 36,
        title: 'Sikho Trading Update v1.0.1 (36)',
        message: 'A new Sikho Trading update is available. Please update to continue.',
      },
    });
    assert.equal(sendRes.statusCode, 200);
    const sendBody = sendRes.json();
    assert.equal(sendBody.success, true);
    assert.equal(sendBody.dryRun, false);
    assert.ok(sendBody.announcementId);

    // Duplicate prevention
    const dupRes = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/notifications/release-announcement',
      headers: {
        'x-admin-secret': 'a_very_secure_admin_secret_phrase_12345',
      },
      payload: {
        dryRun: false,
        targetVersionCode: 36,
        title: 'Sikho Trading Update v1.0.1 (36)',
        message: 'A new Sikho Trading update is available. Please update to continue.',
      },
    });
    assert.equal(dupRes.statusCode, 200);
    const dupBody = dupRes.json();
    assert.equal(dupBody.alreadySent, true);
  });

  await t.test('Mutating orders return 426 Upgrade Required when client version is below minimumSupportedVersionCode', async () => {
    // Set minimum to 36
    await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/app/version-policy',
      headers: {
        'x-admin-secret': 'a_very_secure_admin_secret_phrase_12345',
      },
      payload: { minimumSupportedVersionCode: 36 },
    });

    // Register test user
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: {
        email: 'trader_version_test@sikhotrading.in',
        name: 'Version Test Trader',
        password: 'ValidPassword123#',
      },
    });
    const { token } = regRes.json();

    // Mutating order attempt with outdated version header x-app-version-code: 34
    const placeRes = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/place',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-app-version-code': '34',
      },
      payload: {
        globalInstrumentId: 'NSE:RELIANCE',
        side: 'BUY',
        orderType: 'MARKET',
        quantity: 1,
      },
    });

    assert.equal(placeRes.statusCode, 426);
    const placeBody = placeRes.json();
    assert.equal(placeBody.error, 'ERR_UPDATE_REQUIRED');
    assert.equal(placeBody.minimumSupportedVersionCode, 36);
    assert.ok(placeBody.playStoreUrl);

    // Reset minimumSupportedVersionCode back to 35
    await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/app/version-policy',
      headers: {
        'x-admin-secret': 'a_very_secure_admin_secret_phrase_12345',
      },
      payload: { minimumSupportedVersionCode: 35 },
    });
  });

  await t.test('Server access policy is evaluated server-side and independent of client APK', () => {
    const originalEnv = process.env.SIKHO_ACCESS_MODE;
    try {
      process.env.SIKHO_ACCESS_MODE = 'FREE_LAUNCH';
      const freeLaunch = resolveAccessPolicy('FREE', true);
      assert.equal(freeLaunch.accessMode, 'FREE_LAUNCH');
      assert.equal(freeLaunch.fullFeatureAccess, true);
      assert.equal(freeLaunch.adsRequired, true);

      process.env.SIKHO_ACCESS_MODE = 'STANDARD';
      const standardFree = resolveAccessPolicy('FREE', true);
      assert.equal(standardFree.accessMode, 'STANDARD');
      assert.equal(standardFree.fullFeatureAccess, false);

      const standardPro = resolveAccessPolicy('PRO', true);
      assert.equal(standardPro.accessMode, 'STANDARD');
      assert.equal(standardPro.fullFeatureAccess, true);
      assert.equal(standardPro.adsRequired, false);
    } finally {
      process.env.SIKHO_ACCESS_MODE = originalEnv;
    }
  });
});
