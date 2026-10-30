import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Money } from './money.js';

describe('Money (Paise integer arithmetic)', () => {
  test('converts rupees to paise accurately without floating point drift', () => {
    assert.equal(Money.fromRupees(100000.0), 10000000n);
    assert.equal(Money.fromRupees('100000.00'), 10000000n);
    assert.equal(Money.fromRupees(24500.55), 2450055n);
    assert.equal(Money.fromRupees(-150.25), -15025n);
  });

  test('converts paise to rupees decimal for display', () => {
    assert.equal(Money.toRupees(10000000n), 100000);
    assert.equal(Money.toRupees(2450055n), 24500.55);
    assert.equal(Money.toRupees(-15025n), -150.25);
  });

  test('formats integer paise to Indian currency formatting', () => {
    assert.equal(Money.formatINR(10000000n), '₹1,00,000.00');
    assert.equal(Money.formatINR(2450055n), '₹24,500.55');
    assert.equal(Money.formatINR(-543210n), '-₹5,432.10');
    assert.equal(Money.formatINR(0n), '₹0.00');
  });

  test('multiplies paise by rate with integer half-up rounding', () => {
    const principal = 100000n; // ₹1,000.00
    // 12% = 0.12 -> 12,000 paise (₹120.00)
    assert.equal(Money.multiply(principal, 0.12), 12000n);
  });
});
