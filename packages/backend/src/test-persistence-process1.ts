import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import { buildServer } from './server.js';

dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), 'packages/backend/.env') });

async function main() {
  console.log('[PROCESS 1] Starting backend server process...');
  const { app, db } = await buildServer();

  if (db.isEmulated()) {
    console.error('[PROCESS 1] ERROR: Connected to emulated DB instead of real PostgreSQL!');
    process.exit(1);
  }

  const testEmail = `process_restart_test_${Date.now()}@sikhotrading.com`;
  const testPassword = 'StrongPassword99!';
  const testName = 'Process Persistence Tester';

  console.log(`[PROCESS 1] Registering user: ${testEmail}`);
  const regRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email: testEmail, password: testPassword, name: testName },
  });

  if (regRes.statusCode !== 200) {
    console.error('[PROCESS 1] Registration failed:', regRes.statusCode, regRes.body);
    process.exit(1);
  }

  const regData = regRes.json();
  const userId = regData.user.userId;
  const accountId = regData.account.id;
  const balancePaise = regData.account.cashBalancePaise;

  console.log(`[PROCESS 1] Registration successful. UserID: ${userId}, AccountID: ${accountId}, Balance: ₹${Number(balancePaise)/100}`);

  // Test incorrect password rejection
  const badLoginRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: testEmail, password: 'WrongPassword123' },
  });
  console.log(`[PROCESS 1] Incorrect credentials rejected with HTTP: ${badLoginRes.statusCode} (${badLoginRes.json().code})`);
  if (badLoginRes.statusCode !== 401) {
    console.error('[PROCESS 1] Expected 401 for incorrect password!');
    process.exit(1);
  }

  // Test login in Process 1
  const loginRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: testEmail, password: testPassword },
  });
  if (loginRes.statusCode !== 200) {
    console.error('[PROCESS 1] Login failed:', loginRes.statusCode, loginRes.body);
    process.exit(1);
  }

  // Check ledger entry count
  const ledgerRes = await db.query('SELECT * FROM account_ledger_entries WHERE account_id = $1', [accountId]);
  console.log(`[PROCESS 1] Ledger entry count: ${ledgerRes.rows.length}`);

  // Save metadata to file for Process 2
  const metaPath = path.resolve(process.cwd(), 'packages/backend/dist/persistence-check.json');
  fs.writeFileSync(
    metaPath,
    JSON.stringify({
      testEmail,
      testPassword,
      userId,
      accountId,
      balancePaise: balancePaise.toString(),
      ledgerId: ledgerRes.rows[0]?.id,
    })
  );

  console.log('[PROCESS 1] State saved. Terminating Process 1 (PID: ' + process.pid + ')...');
  await db.close();
  process.exit(0);
}

main();
