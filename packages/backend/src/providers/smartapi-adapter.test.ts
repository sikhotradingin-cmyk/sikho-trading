import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateTOTP,
  isIndianMarketOpen,
  parseAngelExpiryDate,
  SmartAPIAdapter,
} from './smartapi-adapter.js';

describe('SmartAPI Adapter & Utility Functions', () => {
  it('generateTOTP produces valid 6-digit TOTP string for base32 secret', () => {
    // Test base32 secret
    const secret = 'JBSWY3DPEHPK3PXP';
    const timestamp = 1700000000000; // Fixed deterministic timestamp
    const totp1 = generateTOTP(secret, timestamp);
    const totp2 = generateTOTP('jbswy3dpehpk3pxp', timestamp); // Case insensitive
    const totp3 = generateTOTP('JBSW Y3DP-EHPK 3PXP', timestamp); // Whitespace/dashes

    assert.equal(totp1.length, 6);
    assert.match(totp1, /^\d{6}$/);
    assert.equal(totp1, totp2);
    assert.equal(totp1, totp3);
  });

  it('isIndianMarketOpen accurately identifies market session hours (09:15 - 15:30 IST)', () => {
    // 2026-11-04 is Wednesday (weekday)
    // 04:30 UTC = 10:00 IST -> Open
    const midSession = new Date('2026-11-04T04:30:00Z');
    assert.equal(isIndianMarketOpen(midSession), true);

    // 03:00 UTC = 08:30 IST -> Pre-market/Closed
    const preMarket = new Date('2026-11-04T03:00:00Z');
    assert.equal(isIndianMarketOpen(preMarket), false);

    // 10:30 UTC = 16:00 IST -> Post-market/Closed
    const postMarket = new Date('2026-11-04T10:30:00Z');
    assert.equal(isIndianMarketOpen(postMarket), false);

    // 2026-11-01 is Sunday -> Closed
    const sundayMidDay = new Date('2026-11-01T06:00:00Z');
    assert.equal(isIndianMarketOpen(sundayMidDay), false);
  });

  it('parseAngelExpiryDate parses Angel DDMMMYYYY expiry format to UTC epoch ms', () => {
    const epochNov = parseAngelExpiryDate('23NOV2026');
    const expectedNov = Date.UTC(2026, 10, 23, 10, 0, 0); // Month is 0-indexed (10 = NOV)
    assert.equal(epochNov, expectedNov);

    const epochJan = parseAngelExpiryDate('01JAN2025');
    const expectedJan = Date.UTC(2025, 0, 1, 10, 0, 0); // 0 = JAN
    assert.equal(epochJan, expectedJan);

    assert.equal(parseAngelExpiryDate(''), 0);
    assert.equal(parseAngelExpiryDate('INVALID'), 0);
    assert.equal(parseAngelExpiryDate('99XYZ2026'), 0);
  });

  it('SmartAPIAdapter handles unconfigured credentials safely and gracefully', async () => {
    const unconfigured = new SmartAPIAdapter({});
    assert.equal(unconfigured.isConfigured, false);

    await unconfigured.init(); // Must not throw or crash

    const health = unconfigured.getFeedHealth();
    assert.equal(health.source, 'SMARTAPI');
    assert.equal(health.status, 'NOT_LIVE_VERIFIED');
    assert.equal(health.isSimulated, false);
    assert.ok(health.message?.includes('SmartAPI credentials missing'));

    const instruments = await unconfigured.getInstruments();
    assert.ok(instruments.length >= 2);
    const spot = instruments.find((i) => i.instrumentType === 'INDEX_SPOT');
    assert.ok(spot);
    assert.equal(spot.isTradable, false);
    const fut = instruments.find((i) => i.instrumentType === 'FUTIDX');
    assert.ok(fut);
    assert.equal(fut.isTradable, true);
    assert.ok(fut.lotSize > 0);

    const quote = await unconfigured.getQuote('NSE:NIFTY50-INDEX');
    assert.equal(quote, null);

    const candles = await unconfigured.getCandles('NSE:NIFTY50-INDEX', '1m', 10);
    assert.deepEqual(candles, []);

    await unconfigured.dispose();
  });
});
