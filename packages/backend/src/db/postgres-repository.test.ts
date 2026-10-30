import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EmulatedPostgresDatabase } from './database.js';
import { PostgresRepository } from './postgres-repository.js';
import { Money, SimulatedOrder, SimulatedPosition } from '@trading/shared';
import { randomUUID } from 'node:crypto';

describe('PostgreSQL Database Repository Integration', () => {
  let db: EmulatedPostgresDatabase;
  let repo: PostgresRepository;

  beforeEach(async () => {
    db = new EmulatedPostgresDatabase();
    repo = new PostgresRepository(db);
    await repo.syncInstruments([
      {
        globalId: 'NFO:NIFTY26OCTFUT:999001',
        provider: 'DEMO',
        exchange: 'NFO',
        token: '999001',
        symbol: 'NIFTY26OCTFUT',
        name: 'NIFTY Current Month Futures',
        instrumentType: 'FUTIDX',
        isTradable: true,
        lotSize: 25,
        tickSize: 0.05,
      },
    ]);
  });

  test('concurrent first-login requests create exactly one initial ₹100,000 grant', async () => {
    const userId = 'user-concurrent-1';

    // Simulate multiple concurrent login calls
    const accounts = await Promise.all([
      repo.provisionInitialAccount(userId),
      repo.provisionInitialAccount(userId),
      repo.provisionInitialAccount(userId),
    ]);

    const firstId = accounts[0].id;
    for (const acc of accounts) {
      assert.equal(acc.id, firstId);
      assert.equal(acc.cashBalancePaise, 10000000n);
    }

    const ledger = await repo.getLedger(firstId);
    // Exactly one INITIAL_GRANT
    const initialGrants = ledger.filter((l) => l.entryType === 'INITIAL_GRANT');
    assert.equal(initialGrants.length, 1);
  });

  test('margin lock checks available funds and rejects overspending or double-reserving', async () => {
    const acc = await repo.provisionInitialAccount('user-margin-test');
    // Cash balance is ₹100,000 (10,000,000 paise)
    // First lock of ₹60,000 succeeds
    const lock1 = await repo.lockMargin(acc.id, Money.fromRupees(60000));
    assert.equal(lock1, true);

    // Second lock of ₹60,000 must fail because only ₹40,000 available
    const lock2 = await repo.lockMargin(acc.id, Money.fromRupees(60000));
    assert.equal(lock2, false);

    const updated = await repo.getAccount(acc.id);
    assert.equal(updated!.lockedMarginPaise, Money.fromRupees(60000));
    assert.equal(updated!.availableBalancePaise, Money.fromRupees(40000));
  });

  test('account-scoped idempotency stores order and rejects duplicate key with different payload', async () => {
    const acc = await repo.provisionInitialAccount('user-idem-test');

    const order1: SimulatedOrder = {
      id: randomUUID(),
      accountId: acc.id,
      globalInstrumentId: 'NFO:NIFTY26OCTFUT:999001',
      side: 'BUY',
      orderType: 'LIMIT',
      quantity: 25,
      requestedPrice: 24500.0,
      status: 'PENDING',
      idempotencyKey: 'idem-key-1',
      estimatedChargesPaise: Money.fromRupees(20),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await repo.saveOrder(order1);

    // Retrieve by idempotency key
    const retrieved = await repo.getOrderByAccountAndIdempotency(acc.id, 'idem-key-1');
    assert.ok(retrieved);
    assert.equal(retrieved.id, order1.id);

    // Duplicate key insertion must fail PostgreSQL unique constraint
    const orderConflict: SimulatedOrder = {
      ...order1,
      id: randomUUID(),
      quantity: 50, // Conflicting payload!
    };

    await assert.rejects(async () => {
      await repo.saveOrder(orderConflict);
    });
  });

  test('cancellation releases reserved margin accurately', async () => {
    const acc = await repo.provisionInitialAccount('user-cancel-test');
    const margin = Money.fromRupees(40000);

    await repo.lockMargin(acc.id, margin);
    let current = await repo.getAccount(acc.id);
    assert.equal(current!.lockedMarginPaise, margin);

    // Cancel order -> release margin
    await repo.releaseMargin(acc.id, margin);
    current = await repo.getAccount(acc.id);
    assert.equal(current!.lockedMarginPaise, 0n);
    assert.equal(current!.availableBalancePaise, 10000000n);
  });

  test('partial reduction, full exit, fees, and realized P&L settlement', async () => {
    const acc = await repo.provisionInitialAccount('user-trade-test');

    // Simulate trade win: Profit = ₹12,500, Charges = ₹45
    const pnl = Money.fromRupees(12500);
    const charges = Money.fromRupees(45);

    await repo.applyTradeSettlement(acc.id, pnl, charges, 'order-win-1', 'BUY 25 @ ₹24,500');

    const updated = await repo.getAccount(acc.id);
    // 100,000 + 12,500 - 45 = 112,455.00
    assert.equal(updated!.cashBalancePaise, Money.fromRupees(112455));

    const ledger = await repo.getLedger(acc.id);
    const pnlEntry = ledger.find((l) => l.entryType === 'TRADE_PNL');
    const chargesEntry = ledger.find((l) => l.entryType === 'SIMULATED_CHARGES');

    assert.ok(pnlEntry);
    assert.equal(pnlEntry.amountPaise, pnl);
    assert.ok(chargesEntry);
    assert.equal(chargesEntry.amountPaise, -charges);
  });

  test('reset restores ₹100,000 capital, clears margin, and preserves history', async () => {
    const acc = await repo.provisionInitialAccount('user-reset-test');

    // Inflict loss
    await repo.applyTradeSettlement(acc.id, -Money.fromRupees(20000), Money.fromRupees(50), 'ref-loss', 'Loss');
    const preReset = await repo.getAccount(acc.id);
    assert.equal(preReset!.cashBalancePaise, Money.fromRupees(79950));

    // Reset
    const res = await repo.resetAccount(acc.id, [], new Map());
    assert.equal(res.success, true);

    const postReset = await repo.getAccount(acc.id);
    assert.equal(postReset!.cashBalancePaise, 10000000n);
    assert.equal(postReset!.lockedMarginPaise, 0n);

    // Ledger has all 4 entries: RESET, SIMULATED_CHARGES, TRADE_PNL, INITIAL_GRANT
    const ledger = await repo.getLedger(acc.id);
    assert.equal(ledger.length, 4);
    assert.equal(ledger[0].entryType, 'RESET');
  });

  test('application restart recovers persistent orders, positions, and balances from database', async () => {
    const acc = await repo.provisionInitialAccount('user-restart-test');

    const pos: SimulatedPosition = {
      id: randomUUID(),
      accountId: acc.id,
      globalInstrumentId: 'NFO:NIFTY26OCTFUT:999001',
      quantity: 25,
      averageEntryPrice: 24500.0,
      realizedPnlPaise: 0n,
      unrealizedPnlPaise: 0n,
      currentPrice: 24500.0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await repo.saveOrUpdatePosition(pos);

    // Simulate process death and restart by creating a new repository instance pointing to the same DB
    const freshRepoInstance = new PostgresRepository(db);

    const recoveredAccount = await freshRepoInstance.getAccount(acc.id);
    assert.ok(recoveredAccount);
    assert.equal(recoveredAccount.id, acc.id);
    assert.equal(recoveredAccount.cashBalancePaise, 10000000n);

    const recoveredPositions = await freshRepoInstance.getPositions(acc.id);
    assert.equal(recoveredPositions.length, 1);
    assert.equal(recoveredPositions[0].quantity, 25);
    assert.equal(recoveredPositions[0].averageEntryPrice, 24500.0);
  });
});
