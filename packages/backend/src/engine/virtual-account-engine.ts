import {
  LedgerEntry,
  Money,
  Paise,
  SimulatedPosition,
  VirtualAccount,
} from '@trading/shared';
import { randomUUID } from 'node:crypto';

export class VirtualAccountEngine {
  private accounts: Map<string, VirtualAccount> = new Map();
  private ledger: Map<string, LedgerEntry[]> = new Map();

  /**
   * Provision exactly ₹100,000 (10,000,000 Paise) virtual capital once per new user/account.
   */
  public provisionInitialAccount(userId: string, accountName: string = 'Primary Practice Account'): VirtualAccount {
    const existing = Array.from(this.accounts.values()).find((acc) => acc.userId === userId && acc.isDefault);
    if (existing) {
      return existing;
    }

    const accountId = randomUUID();
    const initialPaise = Money.fromRupees(100000); // 10,000,000n

    const account: VirtualAccount = {
      id: accountId,
      userId,
      name: accountName,
      tier: 'FREE',
      startingBalancePaise: initialPaise,
      cashBalancePaise: initialPaise,
      lockedMarginPaise: 0n,
      availableBalancePaise: initialPaise,
      currency: 'INR',
      isDefault: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.accounts.set(accountId, account);
    this.recordLedgerEntry(accountId, 'INITIAL_GRANT', initialPaise, initialPaise, 'Initial virtual practice capital grant of ₹100,000.00');

    return account;
  }

  public getAccount(accountId: string): VirtualAccount | null {
    const acc = this.accounts.get(accountId);
    if (!acc) return null;
    // Recompute available
    acc.availableBalancePaise = acc.cashBalancePaise - acc.lockedMarginPaise;
    return { ...acc };
  }

  public getAccountsForUser(userId: string): VirtualAccount[] {
    return Array.from(this.accounts.values())
      .filter((a) => a.userId === userId)
      .map((a) => ({
        ...a,
        availableBalancePaise: a.cashBalancePaise - a.lockedMarginPaise,
      }));
  }

  /**
   * Atomically reserve margin for an order/position.
   */
  public lockMargin(accountId: string, amountPaise: Paise): boolean {
    const acc = this.accounts.get(accountId);
    if (!acc) throw new Error(`Account not found: ${accountId}`);

    const available = acc.cashBalancePaise - acc.lockedMarginPaise;
    if (available < amountPaise) {
      return false; // Insufficient margin
    }

    acc.lockedMarginPaise += amountPaise;
    acc.availableBalancePaise = acc.cashBalancePaise - acc.lockedMarginPaise;
    acc.updatedAt = Date.now();
    return true;
  }

  /**
   * Release locked margin back to available balance.
   */
  public releaseMargin(accountId: string, amountPaise: Paise): void {
    const acc = this.accounts.get(accountId);
    if (!acc) throw new Error(`Account not found: ${accountId}`);

    acc.lockedMarginPaise -= amountPaise;
    if (acc.lockedMarginPaise < 0n) {
      acc.lockedMarginPaise = 0n;
    }
    acc.availableBalancePaise = acc.cashBalancePaise - acc.lockedMarginPaise;
    acc.updatedAt = Date.now();
  }

  /**
   * Settle trading P&L and simulation charges on the account ledger.
   */
  public applyTradeSettlement(
    accountId: string,
    realizedPnlPaise: Paise,
    chargesPaise: Paise,
    referenceId: string,
    tradeSummary: string
  ): void {
    const acc = this.accounts.get(accountId);
    if (!acc) throw new Error(`Account not found: ${accountId}`);

    // Net settlement = P&L - Charges
    const netChange = realizedPnlPaise - chargesPaise;
    acc.cashBalancePaise += netChange;
    acc.availableBalancePaise = acc.cashBalancePaise - acc.lockedMarginPaise;
    acc.updatedAt = Date.now();

    this.recordLedgerEntry(
      accountId,
      'TRADE_PNL',
      realizedPnlPaise,
      acc.cashBalancePaise,
      `Trade P&L: ${Money.formatINR(realizedPnlPaise)} (${tradeSummary})`,
      referenceId
    );

    if (chargesPaise > 0n) {
      this.recordLedgerEntry(
        accountId,
        'SIMULATED_CHARGES',
        -chargesPaise,
        acc.cashBalancePaise,
        `Simulated regulatory & exchange turnover charges: ${Money.formatINR(chargesPaise)}`,
        referenceId
      );
    }
  }

  /**
   * Reset account back to initial ₹100,000.
   * Preserves full historical ledger while recording a distinct RESET entry.
   * Rejects reset if open positions cannot be priced safely.
   */
  public resetAccount(
    accountId: string,
    openPositions: SimulatedPosition[],
    currentPrices: Map<string, number>
  ): { success: boolean; error?: string } {
    const acc = this.accounts.get(accountId);
    if (!acc) return { success: false, error: 'Account not found' };

    // Check if open positions exist and can be priced safely
    for (const pos of openPositions) {
      if (pos.quantity !== 0) {
        const price = currentPrices.get(pos.globalInstrumentId);
        if (!price || price <= 0) {
          return {
            success: false,
            error: `Cannot safely reset account: open position in ${pos.globalInstrumentId} has missing or unverified market quote. Close position first or wait for valid quote.`,
          };
        }
      }
    }

    const initialPaise = Money.fromRupees(100000);
    const adjustmentPaise = initialPaise - acc.cashBalancePaise;

    acc.cashBalancePaise = initialPaise;
    acc.lockedMarginPaise = 0n;
    acc.availableBalancePaise = initialPaise;
    acc.updatedAt = Date.now();

    this.recordLedgerEntry(
      accountId,
      'RESET',
      adjustmentPaise,
      initialPaise,
      `Account virtual balance reset to ₹100,000.00. Previous cash balance: ${Money.formatINR(acc.cashBalancePaise - adjustmentPaise)}`
    );

    return { success: true };
  }

  public getLedger(accountId: string): LedgerEntry[] {
    return this.ledger.get(accountId) || [];
  }

  private recordLedgerEntry(
    accountId: string,
    entryType: LedgerEntry['entryType'],
    amountPaise: Paise,
    balanceAfterPaise: Paise,
    note: string,
    referenceId?: string
  ): void {
    if (!this.ledger.has(accountId)) {
      this.ledger.set(accountId, []);
    }
    const entry: LedgerEntry = {
      id: randomUUID(),
      accountId,
      entryType,
      amountPaise,
      balanceAfterPaise,
      referenceId,
      note,
      timestamp: Date.now(),
    };
    this.ledger.get(accountId)!.unshift(entry);
  }
}
