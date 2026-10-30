import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SecurityAirGap } from './security-airgap.js';

describe('Security Air-Gap Verification', () => {
  test('strictly prohibits any real broker order routing endpoints', () => {
    assert.throws(() => {
      SecurityAirGap.assertSafeFromRealExecution('/rest/secure/angelbroking/order/v1/placeOrder');
    }, /SECURITY AIR-GAP VIOLATION/);

    assert.throws(() => {
      SecurityAirGap.assertSafeFromRealExecution('/rest/secure/angelbroking/order/v1/modifyOrder');
    }, /SECURITY AIR-GAP VIOLATION/);

    assert.throws(() => {
      SecurityAirGap.assertSafeFromRealExecution('/rest/secure/angelbroking/order/v1/cancelOrder');
    }, /SECURITY AIR-GAP VIOLATION/);
  });

  test('certifies internal simulated actions (MARKET, STOP, TARGET, CANCEL, SQUARE_OFF) are exclusive', () => {
    assert.equal(SecurityAirGap.verifySimulatedActionExclusivity('MARKET'), true);
    assert.equal(SecurityAirGap.verifySimulatedActionExclusivity('STOP'), true);
    assert.equal(SecurityAirGap.verifySimulatedActionExclusivity('TARGET'), true);
    assert.equal(SecurityAirGap.verifySimulatedActionExclusivity('CANCEL'), true);
    assert.equal(SecurityAirGap.verifySimulatedActionExclusivity('SQUARE_OFF'), true);
  });
});
