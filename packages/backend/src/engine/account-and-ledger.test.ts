import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { VirtualAccountEngine } from './virtual-account-engine.js';
import { Money } from '@trading/shared';

describe('Virtual Account & Ledger Engine', () => {
  test('provisions exactly ₹100,000 (10,000,000 Paise) once per new user', () => {
    const engine = new VirtualAccountEngine();
    const acc1 = engine.provisionInitialAccount('user-1');

    assert.equal(acc1.startingBalancePaise, 10000000n);
    assert.equal(acc1.cashBalancePaise, 10000000n);
    assert.equal(acc1.lockedMarginPaise, 0n);
    assert.equal(acc1.availableBalancePaise, 10000000n);

    // Re-provisioning for same user returns existing account without adding funds
    const acc2 = engine.provisionInitialAccount('user-1');
    assert.equal(acc1.id, acc2.id);
    assert.equal(acc2.cashBalancePaise, 10000000n);

    // Initial grant ledger entry
    const ledger = engine.getLedger(acc1.id);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].entryType, 'INITIAL_GRANT');
    assert.equal(ledger[0].amountPaise, 10000000n);
  });

  test('locks and releases margin atomically without floating-point drift', () => {
    const engine = new VirtualAccountEngine();
    const acc = engine.provisionInitialAccount('user-2');

    const marginRequired = Money.fromRupees(45000.50); // 4,500,050 Paise
    const success = engine.lockMargin(acc.id, marginRequired);
    assert.equal(success, true);

    const updated = engine.getAccount(acc.id)!;
    assert.equal(updated.lockedMarginPaise, marginRequired);
    assert.equal(updated.availableBalancePaise, 10000000n - marginRequired);

    // Release margin
    engine.releaseMargin(acc.id, marginRequired);
    const released = engine.getAccount(acc.id)!;
    assert.equal(released.lockedMarginPaise, 0n);
    assert.equal(released.availableBalancePaise, 10000000n);
  });

  test('resets account with preserved history and creates distinct RESET ledger baseline', () => {
    const engine = new VirtualAccountEngine();
    const acc = engine.provisionInitialAccount('user-3');

    // Simulate loss of ₹15,000
    engine.applyTradeSettlement(acc.id, -Money.fromRupees(15000), Money.fromRupees(50), 'ref-1', 'Loss trade');
    assert.equal(engine.getAccount(acc.id)!.cashBalancePaise, Money.fromRupees(84950));

    // Reset account back to ₹100,000
    const resetRes = engine.resetAccount(acc.id, [], new Map());
    assert.equal(resetRes.success, true);

    const postReset = engine.getAccount(acc.id)!;
    assert.equal(postReset.cashBalancePaise, Money.fromRupees(100000));
    assert.equal(postReset.lockedMarginPaise, 0n);

    // Ledger preserves all entries: RESET, SIMULATED_CHARGES, TRADE_PNL, INITIAL_GRANT
    const ledger = engine.getLedger(acc.id);
    assert.equal(ledger.length, 4);
    assert.equal(ledger[0].entryType, 'RESET');
    assert.equal(ledger[0].balanceAfterPaise, Money.fromRupees(100000));
  });
});
