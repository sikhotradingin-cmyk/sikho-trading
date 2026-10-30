import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { OrderValidator } from './order-validator.js';
import { InstrumentMetadata } from '../models/instrument.js';
import { PlaceOrderRequest } from '../models/order.js';
import { Money } from '../models/money.js';

describe('OrderValidator', () => {
  const niftyFuture: InstrumentMetadata = {
    globalId: 'NFO:NIFTY26OCTFUT:999001',
    provider: 'DEMO',
    exchange: 'NFO',
    token: '999001',
    symbol: 'NIFTY26OCTFUT',
    name: 'NIFTY Futures Current Month',
    instrumentType: 'FUTIDX',
    isTradable: true,
    lotSize: 25, // Dynamically set from metadata
    tickSize: 0.05,
    expiry: '2026-11-26',
    isSimulatedFixture: true,
  };

  const spotIndex: InstrumentMetadata = {
    globalId: 'NSE:NIFTY50:999000',
    provider: 'DEMO',
    exchange: 'NSE',
    token: '999000',
    symbol: 'NIFTY 50',
    name: 'NIFTY 50 Spot Index',
    instrumentType: 'INDEX_SPOT',
    isTradable: false, // Spot is non-tradable!
    lotSize: 1,
    tickSize: 0.05,
    isSimulatedFixture: true,
  };

  test('rejects spot index order with explicit educational error', () => {
    const req: PlaceOrderRequest = {
      accountId: 'acc-1',
      globalInstrumentId: spotIndex.globalId,
      side: 'BUY',
      orderType: 'MARKET',
      quantity: 50,
      idempotencyKey: 'idem-1',
    };

    const res = OrderValidator.validate(req, spotIndex, Money.fromRupees(100000), 24500);
    assert.equal(res.isValid, false);
    if (!res.isValid) {
      assert.equal(res.errorCode, 'ERR_SPOT_INDEX_NOT_TRADABLE');
    }
  });

  test('rejects quantity that is not an exact multiple of dynamic lot size', () => {
    const req: PlaceOrderRequest = {
      accountId: 'acc-1',
      globalInstrumentId: niftyFuture.globalId,
      side: 'BUY',
      orderType: 'MARKET',
      quantity: 30, // Not multiple of 25!
      idempotencyKey: 'idem-2',
    };

    const res = OrderValidator.validate(req, niftyFuture, Money.fromRupees(100000), 24500);
    assert.equal(res.isValid, false);
    if (!res.isValid) {
      assert.equal(res.errorCode, 'ERR_INVALID_LOT_MULTIPLE');
    }
  });

  test('rejects price not aligned with tick size', () => {
    const req: PlaceOrderRequest = {
      accountId: 'acc-1',
      globalInstrumentId: niftyFuture.globalId,
      side: 'BUY',
      orderType: 'LIMIT',
      quantity: 25,
      requestedPrice: 24500.13, // Tick is 0.05!
      idempotencyKey: 'idem-3',
    };

    const res = OrderValidator.validate(req, niftyFuture, Money.fromRupees(100000), 24500);
    assert.equal(res.isValid, false);
    if (!res.isValid) {
      assert.equal(res.errorCode, 'ERR_OFF_TICK_PRICE');
    }
  });

  test('validates valid order and calculates required margin and simulation charges', () => {
    const req: PlaceOrderRequest = {
      accountId: 'acc-1',
      globalInstrumentId: niftyFuture.globalId,
      side: 'BUY',
      orderType: 'LIMIT',
      quantity: 25,
      requestedPrice: 24500.0,
      idempotencyKey: 'idem-4',
    };

    // Contract value = 24500 * 25 = 612,500
    // Margin @ 12% = 73,500
    const res = OrderValidator.validate(req, niftyFuture, Money.fromRupees(100000), 24500);
    assert.equal(res.isValid, true);
    if (res.isValid) {
      assert.equal(res.requiredMarginPaise, Money.fromRupees(73500));
      assert.ok(res.estimatedChargesPaise > 0n);
    }
  });

  test('rejects order when available margin is insufficient', () => {
    const req: PlaceOrderRequest = {
      accountId: 'acc-1',
      globalInstrumentId: niftyFuture.globalId,
      side: 'BUY',
      orderType: 'LIMIT',
      quantity: 50, // 2 lots -> margin ~ 147,000
      requestedPrice: 24500.0,
      idempotencyKey: 'idem-5',
    };

    // Available is only ₹1,00,000
    const res = OrderValidator.validate(req, niftyFuture, Money.fromRupees(100000), 24500);
    assert.equal(res.isValid, false);
    if (!res.isValid) {
      assert.equal(res.errorCode, 'ERR_INSUFFICIENT_MARGIN');
    }
  });
});
