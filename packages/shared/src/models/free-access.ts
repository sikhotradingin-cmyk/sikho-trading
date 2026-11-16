/**
 * Canonical FREE-tier access matrix.
 *
 * Product rule: FREE practice covers NIFTY 50 and BANKNIFTY reference indices, their supported
 * index futures and index options (charts, quotes, option chains, simulated orders). Everything
 * else (SENSEX, BANKEX, FINNIFTY, MIDCPNIFTY, NIFTY Next 50, NIFTY IT, stock F&O, equities, MCX)
 * is Premium-only.
 *
 * This module must not use loose substring matching: NIFTY, NIFTY BANK, NIFTY 50, NIFTY IT,
 * NIFTYNXT50, NIFTYFPI, FINNIFTY and MIDCPNIFTY all contain "NIFTY". The parser below is
 * anchored and reject-first so only the two intended underlyings resolve.
 */

export type FreeAccessUnderlying = 'NIFTY' | 'BANKNIFTY';

const FREE_UNDERLYINGS: ReadonlySet<string> = new Set(['NIFTY', 'BANKNIFTY']);

const FREE_INSTRUMENT_TYPES: ReadonlySet<string> = new Set(['INDEX_SPOT', 'FUTIDX', 'OPTIDX']);

const FREE_EXCHANGES: ReadonlySet<string> = new Set(['NSE', 'NFO', 'BSE', 'BFO']);

/** Normalises the provider's many spellings of the two allowed underlyings. */
function normaliseUnderlying(value?: string): string {
  const v = (value || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!v) return '';
  if (v === 'NIFTY' || v === 'NIFTY 50' || v === 'NIFTY50') return 'NIFTY';
  if (v === 'BANKNIFTY' || v === 'NIFTY BANK' || v === 'NIFTYBANK') return 'BANKNIFTY';
  return v;
}

/**
 * Reject-first symbol parser.
 * Accepts only:
 *  - spot index names: "NIFTY", "NIFTY 50", "BANKNIFTY", "NIFTY BANK"
 *  - futures: "NIFTY23NOV26FUT", "BANKNIFTY23NOV26FUT" (digits immediately after the root)
 *  - options: "NIFTY 24750 CE 17 NOV 26", "BANKNIFTY 61000 PE 17 NOV 26" (space + digit)
 * Explicitly refuses other NIFTY-family products, because their next character is a letter.
 */
export function resolveUnderlyingFromSymbol(symbol?: string): FreeAccessUnderlying | null {
  const s = (symbol || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!s) return null;

  // BANKNIFTY first (it contains NIFTY as a suffix).
  if (/^BANKNIFTY$/.test(s)) return 'BANKNIFTY';
  if (/^BANKNIFTY (?=\d)/.test(s)) return 'BANKNIFTY'; // options: BANKNIFTY 61000 CE ...
  if (/^BANKNIFTY(?=\d)/.test(s)) return 'BANKNIFTY'; // futures: BANKNIFTY23NOV26FUT
  if (/^NIFTY BANK$/.test(s)) return 'BANKNIFTY';
  if (/^NIFTY BANK (?=\d)/.test(s)) return 'BANKNIFTY';

  // NIFTY 50 family.
  if (/^NIFTY$/.test(s)) return 'NIFTY';
  if (/^NIFTY 50$/.test(s)) return 'NIFTY';
  if (/^NIFTY 50 (?=\d)/.test(s)) return 'NIFTY';
  if (/^NIFTY (?=\d)/.test(s)) return 'NIFTY'; // options: NIFTY 24750 CE ...
  if (/^NIFTY(?=\d)/.test(s)) return 'NIFTY'; // futures: NIFTY23NOV26FUT

  // Everything else (FINNIFTY, MIDCPNIFTY, NIFTY IT, NIFTYNXT50, NIFTYFPI, SENSEX, ...) is not free.
  return null;
}

export interface FreeAccessInstrumentLike {
  symbol?: string;
  underlying?: string;
  exchange?: string;
  instrumentType?: string;
  provider?: string;
  isSimulatedFixture?: boolean;
}

/**
 * Authoritative predicate used by every REST/WS entitlement check.
 * Fails closed when the instrument cannot be positively identified.
 */
export function isFreeTierAllowedInstrument(inst: FreeAccessInstrumentLike): boolean {
  if (!inst) return false;
  // Explicit bundled test fixtures have display names prefixed DEMO; these exact fixtures do
  // not relax production provider identities or accept arbitrary underlying declarations.
  if (inst.provider === 'DEMO' && inst.isSimulatedFixture && ['DEMO-NIFTY50', 'DEMO-NIFTY-FUT'].includes(inst.symbol || '')) {
    return isFreeTierAllowedInstrument({ ...inst, symbol: inst.instrumentType === 'INDEX_SPOT' ? 'NIFTY 50' : 'NIFTY 50 FUT', provider: undefined });
  }

  const exchange = (inst.exchange || '').trim().toUpperCase();
  if (exchange && !FREE_EXCHANGES.has(exchange)) return false;

  const instrumentType = (inst.instrumentType || '').trim().toUpperCase();
  if (instrumentType && !FREE_INSTRUMENT_TYPES.has(instrumentType)) return false;

  // The provider's `underlying` field is authoritative when present.
  const declared = normaliseUnderlying(inst.underlying);
  if (declared) {
    if (!FREE_UNDERLYINGS.has(declared)) return false;
  }

  const fromSymbol = resolveUnderlyingFromSymbol(inst.symbol);
  // Reference indices require an exact name. A digit suffix such as NIFTY 100 is not a
  // derivative merely because it starts with NIFTY followed by a number.
  if (instrumentType === 'INDEX_SPOT') {
    const spot = normaliseUnderlying(inst.symbol);
    return FREE_UNDERLYINGS.has(spot) && (!declared || declared === spot);
  }
  if (fromSymbol && declared && fromSymbol !== declared) return false;
  if (declared && FREE_UNDERLYINGS.has(declared)) {
    // Guard against mismatched metadata: if the symbol clearly belongs to another product, reject.
    if (inst.symbol && fromSymbol === null && !/^\s*$/.test(inst.symbol)) {
      // Symbols that cannot be parsed are only accepted when the declared underlying is explicit
      // AND the symbol is not an obviously different NIFTY-family name.
      return false;
      // "NIFTY BANK ..." normalises through the symbol parser; anything else with a declared
      // allowed underlying is treated as a provider-specific contract naming variant.
    }
    return true;
  }

  return fromSymbol !== null;
}

/**
 * Best-effort predicate for paths that only have a global instrument id (e.g. deep links).
 * Format is "EXCHANGE:SYMBOL:TOKEN"; anything unparseable fails closed.
 */
export function isFreeTierAllowedGlobalId(globalId?: string): boolean {
  if (!globalId) return false;
  const parts = String(globalId).split(':');
  if (parts.length < 2) return false;
  const exchange = parts[0]?.trim().toUpperCase() || '';
  const symbol = parts[1]?.trim() || '';
  if (!FREE_EXCHANGES.has(exchange)) return false;
  if (exchange === 'NSE' || exchange === 'BSE') return FREE_UNDERLYINGS.has(normaliseUnderlying(symbol));
  // Spot indices have no instrumentType in the id; derivatives are inferred from the symbol.
  return resolveUnderlyingFromSymbol(symbol) !== null;
}
