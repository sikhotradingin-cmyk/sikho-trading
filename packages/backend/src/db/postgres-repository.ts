import {
  LedgerEntry,
  Money,
  Paise,
  ProductType,
  SimulatedOrder,
  SimulatedPosition,
  VirtualAccount,
  PracticeSession,
  LifetimePerformance,
  validateResetCapitalAmount,
  UserTier,
} from '@trading/shared';
import { pbkdf2Sync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { IDatabase } from './database.js';

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  hasPassword: boolean;
  googleSub?: string;
  avatarUrl?: string;
  hasPin: boolean;
  biometricEnabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export function hashSecretPBKDF2(secret: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = pbkdf2Sync(secret, salt, 100000, 32, 'sha256').toString('hex');
  return `pbkdf2:100000:${salt}:${derived}`;
}

export function verifySecretPBKDF2(secret: string, storedHash?: string | null): boolean {
  if (!storedHash || !storedHash.startsWith('pbkdf2:')) return false;
  const parts = storedHash.split(':');
  if (parts.length !== 4) return false;
  const iterations = parseInt(parts[1], 10);
  const salt = parts[2];
  const expectedHex = parts[3];
  const actualBuf = pbkdf2Sync(secret, salt, iterations, 32, 'sha256');
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  if (actualBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(actualBuf, expectedBuf);
}

export class PostgresRepository {
  constructor(private db: IDatabase) {}

  public async syncInstruments(instruments: any[]): Promise<void> {
    const now = Date.now();
    for (const inst of instruments) {
      await this.db.query(
        `INSERT INTO instruments 
         (global_id, provider, exchange, token, symbol, name, instrument_type, is_tradable, lot_size, tick_size, expiry, strike_price, underlying, is_simulated_fixture, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (global_id) DO UPDATE SET updated_at = $15`,
        [
          inst.globalId,
          inst.provider,
          inst.exchange,
          inst.token,
          inst.symbol,
          inst.name,
          inst.instrumentType,
          inst.isTradable,
          inst.lotSize,
          inst.tickSize,
          inst.expiry ?? null,
          inst.strikePrice ?? null,
          inst.underlying ?? null,
          inst.isSimulatedFixture ?? false,
          now,
        ]
      );

      if (inst.canonicalId || inst.upstoxInstrumentKey) {
        const canonicalId = inst.canonicalId || `${inst.exchange}:${inst.token}`;
        await this.db.query(
          `INSERT INTO provider_instrument_mappings
           (canonical_id, exchange, exchange_token, upstox_key, smartapi_global_id, symbol, underlying, instrument_type, expiry_iso, strike_price, option_type, lot_size, tick_size, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           ON CONFLICT (canonical_id) DO UPDATE SET
             upstox_key = COALESCE($4, provider_instrument_mappings.upstox_key),
             smartapi_global_id = COALESCE($5, provider_instrument_mappings.smartapi_global_id),
             updated_at = $14`,
          [
            canonicalId,
            inst.exchange,
            inst.token,
            inst.upstoxInstrumentKey ?? null,
            inst.globalId,
            inst.symbol,
            inst.underlying ?? null,
            inst.instrumentType,
            inst.expiry ?? null,
            inst.strikePrice ?? null,
            inst.optionType ?? null,
            inst.lotSize,
            inst.tickSize,
            now,
          ]
        );
      }
    }
  }

  public async registerUser(params: {
    email: string;
    name: string;
    password?: string;
    googleSub?: string;
    avatarUrl?: string;
  }): Promise<UserRecord> {
    const cleanEmail = params.email.trim().toLowerCase();
    const existing = await this.db.query('SELECT * FROM users WHERE email = $1', [cleanEmail]);
    if (existing.rows.length > 0) {
      throw new Error('ERR_EMAIL_EXISTS: An account with this email already exists. Please sign in.');
    }

    const userId = `usr_${randomUUID()}`;
    const now = Date.now();
    const passwordHash = params.password ? hashSecretPBKDF2(params.password) : null;

    await this.db.query(
      `INSERT INTO users (id, email, name, password_hash, google_sub, avatar_url, biometric_enabled, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        userId,
        cleanEmail,
        params.name.trim(),
        passwordHash,
        params.googleSub ?? null,
        params.avatarUrl ?? null,
        false,
        now,
        now,
      ]
    );

    const res = await this.db.query('SELECT * FROM users WHERE id = $1', [userId]);
    return this.mapUser(res.rows[0]);
  }

  public async authenticateUser(email: string, password: string): Promise<UserRecord> {
    const cleanEmail = email.trim().toLowerCase();
    const res = await this.db.query('SELECT * FROM users WHERE email = $1', [cleanEmail]);
    if (res.rows.length === 0) {
      throw new Error('ERR_INVALID_CREDENTIALS: Invalid email or password.');
    }
    const row = res.rows[0];
    if (!verifySecretPBKDF2(password, row.password_hash)) {
      throw new Error('ERR_INVALID_CREDENTIALS: Invalid email or password.');
    }
    return this.mapUser(row);
  }

  public async upsertGoogleUser(params: {
    email: string;
    name: string;
    googleSub: string;
    avatarUrl?: string;
  }): Promise<UserRecord> {
    const cleanEmail = params.email.trim().toLowerCase();
    const sub = params.googleSub.trim();
    const now = Date.now();

    // 1. Strict primary lookup by permanent immutable Google Subject ID (google_sub)
    const bySub = await this.db.query('SELECT * FROM users WHERE google_sub = $1', [sub]);
    if (bySub.rows.length > 0) {
      const userId = bySub.rows[0].id;
      await this.db.query(
        'UPDATE users SET email = $1, name = COALESCE(NULLIF($2, \'\'), name), avatar_url = COALESCE($3, avatar_url), updated_at = $4 WHERE id = $5',
        [cleanEmail, params.name.trim(), params.avatarUrl ?? null, now, userId]
      );
      const updated = await this.db.query('SELECT * FROM users WHERE id = $1', [userId]);
      return this.mapUser(updated.rows[0]);
    }

    // 2. Check by email ONLY if that existing email user has no conflicting password / account
    // Never merge accounts solely because their email strings match if an existing user was created separately
    const byEmail = await this.db.query('SELECT * FROM users WHERE email = $1', [cleanEmail]);
    if (byEmail.rows.length > 0) {
      const existingUser = byEmail.rows[0];
      // Only link if this existing record already has the same google_sub or no credentials conflicting
      if (existingUser.google_sub === sub) {
        return this.mapUser(existingUser);
      }
      if (!existingUser.google_sub && !existingUser.password_hash) {
        // Link unlinked passwordless record to this verified Google Subject
        await this.db.query(
          'UPDATE users SET google_sub = $1, avatar_url = COALESCE($2, avatar_url), updated_at = $3 WHERE id = $4',
          [sub, params.avatarUrl ?? null, now, existingUser.id]
        );
        const updated = await this.db.query('SELECT * FROM users WHERE id = $1', [existingUser.id]);
        return this.mapUser(updated.rows[0]);
      }
      // If there is an existing email with a password or different google_sub, do not merge blindly!
      // Create distinct isolated Google user to preserve security and isolation.
    }

    const userId = `usr_g_${randomUUID()}`;
    await this.db.query(
      `INSERT INTO users (id, email, name, password_hash, google_sub, avatar_url, biometric_enabled, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        userId,
        cleanEmail,
        params.name.trim(),
        null,
        sub,
        params.avatarUrl ?? null,
        false,
        now,
        now,
      ]
    );

    const res = await this.db.query('SELECT * FROM users WHERE id = $1', [userId]);
    return this.mapUser(res.rows[0]);
  }

  public async getUserById(userId: string): Promise<UserRecord | null> {
    const res = await this.db.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (res.rows.length === 0) return null;
    return this.mapUser(res.rows[0]);
  }

  public async getUserByEmail(email: string): Promise<UserRecord | null> {
    const res = await this.db.query('SELECT * FROM users WHERE email = $1', [email.trim().toLowerCase()]);
    if (res.rows.length === 0) return null;
    return this.mapUser(res.rows[0]);
  }

  public async resetUserPassword(email: string, newPassword: string): Promise<UserRecord> {
    const cleanEmail = email.trim().toLowerCase();
    const res = await this.db.query('SELECT * FROM users WHERE email = $1', [cleanEmail]);
    if (res.rows.length === 0) {
      throw new Error('ERR_USER_NOT_FOUND: No account found with this email address.');
    }
    const userId = res.rows[0].id;
    const hash = hashSecretPBKDF2(newPassword);
    await this.db.query('UPDATE users SET password_hash = $1, pin_hash = NULL, biometric_enabled = FALSE, updated_at = $2 WHERE id = $3', [
      hash,
      Date.now(),
      userId,
    ]);
    const updated = await this.db.query('SELECT * FROM users WHERE id = $1', [userId]);
    return this.mapUser(updated.rows[0]);
  }

  public async getDrawings(userId: string, instrumentId: string): Promise<any[]> {
    const res = await this.db.query(
      'SELECT drawings_json FROM chart_drawings WHERE user_id = $1 AND instrument_id = $2',
      [userId, instrumentId]
    );
    if (res.rows.length === 0) return [];
    try {
      return JSON.parse(res.rows[0].drawings_json || '[]');
    } catch {
      return [];
    }
  }

  public async saveDrawings(userId: string, instrumentId: string, drawings: any[]): Promise<void> {
    const existing = await this.db.query(
      'SELECT id FROM chart_drawings WHERE user_id = $1 AND instrument_id = $2',
      [userId, instrumentId]
    );
    const jsonStr = JSON.stringify(Array.isArray(drawings) ? drawings : []);
    const now = Date.now();
    if (existing.rows.length === 0) {
      await this.db.query(
        'INSERT INTO chart_drawings (id, user_id, instrument_id, drawings_json, updated_at) VALUES ($1, $2, $3, $4, $5)',
        [randomUUID(), userId, instrumentId, jsonStr, now]
      );
    } else {
      await this.db.query(
        'UPDATE chart_drawings SET drawings_json = $1, updated_at = $2 WHERE user_id = $3 AND instrument_id = $4',
        [jsonStr, now, userId, instrumentId]
      );
    }
  }

  public async provisionInitialAccount(
    userId: string,
    accountName: string = 'Primary Practice Account',
    initialTier: 'FREE' | 'PRO' = 'FREE'
  ): Promise<VirtualAccount> {
    // 1. Fast check outside transaction
    const existing = await this.db.query(
      'SELECT * FROM virtual_accounts WHERE user_id = $1 AND is_default = true',
      [userId]
    );
    if (existing.rows.length > 0) {
      if (initialTier === 'PRO' && existing.rows[0].tier !== 'PRO' && process.env.NODE_ENV !== 'production') {
        const realUserCheck = await this.db.query('SELECT id FROM users WHERE id = $1 LIMIT 1', [userId]);
        if (realUserCheck.rows.length === 0) {
          await this.db.query('UPDATE virtual_accounts SET tier = $1 WHERE id = $2', [
            'PRO',
            existing.rows[0].id,
          ]);
          existing.rows[0].tier = 'PRO';
        }
      }
      return this.mapAccount(existing.rows[0]);
    }

    try {
      return await this.db.transaction(async (client) => {
        const checkRes = await client.query(
          'SELECT * FROM virtual_accounts WHERE user_id = $1 AND is_default = true',
          [userId]
        );
        if (checkRes.rows.length > 0) {
          return this.mapAccount(checkRes.rows[0]);
        }

        const accountId = randomUUID();
        const initialPaise = Money.fromRupees(100000); // 10,000,000n
        const now = Date.now();

        await client.query(
          `INSERT INTO virtual_accounts 
           (id, user_id, name, tier, starting_balance_paise, cash_balance_paise, locked_margin_paise, currency, is_default, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            accountId,
            userId,
            accountName,
            initialTier,
            initialPaise.toString(),
            initialPaise.toString(),
            '0',
            'INR',
            true,
            now,
            now,
          ]
        );

        // Record initial grant ledger entry
        await client.query(
          `INSERT INTO account_ledger_entries 
           (id, account_id, entry_type, amount_paise, balance_after_paise, note, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            randomUUID(),
            accountId,
            'INITIAL_GRANT',
            initialPaise.toString(),
            initialPaise.toString(),
            'Initial virtual practice capital grant of ₹100,000.00',
            now,
          ]
        );

        // Initialize active practice session
        const sessionId = randomUUID();
        await client.query(
          `INSERT INTO practice_sessions 
           (id, account_id, user_id, starting_capital_paise, realized_pnl_paise, total_charges_paise, trades_count, win_trades_count, is_active, started_at)
           VALUES ($1, $2, $3, $4, 0, 0, 0, 0, true, $5)`,
          [sessionId, accountId, userId, initialPaise.toString(), now]
        );
        await client.query(
          'UPDATE virtual_accounts SET active_session_id = $1 WHERE id = $2',
          [sessionId, accountId]
        );

        const accRes = await client.query('SELECT * FROM virtual_accounts WHERE id = $1', [accountId]);
        return this.mapAccount(accRes.rows[0]);
      });
    } catch {
      const fallback = await this.db.query(
        'SELECT * FROM virtual_accounts WHERE user_id = $1 AND is_default = true',
        [userId]
      );
      if (fallback.rows.length > 0) {
        return this.mapAccount(fallback.rows[0]);
      }
      throw new Error('Failed to provision account due to unexpected error.');
    }
  }

  public async getAccount(accountId: string): Promise<(VirtualAccount & { baselineResetAt?: number }) | null> {
    const res = await this.db.query('SELECT * FROM virtual_accounts WHERE id = $1', [accountId]);
    if (res.rows.length === 0) return null;
    return this.mapAccount(res.rows[0]);
  }

  public async lockMargin(accountId: string, amountPaise: Paise): Promise<boolean> {
    return this.db.transaction(async (client) => {
      const res = await client.query(
        'SELECT cash_balance_paise, locked_margin_paise FROM virtual_accounts WHERE id = $1 FOR UPDATE',
        [accountId]
      );
      if (res.rows.length === 0) throw new Error(`Account not found: ${accountId}`);

      const cash = BigInt(res.rows[0].cash_balance_paise);
      const locked = BigInt(res.rows[0].locked_margin_paise);
      const available = cash - locked;

      if (available < amountPaise) {
        return false; // Insufficient margin
      }

      const newLocked = locked + amountPaise;
      await client.query(
        'UPDATE virtual_accounts SET locked_margin_paise = $1, updated_at = $2 WHERE id = $3',
        [newLocked.toString(), Date.now(), accountId]
      );
      return true;
    });
  }

  public async releaseMargin(accountId: string, amountPaise: Paise): Promise<void> {
    await this.db.transaction(async (client) => {
      const res = await client.query(
        'SELECT locked_margin_paise FROM virtual_accounts WHERE id = $1 FOR UPDATE',
        [accountId]
      );
      if (res.rows.length === 0) return;

      const currentLocked = BigInt(res.rows[0].locked_margin_paise);
      const newLocked = currentLocked > amountPaise ? currentLocked - amountPaise : 0n;

      await client.query(
        'UPDATE virtual_accounts SET locked_margin_paise = $1, updated_at = $2 WHERE id = $3',
        [newLocked.toString(), Date.now(), accountId]
      );
    });
  }

  public async applyOrderCharges(
    accountId: string,
    chargesPaise: Paise,
    referenceId: string,
    orderSummary: string
  ): Promise<void> {
    if (chargesPaise <= 0n) return;
    await this.db.transaction(async (client) => {
      const res = await client.query(
        'SELECT cash_balance_paise FROM virtual_accounts WHERE id = $1 FOR UPDATE',
        [accountId]
      );
      if (res.rows.length === 0) throw new Error(`Account not found: ${accountId}`);

      const currentCash = BigInt(res.rows[0].cash_balance_paise);
      const newCash = currentCash - chargesPaise;
      const now = Date.now();

      await client.query(
        'UPDATE virtual_accounts SET cash_balance_paise = $1, updated_at = $2 WHERE id = $3',
        [newCash.toString(), now, accountId]
      );

      await client.query(
        `INSERT INTO account_ledger_entries 
         (id, account_id, entry_type, amount_paise, balance_after_paise, reference_id, note, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          randomUUID(),
          accountId,
          'SIMULATED_CHARGES',
          (-chargesPaise).toString(),
          newCash.toString(),
          referenceId,
          `Simulated regulatory & exchange turnover charges: ${Money.formatINR(chargesPaise)} (${orderSummary})`,
          now,
        ]
      );
    });
  }

  public async applyTradeSettlement(
    accountId: string,
    realizedPnlPaise: Paise,
    chargesPaise: Paise,
    referenceId: string,
    tradeSummary: string
  ): Promise<void> {
    await this.db.transaction(async (client) => {
      const res = await client.query(
        'SELECT cash_balance_paise FROM virtual_accounts WHERE id = $1 FOR UPDATE',
        [accountId]
      );
      if (res.rows.length === 0) throw new Error(`Account not found: ${accountId}`);

      const currentCash = BigInt(res.rows[0].cash_balance_paise);
      const netChange = realizedPnlPaise - chargesPaise;
      const newCash = currentCash + netChange;
      const now = Date.now();

      await client.query(
        'UPDATE virtual_accounts SET cash_balance_paise = $1, updated_at = $2 WHERE id = $3',
        [newCash.toString(), now, accountId]
      );

      // Ledger: Trade P&L
      await client.query(
        `INSERT INTO account_ledger_entries 
         (id, account_id, entry_type, amount_paise, balance_after_paise, reference_id, note, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          randomUUID(),
          accountId,
          'TRADE_PNL',
          realizedPnlPaise.toString(),
          (currentCash + realizedPnlPaise).toString(),
          referenceId,
          `Trade P&L: ${Money.formatINR(realizedPnlPaise)} (${tradeSummary})`,
          now,
        ]
      );

      // Ledger: Charges
      if (chargesPaise > 0n) {
        await client.query(
          `INSERT INTO account_ledger_entries 
           (id, account_id, entry_type, amount_paise, balance_after_paise, reference_id, note, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            randomUUID(),
            accountId,
            'SIMULATED_CHARGES',
            (-chargesPaise).toString(),
            newCash.toString(),
            referenceId,
            `Simulated regulatory & exchange turnover charges: ${Money.formatINR(chargesPaise)}`,
            now,
          ]
        );
      }
    });
  }

  public async resetAccount(
    accountId: string,
    openPositions: SimulatedPosition[],
    _currentPrices: Map<string, number>,
    requestedCapitalRupees: number = 100000,
    tier: UserTier = 'FREE'
  ): Promise<{ success: boolean; newSessionId?: string; error?: string }> {
    const hasOpenPositions = openPositions.some((pos) => pos.quantity !== 0);
    if (hasOpenPositions) {
      return {
        success: false,
        error: 'Cannot reset capital while active open positions exist. Please square off all open positions first.',
      };
    }

    const validation = validateResetCapitalAmount(requestedCapitalRupees, tier);
    if (!validation.valid) {
      return {
        success: false,
        error: validation.error,
      };
    }

    return this.db.transaction(async (client) => {
      const res = await client.query('SELECT * FROM virtual_accounts WHERE id = $1 FOR UPDATE', [accountId]);
      if (res.rows.length === 0) return { success: false, error: 'Account not found' };

      const posCheck = await client.query(
        'SELECT COUNT(*) as count FROM positions WHERE account_id = $1 AND quantity != 0',
        [accountId]
      );
      if (parseInt(posCheck.rows[0].count, 10) > 0) {
        return {
          success: false,
          error: 'Cannot reset capital while active open positions exist. Please square off all open positions first.',
        };
      }

      const ordCheck = await client.query(
        "SELECT COUNT(*) as count FROM orders WHERE account_id = $1 AND status = 'PENDING'",
        [accountId]
      );
      if (parseInt(ordCheck.rows[0].count, 10) > 0) {
        return {
          success: false,
          error: 'Cannot reset capital while pending orders exist. Please cancel all pending orders first.',
        };
      }

      const oldCash = BigInt(res.rows[0].cash_balance_paise);
      const activeSessionId = res.rows[0].active_session_id;
      const initialPaise = Money.fromRupees(requestedCapitalRupees);
      const adjustmentPaise = initialPaise - oldCash;
      const now = Date.now();
      const userId = res.rows[0].user_id;

      if (activeSessionId) {
        await client.query(
          `UPDATE practice_sessions 
           SET is_active = false, final_cash_paise = $1, ended_at = $2 
           WHERE id = $3`,
          [oldCash.toString(), now, activeSessionId]
        );
      }

      const newSessionId = randomUUID();
      await client.query(
        `INSERT INTO practice_sessions 
         (id, account_id, user_id, starting_capital_paise, realized_pnl_paise, total_charges_paise, trades_count, win_trades_count, is_active, started_at)
         VALUES ($1, $2, $3, $4, 0, 0, 0, 0, true, $5)`,
        [newSessionId, accountId, userId, initialPaise.toString(), now]
      );

      await client.query(
        `UPDATE virtual_accounts 
         SET cash_balance_paise = $1, starting_balance_paise = $1, locked_margin_paise = 0, 
             active_session_id = $2, baseline_reset_at = $3, updated_at = $3 
         WHERE id = $4`,
        [initialPaise.toString(), newSessionId, now, accountId]
      );

      await client.query(
        `INSERT INTO account_ledger_entries 
         (id, account_id, entry_type, amount_paise, balance_after_paise, note, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          randomUUID(),
          accountId,
          'RESET',
          adjustmentPaise.toString(),
          initialPaise.toString(),
          `Practice capital reset to ${Money.formatINR(initialPaise)}. Previous cash balance: ${Money.formatINR(oldCash)}. New session started.`,
          now,
        ]
      );

      return { success: true, newSessionId };
    });
  }

  public async getActiveSession(accountId: string): Promise<PracticeSession | null> {
    const res = await this.db.query(
      'SELECT * FROM practice_sessions WHERE account_id = $1 AND is_active = true LIMIT 1',
      [accountId]
    );
    if (res.rows.length === 0) {
      const accRes = await this.db.query('SELECT * FROM virtual_accounts WHERE id = $1', [accountId]);
      if (accRes.rows.length === 0) return null;
      const acc = accRes.rows[0];
      const sessionId = randomUUID();
      const now = Date.now();
      const startingPaise = acc.starting_balance_paise || acc.cash_balance_paise || '10000000';
      await this.db.query(
        `INSERT INTO practice_sessions 
         (id, account_id, user_id, starting_capital_paise, realized_pnl_paise, total_charges_paise, trades_count, win_trades_count, is_active, started_at)
         VALUES ($1, $2, $3, $4, 0, 0, 0, 0, true, $5)`,
        [sessionId, accountId, acc.user_id, startingPaise, now]
      );
      await this.db.query('UPDATE virtual_accounts SET active_session_id = $1 WHERE id = $2', [sessionId, accountId]);
      return {
        id: sessionId,
        accountId,
        userId: acc.user_id,
        startingCapitalPaise: BigInt(startingPaise),
        realizedPnlPaise: 0n,
        totalChargesPaise: 0n,
        tradesCount: 0,
        winTradesCount: 0,
        isActive: true,
        startedAt: now,
      };
    }
    return this.mapSession(res.rows[0]);
  }

  public async getLifetimePerformance(userId: string): Promise<LifetimePerformance> {
    const sessRes = await this.db.query(
      `SELECT 
         COUNT(*) as total_sessions,
         COALESCE(SUM(realized_pnl_paise), 0) as total_pnl,
         COALESCE(SUM(total_charges_paise), 0) as total_charges,
         COALESCE(SUM(trades_count), 0) as total_trades,
         COALESCE(SUM(win_trades_count), 0) as total_wins
       FROM practice_sessions
       WHERE user_id = $1`,
      [userId]
    );
    const row = sessRes.rows[0] || {};
    const totalPnl = BigInt(row.total_pnl || 0);
    const totalCharges = BigInt(row.total_charges || 0);
    const totalTrades = parseInt(row.total_trades || '0', 10);
    const winTrades = parseInt(row.total_wins || '0', 10);
    const totalSessions = parseInt(row.total_sessions || '0', 10);

    return {
      lifetimeRealizedPnlPaise: totalPnl,
      lifetimeChargesPaise: totalCharges,
      lifetimeNetTradingPnlPaise: totalPnl - totalCharges,
      lifetimeTradesCount: totalTrades,
      lifetimeWinTradesCount: winTrades,
      winRatePct: totalTrades > 0 ? Math.round((winTrades / totalTrades) * 10000) / 100 : 0,
      totalSessionsCount: totalSessions,
    };
  }

  private mapSession(row: any): PracticeSession {
    return {
      id: row.id,
      accountId: row.account_id,
      userId: row.user_id,
      startingCapitalPaise: BigInt(row.starting_capital_paise),
      finalCashPaise: row.final_cash_paise !== null ? BigInt(row.final_cash_paise) : null,
      realizedPnlPaise: BigInt(row.realized_pnl_paise || 0),
      totalChargesPaise: BigInt(row.total_charges_paise || 0),
      tradesCount: parseInt(row.trades_count || '0', 10),
      winTradesCount: parseInt(row.win_trades_count || '0', 10),
      isActive: Boolean(row.is_active),
      startedAt: Number(row.started_at),
      endedAt: row.ended_at !== null ? Number(row.ended_at) : null,
    };
  }

  public async saveOrder(order: SimulatedOrder): Promise<void> {
    await this.db.query(
      `INSERT INTO orders 
       (id, account_id, global_instrument_id, side, order_type, product_type, quantity, requested_price, trigger_price, executed_price, status, idempotency_key, rejection_reason, oco_companion_order_id, position_id, estimated_charges_paise, executed_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        order.id,
        order.accountId,
        order.globalInstrumentId,
        order.side,
        order.orderType,
        order.productType || 'INTRADAY',
        order.quantity,
        order.requestedPrice ?? null,
        order.triggerPrice ?? null,
        order.executedPrice ?? null,
        order.status,
        order.idempotencyKey,
        order.rejectionReason ?? null,
        order.ocoCompanionOrderId ?? null,
        order.positionId ?? null,
        order.estimatedChargesPaise.toString(),
        order.executedAt ?? null,
        order.createdAt,
        order.updatedAt,
      ]
    );
  }

  public async updateOrder(order: SimulatedOrder): Promise<void> {
    await this.db.query(
      `UPDATE orders 
       SET status = $1, executed_price = $2, rejection_reason = $3, executed_at = $4, updated_at = $5
       WHERE id = $6`,
      [
        order.status,
        order.executedPrice ?? null,
        order.rejectionReason ?? null,
        order.executedAt ?? null,
        order.updatedAt,
        order.id,
      ]
    );
  }

  public async saveOrUpdatePosition(position: SimulatedPosition): Promise<void> {
    const existing = await this.db.query(
      'SELECT id FROM positions WHERE account_id = $1 AND global_instrument_id = $2',
      [position.accountId, position.globalInstrumentId]
    );

    if (existing.rows.length === 0) {
      await this.db.query(
        `INSERT INTO positions 
         (id, account_id, global_instrument_id, product_type, quantity, average_entry_price, realized_pnl_paise, stop_loss_price, target_price, stop_order_id, target_order_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          position.id,
          position.accountId,
          position.globalInstrumentId,
          position.productType || 'INTRADAY',
          position.quantity,
          position.averageEntryPrice,
          position.realizedPnlPaise.toString(),
          position.stopLossPrice ?? null,
          position.targetPrice ?? null,
          position.stopOrderId ?? null,
          position.targetOrderId ?? null,
          position.createdAt,
          position.updatedAt,
        ]
      );
    } else {
      await this.db.query(
        `UPDATE positions 
         SET product_type = $1, quantity = $2, average_entry_price = $3, realized_pnl_paise = $4, stop_loss_price = $5, target_price = $6, updated_at = $7
         WHERE account_id = $8 AND global_instrument_id = $9`,
        [
          position.productType || 'INTRADAY',
          position.quantity,
          position.averageEntryPrice,
          position.realizedPnlPaise.toString(),
          position.stopLossPrice ?? null,
          position.targetPrice ?? null,
          position.updatedAt,
          position.accountId,
          position.globalInstrumentId,
        ]
      );
    }
  }

  public async getOrders(accountId: string): Promise<SimulatedOrder[]> {
    const res = await this.db.query(
      'SELECT * FROM orders WHERE account_id = $1 ORDER BY created_at DESC',
      [accountId]
    );
    return res.rows.map(this.mapOrder);
  }

  public async getOrderByAccountAndIdempotency(
    accountId: string,
    idempotencyKey: string
  ): Promise<SimulatedOrder | null> {
    const res = await this.db.query(
      'SELECT * FROM orders WHERE account_id = $1 AND idempotency_key = $2',
      [accountId, idempotencyKey]
    );
    if (res.rows.length === 0) return null;
    return this.mapOrder(res.rows[0]);
  }

  public async getPositions(accountId: string): Promise<SimulatedPosition[]> {
    const res = await this.db.query('SELECT * FROM positions WHERE account_id = $1', [accountId]);
    return res.rows.map(this.mapPosition);
  }

  public async getAllOpenPositionInstrumentIds(): Promise<string[]> {
    const posRes = await this.db.query('SELECT DISTINCT global_instrument_id FROM positions WHERE quantity != 0');
    const ordRes = await this.db.query("SELECT DISTINCT global_instrument_id FROM orders WHERE status = 'PENDING'");
    const set = new Set<string>();
    for (const r of posRes.rows) set.add(r.global_instrument_id);
    for (const r of ordRes.rows) set.add(r.global_instrument_id);
    return Array.from(set);
  }

  public async getLedger(accountId: string): Promise<LedgerEntry[]> {
    const res = await this.db.query(
      'SELECT * FROM account_ledger_entries WHERE account_id = $1 ORDER BY created_at DESC',
      [accountId]
    );
    return res.rows.map(this.mapLedger);
  }

  private mapUser(row: any): UserRecord {
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      hasPassword: Boolean(row.password_hash),
      googleSub: row.google_sub ?? undefined,
      avatarUrl: row.avatar_url ?? undefined,
      hasPin: false,
      biometricEnabled: false,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private mapAccount(row: any): VirtualAccount & { baselineResetAt?: number } {
    const cash = BigInt(row.cash_balance_paise);
    const locked = BigInt(row.locked_margin_paise);
    return {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      tier: row.tier,
      startingBalancePaise: BigInt(row.starting_balance_paise),
      cashBalancePaise: cash,
      lockedMarginPaise: locked,
      availableBalancePaise: cash - locked,
      currency: 'INR',
      isDefault: Boolean(row.is_default),
      baselineResetAt: Number(row.baseline_reset_at || 0),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private mapOrder(row: any): SimulatedOrder {
    return {
      id: row.id,
      accountId: row.account_id,
      globalInstrumentId: row.global_instrument_id,
      side: row.side,
      orderType: row.order_type,
      productType: (row.product_type as ProductType) || 'INTRADAY',
      quantity: Number(row.quantity),
      requestedPrice: row.requested_price !== null ? Number(row.requested_price) : undefined,
      triggerPrice: row.trigger_price !== null ? Number(row.trigger_price) : undefined,
      executedPrice: row.executed_price !== null ? Number(row.executed_price) : undefined,
      status: row.status,
      idempotencyKey: row.idempotency_key,
      rejectionReason: row.rejection_reason ?? undefined,
      ocoCompanionOrderId: row.oco_companion_order_id ?? undefined,
      positionId: row.position_id ?? undefined,
      estimatedChargesPaise: BigInt(row.estimated_charges_paise || 0),
      executedAt: row.executed_at ? Number(row.executed_at) : undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private mapPosition(row: any): SimulatedPosition {
    return {
      id: row.id,
      accountId: row.account_id,
      globalInstrumentId: row.global_instrument_id,
      productType: (row.product_type as ProductType) || 'INTRADAY',
      quantity: Number(row.quantity),
      averageEntryPrice: Number(row.average_entry_price),
      realizedPnlPaise: BigInt(row.realized_pnl_paise || 0),
      unrealizedPnlPaise: 0n,
      currentPrice: Number(row.average_entry_price),
      stopLossPrice: row.stop_loss_price !== null ? Number(row.stop_loss_price) : undefined,
      targetPrice: row.target_price !== null ? Number(row.target_price) : undefined,
      stopOrderId: row.stop_order_id ?? undefined,
      targetOrderId: row.target_order_id ?? undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  private mapLedger(row: any): LedgerEntry {
    return {
      id: row.id,
      accountId: row.account_id,
      entryType: row.entry_type,
      amountPaise: BigInt(row.amount_paise),
      balanceAfterPaise: BigInt(row.balance_after_paise),
      referenceId: row.reference_id ?? undefined,
      note: row.note,
      timestamp: Number(row.created_at),
    };
  }

  public async getUserIndexPreferences(userId: string): Promise<string[] | null> {
    const cleanUserId = userId.trim();
    const res = await this.db.query(
      'SELECT selected_indices_json FROM user_index_preferences WHERE user_id = $1',
      [cleanUserId]
    );
    if (res.rows.length === 0) return null;
    try {
      const parsed = JSON.parse(res.rows[0].selected_indices_json);
      return Array.isArray(parsed) && parsed.length === 3 ? parsed : null;
    } catch {
      return null;
    }
  }

  public async setUserIndexPreferences(userId: string, selectedIndices: string[]): Promise<void> {
    const cleanUserId = userId.trim();
    const now = Date.now();
    const jsonStr = JSON.stringify(selectedIndices);
    await this.db.query(
      `INSERT INTO user_index_preferences (user_id, selected_indices_json, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE SET selected_indices_json = $2, updated_at = $3`,
      [cleanUserId, jsonStr, now]
    );
  }
}
