import test from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from './server.js';

test('Ownership-Verified In-App Account Deletion & Immediate Session Revocation', async (t) => {
  const { app, provider, repo, db } = await buildServer(undefined, 'DEMO');
  t.after(async () => {
    await app.close();
  });

  // Register User 1 (target for deletion) and User 2 (must remain completely untouched)
  const reg1 = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      email: 'delete-me@example.test',
      name: 'Delete Target',
      password: 'CorrectPassword#123',
    },
  });
  assert.equal(reg1.statusCode, 200);
  const { token: token1, user: user1, account: account1 } = reg1.json();
  assert.equal(user1.hasPassword, true);

  const reg2 = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: {
      email: 'survivor@example.test',
      name: 'Survivor Trader',
      password: 'SurvivorPassword#123',
    },
  });
  assert.equal(reg2.statusCode, 200);
  const { token: token2, user: user2 } = reg2.json();

  // Create associated data for User 1 (order, position, watchlist, journal entry, drawing)
  const allInstruments = await provider.getInstruments();
  const stock = allInstruments.find((i: any) => i.instrumentType === 'FUTIDX' && i.isTradable);
  assert.ok(stock);

  const orderRes = await app.inject({
    method: 'POST',
    url: '/api/v1/orders/place',
    headers: { authorization: `Bearer ${token1}` },
    payload: {
      globalInstrumentId: stock.globalId,
      side: 'BUY',
      orderType: 'MARKET',
      productType: 'INTRADAY',
      quantity: stock.lotSize,
      idempotencyKey: 'del-test-ord-1',
    },
  });
  assert.equal(orderRes.statusCode, 200);

  await app.inject({
    method: 'POST',
    url: '/api/v1/watchlists',
    headers: { authorization: `Bearer ${token1}` },
    payload: { name: 'My Practice List', instruments: [stock.globalId] },
  });

  await repo.saveDrawings(user1.userId, stock.globalId, [{ id: 'd1', type: 'trendline' }]);

  // 1. Reject missing confirmation phrase
  const badPhrase = await app.inject({
    method: 'POST',
    url: '/api/v1/account/delete',
    headers: { authorization: `Bearer ${token1}` },
    payload: {
      confirmEmail: 'delete-me@example.test',
      password: 'CorrectPassword#123',
      confirmPhrase: 'NO',
    },
  });
  assert.equal(badPhrase.statusCode, 400);
  assert.equal(badPhrase.json().code, 'ERR_CONFIRMATION_REQUIRED');

  // 2. Reject mismatched email
  const badEmail = await app.inject({
    method: 'POST',
    url: '/api/v1/account/delete',
    headers: { authorization: `Bearer ${token1}` },
    payload: {
      confirmEmail: 'wrong@example.test',
      password: 'CorrectPassword#123',
      confirmPhrase: 'DELETE',
    },
  });
  assert.equal(badEmail.statusCode, 400);
  assert.equal(badEmail.json().code, 'ERR_EMAIL_MISMATCH');

  // 3. Reject wrong password
  const badPassword = await app.inject({
    method: 'POST',
    url: '/api/v1/account/delete',
    headers: { authorization: `Bearer ${token1}` },
    payload: {
      confirmEmail: 'delete-me@example.test',
      password: 'WrongPassword#999',
      confirmPhrase: 'DELETE',
    },
  });
  assert.equal(badPassword.statusCode, 401);
  assert.equal(badPassword.json().code, 'ERR_INVALID_CREDENTIALS');

  // 4. Succeed with verified ownership credentials
  const okDelete = await app.inject({
    method: 'POST',
    url: '/api/v1/account/delete',
    headers: { authorization: `Bearer ${token1}` },
    payload: {
      confirmEmail: 'delete-me@example.test',
      password: 'CorrectPassword#123',
      confirmPhrase: 'DELETE',
    },
  });
  assert.equal(okDelete.statusCode, 200);
  assert.equal(okDelete.json().success, true);
  assert.equal(okDelete.json().deletedUserId, user1.userId);

  // 5. Verify all User 1 active records are erased while pseudonymous security tombstone exists
  assert.equal(await repo.getUserById(user1.userId), null);
  assert.equal(await repo.getAccount(account1.id), null);
  assert.equal((await repo.getOrders(account1.id)).length, 0);
  assert.equal((await repo.getPositions(account1.id)).length, 0);
  assert.equal((await repo.getDrawings(user1.userId, stock.globalId)).length, 0);

  const tombstoneRes = await db.query(
    'SELECT * FROM deleted_account_tombstones WHERE user_id = $1',
    [user1.userId]
  );
  assert.equal(tombstoneRes.rows.length, 1);
  assert.ok(!JSON.stringify(tombstoneRes.rows[0]).includes('delete-me@example.test'), 'Tombstone must never store plain-text email');

  // 6. Previously issued JWT for User 1 is immediately rejected across protected endpoints
  const meAfterDelete = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/me',
    headers: { authorization: `Bearer ${token1}` },
  });
  assert.equal(meAfterDelete.statusCode, 401);
  assert.equal(meAfterDelete.json().code, 'ERR_ACCOUNT_DELETED');

  // 7. User 2 remains completely intact
  const meUser2 = await app.inject({
    method: 'GET',
    url: '/api/v1/auth/me',
    headers: { authorization: `Bearer ${token2}` },
  });
  assert.equal(meUser2.statusCode, 200);
  assert.equal(meUser2.json().user.userId, user2.userId);
});
