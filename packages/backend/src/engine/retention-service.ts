import { IDatabase, IDatabaseClient } from '../db/database.js';

export const RETENTION_DAYS = 30;
export const MS_PER_DAY = 86400000;

export interface RetentionDryRunSummary {
  cutoffTimestamp: number;
  cutoffIso: string;
  eligibleTradeClosuresCount: number;
  eligibleTradeClosuresGrossPaise: string;
  eligibleTradeClosuresChargesPaise: string;
  eligibleTerminalOrdersCount: number;
  protectedOrdersOlderThanCutoffCount: number;
  protectedOrdersRetentionReasons: string[];
  eligibleProtectionAuditCount: number;
  eligibleProtectionRequestsCount: number;
  affectedAccountsCount: number;
  dryRunMode: true;
}

export interface RetentionCleanupResult {
  cutoffTimestamp: number;
  purgedTradesCount: number;
  purgedTerminalOrdersCount: number;
  purgedProtectionAuditCount: number;
  purgedProtectionRequestsCount: number;
  checkpointsUpdatedCount: number;
  durationMs: number;
}

export function getRetentionCutoffTimestamp(now: number = Date.now(), days: number = RETENTION_DAYS): number {
  return now - days * MS_PER_DAY;
}

/**
 * Perform a non-destructive dry-run preview of records eligible for retention cleanup.
 * Identifies records that must be temporarily retained (e.g. older orders belonging to open positions
 * or recently closed trades) and explains why.
 */
export async function previewRetentionCleanup(
  db: IDatabase,
  options: { accountId?: string; cutoff?: number; now?: number } = {}
): Promise<RetentionDryRunSummary> {
  const cutoff = options.cutoff ?? getRetentionCutoffTimestamp(options.now ?? Date.now(), RETENTION_DAYS);
  const accountFilter = options.accountId ? ' AND account_id = $2' : '';
  const params: any[] = [cutoff];
  if (options.accountId) params.push(options.accountId);

  // 1. Eligible trade closures (completed trades older than 30-day cutoff)
  const tradesRes = await db.query(
    `SELECT COUNT(*) as count, 
            COALESCE(SUM(gross_paise), 0) as gross, 
            COALESCE(SUM(charges_paise), 0) as charges,
            COUNT(DISTINCT account_id) as accounts
     FROM trade_closures 
     WHERE exited_at < $1${accountFilter}`,
    params
  );
  const eligibleTradesCount = Number(tradesRes.rows[0]?.count || 0);
  const eligibleGross = BigInt(tradesRes.rows[0]?.gross || 0).toString();
  const eligibleCharges = BigInt(tradesRes.rows[0]?.charges || 0).toString();
  const affectedAccounts = Number(tradesRes.rows[0]?.accounts || 0);

  // 2. Identify protected order IDs that MUST NOT be deleted even if older than cutoff
  const protectedOrderIds = await getProtectedOrderIds(db, options.accountId, cutoff);

  // 3. Eligible terminal orders older than cutoff that are NOT protected
  const terminalOrdersParams: any[] = [cutoff];
  let terminalSql = `
    SELECT COUNT(*) as count 
    FROM orders 
    WHERE status IN ('EXECUTED', 'CANCELLED', 'REJECTED')
      AND created_at < $1
  `;
  if (options.accountId) {
    terminalOrdersParams.push(options.accountId);
    terminalSql += ` AND account_id = $2`;
  }
  const allOldTerminalOrders = await db.query(terminalSql, terminalOrdersParams);
  const totalOldTerminalCount = Number(allOldTerminalOrders.rows[0]?.count || 0);

  let eligibleOrdersCount = totalOldTerminalCount;
  let protectedOrdersCount = 0;
  const reasons: string[] = [];

  if (protectedOrderIds.size > 0) {
    // Check how many protected orders are older than cutoff
    const protectedList = Array.from(protectedOrderIds);
    const placeholders = protectedList.map((_, i) => `$${i + 2}`).join(', ');
    const oldProtectedParams: any[] = [cutoff, ...protectedList];
    let oldProtectedSql = `
      SELECT COUNT(*) as count 
      FROM orders 
      WHERE created_at < $1 AND id IN (${placeholders})
    `;
    if (options.accountId) {
      oldProtectedParams.push(options.accountId);
      oldProtectedSql += ` AND account_id = $${oldProtectedParams.length}`;
    }
    const oldProtectedRes = await db.query(oldProtectedSql, oldProtectedParams);
    protectedOrdersCount = Number(oldProtectedRes.rows[0]?.count || 0);
    eligibleOrdersCount = Math.max(0, totalOldTerminalCount - protectedOrdersCount);

    if (protectedOrdersCount > 0) {
      reasons.push(
        `${protectedOrdersCount} order(s) older than 30 days are temporarily retained because they belong to currently open positions or trades closed within the last 30 days.`
      );
    }
  }

  // 4. Obsolete protection records older than cutoff for closed positions
  const auditRes = await db.query(
    `SELECT COUNT(*) as count 
     FROM position_protection_audit 
     WHERE created_at < $1
       AND position_id NOT IN (SELECT id FROM positions WHERE quantity != 0)${accountFilter}`,
    params
  );
  const eligibleAuditCount = Number(auditRes.rows[0]?.count || 0);

  const reqRes = await db.query(
    `SELECT COUNT(*) as count 
     FROM position_protection_requests 
     WHERE created_at < $1
       AND position_id NOT IN (SELECT id FROM positions WHERE quantity != 0)${accountFilter}`,
    params
  );
  const eligibleReqCount = Number(reqRes.rows[0]?.count || 0);

  return {
    cutoffTimestamp: cutoff,
    cutoffIso: new Date(cutoff).toISOString(),
    eligibleTradeClosuresCount: eligibleTradesCount,
    eligibleTradeClosuresGrossPaise: eligibleGross,
    eligibleTradeClosuresChargesPaise: eligibleCharges,
    eligibleTerminalOrdersCount: eligibleOrdersCount,
    protectedOrdersOlderThanCutoffCount: protectedOrdersCount,
    protectedOrdersRetentionReasons: reasons,
    eligibleProtectionAuditCount: eligibleAuditCount,
    eligibleProtectionRequestsCount: eligibleReqCount,
    affectedAccountsCount: affectedAccounts,
    dryRunMode: true,
  };
}

/**
 * Execute atomic, bounded retention cleanup for completed trades, terminal orders, and obsolete audit records.
 * Atomically computes accounting checkpoints before deleting detailed trade closures, preserving
 * lifetime totals and ensuring cash balance is never double-counted or altered.
 */
export async function executeRetentionCleanup(
  db: IDatabase,
  options: { accountId?: string; cutoff?: number; now?: number; batchSize?: number } = {}
): Promise<RetentionCleanupResult> {
  const start = Date.now();
  const cutoff = options.cutoff ?? getRetentionCutoffTimestamp(options.now ?? Date.now(), RETENTION_DAYS);
  const batchSize = Math.max(10, Math.min(2000, options.batchSize || 500));

  let totalPurgedTrades = 0;
  let totalPurgedOrders = 0;
  let totalPurgedAudit = 0;
  let totalPurgedRequests = 0;
  let checkpointsUpdated = 0;

  // Determine accounts to process
  let accountIds: string[] = [];
  if (options.accountId) {
    accountIds = [options.accountId];
  } else {
    const accRes = await db.query(
      `SELECT DISTINCT account_id FROM trade_closures WHERE exited_at < $1
       UNION
       SELECT DISTINCT account_id FROM orders WHERE status IN ('EXECUTED', 'CANCELLED', 'REJECTED') AND created_at < $1`,
      [cutoff]
    );
    accountIds = accRes.rows.map((r: any) => r.account_id);
  }

  for (const accountId of accountIds) {
    // Process each account in atomic transactions with bounded batches
    await db.transaction(async (tx) => {
      // 1. Gather protected orders for this account
      const protectedOrderIds = await getProtectedOrderIds(tx, accountId, cutoff);

      // 2. Fetch aggregate for trade closures older than cutoff for this account
      const aggRes = await tx.query(
        `SELECT COUNT(*) as count,
                COALESCE(SUM(gross_paise), 0) as gross,
                COALESCE(SUM(charges_paise), 0) as charges,
                COALESCE(SUM(CASE WHEN charges_paise IS NULL THEN 1 ELSE 0 END), 0) as unknown_charges,
                COALESCE(SUM(CASE WHEN charges_paise IS NOT NULL AND gross_paise > charges_paise THEN 1 ELSE 0 END), 0) as wins,
                COALESCE(SUM(CASE WHEN charges_paise IS NOT NULL AND gross_paise < charges_paise THEN 1 ELSE 0 END), 0) as losses,
                COALESCE(SUM(CASE WHEN charges_paise IS NOT NULL AND gross_paise = charges_paise THEN 1 ELSE 0 END), 0) as breakeven
         FROM trade_closures
         WHERE account_id = $1 AND exited_at < $2`,
        [accountId, cutoff]
      );

      const tradesCount = Number(aggRes.rows[0]?.count || 0);
      if (tradesCount > 0) {
        const gross = BigInt(aggRes.rows[0].gross);
        const charges = BigInt(aggRes.rows[0].charges);
        const net = gross - charges;
        const wins = Number(aggRes.rows[0].wins);
        const losses = Number(aggRes.rows[0].losses);
        const breakeven = Number(aggRes.rows[0].breakeven);
        const unknown = Number(aggRes.rows[0].unknown_charges);
        const now = Date.now();

        // Atomically upsert account history checkpoint
        await tx.query(
          `INSERT INTO account_history_checkpoints (
             account_id, purged_trades_count, purged_gross_paise, purged_charges_paise, purged_net_paise,
             purged_wins_count, purged_losses_count, purged_breakeven_count, purged_unknown_count,
             last_cutoff_timestamp, last_purged_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (account_id) DO UPDATE SET
             purged_trades_count = account_history_checkpoints.purged_trades_count + EXCLUDED.purged_trades_count,
             purged_gross_paise = account_history_checkpoints.purged_gross_paise + EXCLUDED.purged_gross_paise,
             purged_charges_paise = account_history_checkpoints.purged_charges_paise + EXCLUDED.purged_charges_paise,
             purged_net_paise = account_history_checkpoints.purged_net_paise + EXCLUDED.purged_net_paise,
             purged_wins_count = account_history_checkpoints.purged_wins_count + EXCLUDED.purged_wins_count,
             purged_losses_count = account_history_checkpoints.purged_losses_count + EXCLUDED.purged_losses_count,
             purged_breakeven_count = account_history_checkpoints.purged_breakeven_count + EXCLUDED.purged_breakeven_count,
             purged_unknown_count = account_history_checkpoints.purged_unknown_count + EXCLUDED.purged_unknown_count,
             last_cutoff_timestamp = EXCLUDED.last_cutoff_timestamp,
             last_purged_at = EXCLUDED.last_purged_at,
             updated_at = EXCLUDED.updated_at`,
          [
            accountId,
            tradesCount,
            gross.toString(),
            charges.toString(),
            net.toString(),
            wins,
            losses,
            breakeven,
            unknown,
            cutoff,
            now,
            now,
          ]
        );
        checkpointsUpdated++;

        // Delete eligible trade closures in bounded batches
        const delTradesRes = await tx.query(
          `DELETE FROM trade_closures 
           WHERE id IN (
             SELECT id FROM trade_closures 
             WHERE account_id = $1 AND exited_at < $2 
             LIMIT $3
           )`,
          [accountId, cutoff, batchSize]
        );
        totalPurgedTrades += delTradesRes.rowCount || 0;
      }

      // 3. Delete eligible terminal orders (not in protectedOrderIds)
      const protectedArray = Array.from(protectedOrderIds);
      let orderDeleteSql = `
        DELETE FROM orders 
        WHERE id IN (
          SELECT id FROM orders 
          WHERE account_id = $1 
            AND status IN ('EXECUTED', 'CANCELLED', 'REJECTED')
            AND created_at < $2
      `;
      const orderDeleteParams: any[] = [accountId, cutoff];
      if (protectedArray.length > 0) {
        const notInPlaceholders = protectedArray.map((_, i) => `$${orderDeleteParams.length + 1 + i}`).join(', ');
        orderDeleteParams.push(...protectedArray);
        orderDeleteSql += ` AND id NOT IN (${notInPlaceholders})`;
      }
      orderDeleteParams.push(batchSize);
      orderDeleteSql += ` LIMIT $${orderDeleteParams.length}) RETURNING id`;

      const delOrdersRes = await tx.query(orderDeleteSql, orderDeleteParams);
      const deletedOrderIds: string[] = delOrdersRes.rows.map((r: any) => r.id);
      totalPurgedOrders += deletedOrderIds.length;

      // 4. Clean up orphaned execution_history and order_execution_context
      if (deletedOrderIds.length > 0) {
        const delPlaceholders = deletedOrderIds.map((_, i) => `$${i + 1}`).join(', ');
        await tx.query(`DELETE FROM execution_history WHERE order_id IN (${delPlaceholders})`, deletedOrderIds);
        await tx.query(`DELETE FROM order_execution_context WHERE order_id IN (${delPlaceholders})`, deletedOrderIds);
      }

      // 5. Clean up obsolete protection audit and requests older than cutoff for closed positions
      const delAuditRes = await tx.query(
        `DELETE FROM position_protection_audit 
         WHERE account_id = $1 
           AND created_at < $2 
           AND position_id NOT IN (SELECT id FROM positions WHERE account_id = $1 AND quantity != 0)`,
        [accountId, cutoff]
      );
      totalPurgedAudit += delAuditRes.rowCount || 0;

      const delReqRes = await tx.query(
        `DELETE FROM position_protection_requests 
         WHERE account_id = $1 
           AND created_at < $2 
           AND position_id NOT IN (SELECT id FROM positions WHERE account_id = $1 AND quantity != 0)`,
        [accountId, cutoff]
      );
      totalPurgedRequests += delReqRes.rowCount || 0;
    });
  }

  return {
    cutoffTimestamp: cutoff,
    purgedTradesCount: totalPurgedTrades,
    purgedTerminalOrdersCount: totalPurgedOrders,
    purgedProtectionAuditCount: totalPurgedAudit,
    purgedProtectionRequestsCount: totalPurgedRequests,
    checkpointsUpdatedCount: checkpointsUpdated,
    durationMs: Date.now() - start,
  };
}

/**
 * Identify all order IDs required by active open positions or retained completed trades.
 * Guarantees that older orders belonging to open positions or recent trades are NEVER deleted.
 */
async function getProtectedOrderIds(
  client: IDatabase | IDatabaseClient,
  accountId: string | undefined,
  cutoff: number
): Promise<Set<string>> {
  const protectedIds = new Set<string>();

  // A. Orders linked to active positions
  const posFilter = accountId ? 'WHERE account_id = $1 AND quantity != 0' : 'WHERE quantity != 0';
  const posParams = accountId ? [accountId] : [];
  const openPosRes = await client.query(
    `SELECT id, stop_order_id, target_order_id FROM positions ${posFilter}`,
    posParams
  );
  const openPosIds: string[] = [];
  for (const row of openPosRes.rows) {
    openPosIds.push(row.id);
    if (row.stop_order_id) protectedIds.add(row.stop_order_id);
    if (row.target_order_id) protectedIds.add(row.target_order_id);
  }

  if (openPosIds.length > 0) {
    const posPlaceholders = openPosIds.map((_, i) => `$${i + 1}`).join(', ');
    const ordersForPosRes = await client.query(
      `SELECT id FROM orders WHERE position_id IN (${posPlaceholders})`,
      openPosIds
    );
    for (const r of ordersForPosRes.rows) protectedIds.add(r.id);
  }

  // B. Orders referenced in position_history_basis for active positions
  const basisFilter = accountId ? 'WHERE account_id = $1' : '';
  const basisParams = accountId ? [accountId] : [];
  const basisRes = await client.query(`SELECT payload_json FROM position_history_basis ${basisFilter}`, basisParams);
  for (const row of basisRes.rows) {
    try {
      const b = JSON.parse(row.payload_json);
      if (b && b.quantity !== 0 && Array.isArray(b.orders)) {
        for (const oid of b.orders) {
          if (oid) protectedIds.add(String(oid));
        }
      }
    } catch {}
  }

  // C. Orders referenced in retained trades (exited_at >= cutoff)
  const retainedFilter = accountId ? 'WHERE account_id = $1 AND exited_at >= $2' : 'WHERE exited_at >= $1';
  const retainedParams = accountId ? [accountId, cutoff] : [cutoff];
  const retainedTradesRes = await client.query(
    `SELECT payload_json FROM trade_closures ${retainedFilter}`,
    retainedParams
  );
  for (const row of retainedTradesRes.rows) {
    try {
      const p = JSON.parse(row.payload_json);
      if (p) {
        if (p.exitOrderId) protectedIds.add(String(p.exitOrderId));
        if (Array.isArray(p.entryOrderIds)) {
          for (const oid of p.entryOrderIds) {
            if (oid) protectedIds.add(String(oid));
          }
        }
      }
    } catch {}
  }

  return protectedIds;
}

/**
 * Read account checkpoint aggregates for an account, combining purged history with active 30-day window
 * to report accurate lifetime totals without double-counting.
 */
export async function getAccountHistoryCheckpoint(
  db: IDatabase,
  accountId: string
): Promise<{
  purgedTradesCount: number;
  purgedGrossPaise: string;
  purgedChargesPaise: string;
  purgedNetPaise: string;
  purgedWinsCount: number;
  purgedLossesCount: number;
  purgedBreakevenCount: number;
  lastPurgedAt: number;
} | null> {
  const res = await db.query(
    `SELECT purged_trades_count, purged_gross_paise, purged_charges_paise, purged_net_paise,
            purged_wins_count, purged_losses_count, purged_breakeven_count, last_purged_at
     FROM account_history_checkpoints
     WHERE account_id = $1`,
    [accountId]
  );
  if (!res.rows.length) return null;
  const r = res.rows[0];
  return {
    purgedTradesCount: Number(r.purged_trades_count || 0),
    purgedGrossPaise: String(r.purged_gross_paise || 0),
    purgedChargesPaise: String(r.purged_charges_paise || 0),
    purgedNetPaise: String(r.purged_net_paise || 0),
    purgedWinsCount: Number(r.purged_wins_count || 0),
    purgedLossesCount: Number(r.purged_losses_count || 0),
    purgedBreakevenCount: Number(r.purged_breakeven_count || 0),
    lastPurgedAt: Number(r.last_purged_at || 0),
  };
}

let retentionCronTimer: NodeJS.Timeout | null = null;

export function startRetentionCron(db: IDatabase, intervalMs: number = 3600000): void {
  if (retentionCronTimer) return;
  // Run on startup shortly after boot, then recurring
  setTimeout(() => {
    executeRetentionCleanup(db).catch((err) => {
      console.error('[Retention Cron] Startup cleanup error:', err);
    });
  }, 10000);

  retentionCronTimer = setInterval(() => {
    executeRetentionCleanup(db).catch((err) => {
      console.error('[Retention Cron] Recurring cleanup error:', err);
    });
  }, intervalMs);
}

export function stopRetentionCron(): void {
  if (retentionCronTimer) {
    clearInterval(retentionCronTimer);
    retentionCronTimer = null;
  }
}
