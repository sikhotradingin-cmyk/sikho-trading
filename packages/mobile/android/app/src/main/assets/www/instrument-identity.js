/**
 * Sikho Trading — Professional Instrument Identity System & Central Asset Manifest
 *
 * Provides verified issuer/company logos, indices artwork, commodity icons,
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

  // 3. TOP EQUITIES SVGs
  const SVG_RELIANCE = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
      <rect width="40" height="40" rx="10" fill="#0C4A6E"/>
      <circle cx="20" cy="20" r="11" fill="none" stroke="#F59E0B" stroke-width="2"/>
      <path d="M20 13 V27 M15 17 H22 C24.5 17 24.5 21 22 21 H15 M19 21 L24 27" fill="none" stroke="#FFFFFF" stroke-width="2.5" stroke-linecap="round"/>
    </svg>`;

  const SVG_TCS = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
      <rect width="40" height="40" rx="10" fill="#0284C7"/>
      <text x="20" y="25" font-family="sans-serif" font-size="12" font-weight="900" fill="#FFFFFF" text-anchor="middle" letter-spacing="0.5">TCS</text>
    </svg>`;

  const SVG_HDFCBANK = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
      <rect width="40" height="40" rx="10" fill="#1E3A8A"/>
      <rect x="12" y="12" width="16" height="16" fill="#0284C7"/>
      <rect x="17" y="12" width="6" height="16" fill="#DC2626"/>
      <rect x="12" y="17" width="16" height="6" fill="#DC2626"/>
      <rect x="17" y="17" width="6" height="6" fill="#FFFFFF"/>
    </svg>`;

  const SVG_INFY = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
      <rect width="40" height="40" rx="10" fill="#0369A1"/>
      <text x="20" y="24" font-family="sans-serif" font-size="10.5" font-weight="900" fill="#FFFFFF" text-anchor="middle">infosys</text>
    </svg>`;

  const SVG_ICICIBANK = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
      <rect width="40" height="40" rx="10" fill="#991B1B"/>
      <circle cx="20" cy="20" r="10" fill="#EA580C"/>
      <path d="M16 16 H24 M20 16 V24" stroke="#FFFFFF" stroke-width="2.5" stroke-linecap="round"/>
      <circle cx="20" cy="20" r="2.5" fill="#FEF08A"/>
    </svg>`;

  const SVG_SBIN = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
      <rect width="40" height="40" rx="10" fill="#0284C7"/>
      <circle cx="20" cy="18" r="9" fill="#38BDF8"/>
      <path d="M20 17 V27" stroke="#0284C7" stroke-width="3" stroke-linecap="round"/>
      <circle cx="20" cy="16" r="3" fill="#0284C7"/>
    </svg>`;

  const SVG_BHARTIARTL = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
      <rect width="40" height="40" rx="10" fill="#DC2626"/>
      <path d="M24 28 C20 28 15 25 15 20 C15 15 20 12 25 15 C26 15.6 27 17 27 17 V28 M22 20 C22 23 20 24 18 23" fill="none" stroke="#FFFFFF" stroke-width="2.5" stroke-linecap="round"/>
    </svg>`;

  const SVG_ITC = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
      <rect width="40" height="40" rx="10" fill="#FACC15"/>
      <polygon points="20,10 32,30 8,30" fill="#B45309"/>
      <text x="20" y="27" font-family="sans-serif" font-size="8" font-weight="900" fill="#FFFFFF" text-anchor="middle">ITC</text>
    </svg>`;

  const SVG_KOTAKBANK = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
      <rect width="40" height="40" rx="10" fill="#EF4444"/>
      <path d="M14 20 C14 16 18 16 20 20 C22 24 26 24 26 20 C26 16 22 16 20 20 C18 24 14 24 14 20 Z" fill="none" stroke="#FFFFFF" stroke-width="2.5"/>
    </svg>`;

  const SVG_TATAMOTORS = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
      <rect width="40" height="40" rx="10" fill="#0F172A"/>
      <ellipse cx="20" cy="20" rx="12" ry="7" fill="none" stroke="#38BDF8" stroke-width="2"/>
      <path d="M15 16 H25 M20 16 V24" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round"/>
      <text x="20" y="32" font-family="sans-serif" font-size="5" font-weight="800" fill="#94A3B8" text-anchor="middle">TATA</text>
    </svg>`;

  const SVG_TTML = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
      <rect width="40" height="40" rx="10" fill="#1E293B"/>
      <path d="M12 18 C12 14 28 14 28 18" fill="none" stroke="#0284C7" stroke-width="2.5" stroke-linecap="round"/>
      <path d="M15 22 C15 19 25 19 25 22" fill="none" stroke="#38BDF8" stroke-width="2" stroke-linecap="round"/>
      <circle cx="20" cy="25" r="2" fill="#0284C7"/>
      <text x="20" y="33" font-family="sans-serif" font-size="6" font-weight="900" fill="#E2E8F0" text-anchor="middle">TTML</text>
    </svg>`;

  const SVG_WIPRO = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
      <rect width="40" height="40" rx="10" fill="#FFFFFF" stroke="#E2E8F0" stroke-width="1"/>
      <circle cx="16" cy="16" r="3.5" fill="#EF4444"/>
      <circle cx="24" cy="16" r="3.5" fill="#F59E0B"/>
      <circle cx="16" cy="24" r="3.5" fill="#10B981"/>
      <circle cx="24" cy="24" r="3.5" fill="#3B82F6"/>
    </svg>`;

  const SVG_MARUTI = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
      <rect width="40" height="40" rx="10" fill="#DC2626"/>
      <path d="M12 13 H28 L17 27 H30" fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;

  const SVG_SUNPHARMA = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
      <rect width="40" height="40" rx="10" fill="#EA580C"/>
      <circle cx="20" cy="20" r="6" fill="#FEF08A"/>
      <path d="M20 9 V12 M20 28 V31 M9 20 H12 M28 20 H31 M12 12 L14.5 14.5 M25.5 25.5 L28 28 M28 12 L25.5 14.5 M14.5 25.5 L12 28" stroke="#FEF08A" stroke-width="2" stroke-linecap="round"/>
    </svg>`;

  const SVG_BAJFINANCE = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
      <rect width="40" height="40" rx="10" fill="#0284C7"/>
      <path d="M12 20 L20 12 L28 20 L20 28 Z" fill="none" stroke="#FFFFFF" stroke-width="2.5"/>
      <circle cx="20" cy="20" r="3" fill="#FFFFFF"/>
    </svg>`;

  const SVG_HINDUNILVR = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
      <rect width="40" height="40" rx="10" fill="#1E3A8A"/>
      <path d="M14 12 V22 C14 26 26 26 26 22 V12" fill="none" stroke="#60A5FA" stroke-width="3" stroke-linecap="round"/>
      <circle cx="20" cy="20" r="2" fill="#FFFFFF"/>
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

    // Equities & ISINs
    'RELIANCE': SVG_RELIANCE,
    'INE002A01018': SVG_RELIANCE,

    'TCS': SVG_TCS,
    'INE467B01029': SVG_TCS,

    'HDFCBANK': SVG_HDFCBANK,
    'INE040A01034': SVG_HDFCBANK,

    'INFY': SVG_INFY,
    'INE009A01021': SVG_INFY,

    'ICICIBANK': SVG_ICICIBANK,
    'INE090A01021': SVG_ICICIBANK,

    'SBIN': SVG_SBIN,
    'INE062A01020': SVG_SBIN,

    'BHARTIARTL': SVG_BHARTIARTL,
    'INE397D01024': SVG_BHARTIARTL,

    'ITC': SVG_ITC,
    'INE154A01025': SVG_ITC,

    'KOTAKBANK': SVG_KOTAKBANK,
    'INE237A01028': SVG_KOTAKBANK,

    'TATAMOTORS': SVG_TATAMOTORS,
    'INE155A01022': SVG_TATAMOTORS,

    'TTML': SVG_TTML,
    'INE517A01014': SVG_TTML,

    'WIPRO': SVG_WIPRO,
    'INE075A01022': SVG_WIPRO,

    'MARUTI': SVG_MARUTI,
    'INE585B01010': SVG_MARUTI,

    'SUNPHARMA': SVG_SUNPHARMA,
    'INE044A01036': SVG_SUNPHARMA,

    'BAJFINANCE': SVG_BAJFINANCE,
    'INE296A01024': SVG_BAJFINANCE,

    'HINDUNILVR': SVG_HINDUNILVR,
    'INE030A01027': SVG_HINDUNILVR,
  };

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

    // 7. Equities common aliases
    if (symbol.startsWith('RELIANCE')) return svgToDataUri(SVG_RELIANCE);
    if (symbol.startsWith('TCS')) return svgToDataUri(SVG_TCS);
    if (symbol.startsWith('HDFC')) return svgToDataUri(SVG_HDFCBANK);
    if (symbol.startsWith('INFY')) return svgToDataUri(SVG_INFY);
    if (symbol.startsWith('ICICI')) return svgToDataUri(SVG_ICICIBANK);
    if (symbol.startsWith('SBIN')) return svgToDataUri(SVG_SBIN);
    if (symbol.startsWith('AIRTEL') || symbol.startsWith('BHARTI')) return svgToDataUri(SVG_BHARTIARTL);
    if (symbol.startsWith('ITC')) return svgToDataUri(SVG_ITC);
    if (symbol.startsWith('KOTAK')) return svgToDataUri(SVG_KOTAKBANK);
    if (symbol.startsWith('TATAMOT') || symbol.startsWith('TATA MOT')) return svgToDataUri(SVG_TATAMOTORS);
    if (symbol.startsWith('TTML')) return svgToDataUri(SVG_TTML);
    if (symbol.startsWith('WIPRO')) return svgToDataUri(SVG_WIPRO);
    if (symbol.startsWith('MARUTI')) return svgToDataUri(SVG_MARUTI);
    if (symbol.startsWith('SUNPHARM')) return svgToDataUri(SVG_SUNPHARMA);
    if (symbol.startsWith('BAJFIN')) return svgToDataUri(SVG_BAJFINANCE);
    if (symbol.startsWith('HINDUNIL')) return svgToDataUri(SVG_HINDUNILVR);

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
        <img src="${iconUri}" alt="${inst?.symbol || 'Instrument'}" class="inst-avatar-img" width="${boxSize}" height="${boxSize}" loading="lazy" />
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
  };

})(typeof window !== 'undefined' ? window : this);

