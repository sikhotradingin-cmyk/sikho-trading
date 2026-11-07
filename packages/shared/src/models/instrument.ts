export type Exchange = 'NSE' | 'NFO' | 'BSE' | 'BFO' | 'MCX';

export type InstrumentType =
  | 'INDEX_SPOT' // E.g. NIFTY 50 (Non-tradable reference index)
  | 'EQUITY_STOCK' // E.g. RELIANCE, TCS
  | 'FUTIDX' // E.g. NIFTY Monthly Futures
  | 'OPTIDX' // E.g. NIFTY Call/Put Options
  | 'FUTSTK' // Stock Futures
  | 'OPTSTK' // Stock Options
  | 'FUTCOM' // Commodity Futures (E.g. GOLD, CRUDEOIL, NATURALGAS)
  | 'OPTCOM'; // Commodity Options (E.g. CRUDEOIL CE/PE)

export interface InstrumentMetadata {
  /**
   * Globally safe composite identity: `${exchange}:${symbol}:${token}`
   * E.g. "NFO:NIFTY26OCTFUT:999001" or "NSE:NIFTY50:999000" or "MCX:CRUDEOIL26NOVFUT:573422"
   */
  globalId: string;
  provider: 'DEMO' | 'SMARTAPI' | 'UPSTOX' | 'MOCK';
  exchange: Exchange;
  token: string;
  symbol: string;
  name: string;
  instrumentType: InstrumentType;
  isTradable: boolean; // SPOT indices are false!
  lotSize: number; // MUST be dynamically resolved, never hardcoded
  tickSize: number; // E.g. 0.05
  expiry?: string; // ISO Date "YYYY-MM-DD" or Angel DDMMMYYYY where applicable
  strikePrice?: number;
  optionType?: 'CE' | 'PE';
  underlying?: string; // E.g. "NIFTY", "CRUDEOIL"
  hasDerivatives?: boolean; // For INDEX_SPOT: true if exchange-traded F&O exist
  marginMultiplier?: number; // Optional custom margin multiplier
  upstoxInstrumentKey?: string; // E.g. "NSE_INDEX|Nifty 50", "MCX_FO|573422"
  isin?: string;
  canonicalId?: string;
  isSimulatedFixture: boolean; // Labeled explicitly when DEMO
  segment?: 'EQUITY' | 'FNO' | 'COMMODITY';
  commodityCategory?: 'METALS' | 'ENERGY' | 'AGRICULTURE';
  quotationUnit?: string;
  tradingUnit?: string;
  qtyMultiplier?: number;
  priceQuoteMultiplier?: number;
  tickValue?: number;
  underlyingKey?: string;
}

export function makeGlobalInstrumentId(exchange: Exchange, symbol: string, token: string): string {
  return `${exchange}:${symbol.toUpperCase()}:${token}`;
}

export function parseGlobalInstrumentId(globalId: string): { exchange: Exchange; symbol: string; token: string } {
  const parts = globalId.split(':');
  if (parts.length < 3) {
    throw new Error(`Invalid global instrument ID format: ${globalId}. Expected format exchange:symbol:token`);
  }
  return {
    exchange: parts[0] as Exchange,
    symbol: parts[1],
    token: parts.slice(2).join(':'),
  };
}
