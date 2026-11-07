import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  calculateContractExposure,
  calculateCommodityPositionPnl,
  getExchangeSessionStatus,
  resolveCommoditySpec,
} from './contract-spec.js';

describe('MCX Commodity Contract Specifications & Math Verification', () => {
  it('correctly resolves specifications for Gold, Silver, Crude Oil, Natural Gas and Copper', () => {
    const gold = resolveCommoditySpec('GOLD');
    assert.ok(gold);
    assert.strictEqual(gold.symbol, 'GOLD');
    assert.strictEqual(gold.category, 'METALS');
    assert.strictEqual(gold.priceQuoteMultiplier, 10);
    assert.strictEqual(gold.tickSize, 1.0);
    assert.strictEqual(gold.tickValuePerLot, 10.0);

    const crude = resolveCommoditySpec('CRUDEOIL');
    assert.ok(crude);
    assert.strictEqual(crude.symbol, 'CRUDEOIL');
    assert.strictEqual(crude.category, 'ENERGY');
    assert.strictEqual(crude.priceQuoteMultiplier, 100);
    assert.strictEqual(crude.tickSize, 1.0);
    assert.strictEqual(crude.tickValuePerLot, 100.0);

    const natgas = resolveCommoditySpec('NATURALGAS');
    assert.ok(natgas);
    assert.strictEqual(natgas.symbol, 'NATURALGAS');
    assert.strictEqual(natgas.category, 'ENERGY');
    assert.strictEqual(natgas.priceQuoteMultiplier, 1250);
    assert.strictEqual(natgas.tickSize, 0.1);
    assert.strictEqual(natgas.tickValuePerLot, 125.0);

    const copper = resolveCommoditySpec('COPPER');
    assert.ok(copper);
    assert.strictEqual(copper.symbol, 'COPPER');
    assert.strictEqual(copper.category, 'METALS');
    assert.strictEqual(copper.priceQuoteMultiplier, 2500);
    assert.strictEqual(copper.tickSize, 0.05);
    assert.strictEqual(copper.tickValuePerLot, 125.0);

    const silver = resolveCommoditySpec('SILVER');
    assert.ok(silver);
    assert.strictEqual(silver.symbol, 'SILVER');
    assert.strictEqual(silver.category, 'METALS');
    assert.strictEqual(silver.priceQuoteMultiplier, 30);
    assert.strictEqual(silver.tickSize, 1.0);
    assert.strictEqual(silver.tickValuePerLot, 30.0);
  });

  it('independently verifies Gold contract value and tick P&L without double multiplier', () => {
    const gold = resolveCommoditySpec('GOLD');
    assert.ok(gold);
    // Gold quote: ₹142,167 per 10g. 1 lot = 100g.
    // Exposure = 1 lot * 142167 * (100g / 10g) = ₹1,421,670
    const exposure = calculateContractExposure(142167, 1, gold);
    assert.strictEqual(exposure, 1421670);

    // 1 tick move (+₹1.00):
    const pnl1Tick = calculateCommodityPositionPnl(142167, 142168, 1, 'BUY', gold);
    assert.strictEqual(pnl1Tick, 10.0);

    // +40 tick move (+₹40.00 from 142160 to 142200):
    const pnl40Ticks = calculateCommodityPositionPnl(142160, 142200, 1, 'BUY', gold);
    assert.strictEqual(pnl40Ticks, 400.0);
  });

  it('independently verifies Crude Oil contract value and short position P&L', () => {
    const crude = resolveCommoditySpec('CRUDEOIL');
    assert.ok(crude);
    // 2 lots Crude Oil at ₹8,459 (quoted per barrel). 1 lot = 100 barrels.
    // Exposure = 2 * 8459 * 100 = ₹1,691,800
    const exposure = calculateContractExposure(8459, 2, crude);
    assert.strictEqual(exposure, 1691800);

    // Short position entry at 8500, exit at 8400 (gain of ₹100 per bbl):
    const pnlShort = calculateCommodityPositionPnl(8500, 8400, 2, 'SELL', crude);
    assert.strictEqual(pnlShort, 20000.0); // 2 lots * 100 bbl * ₹100 = ₹20,000
  });

  it('independently verifies Natural Gas contract value, tick size and P&L', () => {
    const natgas = resolveCommoditySpec('NATURALGAS');
    assert.ok(natgas);
    // 1 lot Natural Gas at ₹283.60. 1 lot = 1250 mmBtu.
    // Exposure = 1 * 283.60 * 1250 = ₹354,500
    const exposure = calculateContractExposure(283.6, 1, natgas);
    assert.strictEqual(exposure, 354500);

    // 1 tick move (+₹0.10):
    const pnl1Tick = calculateCommodityPositionPnl(283.6, 283.7, 1, 'BUY', natgas);
    assert.strictEqual(Math.round(pnl1Tick * 100) / 100, 125.0);

    // Adverse move for Short position from 285.0 to 287.0 (-₹2.00 per mmBtu):
    const pnlShortLoss = calculateCommodityPositionPnl(285.0, 287.0, 1, 'SELL', natgas);
    assert.strictEqual(pnlShortLoss, -2500.0);
  });

  it('accurately distinguishes MCX evening session hours from NSE equity hours', () => {
    // Test a Monday evening at 20:00 IST (14:30 UTC):
    // 2026-11-09 is a Monday. 14:30 UTC = 20:00 IST.
    const mondayEveningUtc = new Date('2026-11-09T14:30:00.000Z');

    const nseStatus = getExchangeSessionStatus('NSE', mondayEveningUtc);
    assert.strictEqual(nseStatus.isOpen, false, 'NSE should be closed at 20:00 IST');

    const mcxStatus = getExchangeSessionStatus('MCX', mondayEveningUtc);
    assert.strictEqual(mcxStatus.isOpen, true, 'MCX should be OPEN in evening session at 20:00 IST');
    assert.strictEqual(mcxStatus.sessionName, 'MCX_EVENING_SESSION');

    // Test a Sunday morning: both should be closed
    const sundayUtc = new Date('2026-11-08T06:00:00.000Z');
    assert.strictEqual(getExchangeSessionStatus('NSE', sundayUtc).isOpen, false);
    assert.strictEqual(getExchangeSessionStatus('MCX', sundayUtc).isOpen, false);

    // Test a Tuesday at 11:30 IST (06:00 UTC):
    const tuesdayMorningUtc = new Date('2026-11-10T06:00:00.000Z');
    assert.strictEqual(getExchangeSessionStatus('NSE', tuesdayMorningUtc).isOpen, true);
    assert.strictEqual(getExchangeSessionStatus('MCX', tuesdayMorningUtc).isOpen, true);
  });
});
