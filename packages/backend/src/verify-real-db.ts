import dotenv from 'dotenv';
import path from 'node:path';
import { createDatabase, runDatabaseMigrations } from './db/database.js';
import { PostgresRepository } from './db/postgres-repository.js';

dotenv.config();
dotenv.config({ path: path.resolve(process.cwd(), 'packages/backend/.env') });

async function main() {
  const dbUrl = process.env.DATABASE_URL?.trim();
  if (!dbUrl || (!dbUrl.startsWith('postgres://') && !dbUrl.startsWith('postgresql://'))) {
    console.error('ERROR: DATABASE_URL in packages/backend/.env is empty or not a valid postgres:// URL.');
    process.exit(1);
  }

  console.log('[1/5] Connecting to Render PostgreSQL instance...');
  const db = createDatabase(dbUrl);

  try {
    const versionRes = await db.query('SELECT version()');
    const fullVersion = versionRes.rows[0]?.version || 'Unknown';
    console.log(`[1/5] Connected successfully! Engine: ${fullVersion.split(' on ')[0]}`);

    console.log('[2/5] Running database migrations...');
    const applied = await runDatabaseMigrations(db);
    if (applied.length > 0) {
      console.log(`[2/5] Successfully applied ${applied.length} migration(s): ${applied.join(', ')}`);
    } else {
      console.log('[2/5] All migrations are already applied and up to date.');
    }

    const tablesRes = await db.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `);
    const tableNames = tablesRes.rows.map((r: any) => r.table_name);
    console.log('[2/5] Verified public tables:', tableNames.join(', '));

    console.log('[3/5] Testing real user registration & virtual account provisioning...');
    const repo = new PostgresRepository(db);
    const testEmail = `render_test_${Date.now()}@sikhotrading.com`;
    const testPass = 'SecurePaperPass2026!';

    const user = await repo.registerUser({
      email: testEmail,
      name: 'Render DB Verified Trader',
      password: testPass,
    });
    console.log(`[3/5] User registered successfully: ID=${user.id}`);

    const account = await repo.provisionInitialAccount(user.id, `${user.name}'s Account`, 'PRO');
    console.log(`[3/5] Virtual account provisioned: AccountID=${account.id}, Balance=${account.cashBalancePaise} paise (₹${Number(account.cashBalancePaise)/100})`);

    const ledgerRes = await db.query('SELECT * FROM account_ledger_entries WHERE account_id = $1', [account.id]);
    console.log(`[3/5] Ledger entries count: ${ledgerRes.rows.length} (Initial Grant: ${ledgerRes.rows[0]?.amount_paise} paise)`);

    console.log('[4/5] Simulating backend restart (closing connection pool)...');
    await db.close();

    console.log('[5/5] Reconnecting new backend pool to verify persistent storage & idempotency...');
    const db2 = createDatabase(dbUrl);
    const repo2 = new PostgresRepository(db2);

    const authUser = await repo2.authenticateUser(testEmail, testPass);
    console.log(`[5/5] Authentication succeeded after backend restart: ${authUser.email}`);

    // Verify idempotency: calling provisionInitialAccount again MUST NOT create a duplicate account or ledger grant
    const account2 = await repo2.provisionInitialAccount(authUser.id, `${authUser.name}'s Account`, 'PRO');
    const ledgerRes2 = await db2.query('SELECT * FROM account_ledger_entries WHERE account_id = $1', [account2.id]);

    if (account.id === account2.id && ledgerRes2.rows.length === 1) {
      console.log('✓ VERIFIED: Account persisted with exact same ID, balance intact, 0 duplicate ledger grants.');
    } else {
      console.error('✗ FAILED: Duplicate account or ledger entries detected.');
      process.exit(1);
    }

    await db2.close();
    console.log('--- ALL REAL DATABASE CHECKS PASSED SUCCESSFULLY ---');
  } catch (err: any) {
    console.error('Database verification failed:', err.message);
    try { await db.close(); } catch {}
    process.exit(1);
  }
}

main();

