/**
 * Canonical FREE-tier access matrix (WebView build).
 *
 * This mirrors packages/shared/src/models/free-access.ts exactly. It is a separate plain-JS asset
 * because the WebView SPA is not bundled with TypeScript, and it is unit-tested by
 * packages/mobile/test-assets/free-access.test.js.
 *
 * Product rule: FREE practice covers the NIFTY 50 and BANKNIFTY reference indices, their supported
 * index futures and index options. Every other product (SENSEX, BANKEX, FINNIFTY, MIDCPNIFTY,
 * NIFTY Next 50, NIFTY IT, equities, stock F&O, MCX) is Premium-only.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.TzFreeAccess = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var FREE_UNDERLYINGS = { NIFTY: true, BANKNIFTY: true };
  var FREE_INSTRUMENT_TYPES = { INDEX_SPOT: true, FUTIDX: true, OPTIDX: true };
  var FREE_EXCHANGES = { NSE: true, NFO: true, BSE: true, BFO: true };

  function normaliseUnderlying(value) {
    var v = String(value || '').trim().toUpperCase().replace(/\s+/g, ' ');
    if (!v) return '';
    if (v === 'NIFTY' || v === 'NIFTY 50' || v === 'NIFTY50') return 'NIFTY';
    if (v === 'BANKNIFTY' || v === 'NIFTY BANK' || v === 'NIFTYBANK') return 'BANKNIFTY';
    return v;
  }

  /**
   * Reject-first parser. Only these shapes resolve:
   *  spot: "NIFTY", "NIFTY 50", "BANKNIFTY", "NIFTY BANK"
   *  futures: "NIFTY23NOV26FUT" / "BANKNIFTY23NOV26FUT" (digit immediately after the root)
   *  options: "NIFTY 24750 CE 17 NOV 26" / "BANKNIFTY 61000 PE 17 NOV 26" (space + digit)
   * Other NIFTY-family products continue with a letter and are rejected.
   */
  function resolveUnderlyingFromSymbol(symbol) {
    var s = String(symbol || '').trim().toUpperCase().replace(/\s+/g, ' ');
    if (!s) return null;

    if (/^BANKNIFTY$/.test(s)) return 'BANKNIFTY';
    if (/^BANKNIFTY (?=\d)/.test(s)) return 'BANKNIFTY';
    if (/^BANKNIFTY(?=\d)/.test(s)) return 'BANKNIFTY';
    if (/^NIFTY BANK$/.test(s)) return 'BANKNIFTY';
    if (/^NIFTY BANK (?=\d)/.test(s)) return 'BANKNIFTY';

    if (/^NIFTY$/.test(s)) return 'NIFTY';
    if (/^NIFTY 50$/.test(s)) return 'NIFTY';
    if (/^NIFTY 50 (?=\d)/.test(s)) return 'NIFTY';
    if (/^NIFTY (?=\d)/.test(s)) return 'NIFTY';
    if (/^NIFTY(?=\d)/.test(s)) return 'NIFTY';

    return null;
  }

  function isFreeTierAllowedInstrument(inst) {
    if (!inst) return false;

    var exchange = String(inst.exchange || '').trim().toUpperCase();
    if (exchange && !FREE_EXCHANGES[exchange]) return false;

    var instrumentType = String(inst.instrumentType || '').trim().toUpperCase();
    if (instrumentType && !FREE_INSTRUMENT_TYPES[instrumentType]) return false;

    var declared = normaliseUnderlying(inst.underlying);
    if (declared && !FREE_UNDERLYINGS[declared]) return false;

    var fromSymbol = resolveUnderlyingFromSymbol(inst.symbol);
    if (declared && FREE_UNDERLYINGS[declared]) {
      if (inst.symbol && fromSymbol === null) {
        var s = String(inst.symbol).trim().toUpperCase();
        if (/^(FINNIFTY|MIDCPNIFTY|NIFTYIT|NIFTYNXT50|NIFTYFPI|NIFTYMID|NIFTYMIDSML|NIFTYSMALLCAP|NIFTYBANK|SENSEX|BANKEX)/.test(s)) {
          return false;
        }
      }
      return true;
    }
    return fromSymbol !== null;
  }

  function isFreeTierAllowedGlobalId(globalId) {
    if (!globalId) return false;
    var parts = String(globalId).split(':');
    if (parts.length < 2) return false;
    var exchange = String(parts[0] || '').trim().toUpperCase();
    var symbol = String(parts[1] || '').trim();
    if (!FREE_EXCHANGES[exchange]) return false;
    return resolveUnderlyingFromSymbol(symbol) !== null;
  }

  return {
    normaliseUnderlying: normaliseUnderlying,
    resolveUnderlyingFromSymbol: resolveUnderlyingFromSymbol,
    isFreeTierAllowedInstrument: isFreeTierAllowedInstrument,
    isFreeTierAllowedGlobalId: isFreeTierAllowedGlobalId,
    FREE_UNDERLYINGS: FREE_UNDERLYINGS,
    FREE_INSTRUMENT_TYPES: FREE_INSTRUMENT_TYPES,
  };
});
