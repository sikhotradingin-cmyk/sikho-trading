import { Exchange } from '../models/instrument.js';

export type CommodityCategory = 'METALS' | 'ENERGY' | 'AGRICULTURE';

export interface CommodityContractSpec {
  symbol: string;
  name: string;
  category: CommodityCategory;
  tradingUnit: string;
  quotationUnit: string;
  lotSize: number;
  priceQuoteMultiplier: number; // Multiplier from quoted price to 1 lot value: e.g. Gold (quote per 10g, 100g lot) => 10
  tickSize: number;
  tickValuePerLot: number; // Rupees gained/lost per tick per lot
  simulatedMarginRate: number; // Educational simulation margin (e.g. 0.05 for 5%)
  freezeQuantityLots?: number;
  expiryPolicy: string;
}

export const COMMODITY_CONTRACT_SPECS: Record<string, CommodityContractSpec> = {
  GOLD: {
    symbol: 'GOLD',
    name: 'Gold',
    category: 'METALS',
    tradingUnit: '100 g',
    quotationUnit: '₹ / 10 g',
    lotSize: 1,
    priceQuoteMultiplier: 10, // 100g / 10g = 10
    tickSize: 1.0,
    tickValuePerLot: 10.0, // ₹1.00 * 10 = ₹10.00
    simulatedMarginRate: 0.05,
    freezeQuantityLots: 10,
    expiryPolicy: 'Cash-settled paper simulation. No physical delivery obligations. Trading halted 24h prior to contract expiry cutoff.',
  },
  GOLDM: {
    symbol: 'GOLDM',
    name: 'Gold Mini',
    category: 'METALS',
    tradingUnit: '10 g',
    quotationUnit: '₹ / 10 g',
    lotSize: 1,
    priceQuoteMultiplier: 1, // 10g / 10g = 1
    tickSize: 1.0,
    tickValuePerLot: 1.0,
    simulatedMarginRate: 0.05,
    freezeQuantityLots: 50,
    expiryPolicy: 'Cash-settled paper simulation. No physical delivery obligations. Trading halted 24h prior to contract expiry cutoff.',
  },
  SILVER: {
    symbol: 'SILVER',
    name: 'Silver',
    category: 'METALS',
    tradingUnit: '30 kg',
    quotationUnit: '₹ / 1 kg',
    lotSize: 30,
    priceQuoteMultiplier: 30, // 30 kg / 1 kg = 30
    tickSize: 1.0,
    tickValuePerLot: 30.0, // ₹1.00 * 30 = ₹30.00
    simulatedMarginRate: 0.05,
    freezeQuantityLots: 20,
    expiryPolicy: 'Cash-settled paper simulation. No physical delivery obligations. Trading halted 24h prior to contract expiry cutoff.',
  },
  SILVERM: {
    symbol: 'SILVERM',
    name: 'Silver Mini',
    category: 'METALS',
    tradingUnit: '5 kg',
    quotationUnit: '₹ / 1 kg',
    lotSize: 5,
    priceQuoteMultiplier: 5, // 5 kg / 1 kg = 5
    tickSize: 1.0,
    tickValuePerLot: 5.0,
    simulatedMarginRate: 0.05,
    freezeQuantityLots: 100,
    expiryPolicy: 'Cash-settled paper simulation. No physical delivery obligations. Trading halted 24h prior to contract expiry cutoff.',
  },
  CRUDEOIL: {
    symbol: 'CRUDEOIL',
    name: 'Crude Oil',
    category: 'ENERGY',
    tradingUnit: '100 bbl',
    quotationUnit: '₹ / 1 bbl',
    lotSize: 100,
    priceQuoteMultiplier: 100, // 100 bbl / 1 bbl = 100
    tickSize: 1.0,
    tickValuePerLot: 100.0, // ₹1.00 * 100 = ₹100.00
    simulatedMarginRate: 0.05,
    freezeQuantityLots: 100,
    expiryPolicy: 'Cash-settled paper simulation. No physical delivery obligations. Trading halted 24h prior to contract expiry cutoff.',
  },
  CRUDEOILM: {
    symbol: 'CRUDEOILM',
    name: 'Crude Oil Mini',
    category: 'ENERGY',
    tradingUnit: '10 bbl',
    quotationUnit: '₹ / 1 bbl',
    lotSize: 10,
    priceQuoteMultiplier: 10, // 10 bbl / 1 bbl = 10
    tickSize: 1.0,
    tickValuePerLot: 10.0,
    simulatedMarginRate: 0.05,
    freezeQuantityLots: 500,
    expiryPolicy: 'Cash-settled paper simulation. No physical delivery obligations. Trading halted 24h prior to contract expiry cutoff.',
  },
  NATURALGAS: {
    symbol: 'NATURALGAS',
    name: 'Natural Gas',
    category: 'ENERGY',
    tradingUnit: '1250 mmBtu',
    quotationUnit: '₹ / 1 mmBtu',
    lotSize: 1250,
    priceQuoteMultiplier: 1250, // 1250 mmBtu / 1 mmBtu = 1250
    tickSize: 0.1,
    tickValuePerLot: 125.0, // ₹0.10 * 1250 = ₹125.00
    simulatedMarginRate: 0.05,
    freezeQuantityLots: 48,
    expiryPolicy: 'Cash-settled paper simulation. No physical delivery obligations. Trading halted 24h prior to contract expiry cutoff.',
  },
  NATGASMINI: {
    symbol: 'NATGASMINI',
    name: 'Natural Gas Mini',
    category: 'ENERGY',
    tradingUnit: '250 mmBtu',
    quotationUnit: '₹ / 1 mmBtu',
    lotSize: 250,
    priceQuoteMultiplier: 250, // 250 mmBtu / 1 mmBtu = 250
    tickSize: 0.1,
    tickValuePerLot: 25.0,
    simulatedMarginRate: 0.05,
    freezeQuantityLots: 240,
    expiryPolicy: 'Cash-settled paper simulation. No physical delivery obligations. Trading halted 24h prior to contract expiry cutoff.',
  },
  COPPER: {
    symbol: 'COPPER',
    name: 'Copper',
    category: 'METALS',
    tradingUnit: '2500 kg',
    quotationUnit: '₹ / 1 kg',
    lotSize: 2500,
    priceQuoteMultiplier: 2500, // 2500 kg / 1 kg = 2500
    tickSize: 0.05,
    tickValuePerLot: 125.0, // ₹0.05 * 2500 = ₹125.00
    simulatedMarginRate: 0.05,
    freezeQuantityLots: 28,
    expiryPolicy: 'Cash-settled paper simulation. No physical delivery obligations. Trading halted 24h prior to contract expiry cutoff.',
  },
  ZINC: {
    symbol: 'ZINC',
    name: 'Zinc',
    category: 'METALS',
    tradingUnit: '5000 kg',
    quotationUnit: '₹ / 1 kg',
    lotSize: 5000,
    priceQuoteMultiplier: 5000,
    tickSize: 0.05,
    tickValuePerLot: 250.0,
    simulatedMarginRate: 0.05,
    freezeQuantityLots: 20,
    expiryPolicy: 'Cash-settled paper simulation. No physical delivery obligations. Trading halted 24h prior to contract expiry cutoff.',
  },
  ALUMINIUM: {
    symbol: 'ALUMINIUM',
    name: 'Aluminium',
    category: 'METALS',
    tradingUnit: '5000 kg',
    quotationUnit: '₹ / 1 kg',
    lotSize: 5000,
    priceQuoteMultiplier: 5000,
    tickSize: 0.05,
    tickValuePerLot: 250.0,
    simulatedMarginRate: 0.05,
    freezeQuantityLots: 20,
    expiryPolicy: 'Cash-settled paper simulation. No physical delivery obligations. Trading halted 24h prior to contract expiry cutoff.',
  },
  LEAD: {
    symbol: 'LEAD',
    name: 'Lead',
    category: 'METALS',
    tradingUnit: '5000 kg',
    quotationUnit: '₹ / 1 kg',
    lotSize: 5000,
    priceQuoteMultiplier: 5000,
    tickSize: 0.05,
    tickValuePerLot: 250.0,
    simulatedMarginRate: 0.05,
    freezeQuantityLots: 20,
    expiryPolicy: 'Cash-settled paper simulation. No physical delivery obligations. Trading halted 24h prior to contract expiry cutoff.',
  },
  NICKEL: {
    symbol: 'NICKEL',
    name: 'Nickel',
    category: 'METALS',
    tradingUnit: '1500 kg',
    quotationUnit: '₹ / 1 kg',
    lotSize: 1500,
    priceQuoteMultiplier: 1500,
    tickSize: 0.1,
    tickValuePerLot: 150.0,
    simulatedMarginRate: 0.05,
    freezeQuantityLots: 20,
    expiryPolicy: 'Cash-settled paper simulation. No physical delivery obligations. Trading halted 24h prior to contract expiry cutoff.',
  },
  COTTON: {
    symbol: 'COTTON',
    name: 'Cotton',
    category: 'AGRICULTURE',
    tradingUnit: '25 bales',
    quotationUnit: '₹ / 1 bale',
    lotSize: 25,
    priceQuoteMultiplier: 25,
    tickSize: 20.0,
    tickValuePerLot: 500.0,
    simulatedMarginRate: 0.05,
    freezeQuantityLots: 20,
    expiryPolicy: 'Cash-settled paper simulation. No physical delivery obligations. Trading halted 24h prior to contract expiry cutoff.',
  },
  MENTHAOIL: {
    symbol: 'MENTHAOIL',
    name: 'Mentha Oil',
    category: 'AGRICULTURE',
    tradingUnit: '360 kg',
    quotationUnit: '₹ / 1 kg',
    lotSize: 360,
    priceQuoteMultiplier: 360,
    tickSize: 0.1,
    tickValuePerLot: 36.0,
    simulatedMarginRate: 0.05,
    freezeQuantityLots: 20,
    expiryPolicy: 'Cash-settled paper simulation. No physical delivery obligations. Trading halted 24h prior to contract expiry cutoff.',
  },
};

/**
 * Resolve contract specification for any given underlying or symbol.
 */
export function resolveCommoditySpec(symbolOrUnderlying: string): CommodityContractSpec | null {
  const clean = symbolOrUnderlying.trim().toUpperCase().replace(/[\s\-_]/g, '');
  if (COMMODITY_CONTRACT_SPECS[clean]) {
    return COMMODITY_CONTRACT_SPECS[clean];
  }
  // Try matching prefixes
  for (const key of Object.keys(COMMODITY_CONTRACT_SPECS)) {
    if (clean.startsWith(key)) {
      return COMMODITY_CONTRACT_SPECS[key];
    }
  }
  return null;
}

/**
 * Calculate effective contract exposure without double multipliers.
 * For Gold: 1 lot at ₹142,160 => 1 * 142160 * 10 = ₹1,421,600.
 * For Crude: 2 lots at ₹8,450 => 2 * 8450 * 100 = ₹1,690,000.
 */
export function calculateContractExposure(
  price: number,
  lotsOrUnits: number,
  spec?: CommodityContractSpec | null,
  isUnits: boolean = false
): number {
  if (!spec) {
    return price * lotsOrUnits;
  }
  if (isUnits) {
    // If quantity is already in physical trading units (e.g. 100 barrels for Crude Oil)
    const quoteRatio = spec.priceQuoteMultiplier / spec.lotSize;
    return price * lotsOrUnits * quoteRatio;
  }
  // Standard entry: lots * price * priceQuoteMultiplier
  return price * lotsOrUnits * spec.priceQuoteMultiplier;
}

/**
 * Calculate position P&L accurately.
 */
export function calculateCommodityPositionPnl(
  entryPrice: number,
  currentPrice: number,
  lotsOrUnits: number,
  side: 'BUY' | 'SELL',
  spec?: CommodityContractSpec | null,
  isUnits: boolean = false
): number {
  const diff = side === 'BUY' ? currentPrice - entryPrice : entryPrice - currentPrice;
  if (!spec) {
    return diff * lotsOrUnits;
  }
  if (isUnits) {
    const quoteRatio = spec.priceQuoteMultiplier / spec.lotSize;
    return diff * lotsOrUnits * quoteRatio;
  }
  return diff * lotsOrUnits * spec.priceQuoteMultiplier;
}

/**
 * Comprehensive Multi-Exchange Market Hours Validator.
 * Handles NSE/BSE Equity & F&O (09:15 - 15:30 IST) vs MCX Commodities (09:00 - 23:30/23:55 IST).
 */
export interface MarketSessionStatus {
  isOpen: boolean;
  exchange: Exchange;
  sessionName: string;
  istTime: string;
  nextEventDescription: string;
}

export function getExchangeSessionStatus(exchange: Exchange, date: Date = new Date()): MarketSessionStatus {
  // Convert UTC to Asia/Kolkata (+05:30)
  const utcMs = date.getTime();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(utcMs + istOffsetMs);

  const dayOfWeek = istDate.getUTCDay(); // 0 = Sunday, 6 = Saturday
  const hours = istDate.getUTCHours();
  const minutes = istDate.getUTCMinutes();
  const totalMinutes = hours * 60 + minutes;

  const pad = (n: number) => n.toString().padStart(2, '0');
  const istTimeStr = `${pad(hours)}:${pad(minutes)} IST`;

  // Standard weekend check
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return {
      isOpen: false,
      exchange,
      sessionName: 'WEEKEND_CLOSED',
      istTime: istTimeStr,
      nextEventDescription: exchange === 'MCX' ? 'Opens Monday 09:00 IST' : 'Opens Monday 09:15 IST',
    };
  }

  if (exchange === 'MCX') {
    // MCX Trading Session: 09:00 (540 min) to 23:30 (1410 min) / 23:55 (1435 min)
    const MCX_OPEN_MIN = 9 * 60; // 540
    const MCX_CLOSE_MIN = 23 * 60 + 55; // 1435 (winter session)

    if (totalMinutes >= MCX_OPEN_MIN && totalMinutes < MCX_CLOSE_MIN) {
      return {
        isOpen: true,
        exchange: 'MCX',
        sessionName: totalMinutes >= 17 * 60 ? 'MCX_EVENING_SESSION' : 'MCX_DAY_SESSION',
        istTime: istTimeStr,
        nextEventDescription: 'Closes at 23:30 / 23:55 IST',
      };
    }

    return {
      isOpen: false,
      exchange: 'MCX',
      sessionName: 'MCX_NIGHT_CLOSED',
      istTime: istTimeStr,
      nextEventDescription: totalMinutes < MCX_OPEN_MIN ? 'Opens today at 09:00 IST' : 'Opens tomorrow at 09:00 IST',
    };
  }

  // NSE / BSE / NFO / BFO: 09:15 (555 min) to 15:30 (930 min)
  const NSE_OPEN_MIN = 9 * 60 + 15; // 555
  const NSE_CLOSE_MIN = 15 * 60 + 30; // 930

  if (totalMinutes >= NSE_OPEN_MIN && totalMinutes < NSE_CLOSE_MIN) {
    return {
      isOpen: true,
      exchange,
      sessionName: 'EQUITY_REGULAR_SESSION',
      istTime: istTimeStr,
      nextEventDescription: 'Closes at 15:30 IST',
    };
  }

  return {
    isOpen: false,
    exchange,
    sessionName: totalMinutes < NSE_OPEN_MIN ? 'PRE_MARKET_CLOSED' : 'POST_MARKET_CLOSED',
    istTime: istTimeStr,
    nextEventDescription: totalMinutes < NSE_OPEN_MIN ? 'Opens today at 09:15 IST' : 'Opens tomorrow at 09:15 IST',
  };
}

