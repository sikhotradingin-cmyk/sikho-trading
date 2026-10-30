import {
  LedgerEntry,
  Money,
  Paise,
  SimulatedOrder,
  SimulatedPosition,
  VirtualAccount,
} from '@trading/shared';
import { randomUUID } from 'node:crypto';
import { IDatabase } from './database.js';

export class PostgresRepository {
  constructor(private db: IDatabase) {}

  public async syncInstruments(instruments: any[]): Promise<void> {
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
          Date.now(),
        ]
      );
    }
  }

  public async provisionInitialAccount(
    userId: string,
    accountName: string = 'Primary Practice Account'
  ): Promise<VirtualAccount> {
    // 1. Fast check outside transaction
    const existing = await this.db.query(
      'SELECT * FROM virtual_accounts WHERE user_id = $1 AND is_default = true',
      [userId]
    );
    if (existing.rows.length > 0) {
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
            'FREE',
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

        const accRes = await client.query('SELECT * FROM virtual_accounts WHERE id = $1', [accountId]);
        return this.mapAccount(accRes.rows[0]);
      });
    } catch {
      // If unique violation occurred from concurrent race, return the newly created row
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

  public async getAccount(accountId: string): Promise<VirtualAccount | null> {
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
    currentPrices: Map<string, number>
  ): Promise<{ success: boolean; error?: string }> {
    for (const pos of openPositions) {
      if (pos.quantity !== 0) {
        const price = currentPrices.get(pos.globalInstrumentId);
        if (!price || price <= 0) {
          return {
            success: false,
            error: `Cannot safely reset account: open position in ${pos.globalInstrumentId} has missing quote.`,
          };
        }
      }
    }

    return this.db.transaction(async (client) => {
      const res = await client.query('SELECT * FROM virtual_accounts WHERE id = $1 FOR UPDATE', [accountId]);
      if (res.rows.length === 0) return { success: false, error: 'Account not found' };

      const oldCash = BigInt(res.rows[0].cash_balance_paise);
      const initialPaise = Money.fromRupees(100000);
      const adjustmentPaise = initialPaise - oldCash;
      const now = Date.now();

      await client.query(
        'UPDATE virtual_accounts SET cash_balance_paise = $1, locked_margin_paise = 0, updated_at = $2 WHERE id = $3',
        [initialPaise.toString(), now, accountId]
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
          `Account virtual balance reset to ₹100,000.00. Previous cash balance: ${Money.formatINR(oldCash)}`,
          now,
        ]
      );

      return { success: true };
    });
  }

  public async saveOrder(order: SimulatedOrder): Promise<void> {
    await this.db.query(
      `INSERT INTO orders 
       (id, account_id, global_instrument_id, side, order_type, quantity, requested_price, trigger_price, executed_price, status, idempotency_key, rejection_reason, oco_companion_order_id, position_id, estimated_charges_paise, executed_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        order.id,
        order.accountId,
        order.globalInstrumentId,
        order.side,
        order.orderType,
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
         (id, account_id, global_instrument_id, quantity, average_entry_price, realized_pnl_paise, stop_loss_price, target_price, stop_order_id, target_order_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          position.id,
          position.accountId,
          position.globalInstrumentId,
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
         SET quantity = $1, average_entry_price = $2, realized_pnl_paise = $3, stop_loss_price = $4, target_price = $5, updated_at = $6
         WHERE account_id = $7 AND global_instrument_id = $8`,
        [
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

  public async getLedger(accountId: string): Promise<LedgerEntry[]> {
    const res = await this.db.query(
      'SELECT * FROM account_ledger_entries WHERE account_id = $1 ORDER BY created_at DESC',
      [accountId]
    );
    return res.rows.map(this.mapLedger);
  }

  private mapAccount(row: any): VirtualAccount {
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
}
