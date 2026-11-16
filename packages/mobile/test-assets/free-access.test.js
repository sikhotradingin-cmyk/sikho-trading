'use strict';
// Plain-Node regression tests for the WebView canonical FREE-access matrix.
// Run: node --test packages/mobile/test-assets/free-access.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isFreeTierAllowedInstrument,
  isFreeTierAllowedGlobalId,
  resolveUnderlyingFromSymbol,
} = require('../android/app/src/main/assets/www/free-access.js');

const FREE = [
  { symbol: 'NIFTY 50', underlying: 'NIFTY', exchange: 'NSE', instrumentType: 'INDEX_SPOT' },
  { symbol: 'BANKNIFTY', underlying: 'BANKNIFTY', exchange: 'NSE', instrumentType: 'INDEX_SPOT' },
  { symbol: 'NIFTY23NOV26FUT', underlying: 'NIFTY', exchange: 'NFO', instrumentType: 'FUTIDX' },
  { symbol: 'BANKNIFTY23NOV26FUT', underlying: 'BANKNIFTY', exchange: 'NFO', instrumentType: 'FUTIDX' },
  { symbol: 'NIFTY 24750 CE 17 NOV 26', underlying: 'NIFTY', exchange: 'NFO', instrumentType: 'OPTIDX' },
  { symbol: 'NIFTY 24750 PE 17 NOV 26', underlying: 'NIFTY', exchange: 'NFO', instrumentType: 'OPTIDX' },
  { symbol: 'BANKNIFTY 61000 PE 17 NOV 26', underlying: 'BANKNIFTY', exchange: 'NFO', instrumentType: 'OPTIDX' },
];

const PREMIUM = [
  { symbol: 'SENSEX', underlying: 'SENSEX', exchange: 'BSE', instrumentType: 'INDEX_SPOT' },
  { symbol: 'BANKEX', underlying: 'BANKEX', exchange: 'BSE', instrumentType: 'INDEX_SPOT' },
  { symbol: 'FINNIFTY23NOV26FUT', underlying: 'FINNIFTY', exchange: 'NFO', instrumentType: 'FUTIDX' },
  { symbol: 'MIDCPNIFTY23NOV26FUT', underlying: 'MIDCPNIFTY', exchange: 'NFO', instrumentType: 'FUTIDX' },
  { symbol: 'NIFTYNXT5023NOV26FUT', underlying: 'NIFTYNXT50', exchange: 'NFO', instrumentType: 'FUTIDX' },
  { symbol: 'NIFTYFPI23NOV26FUT', underlying: 'NIFTYFPI', exchange: 'NFO', instrumentType: 'FUTIDX' },
  { symbol: 'NIFTY IT', underlying: 'NIFTY IT', exchange: 'NSE', instrumentType: 'INDEX_SPOT' },
  { symbol: 'RELIANCE', underlying: 'RELIANCE', exchange: 'NSE', instrumentType: 'EQUITY_STOCK' },
  { symbol: 'GOLD26NOVFUT', underlying: 'GOLD', exchange: 'MCX', instrumentType: 'FUTCOM' },
];

test('free instruments are allowed', () => {
  for (const inst of FREE) {
    assert.equal(isFreeTierAllowedInstrument(inst), true, inst.symbol);
  }
});

test('premium instruments stay locked (no loose NIFTY substring matching)', () => {
  for (const inst of PREMIUM) {
    assert.equal(isFreeTierAllowedInstrument(inst), false, inst.symbol);
  }
});

test('spot names and conflicting provider metadata fail closed', () => {
  for (const symbol of ['NIFTY 100', 'NIFTY 500', 'NIFTY IT']) {
    assert.equal(isFreeTierAllowedInstrument({ symbol, underlying: 'NIFTY', exchange: 'NSE', instrumentType: 'INDEX_SPOT' }), false);
    assert.equal(isFreeTierAllowedGlobalId(`NSE:${symbol}:1234`), false);
  }
  assert.equal(isFreeTierAllowedInstrument({ symbol: 'BANKNIFTY23NOV26FUT', underlying: 'NIFTY', exchange: 'NFO', instrumentType: 'FUTIDX' }), false);
});

test('symbol resolution rejects NIFTY-family lookalikes', () => {
  assert.equal(resolveUnderlyingFromSymbol('NIFTY 50'), 'NIFTY');
  assert.equal(resolveUnderlyingFromSymbol('NIFTY BANK'), 'BANKNIFTY');
  assert.equal(resolveUnderlyingFromSymbol('BANKNIFTY23NOV26FUT'), 'BANKNIFTY');
  assert.equal(resolveUnderlyingFromSymbol('FINNIFTY23NOV26FUT'), null);
  assert.equal(resolveUnderlyingFromSymbol('MIDCPNIFTY23NOV26FUT'), null);
  assert.equal(resolveUnderlyingFromSymbol('NIFTY IT'), null);
  assert.equal(resolveUnderlyingFromSymbol('NIFTYNXT5023NOV26FUT'), null);
});

test('nifty and banknifty futures/options global ids are allowed, lookalikes are not', () => {
  assert.equal(isFreeTierAllowedGlobalId('NFO:NIFTY23NOV26FUT:61471'), true);
  assert.equal(isFreeTierAllowedGlobalId('NFO:BANKNIFTY23NOV26FUT:61466'), true);
  assert.equal(isFreeTierAllowedGlobalId('NFO:NIFTY 24800 CE 17 NOV 26:45375'), true);
  assert.equal(isFreeTierAllowedGlobalId('NFO:FINNIFTY23NOV26FUT:61469'), false);
  assert.equal(isFreeTierAllowedGlobalId('BSE:SENSEX:99919000'), false);
  assert.equal(isFreeTierAllowedGlobalId('NSE:RELIANCE:2885'), false);
});
