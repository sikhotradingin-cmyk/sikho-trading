import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isFreeTierAllowedGlobalId,
  isFreeTierAllowedInstrument,
  resolveUnderlyingFromSymbol,
} from './free-access.js';

const FREE_CASES = [
  { symbol: 'NIFTY 50', underlying: 'NIFTY', exchange: 'NSE', instrumentType: 'INDEX_SPOT' },
  { symbol: 'BANKNIFTY', underlying: 'BANKNIFTY', exchange: 'NSE', instrumentType: 'INDEX_SPOT' },
  { symbol: 'NIFTY23NOV26FUT', underlying: 'NIFTY', exchange: 'NFO', instrumentType: 'FUTIDX' },
  { symbol: 'BANKNIFTY23NOV26FUT', underlying: 'BANKNIFTY', exchange: 'NFO', instrumentType: 'FUTIDX' },
  { symbol: 'NIFTY 24750 CE 17 NOV 26', underlying: 'NIFTY', exchange: 'NFO', instrumentType: 'OPTIDX' },
  { symbol: 'NIFTY 24750 PE 17 NOV 26', underlying: 'NIFTY', exchange: 'NFO', instrumentType: 'OPTIDX' },
  { symbol: 'BANKNIFTY 61000 CE 17 NOV 26', underlying: 'BANKNIFTY', exchange: 'NFO', instrumentType: 'OPTIDX' },
  { symbol: 'NIFTY 50 FUT', underlying: 'NIFTY 50', exchange: 'NFO', instrumentType: 'FUTIDX' },
];

const PREMIUM_ONLY_CASES = [
  // Restricted indices / other products that contain "NIFTY".
  { symbol: 'SENSEX', underlying: 'SENSEX', exchange: 'BSE', instrumentType: 'INDEX_SPOT' },
  { symbol: 'BANKEX', underlying: 'BANKEX', exchange: 'BSE', instrumentType: 'INDEX_SPOT' },
  { symbol: 'FINNIFTY23NOV26FUT', underlying: 'FINNIFTY', exchange: 'NFO', instrumentType: 'FUTIDX' },
  { symbol: 'MIDCPNIFTY23NOV26FUT', underlying: 'MIDCPNIFTY', exchange: 'NFO', instrumentType: 'FUTIDX' },
  { symbol: 'NIFTYNXT5023NOV26FUT', underlying: 'NIFTYNXT50', exchange: 'NFO', instrumentType: 'FUTIDX' },
  { symbol: 'NIFTYFPI23NOV26FUT', underlying: 'NIFTYFPI', exchange: 'NFO', instrumentType: 'FUTIDX' },
  { symbol: 'NIFTY IT', underlying: 'NIFTY IT', exchange: 'NSE', instrumentType: 'INDEX_SPOT' },
  { symbol: 'NIFTY MIDCAP 50', underlying: 'NIFTY MIDCAP 50', exchange: 'NSE', instrumentType: 'INDEX_SPOT' },
  { symbol: 'NIFTY 50 CE 17 NOV 26', underlying: 'SENSEX', exchange: 'BFO', instrumentType: 'OPTIDX' },
  // Equities and stock F&O.
  { symbol: 'RELIANCE', underlying: 'RELIANCE', exchange: 'NSE', instrumentType: 'EQUITY_STOCK' },
  { symbol: 'RELIANCE26NOVFUT', underlying: 'RELIANCE', exchange: 'NFO', instrumentType: 'FUTSTK' },
  // MCX commodities.
  { symbol: 'GOLD26NOVFUT', underlying: 'GOLD', exchange: 'MCX', instrumentType: 'FUTCOM' },
  { symbol: 'CRUDEOIL 5000 CE', underlying: 'CRUDEOIL', exchange: 'MCX', instrumentType: 'OPTCOM' },
];

test('FREE access is granted for NIFTY 50 / BANKNIFTY spot, futures and options', () => {
  for (const inst of FREE_CASES) {
    assert.equal(isFreeTierAllowedInstrument(inst), true, `expected FREE access: ${inst.symbol}`);
  }
});

test('PREMIUM-ONLY instruments are never unlocked by loose NIFTY substring matching', () => {
  for (const inst of PREMIUM_ONLY_CASES) {
    assert.equal(
      isFreeTierAllowedInstrument(inst),
      false,
      `expected PREMIUM-only: ${inst.symbol} (${inst.underlying})`
    );
  }
});

test('underlying normalisation handles provider spellings', () => {
  assert.equal(resolveUnderlyingFromSymbol('NIFTY'), 'NIFTY');
  assert.equal(resolveUnderlyingFromSymbol('NIFTY 50'), 'NIFTY');
  assert.equal(resolveUnderlyingFromSymbol('NIFTY BANK'), 'BANKNIFTY');
  assert.equal(resolveUnderlyingFromSymbol('NIFTY23NOV26FUT'), 'NIFTY');
  assert.equal(resolveUnderlyingFromSymbol('BANKNIFTY23NOV26FUT'), 'BANKNIFTY');
  assert.equal(resolveUnderlyingFromSymbol('FINNIFTY23NOV26FUT'), null);
  assert.equal(resolveUnderlyingFromSymbol('MIDCPNIFTY23NOV26FUT'), null);
  assert.equal(resolveUnderlyingFromSymbol('NIFTY IT'), null);
  assert.equal(resolveUnderlyingFromSymbol('SENSEX'), null);
});

test('global-id hint resolves canonical exchange ids and fails closed otherwise', () => {
  assert.equal(isFreeTierAllowedGlobalId('NSE:NIFTY 50:99926000'), true);
  assert.equal(isFreeTierAllowedGlobalId('NSE:BANKNIFTY:99926009'), true);
  assert.equal(isFreeTierAllowedGlobalId('NFO:NIFTY23NOV26FUT:61471'), true);
  assert.equal(isFreeTierAllowedGlobalId('NFO:NIFTY 24800 CE 17 NOV 26:45375'), true);
  assert.equal(isFreeTierAllowedGlobalId('NFO:BANKNIFTY23NOV26FUT:61466'), true);
  assert.equal(isFreeTierAllowedGlobalId('NFO:FINNIFTY23NOV26FUT:61469'), false);
  assert.equal(isFreeTierAllowedGlobalId('NFO:MIDCPNIFTY23NOV26FUT:61470'), false);
  assert.equal(isFreeTierAllowedGlobalId('NFO:NIFTYFPI23NOV26FUT:61472'), false);
  assert.equal(isFreeTierAllowedGlobalId('BSE:SENSEX:99919000'), false);
  assert.equal(isFreeTierAllowedGlobalId('MCX:GOLD:1'), false);
  assert.equal(isFreeTierAllowedGlobalId(''), false);
  assert.equal(isFreeTierAllowedGlobalId('garbage'), false);
});

test('declared premium underlying wins over a misleading symbol', () => {
  assert.equal(
    isFreeTierAllowedInstrument({
      symbol: 'NIFTY 50',
      underlying: 'SENSEX',
      exchange: 'NFO',
      instrumentType: 'FUTIDX',
    }),
    false
  );
});
