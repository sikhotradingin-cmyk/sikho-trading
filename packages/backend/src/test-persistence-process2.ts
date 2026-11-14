import path from 'node:path';
import fs from 'node:fs';
import { assertSafeTestDatabaseTarget } from './db/database.js';
import { buildServer } from './server.js';

process.env.SIKHO_TEST_MODE = 'true';
process.env.TEST_USE_REAL_PG = 'true';

async function main() {
  assertSafeTestDatabaseTarget(process.env.TEST_DATABASE_URL);
  console.log('[PROCESS 2] Starting FRESH backend server process (PID: ' + process.pid + ')...');
  const metaPath = path.resolve(process.cwd(), 'packages/backend/dist/persistence-check.json');
  if (!fs.existsSync(metaPath)) {
    console.error('[PROCESS 2] ERROR: Metadata file from Process 1 not found!');
    process.exit(1);
  }

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  console.log(`[PROCESS 2] Attempting login for user: ${meta.testEmail}`);

  const { app, db } = await buildServer();

  if (db.isEmulated()) {
    console.error('[PROCESS 2] ERROR: Connected to emulated DB!');
    process.exit(1);
  }

  // 1. Verify user can authenticate in fresh process
  const loginRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: meta.testEmail, password: meta.testPassword },
  });

  if (loginRes.statusCode !== 200) {
    console.error('[PROCESS 2] Login failed in fresh process:', loginRes.statusCode, loginRes.body);
    process.exit(1);
  }

  const loginData = loginRes.json();
  const freshUserId = loginData.user.userId;
  const freshAccountId = loginData.account.id;
  const freshBalancePaise = loginData.account.cashBalancePaise;

  console.log(`[PROCESS 2] Login successful! UserID: ${freshUserId}, AccountID: ${freshAccountId}, Balance: ₹${Number(freshBalancePaise)/100}`);

  // 2. Verify account identity matches Process 1
  if (freshUserId !== meta.userId) {
    console.error(`[PROCESS 2] User ID mismatch! Expected ${meta.userId}, got ${freshUserId}`);
    process.exit(1);
  }
  if (freshAccountId !== meta.accountId) {
    console.error(`[PROCESS 2] Account ID mismatch! Expected ${meta.accountId}, got ${freshAccountId}`);
    process.exit(1);
  }
  if (freshBalancePaise.toString() !== meta.balancePaise) {
    console.error(`[PROCESS 2] Balance mismatch! Expected ${meta.balancePaise}, got ${freshBalancePaise}`);
    process.exit(1);
  }

  // 3. Verify ledger history in database: MUST be exactly 1 entry (no duplicate grants)
  const ledgerRes = await db.query(
    'SELECT * FROM account_ledger_entries WHERE account_id = $1 ORDER BY created_at ASC',
    [freshAccountId]
  );
  console.log(`[PROCESS 2] Total ledger entries for account: ${ledgerRes.rows.length}`);
  if (ledgerRes.rows.length !== 1) {
    console.error(`[PROCESS 2] Expected exactly 1 initial grant ledger entry, found ${ledgerRes.rows.length}!`);
    process.exit(1);
  }

  const ledgerEntry = ledgerRes.rows[0];
  if (ledgerEntry.entry_type !== 'INITIAL_GRANT' || ledgerEntry.amount_paise.toString() !== '10000000') {
    console.error('[PROCESS 2] Ledger entry mismatch:', ledgerEntry);
    process.exit(1);
  }

  // 4. Test repeated login to confirm zero duplicate accounts
  const repeatLoginRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: meta.testEmail, password: meta.testPassword },
  });
  if (repeatLoginRes.statusCode !== 200) {
    console.error('[PROCESS 2] Repeat login failed');
    process.exit(1);
  }

  const allAccountsRes = await db.query('SELECT * FROM virtual_accounts WHERE user_id = $1', [freshUserId]);
  console.log(`[PROCESS 2] Total virtual accounts for user: ${allAccountsRes.rows.length}`);
  if (allAccountsRes.rows.length !== 1) {
    console.error(`[PROCESS 2] Expected exactly 1 account, found ${allAccountsRes.rows.length}!`);
    process.exit(1);
  }

  console.log('✓ [PROCESS 2] VERIFIED: User, password authentication, virtual account ID, ₹100,000 balance, and ledger history completely persisted across actual OS process restart with zero duplicates.');

  // Clean up test metadata file
  try { fs.unlinkSync(metaPath); } catch {}
  await db.close();
  process.exit(0);
}

main();

