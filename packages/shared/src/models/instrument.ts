export type Exchange = 'NSE' | 'NFO' | 'BSE' | 'BFO' | 'MCX';

export type InstrumentType =
  | 'INDEX_SPOT' // E.g. NIFTY 50 (Non-tradable reference index)
  | 'EQUITY_STOCK' // E.g. RELIANCE, TCS
  | 'FUTIDX' // E.g. NIFTY Monthly Futures
  | 'OPTIDX' // E.g. NIFTY Call/Put Options
  | 'FUTSTK' // Stock Futures
  | 'OPTSTK'; // Stock Options

export interface InstrumentMetadata {
  /**
   * Globally safe composite identity: `${exchange}:${symbol}:${token}`
   * E.g. "NFO:NIFTY26OCTFUT:999001" or "NSE:NIFTY50:999000"
   */
  globalId: string;
  provider: 'DEMO' | 'SMARTAPI' | 'MOCK';
  exchange: Exchange;
  token: string;
  symbol: string;
  name: string;
  instrumentType: InstrumentType;
  isTradable: boolean; // SPOT indices are false!
  lotSize: number; // MUST be dynamically resolved, never hardcoded
  tickSize: number; // E.g. 0.05
  expiry?: string; // ISO Date "YYYY-MM-DD" where applicable
  strikePrice?: number;
  underlying?: string; // E.g. "NIFTY"
  isSimulatedFixture: boolean; // Labeled explicitly when DEMO
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
