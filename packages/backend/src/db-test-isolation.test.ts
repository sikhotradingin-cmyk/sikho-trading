import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from './config.js';
import { assertSafeTestDatabaseTarget, createDatabase } from './db/database.js';

test('Test mode never inherits production DATABASE_URL from .env', () => {
  // packages/backend/.env contains a Render production DATABASE_URL on this machine;
  // config.databaseUrl must remain undefined unless TEST_DATABASE_URL is explicitly set.
  if (!process.env.TEST_DATABASE_URL) {
    assert.equal(config.databaseUrl, undefined);
  }
});

test('Production DB guard fails closed on Render, remote, or non-test database URLs', () => {
  assert.throws(
    () => assertSafeTestDatabaseTarget(undefined),
    /TEST_DB_GUARD/
  );
  assert.throws(
    () =>
      assertSafeTestDatabaseTarget(
        'postgresql://user:pass@dpg-dbneto15efls73b5fq50-a.singapore-postgres.render.com/sikho_trading'
      ),
    /production database host/i
  );
  assert.throws(
    () => assertSafeTestDatabaseTarget('postgresql://user:pass@db.example.com:5432/sikho_trading_test'),
    /non-local database host/i
  );
  assert.throws(
    () => assertSafeTestDatabaseTarget('postgresql://user:pass@localhost:5432/sikho_trading'),
    /must contain "test"/i
  );

  assert.doesNotThrow(() =>
    assertSafeTestDatabaseTarget('postgresql://postgres:postgres@localhost:5432/sikho_trading_test')
  );
});

test('createDatabase rejects production URL even when TEST_USE_REAL_PG=true', () => {
  const prevUseReal = process.env.TEST_USE_REAL_PG;
  const prevTestDb = process.env.TEST_DATABASE_URL;
  try {
    process.env.TEST_USE_REAL_PG = 'true';
    process.env.TEST_DATABASE_URL =
      'postgresql://user:pass@dpg-dbneto15efls73b5fq50-a.singapore-postgres.render.com/sikho_trading';
    assert.throws(() => createDatabase(process.env.TEST_DATABASE_URL), /TEST_DB_GUARD/);
  } finally {
    if (prevUseReal === undefined) delete process.env.TEST_USE_REAL_PG;
    else process.env.TEST_USE_REAL_PG = prevUseReal;
    if (prevTestDb === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = prevTestDb;
  }
});
