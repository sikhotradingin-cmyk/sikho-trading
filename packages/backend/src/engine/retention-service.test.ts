import test from 'node:test';
import assert from 'node:assert/strict';
import { EmulatedPostgresDatabase } from '../db/database.js';
import { PostgresRepository } from '../db/postgres-repository.js';
import {
  executeRetentionCleanup,
  getAccountHistoryCheckpoint,
  getRetentionCutoffTimestamp,
  previewRetentionCleanup,
  MS_PER_DAY,
  RETENTION_DAYS,
} from './retention-service.js';

test('30-Day Retention Engine: Bounded Purge, Checkpoint Invariance, and Protected Orders', async () => {
  const db = new EmulatedPostgresDatabase();
  const repo = new PostgresRepository(db);

  // 1. Provision account
  const account = await repo.provisionInitialAccount('user-retention-test');
  const accountId = account.id;
  const initialCash = account.cashBalancePaise;

  const now = Date.now();
  const cutoff = getRetentionCutoffTimestamp(now, RETENTION_DAYS);
  const oldTimestamp = cutoff - 5 * MS_PER_DAY; // 35 days ago (eligible)
  const recentTimestamp = cutoff + 2 * MS_PER_DAY; // 28 days ago (retained)

  // Seed instruments
  await db.query(`
    INSERT INTO instruments (global_id, provider, exchange, token, symbol, name, instrument_type, is_tradable, lot_size, tick_size, updated_at)
    VALUES ('NSE:RELIANCE:1', 'SIM', 'NSE', '101', 'RELIANCE', 'Reliance Industries', 'EQUITY_STOCK', true, 1, 0.05, ${now})
    ON CONFLICT (global_id) DO NOTHING
  `);

  // 2. Insert an old terminal order and old completed trade closure (35 days ago)
  const oldOrderId1 = 'order-old-exit-1';
  await db.query(`
    INSERT INTO orders (id, account_id, global_instrument_id, side, order_type, quantity, executed_price, status, idempotency_key, estimated_charges_paise, executed_at, created_at, updated_at)
    VALUES ('${oldOrderId1}', '${accountId}', 'NSE:RELIANCE:1', 'SELL', 'MARKET', 10, 2500, 'EXECUTED', 'idem-old-1', 2000, ${oldTimestamp}, ${oldTimestamp}, ${oldTimestamp})
  `);

  const oldTradePayload = {
    id: oldOrderId1,
    globalInstrumentId: 'NSE:RELIANCE:1',
    side: 'LONG',
    quantity: 10,
    entryPrice: 2400,
    exitPrice: 2500,
    entryTimestamp: oldTimestamp - 1000,
    exitTimestamp: oldTimestamp,
    entryOrderIds: ['order-old-entry-1'],
    exitOrderId: oldOrderId1,
    grossPaise: '100000', // ₹1,000 profit (100,000 paise)
    chargesPaise: '4000', // ₹40 charges (4,000 paise)
    netPaise: '96000',
    coverage: 'COMPLETE',
  };

  await db.query(`
    INSERT INTO trade_closures (id, account_id, instrument_id, session_id, exited_at, gross_paise, charges_paise, payload_json)
    VALUES ('${oldOrderId1}', '${accountId}', 'NSE:RELIANCE:1', 'session-1', ${oldTimestamp}, 100000, 4000, '${JSON.stringify(oldTradePayload)}')
  `);

  // 3. Insert an old entry order (35 days ago) that belongs to a RECENTLY CLOSED trade (28 days ago)
  // This order MUST BE PROTECTED from deletion!
  const protectedEntryOrderId = 'order-protected-entry-1';
  await db.query(`
    INSERT INTO orders (id, account_id, global_instrument_id, side, order_type, quantity, executed_price, status, idempotency_key, estimated_charges_paise, executed_at, created_at, updated_at)
    VALUES ('${protectedEntryOrderId}', '${accountId}', 'NSE:RELIANCE:1', 'BUY', 'MARKET', 10, 2400, 'EXECUTED', 'idem-prot-1', 2000, ${oldTimestamp}, ${oldTimestamp}, ${oldTimestamp})
  `);

  const recentOrderId = 'order-recent-exit-1';
  await db.query(`
    INSERT INTO orders (id, account_id, global_instrument_id, side, order_type, quantity, executed_price, status, idempotency_key, estimated_charges_paise, executed_at, created_at, updated_at)
    VALUES ('${recentOrderId}', '${accountId}', 'NSE:RELIANCE:1', 'SELL', 'MARKET', 10, 2550, 'EXECUTED', 'idem-rec-1', 2000, ${recentTimestamp}, ${recentTimestamp}, ${recentTimestamp})
  `);

  const recentTradePayload = {
    id: recentOrderId,
    globalInstrumentId: 'NSE:RELIANCE:1',
    side: 'LONG',
    quantity: 10,
    entryPrice: 2400,
    exitPrice: 2550,
    entryTimestamp: oldTimestamp,
    exitTimestamp: recentTimestamp,
    entryOrderIds: [protectedEntryOrderId],
    exitOrderId: recentOrderId,
    grossPaise: '150000',
    chargesPaise: '4000',
    netPaise: '146000',
    coverage: 'COMPLETE',
  };

  await db.query(`
    INSERT INTO trade_closures (id, account_id, instrument_id, session_id, exited_at, gross_paise, charges_paise, payload_json)
    VALUES ('${recentOrderId}', '${accountId}', 'NSE:RELIANCE:1', 'session-1', ${recentTimestamp}, 150000, 4000, '${JSON.stringify(recentTradePayload)}')
  `);

  // 4. Insert an old order that belongs to a currently OPEN position (35 days ago)
  // MUST BE PROTECTED from deletion!
  const openPosOrderId = 'order-open-pos-entry';
  await db.query(`
    INSERT INTO orders (id, account_id, global_instrument_id, side, order_type, quantity, executed_price, status, idempotency_key, estimated_charges_paise, executed_at, created_at, updated_at, position_id)
    VALUES ('${openPosOrderId}', '${accountId}', 'NSE:RELIANCE:1', 'BUY', 'MARKET', 5, 2450, 'EXECUTED', 'idem-open-1', 1000, ${oldTimestamp}, ${oldTimestamp}, ${oldTimestamp}, 'pos-active-1')
  `);

  await db.query(`
    INSERT INTO positions (id, account_id, global_instrument_id, quantity, average_entry_price, realized_pnl_paise, created_at, updated_at)
    VALUES ('pos-active-1', '${accountId}', 'NSE:RELIANCE:1', 5, 2450, 0, ${oldTimestamp}, ${now})
  `);

  // 5. TEST: Preview dry run
  const dryRun = await previewRetentionCleanup(db, { accountId, now });
  assert.equal(dryRun.eligibleTradeClosuresCount, 1, 'Exactly 1 old trade closure must be eligible');
  assert.equal(dryRun.eligibleTradeClosuresGrossPaise, '100000');
  assert.equal(dryRun.eligibleTradeClosuresChargesPaise, '4000');
  assert.ok(dryRun.protectedOrdersOlderThanCutoffCount >= 2, 'Orders for open position and recent trade must be protected');
  assert.ok(dryRun.protectedOrdersRetentionReasons.length > 0, 'Must document retention reasons for protected orders');

  // 6. TEST: Execute cleanup
  const cleanupRes = await executeRetentionCleanup(db, { accountId, now });
  assert.equal(cleanupRes.purgedTradesCount, 1, 'Must purge exactly 1 old trade closure');
  assert.equal(cleanupRes.checkpointsUpdatedCount, 1, 'Must update checkpoint');

  // Verify old trade closure is purged, but recent trade closure is retained
  const remainingTrades = await db.query('SELECT id FROM trade_closures WHERE account_id = $1', [accountId]);
  assert.equal(remainingTrades.rows.length, 1);
  assert.equal(remainingTrades.rows[0].id, recentOrderId);

  // Verify protected orders are NOT deleted
  const checkProt1 = await db.query('SELECT id FROM orders WHERE id = $1', [protectedEntryOrderId]);
  assert.equal(checkProt1.rows.length, 1, 'Old order for recently closed trade must be preserved');

  const checkProt2 = await db.query('SELECT id FROM orders WHERE id = $1', [openPosOrderId]);
  assert.equal(checkProt2.rows.length, 1, 'Old order for currently open position must be preserved');

  // Verify standalone old order was purged
  const checkOldOrder = await db.query('SELECT id FROM orders WHERE id = $1', [oldOrderId1]);
  assert.equal(checkOldOrder.rows.length, 0, 'Unreferenced old terminal order must be purged');

  // 7. Verify Checkpoint data accurately recorded
  const cp = await getAccountHistoryCheckpoint(db, accountId);
  assert.ok(cp !== null);
  assert.equal(cp!.purgedTradesCount, 1);
  assert.equal(cp!.purgedGrossPaise, '100000');
  assert.equal(cp!.purgedChargesPaise, '4000');
  assert.equal(cp!.purgedNetPaise, '96000');
  assert.equal(cp!.purgedWinsCount, 1);

  // 8. CRITICAL: Cash balance of virtual account must be UNCHANGED
  const postAcc = await repo.getAccount(accountId);
  assert.equal(postAcc!.cashBalancePaise, initialCash, 'Account balance must never be altered by retention cleanup');

  // 9. TEST: Repeated execution is idempotent
  const repeatRes = await executeRetentionCleanup(db, { accountId, now });
  assert.equal(repeatRes.purgedTradesCount, 0, 'Second run must purge 0 additional trades');
  const cp2 = await getAccountHistoryCheckpoint(db, accountId);
  assert.equal(cp2!.purgedTradesCount, 1, 'Checkpoint count must not double-count');
  assert.equal(cp2!.purgedGrossPaise, '100000');
});
