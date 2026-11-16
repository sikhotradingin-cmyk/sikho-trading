/**
 * Sikho Trading — Professional Instrument Identity System & Central Asset Manifest
 *
 * Provides sourced issuer/company logos, indices artwork, commodity icons,
 * derivative badges (FUT / CE / PE), and deterministic high-contrast monogram fallbacks.
 *
 * Security & Performance:
 * - All SVGs are sanitized vector assets bundled 100% locally.
 * - Rendered as standard <img> elements via data URIs to isolate execution.
 * - Zero external HTTP requests preserving watchlist privacy.
 * - Completely offline-ready and DPI-independent.
 */
(function (global) {
  'use strict';

  // Helper to convert inline SVG string to sanitized data URI for <img> tag
  function svgToDataUri(svgString) {
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svgString.trim());
  }

  // Palette for deterministic, contrast-safe monogram backgrounds
  const MONOGRAM_PALETTE = [
    { bg: '#EFF6FF', text: '#1D4ED8', border: '#BFDBFE' }, // Blue
    { bg: '#ECFDF5', text: '#047857', border: '#A7F3D0' }, // Emerald
    { bg: '#FEF3C7', text: '#B45309', border: '#FDE68A' }, // Amber
    { bg: '#F5F3FF', text: '#6D28D9', border: '#DDD6FE' }, // Purple
    { bg: '#FDF2F8', text: '#BE185D', border: '#FBCFE8' }, // Pink
    { bg: '#F0FDFA', text: '#0F766E', border: '#99F6E4' }, // Teal
    { bg: '#FFF7ED', text: '#C2410C', border: '#FFEDD5' }, // Orange
    { bg: '#F1F5F9', text: '#334155', border: '#CBD5E1' }, // Slate
  ];

  function getMonogramColors(seed) {
    let hash = 0;
    const str = (seed || 'EQ').toUpperCase();
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    const idx = Math.abs(hash) % MONOGRAM_PALETTE.length;
    return MONOGRAM_PALETTE[idx];
  }

  // 1. INDICES SVGs (38x38 viewport)
  const SVG_NIFTY50 = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
      <rect width="40" height="40" rx="10" fill="#FFF7ED"/>
      <path d="M11 26 L17 14 L23 26 L29 14" fill="none" stroke="#EA580C" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      <circle cx="29" cy="14" r="2.5" fill="#DC2626"/>
      <circle cx="11" cy="26" r="2.5" fill="#EA580C"/>
    </svg>`;

  const SVG_BANKNIFTY = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
      <rect width="40" height="40" rx="10" fill="#FEF3C7"/>
      <path d="M10 16 L20 10 L30 16 Z" fill="#D97706"/>
      <rect x="12" y="18" width="3" height="11" rx="1" fill="#B45309"/>
      <rect x="18.5" y="18" width="3" height="11" rx="1" fill="#B45309"/>
      <rect x="25" y="18" width="3" height="11" rx="1" fill="#B45309"/>
      <rect x="9" y="29" width="22" height="2.5" rx="1" fill="#D97706"/>
    </svg>`;

  const SVG_SENSEX = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
      <rect width="40" height="40" rx="10" fill="#F0F9FF"/>
      <path d="M12 28 L19 21 L23 25 L30 14" fill="none" stroke="#0284C7" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M25 14 H30 V19" fill="none" stroke="#0284C7" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      <rect x="9" y="8" width="6" height="4" rx="1" fill="#0369A1"/>
    </svg>`;

  const SVG_NIFTYIT = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
      <rect width="40" height="40" rx="10" fill="#ECFEFF"/>
      <rect x="13" y="13" width="14" height="14" rx="2" fill="#0E7490"/>
      <path d="M20 7 V13 M20 27 V33 M7 20 H13 M27 20 H33" stroke="#0891B2" stroke-width="2.5" stroke-linecap="round"/>
      <circle cx="20" cy="20" r="3" fill="#A5F3FC"/>
    </svg>`;

  const SVG_NIFTYPHARMA = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
      <rect width="40" height="40" rx="10" fill="#F0FDF4"/>
      <rect x="17" y="10" width="6" height="20" rx="2" fill="#16A34A"/>
      <rect x="10" y="17" width="20" height="6" rx="2" fill="#16A34A"/>
      <circle cx="29" cy="11" r="3" fill="#22C55E"/>
    </svg>`;

  const SVG_NIFTYMETAL = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
      <rect width="40" height="40" rx="10" fill="#F1F5F9"/>
      <polygon points="12,28 16,14 28,14 32,28" fill="#64748B"/>
      <polygon points="16,14 20,10 32,10 28,14" fill="#94A3B8"/>
      <polygon points="28,14 32,10 36,24 32,28" fill="#475569"/>
    </svg>`;

  const SVG_MIDCPNIFTY = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
      <rect width="40" height="40" rx="10" fill="#FFFBEB"/>
      <path d="M10 28 V12 L16 20 L22 12 V28 M26 12 H31 V28 H26" fill="none" stroke="#D97706" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;

  // 2. MCX COMMODITIES SVGs
  const SVG_GOLD = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
      <rect width="40" height="40" rx="10" fill="#FEF3C7"/>
      <polygon points="11,28 15,16 27,16 31,28" fill="#EAB308"/>
      <polygon points="15,16 19,12 31,12 27,16" fill="#FDE047"/>
      <polygon points="27,16 31,12 35,24 31,28" fill="#CA8A04"/>
      <text x="21" y="24" font-family="sans-serif" font-size="6.5" font-weight="900" fill="#713F12" text-anchor="middle">AU 999</text>
    </svg>`;

  const SVG_SILVER = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
      <rect width="40" height="40" rx="10" fill="#F8FAFC"/>
      <polygon points="11,28 15,16 27,16 31,28" fill="#94A3B8"/>
      <polygon points="15,16 19,12 31,12 27,16" fill="#E2E8F0"/>
      <polygon points="27,16 31,12 35,24 31,28" fill="#64748B"/>
      <text x="21" y="24" font-family="sans-serif" font-size="6.5" font-weight="900" fill="#1E293B" text-anchor="middle">AG 999</text>
    </svg>`;

  const SVG_CRUDEOIL = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
      <rect width="40" height="40" rx="10" fill="#F1F5F9"/>
      <ellipse cx="20" cy="13" rx="8" ry="3" fill="#0F172A"/>
      <path d="M12 13 V27 C12 29 28 29 28 27 V13" fill="#1E293B"/>
      <ellipse cx="20" cy="27" rx="8" ry="3" fill="#0F172A"/>
      <path d="M20 18 Q23 23 20 25 Q17 23 20 18 Z" fill="#F59E0B"/>
    </svg>`;

  const SVG_NATURALGAS = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
      <rect width="40" height="40" rx="10" fill="#EFF6FF"/>
      <path d="M20 9 C20 9 27 18 27 24 C27 28 23.8 31 20 31 C16.2 31 13 28 13 24 C13 18 20 9 20 9 Z" fill="#2563EB"/>
      <path d="M20 17 C20 17 24 22 24 25 C24 27.5 22.2 29.5 20 29.5 C17.8 29.5 16 27.5 16 25 C16 22 20 17 20 17 Z" fill="#60A5FA"/>
      <circle cx="20" cy="26" r="2" fill="#FFFFFF"/>
    </svg>`;

  const SVG_COPPER = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
      <rect width="40" height="40" rx="10" fill="#FFF7ED"/>
      <circle cx="20" cy="20" r="10" fill="#C2410C"/>
      <circle cx="20" cy="20" r="6" fill="#FFF7ED"/>
      <text x="20" y="23" font-family="sans-serif" font-size="8" font-weight="900" fill="#C2410C" text-anchor="middle">Cu</text>
    </svg>`;

  // Central mapping table by canonical symbol & ISIN & alias
  const ASSET_REGISTRY = {
    // Indices
    'NIFTY 50': SVG_NIFTY50,
    'NIFTY': SVG_NIFTY50,
    'DEMO-NIFTY50': SVG_NIFTY50,
    'NSE:NIFTY:INDEX': SVG_NIFTY50,
    'NSE:NIFTY 50:INDEX': SVG_NIFTY50,

    'BANKNIFTY': SVG_BANKNIFTY,
    'NIFTY BANK': SVG_BANKNIFTY,
    'NSE:BANKNIFTY:INDEX': SVG_BANKNIFTY,
    'NSE:NIFTY BANK:INDEX': SVG_BANKNIFTY,

    'SENSEX': SVG_SENSEX,
    'BSE:SENSEX:INDEX': SVG_SENSEX,
    'BSE:SENSEX 30:INDEX': SVG_SENSEX,

    'NIFTY IT': SVG_NIFTYIT,
    'NSE:NIFTYIT:INDEX': SVG_NIFTYIT,

    'NIFTY PHARMA': SVG_NIFTYPHARMA,
    'NSE:NIFTYPHARMA:INDEX': SVG_NIFTYPHARMA,

    'NIFTY METAL': SVG_NIFTYMETAL,
    'NSE:NIFTYMETAL:INDEX': SVG_NIFTYMETAL,

    'NIFTY MIDCAP': SVG_MIDCPNIFTY,
    'MIDCPNIFTY': SVG_MIDCPNIFTY,

    // Commodities
    'GOLD': SVG_GOLD,
    'GOLDM': SVG_GOLD,
    'MCX:GOLD': SVG_GOLD,

    'SILVER': SVG_SILVER,
    'SILVERM': SVG_SILVER,
    'MCX:SILVER': SVG_SILVER,

    'CRUDEOIL': SVG_CRUDEOIL,
    'CRUDEOILM': SVG_CRUDEOIL,
    'MCX:CRUDEOIL': SVG_CRUDEOIL,

    'NATURALGAS': SVG_NATURALGAS,
    'MCX:NATURALGAS': SVG_NATURALGAS,

    'COPPER': SVG_COPPER,
    'MCX:COPPER': SVG_COPPER,

  };

  const ISSUER_LOGOS = Object.freeze({...{"AADHARHFC":"logos/AADHARHFC.png","INE883F01010":"logos/AADHARHFC.png","HDFCBANK":"logos/HDFCBANK.png","INE040A01034":"logos/HDFCBANK.png","ICICIBANK":"logos/ICICIBANK.png","INE090A01021":"logos/ICICIBANK.png","SBIN":"logos/SBIN.ico","INE062A01020":"logos/SBIN.ico","ITC":"logos/ITC.png","INE154A01025":"logos/ITC.png","BAJFINANCE":"logos/BAJFINANCE.svg","INE296A01032":"logos/BAJFINANCE.svg","RELIANCE":"logos/RELIANCE.ico","INE002A01018":"logos/RELIANCE.ico","TCS":"logos/TCS.png","INE467B01029":"logos/TCS.png","INFY":"logos/INFY.png","INE009A01021":"logos/INFY.png","BHARTIARTL":"logos/BHARTIARTL.png","INE397D01024":"logos/BHARTIARTL.png","KOTAKBANK":"logos/KOTAKBANK.ico","INE237A01036":"logos/KOTAKBANK.ico","WIPRO":"logos/WIPRO.png","INE075A01022":"logos/WIPRO.png","MARUTI":"logos/MARUTI.ico","INE585B01010":"logos/MARUTI.ico","SUNPHARMA":"logos/SUNPHARMA.png","INE044A01036":"logos/SUNPHARMA.png","HINDUNILVR":"logos/HINDUNILVR.png","INE030A01027":"logos/HINDUNILVR.png","TATAMOTORS":"logos/TATAMOTORS.ico","TTML":"logos/TTML.ico","INE517B01013":"logos/TTML.ico"},
  "AADHARHFC": "logos/AADHARHFC.png",
  "INE883F01010": "logos/AADHARHFC.png",
  "HDFCBANK": "logos/HDFCBANK.png",
  "INE040A01034": "logos/HDFCBANK.png",
  "ICICIBANK": "logos/ICICIBANK.png",
  "INE090A01021": "logos/ICICIBANK.png",
  "SBIN": "logos/SBIN.ico",
  "INE062A01020": "logos/SBIN.ico",
  "ITC": "logos/ITC.png",
  "INE154A01025": "logos/ITC.png",
  "BAJFINANCE": "logos/BAJFINANCE.svg",
  "INE296A01032": "logos/BAJFINANCE.svg",
  "HDFC BANK": "logos/HDFCBANK.png",
  "ICICI BANK": "logos/ICICIBANK.png",
  "STATE BANK OF INDIA": "logos/SBIN.ico",
  "AADHAR HOUSING FINANCE": "logos/AADHARHFC.png",
  "BAJAJ FINANCE": "logos/BAJFINANCE.svg",
  "INE296A01024": "logos/BAJFINANCE.svg"
});

  /**
   * Generates an intentional, attractive monogram SVG data URI fallback
   */
  function createMonogramDataUri(symbol, name, size) {
    const rawSymbol = (symbol || 'EQ').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    let monogram = rawSymbol.slice(0, 3);
    if (!monogram) monogram = 'EQ';

    const colors = getMonogramColors(rawSymbol);
    const fontSize = monogram.length > 2 ? 11 : 13;

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="${size}" height="${size}">
        <rect width="40" height="40" rx="10" fill="${colors.bg}" stroke="${colors.border}" stroke-width="1.5"/>
        <text x="20" y="24" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="${fontSize}" font-weight="800" fill="${colors.text}" text-anchor="middle" letter-spacing="0.2">${monogram}</text>
      </svg>`;
    return svgToDataUri(svg);
  }

  /**
   * Resolves the primary SVG icon data URI for an instrument
   */
  function resolveInstrumentSvgUri(inst, size) {
    if (!inst) return createMonogramDataUri('EQ', '', size);

    const symbol = (inst.symbol || '').trim().toUpperCase();
    const underlying = (inst.underlying || '').trim().toUpperCase();
    const globalId = (inst.globalId || '').trim();
    const isin = (inst.isin || '').trim().toUpperCase();
    const name = (inst.name || '').trim().toUpperCase();

    // Issuer ISIN takes precedence over display aliases; derivatives use an exact underlying.
    const issuerKey = (inst.tradingSymbol || symbol).toUpperCase().replace(/-(EQ|BE|BZ)$/, '');
    const issuer = ISSUER_LOGOS[isin] || ISSUER_LOGOS[issuerKey] ||
      ((inst.instrumentType === 'FUTSTK' || inst.instrumentType === 'OPTSTK') ? ISSUER_LOGOS[underlying] : null);
    if (issuer) return issuer;

    // 1. Direct registry lookup by exact symbol
    if (ASSET_REGISTRY[symbol]) return svgToDataUri(ASSET_REGISTRY[symbol]);

    // 2. Lookup by ISIN
    if (isin && ASSET_REGISTRY[isin]) return svgToDataUri(ASSET_REGISTRY[isin]);

    // 3. Lookup by Global ID
    if (globalId && ASSET_REGISTRY[globalId]) return svgToDataUri(ASSET_REGISTRY[globalId]);

    // 4. Lookup by underlying for derivatives
    if (underlying && ASSET_REGISTRY[underlying]) return svgToDataUri(ASSET_REGISTRY[underlying]);

    // 5. Commodity substring matching
    if (inst.exchange === 'MCX' || inst.segment === 'COMMODITY' || inst.instrumentType === 'FUTCOM' || inst.instrumentType === 'OPTCOM') {
      if (symbol.includes('GOLD')) return svgToDataUri(SVG_GOLD);
      if (symbol.includes('SILVER')) return svgToDataUri(SVG_SILVER);
      if (symbol.includes('CRUDE')) return svgToDataUri(SVG_CRUDEOIL);
      if (symbol.includes('NATURAL') || symbol.includes('GAS')) return svgToDataUri(SVG_NATURALGAS);
      if (symbol.includes('COPPER')) return svgToDataUri(SVG_COPPER);
      if (symbol.includes('ZINC') || symbol.includes('LEAD') || symbol.includes('ALUM')) return svgToDataUri(SVG_NIFTYMETAL);
    }

    // 6. Index substring matching
    if (inst.instrumentType === 'INDEX_SPOT' || inst.instrumentType === 'FUTIDX' || inst.instrumentType === 'OPTIDX') {
      if (symbol.includes('BANK')) return svgToDataUri(SVG_BANKNIFTY);
      if (symbol.includes('NIFTY') || name.includes('NIFTY')) return svgToDataUri(SVG_NIFTY50);
      if (symbol.includes('SENSEX') || name.includes('SENSEX')) return svgToDataUri(SVG_SENSEX);
      if (symbol.includes('IT')) return svgToDataUri(SVG_NIFTYIT);
      if (symbol.includes('PHARMA')) return svgToDataUri(SVG_NIFTYPHARMA);
      if (symbol.includes('METAL')) return svgToDataUri(SVG_NIFTYMETAL);
    }

    // 8. Intentional, attractive monogram fallback
    return createMonogramDataUri(symbol, inst.name, size);
  }

  /**
   * Reusable InstrumentAvatar Component
   * Returns HTML string for the avatar container with optional derivative pill badge.
   *
   * @param {Object} inst Instrument metadata
   * @param {number} size Box dimension in px (default 38)
   * @param {string} extraClass Additional CSS classes
   */
  function renderInstrumentAvatar(inst, size = 38, extraClass = '') {
    const iconUri = resolveInstrumentSvgUri(inst, size);
    const fallback = createMonogramDataUri(inst?.symbol, inst?.name, size);
    const boxSize = size;
    const isDeriv = inst && (
      inst.instrumentType === 'FUTIDX' ||
      inst.instrumentType === 'FUTSTK' ||
      inst.instrumentType === 'FUTCOM' ||
      inst.instrumentType === 'OPTIDX' ||
      inst.instrumentType === 'OPTSTK' ||
      inst.instrumentType === 'OPTCOM'
    );

    let badgeHtml = '';
    if (isDeriv) {
      if (inst.instrumentType.startsWith('FUT')) {
        badgeHtml = '<span class="avatar-deriv-badge badge-fut">FUT</span>';
      } else if (inst.optionType === 'CE') {
        badgeHtml = '<span class="avatar-deriv-badge badge-ce">CE</span>';
      } else if (inst.optionType === 'PE') {
        badgeHtml = '<span class="avatar-deriv-badge badge-pe">PE</span>';
      }
    }

    return `
      <div class="inst-avatar-box ${extraClass}" style="width:${boxSize}px;height:${boxSize}px;">
        <img src="${iconUri}" alt="${inst?.symbol || 'Instrument'}" class="inst-avatar-img" width="${boxSize}" height="${boxSize}" loading="lazy" decoding="async" data-logo-fallback="${fallback}" onerror="this.onerror=null;this.src=this.dataset.logoFallback" />
        ${badgeHtml}
      </div>
    `;
  }

  // Export to global scope
  global.InstrumentIdentity = {
    renderInstrumentAvatar,
    resolveInstrumentSvgUri,
    createMonogramDataUri,
    ASSET_REGISTRY,
    ISSUER_LOGOS,
  };

})(typeof window !== 'undefined' ? window : this);

