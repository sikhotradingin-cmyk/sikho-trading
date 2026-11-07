import {
  Candle,
  ChartRange,
  Exchange,
  InstrumentMetadata,
  InstrumentType,
  QuoteSnapshot,
  Timeframe,
  makeGlobalInstrumentId,
} from '@trading/shared';
import {
  CandlePageResult,
  CandleQueryOptions,
  FeedHealth,
  IMarketDataProvider,
  InstrumentSearchOptions,
  InstrumentSearchResult,
} from './types.js';
import { validateSmartApiEnv, SmartApiEnvValidation } from '../config.js';
import { WebSocket } from 'ws';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface SmartAPIConfig {
  apiKey?: string;
  clientCode?: string;
  password?: string; // 4-digit numeric MPIN
  totpSecret?: string; // Base32 TOTP secret key
  clientPublicIp?: string;
}

export interface SessionData {
  jwtToken: string;
  refreshToken: string;
  feedToken: string;
  loginTime: number;
  expiresAt: number;
}

const DERIVATIVE_UNDERLYINGS = new Set([
  'NIFTY',
  'BANKNIFTY',
  'FINNIFTY',
  'MIDCPNIFTY',
  'SENSEX',
  'BANKEX',
]);

/**
 * Base32 decoder and RFC 6238 TOTP generator (zero external dependency).
 */
export function generateTOTP(base32Secret: string, timeMs: number = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = base32Secret.replace(/[\s-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const output: number[] = [];

  for (let i = 0; i < clean.length; i++) {
    const idx = alphabet.indexOf(clean[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  const key = Buffer.from(output);
  const counter = Math.floor(timeMs / 1000 / 30);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigInt64BE(BigInt(counter), 0);

  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const otp = binary % 1000000;
  return otp.toString().padStart(6, '0');
}

/**
 * Checks if current time is within Indian equity/derivatives market session (09:15 - 15:30 IST, Mon-Fri).
 */
export function isIndianMarketOpen(date: Date = new Date()): boolean {
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(date.getTime() + istOffsetMs);

  const day = istDate.getUTCDay();
  if (day === 0 || day === 6) return false;

  const hours = istDate.getUTCHours();
  const minutes = istDate.getUTCMinutes();
  const totalMinutes = hours * 60 + minutes;

  const openMinutes = 9 * 60 + 15; // 09:15 IST
  const closeMinutes = 15 * 60 + 30; // 15:30 IST

  return totalMinutes >= openMinutes && totalMinutes <= closeMinutes;
}

/**
 * Formats an epoch millisecond timestamp as YYYY-MM-DD in IST.
 */
export function formatISTDate(epochMs: number): string {
  const ist = new Date(epochMs + 5.5 * 3600000);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Parses DDMMMYYYY expiry (e.g. "23NOV2026") into epoch milliseconds timestamp.
 */
export function parseAngelExpiryDate(expiryStr: string): number {
  if (!expiryStr || expiryStr.length < 9) return 0;
  const day = parseInt(expiryStr.slice(0, 2), 10);
  const monthStr = expiryStr.slice(2, 5).toUpperCase();
  const year = parseInt(expiryStr.slice(5), 10);

  const months: Record<string, number> = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
  };
  const month = months[monthStr];
  if (month === undefined || isNaN(day) || isNaN(year)) return 0;

  // Expire at 15:30 IST on the expiry date (10:00 UTC)
  return Date.UTC(year, month, day, 10, 0, 0);
}

/**
 * Official Angel One per-request day limits by interval.
 */
export const ANGEL_MAX_DAYS_BY_TIMEFRAME: Record<Timeframe, number> = {
  '1m': 30,
  '3m': 60,
  '5m': 90,
  '15m': 180,
  '30m': 180,
  '1h': 365,
  '1D': 1800,
};

/**
 * Default initial window days loaded when a timeframe is selected without a range override.
 */
export const INITIAL_WINDOW_DAYS_BY_TIMEFRAME: Record<Timeframe, number> = {
  '1m': 7,
  '3m': 18,
  '5m': 35,
  '15m': 75,
  '30m': 120,
  '1h': 250,
  '1D': 1800,
};

export class SmartAPIAdapter implements IMarketDataProvider {
  public readonly providerId = 'SMARTAPI' as const;
  public readonly config: SmartAPIConfig;
  public readonly isConfigured: boolean;
  public readonly envValidation: SmartApiEnvValidation;

  private session: SessionData | null = null;
  private authError: string | null = null;
  private lastDataError: string | null = null;
  private lastSessionDateIST: string | null = null;
  private lastTickTimestamp: number = 0;
  private lastPacketReceivedAt: number = 0;
  private ws: WebSocket | null = null;
  private wsConnected: boolean = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts: number = 0;
  private pingInterval: NodeJS.Timeout | null = null;

  // Full indexed catalog from OpenAPIScripMaster.json
  private instrumentsMap: Map<string, InstrumentMetadata> = new Map();
  private defaultWatchlistIds: string[] = [];
  private tokenToGlobalId: Map<string, string> = new Map();
  private subscribedGlobalIds: Set<string> = new Set();
  private cachedQuotes: Map<string, QuoteSnapshot> = new Map();

  // Historical caches & deduplication
  private chunkCache: Map<string, Candle[]> = new Map();
  private mergedSeriesCache: Map<string, Candle[]> = new Map();
  private inFlightChunkRequests: Map<string, Promise<Candle[]>> = new Map();
  private lastRestCandleCallAt: number = 0;
  private restQueue: Promise<any> = Promise.resolve();

  // Available filterfacets
  private availableExpiriesByUnderlying: Map<string, string[]> = new Map();
  private topUnderlyings: string[] = [
    'NIFTY',
    'BANKNIFTY',
    'FINNIFTY',
    'MIDCPNIFTY',
    'SENSEX',
    'BANKEX',
    'RELIANCE',
    'TCS',
    'HDFCBANK',
    'INFY',
    'ICICIBANK',
    'SBIN',
    'TATAMOTORS',
    'ITC',
    'LT',
    'BHARTIARTL',
    'AXISBANK',
    'BAJFINANCE',
  ];

  private listeners: Map<string, Set<(quote: QuoteSnapshot) => void>> = new Map();
  private scripMasterCachePath: string;

  constructor(config: SmartAPIConfig = {}) {
    const baseDir =
      process.cwd().endsWith('packages/backend') || process.cwd().endsWith('packages\\backend')
        ? process.cwd()
        : path.resolve(process.cwd(), 'packages/backend');
    const dataDir = path.resolve(baseDir, 'data');
    if (!fs.existsSync(dataDir)) {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
      } catch {}
    }
    this.scripMasterCachePath = path.resolve(dataDir, 'scrip_master.json');

    this.config = {
      ...config,
      clientPublicIp: config.clientPublicIp || '45.115.52.180',
    };
    this.envValidation = validateSmartApiEnv(this.config);
    this.isConfigured = Boolean(
      this.config.apiKey &&
        this.config.clientCode &&
        this.config.password &&
        this.config.totpSecret
    );
  }

  public async init(): Promise<void> {
    if (!this.isConfigured) {
      if (this.envValidation.hasAnyCredential) {
        const missing = this.envValidation.missingVars.join(', ');
        this.authError = `Incomplete SmartAPI configuration in packages/backend/.env. Missing: ${missing}`;
        console.warn(`[SmartAPI] ${this.authError}`);
      } else {
        console.log('[SmartAPI] Notice: Credentials not fully configured in environment. Adapter remains idle.');
      }
      return;
    }

    if (this.envValidation.placeholderVars.length > 0) {
      this.lastDataError = `Placeholder credential detected in packages/backend/.env for: ${this.envValidation.placeholderVars.join(', ')}. Replace with your actual Angel One SmartAPI value.`;
      console.warn(`[SmartAPI] Warning: ${this.lastDataError}`);
    }

    try {
      console.log('[SmartAPI] Initializing authenticated session with registered IP:', this.config.clientPublicIp);
      await this.authenticateWithRetries(3);
      await this.loadAndResolveInstruments();
      await this.fetchBatchQuotes(this.defaultWatchlistIds);
      await this.connectWebSocket();
    } catch (err: any) {
      this.authError = err.message || 'Authentication failed';
      console.error('[SmartAPI] Initialization Error:', this.authError);
    }
  }

  public async authenticateWithRetries(maxRetries: number = 3): Promise<void> {
    let attempt = 0;
    while (attempt < maxRetries) {
      attempt++;
      try {
        await this.performLogin();
        this.authError = null;
        console.log(`[SmartAPI] Authentication successful on attempt ${attempt}. Session active.`);
        return;
      } catch (err: any) {
        console.warn(`[SmartAPI] Auth attempt ${attempt}/${maxRetries} failed: ${err.message}`);
        if (attempt >= maxRetries) {
          throw err;
        }
        const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 5000);
        await new Promise((res) => setTimeout(res, delay));
      }
    }
  }

  private async performLogin(): Promise<void> {
    if (!this.config.apiKey || !this.config.clientCode || !this.config.password || !this.config.totpSecret) {
      throw new Error('MISSING_CREDENTIALS: Required fields missing from configuration.');
    }

    const url = 'https://apiconnect.angelone.in/rest/auth/angelbroking/user/v1/loginByPassword';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-UserType': 'USER',
      'X-SourceID': 'WEB',
      'X-ClientLocalIP': '127.0.0.1',
      'X-ClientPublicIP': this.config.clientPublicIp || '45.115.52.180',
      'X-MACAddress': 'fe80::1',
      'X-PrivateKey': this.config.apiKey,
    };

    const windowOffsetsMs = [0, -30000, 30000];
    let lastErr = 'Unknown error';

    for (const offsetMs of windowOffsetsMs) {
      const totp = generateTOTP(this.config.totpSecret, Date.now() + offsetMs);
      const body = {
        clientcode: this.config.clientCode,
        password: this.config.password,
        totp,
      };

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      const data: any = await res.json().catch(() => null);

      if (res.ok && data && data.status === true && data.data?.jwtToken) {
        const rawJwt: string = data.data.jwtToken;
        const cleanJwt = rawJwt.startsWith('Bearer ') ? rawJwt.slice(7) : rawJwt;

        this.session = {
          jwtToken: cleanJwt,
          refreshToken: data.data.refreshToken || '',
          feedToken: data.data.feedToken || '',
          loginTime: Date.now(),
          expiresAt: Date.now() + 23 * 60 * 60 * 1000,
        };
        return;
      }

      const errCode = data?.errorcode || `HTTP_${res.status}`;
      const errMsg = data?.message || 'Unknown authentication error from Angel One';
      lastErr = `[${errCode}] ${errMsg}`;
      if (!errMsg.toLowerCase().includes('totp') && errCode !== 'AB1050') {
        break;
      }
    }

    throw new Error(lastErr);
  }

  public async refreshTokens(): Promise<boolean> {
    if (!this.session?.refreshToken || !this.config.apiKey) return false;
    try {
      const url = 'https://apiconnect.angelone.in/rest/auth/angelbroking/jwt/v1/generateTokens';
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-UserType': 'USER',
        'X-SourceID': 'WEB',
        'X-ClientLocalIP': '127.0.0.1',
        'X-ClientPublicIP': this.config.clientPublicIp || '45.115.52.180',
        'X-MACAddress': 'fe80::1',
        'X-PrivateKey': this.config.apiKey,
        Authorization: `Bearer ${this.session.jwtToken}`,
      };

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ refreshToken: this.session.refreshToken }),
      });

      const body: any = await res.json().catch(() => null);
      if (res.ok && body?.status === true && body?.data?.jwtToken) {
        this.session.jwtToken = body.data.jwtToken.startsWith('Bearer ')
          ? body.data.jwtToken.slice(7)
          : body.data.jwtToken;
        if (body.data.refreshToken) this.session.refreshToken = body.data.refreshToken;
        if (body.data.feedToken) this.session.feedToken = body.data.feedToken;
        this.session.expiresAt = Date.now() + 23 * 3600 * 1000;
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Indexes official Scrip Master across NSE/BSE Equities, Reference Indices, Active Futures, and Active Options.
   */
  public async loadAndResolveInstruments(): Promise<InstrumentMetadata[]> {
    let scripMaster: any[] = [];

    try {
      if (fs.existsSync(this.scripMasterCachePath)) {
        const stats = fs.statSync(this.scripMasterCachePath);
        const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 3600);
        if (ageHours < 24) {
          const raw = fs.readFileSync(this.scripMasterCachePath, 'utf8');
          scripMaster = JSON.parse(raw);
        }
      }
    } catch {
      console.warn('[SmartAPI] Local scrip master cache read failed, will fetch online.');
    }

    if (!scripMaster || scripMaster.length === 0) {
      try {
        console.log('[SmartAPI] Downloading official Angel One Scrip Master JSON...');
        const res = await fetch('https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json');
        if (res.ok) {
          scripMaster = await res.json();
          fs.writeFileSync(this.scripMasterCachePath, JSON.stringify(scripMaster), 'utf8');
          console.log(`[SmartAPI] Scrip Master downloaded and cached (${scripMaster.length} instruments).`);
        }
      } catch (err) {
        console.error('[SmartAPI] Failed to fetch Scrip Master:', err);
      }
    }

    if (!scripMaster || scripMaster.length === 0) {
      console.warn('[SmartAPI] No Scrip Master available, unable to resolve live contracts.');
      return [];
    }

    this.instrumentsMap.clear();
    this.tokenToGlobalId.clear();
    this.defaultWatchlistIds = [];
    this.availableExpiriesByUnderlying.clear();

    const nowMs = Date.now();
    const activeNiftyFutures: { meta: InstrumentMetadata; expiryTime: number }[] = [];
    const activeBankNiftyFutures: { meta: InstrumentMetadata; expiryTime: number }[] = [];
    const activeNiftyOptions: { meta: InstrumentMetadata; expiryTime: number }[] = [];
    const expirySetByUnderlying = new Map<string, Set<string>>();

    for (const item of scripMaster) {
      const exch = item.exch_seg as Exchange;
      if (exch !== 'NSE' && exch !== 'NFO' && exch !== 'BSE' && exch !== 'BFO') continue;

      const token = String(item.token || '').trim();
      const symbol = String(item.symbol || '').trim();
      if (!token || !symbol) continue;

      const rawTick = parseFloat(item.tick_size || '5.0');
      const tickSize = rawTick >= 1 ? Number((rawTick / 100).toFixed(2)) : rawTick || 0.05;
      const lotSize = Math.max(1, parseInt(item.lotsize || '1', 10));
      const instTypeRaw = String(item.instrumenttype || '');

      // 1. Reference Spot Indices (NSE & BSE)
      if (instTypeRaw === 'AMXIDX') {
        const underlyingName = String(item.name || symbol).toUpperCase();
        const hasDeriv =
          DERIVATIVE_UNDERLYINGS.has(underlyingName) ||
          symbol.toUpperCase().includes('NIFTY 50') ||
          symbol.toUpperCase().includes('NIFTY BANK') ||
          symbol.toUpperCase().includes('FIN SERVICE') ||
          symbol.toUpperCase().includes('MIDCAP') ||
          symbol.toUpperCase().includes('SENSEX') ||
          symbol.toUpperCase().includes('BANKEX');

        const meta: InstrumentMetadata = {
          globalId: makeGlobalInstrumentId(exch, symbol, token),
          provider: 'SMARTAPI',
          exchange: exch,
          token,
          symbol,
          name: `${symbol} (${exch} Reference Index${hasDeriv ? ' • F&O Available' : ' • Index Only'})`,
          instrumentType: 'INDEX_SPOT',
          isTradable: false,
          lotSize: 1,
          tickSize: 0.05,
          underlying: underlyingName,
          hasDerivatives: hasDeriv,
          isSimulatedFixture: false,
        };
        this.instrumentsMap.set(meta.globalId, meta);
        this.tokenToGlobalId.set(meta.token, meta.globalId);
        continue;
      }

      // 2. NSE & BSE Equities
      if ((exch === 'NSE' && symbol.endsWith('-EQ')) || (exch === 'BSE' && !instTypeRaw)) {
        const cleanName = String(item.name || symbol.replace(/-EQ$/, ''));
        const meta: InstrumentMetadata = {
          globalId: makeGlobalInstrumentId(exch, symbol, token),
          provider: 'SMARTAPI',
          exchange: exch,
          token,
          symbol,
          name: `${cleanName} (${exch} Equity)`,
          instrumentType: 'EQUITY_STOCK',
          isTradable: true,
          lotSize: 1,
          tickSize: tickSize > 0 ? tickSize : 0.05,
          underlying: cleanName.toUpperCase(),
          isSimulatedFixture: false,
        };
        this.instrumentsMap.set(meta.globalId, meta);
        if (exch === 'NSE') {
          this.tokenToGlobalId.set(meta.token, meta.globalId);
        }
        continue;
      }

      // 3. Active Futures (FUTIDX & FUTSTK on NFO / BFO)
      if (instTypeRaw === 'FUTIDX' || instTypeRaw === 'FUTSTK') {
        const expiryTime = parseAngelExpiryDate(item.expiry);
        if (expiryTime < nowMs) continue; // Skip expired contracts

        const underlying = String(item.name || '').toUpperCase();
        const meta: InstrumentMetadata = {
          globalId: makeGlobalInstrumentId(exch, symbol, token),
          provider: 'SMARTAPI',
          exchange: exch,
          token,
          symbol,
          name: `${underlying} Futures (${item.expiry})`,
          instrumentType: instTypeRaw as InstrumentType,
          isTradable: true,
          lotSize,
          tickSize: tickSize > 0 ? tickSize : 0.05,
          expiry: item.expiry,
          underlying,
          marginMultiplier: 0.05,
          isSimulatedFixture: false,
        };
        this.instrumentsMap.set(meta.globalId, meta);
        this.tokenToGlobalId.set(meta.token, meta.globalId);

        if (!expirySetByUnderlying.has(underlying)) {
          expirySetByUnderlying.set(underlying, new Set());
        }
        expirySetByUnderlying.get(underlying)!.add(item.expiry);

        if (exch === 'NFO' && underlying === 'NIFTY' && instTypeRaw === 'FUTIDX') {
          activeNiftyFutures.push({ meta, expiryTime });
        } else if (exch === 'NFO' && underlying === 'BANKNIFTY' && instTypeRaw === 'FUTIDX') {
          activeBankNiftyFutures.push({ meta, expiryTime });
        }
        continue;
      }

      // 4. Active Options (OPTIDX & OPTSTK on NFO / BFO)
      if (instTypeRaw === 'OPTIDX' || instTypeRaw === 'OPTSTK') {
        const expiryTime = parseAngelExpiryDate(item.expiry);
        if (expiryTime < nowMs) continue; // Skip expired contracts

        const underlying = String(item.name || '').toUpperCase();
        const rawStrike = parseFloat(item.strike || '0');
        const strikePrice = rawStrike > 0 ? Number((rawStrike / 100).toFixed(2)) : undefined;
        const optionType: 'CE' | 'PE' | undefined = symbol.endsWith('CE')
          ? 'CE'
          : symbol.endsWith('PE')
            ? 'PE'
            : undefined;

        const meta: InstrumentMetadata = {
          globalId: makeGlobalInstrumentId(exch, symbol, token),
          provider: 'SMARTAPI',
          exchange: exch,
          token,
          symbol,
          name: `${underlying} ${item.expiry} ${strikePrice ?? ''} ${optionType ?? ''}`.trim(),
          instrumentType: instTypeRaw as InstrumentType,
          isTradable: true,
          lotSize,
          tickSize: tickSize > 0 ? tickSize : 0.05,
          expiry: item.expiry,
          strikePrice,
          optionType,
          underlying,
          marginMultiplier: 0.05,
          isSimulatedFixture: false,
        };
        this.instrumentsMap.set(meta.globalId, meta);
        this.tokenToGlobalId.set(meta.token, meta.globalId);

        if (!expirySetByUnderlying.has(underlying)) {
          expirySetByUnderlying.set(underlying, new Set());
        }
        expirySetByUnderlying.get(underlying)!.add(item.expiry);

        if (exch === 'NFO' && underlying === 'NIFTY' && instTypeRaw === 'OPTIDX') {
          activeNiftyOptions.push({ meta, expiryTime });
        }
      }
    }

    for (const [und, set] of expirySetByUnderlying.entries()) {
      const sorted = Array.from(set).sort((a, b) => parseAngelExpiryDate(a) - parseAngelExpiryDate(b));
      this.availableExpiriesByUnderlying.set(und, sorted);
    }

    activeNiftyFutures.sort((a, b) => a.expiryTime - b.expiryTime);
    activeBankNiftyFutures.sort((a, b) => a.expiryTime - b.expiryTime);
    activeNiftyOptions.sort((a, b) => a.expiryTime - b.expiryTime);

    // Build curated default watchlist (Spot Indices + Active Futures + ATM Options + Top NSE Equities)
    const addDefault = (gid?: string) => {
      if (gid && this.instrumentsMap.has(gid) && !this.defaultWatchlistIds.includes(gid)) {
        this.defaultWatchlistIds.push(gid);
        this.subscribedGlobalIds.add(gid);
      }
    };

    // 1. NIFTY 50 & NIFTY BANK & FINNIFTY Spot Indices
    addDefault(this.tokenToGlobalId.get('99926000')); // Nifty 50
    addDefault(this.tokenToGlobalId.get('99926009')); // Nifty Bank
    addDefault(this.tokenToGlobalId.get('99926037')); // Nifty Fin Service

    // 2. Near-month & Next-month NIFTY & BANKNIFTY Futures
    if (activeNiftyFutures[0]) {
      const f = activeNiftyFutures[0].meta;
      addDefault(f.globalId);
      console.log(
        `[SmartAPI] Resolved Active Futures Contract: ${f.symbol} | Token: ${f.token} | Lot: ${f.lotSize} | Expiry: ${f.expiry}`
      );
    }
    if (activeNiftyFutures[1]) addDefault(activeNiftyFutures[1].meta.globalId);
    if (activeBankNiftyFutures[0]) addDefault(activeBankNiftyFutures[0].meta.globalId);

    // 3. Nearest expiry NIFTY 24000 CE & PE Options
    const nearestOptExpiry = activeNiftyOptions[0]?.meta.expiry;
    if (nearestOptExpiry) {
      const ce24000 = activeNiftyOptions.find(
        (o) => o.meta.expiry === nearestOptExpiry && o.meta.strikePrice === 24000 && o.meta.optionType === 'CE'
      );
      const pe24000 = activeNiftyOptions.find(
        (o) => o.meta.expiry === nearestOptExpiry && o.meta.strikePrice === 24000 && o.meta.optionType === 'PE'
      );
      if (ce24000) addDefault(ce24000.meta.globalId);
      if (pe24000) addDefault(pe24000.meta.globalId);
    }

    // 4. Top NSE Liquid Equities
    const topEqSymbols = ['RELIANCE-EQ', 'TCS-EQ', 'HDFCBANK-EQ', 'INFY-EQ', 'ICICIBANK-EQ', 'SBIN-EQ'];
    for (const sym of topEqSymbols) {
      for (const inst of this.instrumentsMap.values()) {
        if (inst.exchange === 'NSE' && inst.symbol === sym) {
          addDefault(inst.globalId);
          break;
        }
      }
    }

    return this.defaultWatchlistIds.map((id) => this.instrumentsMap.get(id)!).filter(Boolean);
  }

  public async getInstruments(): Promise<InstrumentMetadata[]> {
    if (this.instrumentsMap.size === 0) {
      await this.loadAndResolveInstruments();
    }
    return this.defaultWatchlistIds.map((id) => this.instrumentsMap.get(id)!).filter(Boolean);
  }

  public async getInstrumentById(globalId: string): Promise<InstrumentMetadata | undefined> {
    if (this.instrumentsMap.size === 0) {
      await this.loadAndResolveInstruments();
    }
    return this.instrumentsMap.get(globalId);
  }

  /**
   * Search and filter across all indexed NSE/BSE/NFO/BFO instruments from Scrip Master.
   */
  public async searchInstruments(opts: InstrumentSearchOptions = {}): Promise<InstrumentSearchResult> {
    if (this.instrumentsMap.size === 0) {
      await this.loadAndResolveInstruments();
    }

    const q = (opts.q || '').trim().toUpperCase();
    const exch = (opts.exchange || 'ALL').toUpperCase();
    const seg = (opts.segment || 'ALL').toUpperCase();
    const und = (opts.underlying || 'ALL').toUpperCase();
    const exp = (opts.expiry || 'ALL').toUpperCase();
    const optType = (opts.optionType || 'ALL').toUpperCase();
    const strike = opts.strike !== undefined && Number.isFinite(opts.strike) ? opts.strike : undefined;
    const page = Math.max(1, opts.page || 1);
    const limit = Math.min(100, Math.max(1, opts.limit || 25));

    const hasActiveFilter =
      q.length > 0 ||
      exch !== 'ALL' ||
      seg !== 'ALL' ||
      und !== 'ALL' ||
      exp !== 'ALL' ||
      optType !== 'ALL' ||
      strike !== undefined;

    let pool: InstrumentMetadata[];
    if (!hasActiveFilter) {
      pool = this.defaultWatchlistIds.map((id) => this.instrumentsMap.get(id)!).filter(Boolean);
    } else {
      pool = [];
      for (const inst of this.instrumentsMap.values()) {
        if (exch !== 'ALL' && inst.exchange !== exch) continue;
        if (seg !== 'ALL' && inst.instrumentType !== seg) continue;
        if (und !== 'ALL' && (inst.underlying || '').toUpperCase() !== und) continue;
        if (exp !== 'ALL' && (inst.expiry || '').toUpperCase() !== exp) continue;
        if (optType !== 'ALL' && inst.optionType !== optType) continue;
        if (strike !== undefined && inst.strikePrice !== strike) continue;

        if (q.length > 0) {
          const symUpper = inst.symbol.toUpperCase();
          const nameUpper = inst.name.toUpperCase();
          const undUpper = (inst.underlying || '').toUpperCase();
          const strikeStr = inst.strikePrice ? String(inst.strikePrice) : '';
          if (
            !symUpper.includes(q) &&
            !nameUpper.includes(q) &&
            !undUpper.includes(q) &&
            !strikeStr.includes(q)
          ) {
            continue;
          }
        }
        pool.push(inst);
      }

      // Rank results so exact/prefix matches, indices, futures, and NSE equities appear first
      pool.sort((a, b) => {
        const rankType = (t: InstrumentType) => {
          if (t === 'INDEX_SPOT') return 1;
          if (t === 'FUTIDX') return 2;
          if (t === 'EQUITY_STOCK') return 3;
          if (t === 'FUTSTK') return 4;
          if (t === 'OPTIDX') return 5;
          return 6;
        };
        if (q.length > 0) {
          const aExact = a.symbol.toUpperCase() === q || a.symbol.toUpperCase() === `${q}-EQ` ? 0 : 1;
          const bExact = b.symbol.toUpperCase() === q || b.symbol.toUpperCase() === `${q}-EQ` ? 0 : 1;
          if (aExact !== bExact) return aExact - bExact;

          const aStarts = a.symbol.toUpperCase().startsWith(q) ? 0 : 1;
          const bStarts = b.symbol.toUpperCase().startsWith(q) ? 0 : 1;
          if (aStarts !== bStarts) return aStarts - bStarts;
        }
        const rtA = rankType(a.instrumentType);
        const rtB = rankType(b.instrumentType);
        if (rtA !== rtB) return rtA - rtB;
        if (a.expiry && b.expiry && a.expiry !== b.expiry) {
          return parseAngelExpiryDate(a.expiry) - parseAngelExpiryDate(b.expiry);
        }
        if (a.strikePrice !== undefined && b.strikePrice !== undefined) {
          return a.strikePrice - b.strikePrice;
        }
        return a.symbol.localeCompare(b.symbol);
      });
    }

    const totalCount = pool.length;
    const startIdx = (page - 1) * limit;
    const sliced = pool.slice(startIdx, startIdx + limit);

    // Hydrate quotes for visible slice if missing
    const missingQuotes = sliced
      .map((i) => i.globalId)
      .filter((gid) => !this.cachedQuotes.has(gid));
    if (missingQuotes.length > 0 && this.session?.jwtToken) {
      await this.fetchBatchQuotes(missingQuotes.slice(0, 25));
    }

    const expiriesForSelectedUnd =
      und !== 'ALL' && this.availableExpiriesByUnderlying.has(und)
        ? this.availableExpiriesByUnderlying.get(und)!
        : this.availableExpiriesByUnderlying.get('NIFTY') || [];

    return {
      instruments: sliced,
      totalCount,
      page,
      limit,
      availableFilters: {
        exchanges: ['ALL', 'NSE', 'NFO', 'BSE', 'BFO'],
        segments: ['ALL', 'INDEX_SPOT', 'EQUITY_STOCK', 'FUTIDX', 'OPTIDX', 'FUTSTK', 'OPTSTK'],
        underlyings: ['ALL', ...this.topUnderlyings],
        expiries: ['ALL', ...expiriesForSelectedUnd.slice(0, 12)],
      },
    };
  }

  /**
   * Batch fetches authoritative FULL quotes (LTP, Open, High, Low, Close/PrevClose, Volume, Depth)
   * from Angel One REST Market Quote API for up to 50 tokens at a time.
   */
  public async fetchBatchQuotes(globalIds: string[]): Promise<void> {
    if (!this.session?.jwtToken || !this.config.apiKey || globalIds.length === 0) return;

    const exchangeTokens: Record<string, string[]> = {};
    for (const gid of globalIds) {
      const inst = this.instrumentsMap.get(gid);
      if (!inst) continue;
      if (!exchangeTokens[inst.exchange]) exchangeTokens[inst.exchange] = [];
      if (exchangeTokens[inst.exchange].length < 45 && !exchangeTokens[inst.exchange].includes(inst.token)) {
        exchangeTokens[inst.exchange].push(inst.token);
      }
      this.tokenToGlobalId.set(inst.token, inst.globalId);
    }

    if (Object.keys(exchangeTokens).length === 0) return;

    try {
      const url = 'https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/';
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-UserType': 'USER',
        'X-SourceID': 'WEB',
        'X-ClientLocalIP': '127.0.0.1',
        'X-ClientPublicIP': this.config.clientPublicIp || '45.115.52.180',
        'X-MACAddress': 'fe80::1',
        'X-PrivateKey': this.config.apiKey,
        Authorization: `Bearer ${this.session.jwtToken}`,
      };

      await new Promise<void>((resolve) => {
        this.restQueue = this.restQueue.then(async () => {
          const elapsed = Date.now() - this.lastRestCandleCallAt;
          if (elapsed < 350) {
            await new Promise((r) => setTimeout(r, 350 - elapsed));
          }
          this.lastRestCandleCallAt = Date.now();
          resolve();
        });
      });

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ mode: 'FULL', exchangeTokens }),
      });

      const body: any = await res.json().catch(() => null);
      if (res.ok && body?.status === true && Array.isArray(body?.data?.fetched)) {
        const now = Date.now();
        for (const item of body.data.fetched) {
          const token = String(item.symbolToken || '');
          const gid = this.tokenToGlobalId.get(token);
          if (!gid) continue;
          const inst = this.instrumentsMap.get(gid);
          const tickSize = inst?.tickSize || 0.05;
          const ltp = Number(item.ltp || 0);
          if (ltp <= 0) continue;

          const bestBuy = item.depth?.buy?.[0]?.price;
          const bestSell = item.depth?.sell?.[0]?.price;
          const bidPrice =
            typeof bestBuy === 'number' && bestBuy > 0
              ? bestBuy
              : Number((ltp - tickSize).toFixed(2));
          const askPrice =
            typeof bestSell === 'number' && bestSell > 0
              ? bestSell
              : Number((ltp + tickSize).toFixed(2));

          const quote: QuoteSnapshot = {
            globalId: gid,
            token,
            ltp,
            open: Number(item.open || ltp),
            high: Number(item.high || ltp),
            low: Number(item.low || ltp),
            close: Number(item.close || ltp), // Official previous session close
            bidPrice,
            askPrice,
            volume: Number(item.tradeVolume || 0),
            openInterest: Number(item.opnInterest || 0),
            providerTimestamp: now,
            receiveTimestamp: now,
            source: 'SMARTAPI',
            isSimulated: false,
          };
          this.cachedQuotes.set(gid, quote);
        }
      }
    } catch (err: any) {
      console.warn('[SmartAPI] Batch quote fetch warning:', err.message);
    }
  }

  /**
   * Ensures an instrument is actively subscribed on SmartStream WebSocket (bounded to 100 active tokens).
   */
  public ensureSubscribed(globalId: string): void {
    const inst =
      this.instrumentsMap.get(globalId) ||
      this.instrumentsMap.get(globalId.toUpperCase()) ||
      this.instrumentsMap.get(this.tokenToGlobalId.get(globalId.split(':').pop() || '') || '');
    if (!inst) return;
    this.tokenToGlobalId.set(inst.token, inst.globalId);
    if (this.subscribedGlobalIds.has(globalId)) return;

    if (this.subscribedGlobalIds.size >= 100) {
      // Evict oldest non-default subscription
      for (const existing of this.subscribedGlobalIds) {
        if (!this.defaultWatchlistIds.includes(existing)) {
          this.subscribedGlobalIds.delete(existing);
          break;
        }
      }
    }
    this.subscribedGlobalIds.add(globalId);

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const exchTypeMap: Record<string, number> = { NSE: 1, NFO: 2, BSE: 3, BFO: 4, MCX: 5 };
      const exchangeType = exchTypeMap[inst.exchange] || 1;
      const subMsg = {
        correlationID: `tz_sub_${Date.now()}`,
        action: 1,
        params: {
          mode: 2,
          tokenList: [{ exchangeType, tokens: [inst.token] }],
        },
      };
      try {
        this.ws.send(JSON.stringify(subMsg));
      } catch {}
    }
  }

  /**
   * Rate-limited upstream historical chunk fetch with in-flight deduplication and caching.
   */
  private async fetchRawCandleChunk(
    inst: InstrumentMetadata,
    timeframe: Timeframe,
    fromMs: number,
    toMs: number
  ): Promise<Candle[]> {
    const intervalMap: Record<Timeframe, string> = {
      '1m': 'ONE_MINUTE',
      '3m': 'THREE_MINUTE',
      '5m': 'FIVE_MINUTE',
      '15m': 'FIFTEEN_MINUTE',
      '30m': 'THIRTY_MINUTE',
      '1h': 'ONE_HOUR',
      '1D': 'ONE_DAY',
    };
    const interval = intervalMap[timeframe] || 'FIVE_MINUTE';

    const formatAngelDate = (ms: number) => {
      const ist = new Date(ms + 5.5 * 3600000);
      const y = ist.getUTCFullYear();
      const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
      const day = String(ist.getUTCDate()).padStart(2, '0');
      const h = String(ist.getUTCHours()).padStart(2, '0');
      const min = String(ist.getUTCMinutes()).padStart(2, '0');
      return `${y}-${m}-${day} ${h}:${min}`;
    };

    const fromStr = formatAngelDate(fromMs);
    const toStr = formatAngelDate(toMs);
    const chunkKey = `SMARTAPI:${inst.exchange}:${inst.globalId}:${timeframe}:${fromStr.slice(0, 10)}:${toStr.slice(0, 10)}`;

    // Return cached chunk if it is a historical window not ending today, or if market is closed
    if (this.chunkCache.has(chunkKey)) {
      const cached = this.chunkCache.get(chunkKey)!;
      const isRecentEnd = Date.now() - toMs < 86400000;
      if (!isRecentEnd || !isIndianMarketOpen()) {
        return cached;
      }
    }

    if (this.inFlightChunkRequests.has(chunkKey)) {
      return this.inFlightChunkRequests.get(chunkKey)!;
    }

    const requestPromise = (async (): Promise<Candle[]> => {
      const url = 'https://apiconnect.angelone.in/rest/secure/angelbroking/historical/v1/getCandleData';
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-UserType': 'USER',
        'X-SourceID': 'WEB',
        'X-ClientLocalIP': '127.0.0.1',
        'X-ClientPublicIP': this.config.clientPublicIp || '45.115.52.180',
        'X-MACAddress': 'fe80::1',
        'X-PrivateKey': this.config.apiKey || '',
        Authorization: `Bearer ${this.session?.jwtToken || ''}`,
      };

      const payload = {
        exchange: inst.exchange,
        symboltoken: inst.token,
        interval,
        fromdate: fromStr,
        todate: toStr,
      };

      for (let attempt = 1; attempt <= 3; attempt++) {
        // Serialize through rate-limit queue (min 550ms between upstream REST calls)
        await new Promise<void>((resolve) => {
          this.restQueue = this.restQueue.then(async () => {
            const elapsed = Date.now() - this.lastRestCandleCallAt;
            const minGap = attempt > 1 ? 1200 : 550;
            if (elapsed < minGap) {
              await new Promise((r) => setTimeout(r, minGap - elapsed));
            }
            this.lastRestCandleCallAt = Date.now();
            resolve();
          });
        });

        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        });

        const data: any = await res.json().catch(() => null);
        if (res.ok && data?.status === true) {
          this.lastDataError = null;
          if (!Array.isArray(data.data) || data.data.length === 0) {
            return [];
          }
          const parsed: Candle[] = data.data.map((row: any[]) => {
            let ts = String(row[0]);
            if (!ts.includes('T')) {
              ts = ts.replace(' ', 'T') + '+05:30';
            }
            const epochSec = Math.floor(new Date(ts).getTime() / 1000);
            return {
              time: epochSec,
              open: parseFloat(row[1]),
              high: parseFloat(row[2]),
              low: parseFloat(row[3]),
              close: parseFloat(row[4]),
              volume: parseInt(row[5] || '0', 10),
            };
          });

          const sorted = parsed
            .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.close))
            .sort((a, b) => a.time - b.time)
            .filter((c, idx, arr) => idx === 0 || c.time > arr[idx - 1].time);

          if (sorted.length > 0) {
            this.chunkCache.set(chunkKey, sorted);
          }
          return sorted;
        }

        const errCode = data?.errorCode || data?.errorcode || `HTTP_${res.status}`;
        if ((res.status === 403 || res.status === 429 || errCode === 'AB2001') && attempt < 3) {
          continue; // Transient rate-limit; back off and retry
        }

        const errMsg = data?.message || 'Historical candle request rejected by Angel One';
        if (errCode === 'AG8004') {
          this.lastDataError = `SmartAPI getCandleData rejected [${errCode}]: ${errMsg}`;
        }
        console.warn(`[SmartAPI] getCandleData notice [${errCode}]: ${errMsg}`);
        return [];
      }
      return [];
    })();

    this.inFlightChunkRequests.set(chunkKey, requestPromise);
    try {
      return await requestPromise;
    } finally {
      this.inFlightChunkRequests.delete(chunkKey);
    }
  }

  /**
   * Paginated, range-aware historical candle loader with automatic deduplication, merging,
   * and previous-session close resolution.
   */
  public async getCandlesPaginated(
    globalId: string,
    timeframe: Timeframe,
    opts: CandleQueryOptions = {}
  ): Promise<CandlePageResult> {
    if (this.instrumentsMap.size === 0) {
      await this.loadAndResolveInstruments();
    }
    const inst =
      this.instrumentsMap.get(globalId) ||
      this.instrumentsMap.get(globalId.toUpperCase()) ||
      this.instrumentsMap.get(this.tokenToGlobalId.get(globalId.split(':').pop() || '') || '');
    if (!inst || !this.session?.jwtToken || !this.config.apiKey) {
      return {
        candles: [],
        hasMore: false,
        earliestTime: null,
        latestTime: null,
        sessionDateIST: this.lastSessionDateIST,
        prevSessionClose: null,
        providerError: this.lastDataError || this.authError || 'Instrument or session unavailable',
      };
    }

    this.ensureSubscribed(globalId);
    if (!this.cachedQuotes.has(globalId)) {
      await this.fetchBatchQuotes([globalId]);
    }

    const seriesKey = `${globalId}:${timeframe}`;
    const maxChunkDays = ANGEL_MAX_DAYS_BY_TIMEFRAME[timeframe] || 90;
    const defaultDays = INITIAL_WINDOW_DAYS_BY_TIMEFRAME[timeframe] || 35;

    try {
      let fetchedCandles: Candle[] = [];
      let hasMore = true;

      if (opts.before && opts.before > 0) {
        // Left-scroll pagination: fetch window strictly before `opts.before`
        let toMs = opts.before * 1000 - 1000;
        const stepDays = Math.min(maxChunkDays, defaultDays);
        const minValidEpochMs =
          inst.instrumentType === 'FUTIDX' ||
          inst.instrumentType === 'OPTIDX' ||
          inst.instrumentType === 'FUTSTK' ||
          inst.instrumentType === 'OPTSTK'
            ? Date.UTC(2024, 0, 1)
            : Date.UTC(2000, 0, 1);

        // Try up to 2 backward steps in case the first window lands on a holiday gap
        let attempts = 0;
        while (attempts < 2 && fetchedCandles.length === 0 && toMs > minValidEpochMs) {
          attempts++;
          const fromMs = Math.max(minValidEpochMs, toMs - stepDays * 86400000);
          const chunk = await this.fetchRawCandleChunk(inst, timeframe, fromMs, toMs);
          const strictlyOlder = chunk.filter((c) => c.time < opts.before!);
          if (strictlyOlder.length > 0) {
            fetchedCandles = strictlyOlder;
            hasMore = fromMs > minValidEpochMs;
            break;
          }
          toMs = fromMs - 1000;
        }

        if (fetchedCandles.length === 0) {
          hasMore = false;
        }
      } else if (opts.range === 'ALL' && timeframe === '1D') {
        // Full available daily history overview ("All"): fetch up to 4 x 1800-day chunks (~20 years)
        let cursorToMs = Date.now();
        const minEpochMs =
          inst.instrumentType === 'FUTIDX' ||
          inst.instrumentType === 'OPTIDX' ||
          inst.instrumentType === 'FUTSTK' ||
          inst.instrumentType === 'OPTSTK'
            ? Date.UTC(2024, 0, 1)
            : Date.UTC(2000, 0, 1);

        const allChunks: Candle[] = [];
        for (let i = 0; i < 4 && cursorToMs > minEpochMs; i++) {
          const fromMs = Math.max(minEpochMs, cursorToMs - 1800 * 86400000);
          const chunk = await this.fetchRawCandleChunk(inst, '1D', fromMs, cursorToMs);
          if (chunk.length === 0) break;
          allChunks.push(...chunk);
          cursorToMs = chunk[0].time * 1000 - 86400000;
        }
        fetchedCandles = this.deduplicateAndSort(allChunks);
        hasMore = false; // Full daily history loaded
      } else {
        // Initial load or range load (1D, 5D, 1M, 3M, 6M, 1Y)
        const rangeDaysMap: Record<ChartRange, number> = {
          '1D': 5, // Load 5 calendar days so previous session + current session are always present
          '5D': 12,
          '1M': 35,
          '3M': 95,
          '6M': 185,
          '1Y': 370,
          ALL: maxChunkDays,
        };
        const requestedDays = opts.range ? rangeDaysMap[opts.range] || defaultDays : defaultDays;
        const windowDays = Math.min(maxChunkDays, requestedDays);
        const toMs = opts.to ? opts.to * 1000 : Date.now();
        const fromMs = opts.from ? opts.from * 1000 : toMs - windowDays * 86400000;

        fetchedCandles = await this.fetchRawCandleChunk(inst, timeframe, fromMs, toMs);
        hasMore = fetchedCandles.length > 0;
      }

      // Merge into bounded series cache (max 8000 candles per instrument:timeframe)
      if (fetchedCandles.length > 0) {
        const existing = this.mergedSeriesCache.get(seriesKey) || [];
        const merged = this.deduplicateAndSort([...existing, ...fetchedCandles]);
        const bounded = merged.length > 8000 ? merged.slice(-8000) : merged;
        this.mergedSeriesCache.set(seriesKey, bounded);

        const lastCandleMs = bounded[bounded.length - 1].time * 1000;
        this.lastSessionDateIST = formatISTDate(lastCandleMs);
      }

      const outputCandles =
        opts.limit && opts.limit > 0 && fetchedCandles.length > opts.limit
          ? fetchedCandles.slice(-opts.limit)
          : fetchedCandles;

      const fullSeries = this.mergedSeriesCache.get(seriesKey) || outputCandles;
      const latestSessionIST =
        fullSeries.length > 0
          ? formatISTDate(fullSeries[fullSeries.length - 1].time * 1000)
          : this.lastSessionDateIST;

      // Resolve accurate previous-session close (never first candle in window!)
      let prevSessionClose: number | null = null;
      const quote = this.cachedQuotes.get(globalId);
      if (quote && quote.close > 0) {
        prevSessionClose = quote.close;
      } else if (fullSeries.length > 1 && latestSessionIST) {
        for (let i = fullSeries.length - 1; i >= 0; i--) {
          const barDateIST = formatISTDate(fullSeries[i].time * 1000);
          if (barDateIST < latestSessionIST) {
            prevSessionClose = fullSeries[i].close;
            break;
          }
        }
      }

      return {
        candles: outputCandles,
        hasMore,
        earliestTime: outputCandles.length > 0 ? outputCandles[0].time : null,
        latestTime: outputCandles.length > 0 ? outputCandles[outputCandles.length - 1].time : null,
        sessionDateIST: latestSessionIST,
        prevSessionClose,
        providerError: this.lastDataError,
      };
    } catch (err: any) {
      this.lastDataError = `Failed to fetch historical candles: ${err.message}`;
      return {
        candles: [],
        hasMore: false,
        earliestTime: null,
        latestTime: null,
        sessionDateIST: this.lastSessionDateIST,
        prevSessionClose: null,
        providerError: this.lastDataError,
      };
    }
  }

  private deduplicateAndSort(candles: Candle[]): Candle[] {
    return candles
      .filter((c) => Number.isFinite(c.time) && Number.isFinite(c.close))
      .sort((a, b) => a.time - b.time)
      .filter((c, idx, arr) => idx === 0 || c.time > arr[idx - 1].time);
  }

  public async getCandles(globalId: string, timeframe: Timeframe, count?: number): Promise<Candle[]> {
    const res = await this.getCandlesPaginated(globalId, timeframe, { limit: count });
    return res.candles;
  }

  public async getQuote(globalId: string): Promise<QuoteSnapshot | null> {
    if (!this.cachedQuotes.has(globalId) && this.session?.jwtToken) {
      await this.fetchBatchQuotes([globalId]);
    }
    return this.cachedQuotes.get(globalId) || null;
  }

  public getLastSessionDateIST(): string | null {
    return this.lastSessionDateIST;
  }

  public getLastDataError(): string | null {
    return this.lastDataError || this.authError;
  }

  public subscribe(globalId: string, listener: (quote: QuoteSnapshot) => void): () => void {
    if (!this.listeners.has(globalId)) {
      this.listeners.set(globalId, new Set());
    }
    this.listeners.get(globalId)!.add(listener);
    this.ensureSubscribed(globalId);

    const cached = this.cachedQuotes.get(globalId);
    if (cached) {
      try {
        listener(cached);
      } catch {}
    }

    return () => {
      this.listeners.get(globalId)?.delete(listener);
    };
  }

  public async connectWebSocket(): Promise<void> {
    if (!this.session?.jwtToken || !this.session?.feedToken || !this.config.apiKey || !this.config.clientCode) {
      console.warn('[SmartAPI] WebSocket connection deferred: Active session tokens missing.');
      return;
    }

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const wsUrl = 'wss://smartapisocket.angelone.in/smart-stream';
    console.log('[SmartAPI] Connecting to SmartStream WebSocket 2.0...');

    try {
      this.ws = new WebSocket(wsUrl, {
        headers: {
          Authorization: this.session.jwtToken,
          'x-api-key': this.config.apiKey,
          'x-client-code': this.config.clientCode,
          'x-feed-token': this.session.feedToken,
        },
      });

      this.ws.on('open', () => {
        this.wsConnected = true;
        this.reconnectAttempts = 0;
        console.log('[SmartAPI] SmartStream WebSocket 2.0 connected.');
        this.sendSubscriptions();
        this.startHeartbeat();
      });

      this.ws.on('message', (data: Buffer | string) => {
        this.handleWebSocketMessage(data);
      });

      this.ws.on('error', (err) => {
        console.warn('[SmartAPI] WebSocket Error:', err.message);
      });

      this.ws.on('close', (code, reason) => {
        this.wsConnected = false;
        this.stopHeartbeat();
        console.warn(`[SmartAPI] WebSocket Closed (Code: ${code}, Reason: ${reason.toString() || 'none'}). Scheduling reconnect...`);
        this.scheduleReconnect();
      });
    } catch (err: any) {
      console.error('[SmartAPI] WebSocket connection initiation failed:', err.message);
      this.scheduleReconnect();
    }
  }

  private sendSubscriptions(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const byExchType: Record<number, string[]> = {};
    const exchTypeMap: Record<string, number> = { NSE: 1, NFO: 2, BSE: 3, BFO: 4, MCX: 5 };

    for (const gid of this.subscribedGlobalIds) {
      const inst = this.instrumentsMap.get(gid);
      if (!inst) continue;
      const et = exchTypeMap[inst.exchange] || 1;
      if (!byExchType[et]) byExchType[et] = [];
      byExchType[et].push(inst.token);
    }

    const tokenList = Object.entries(byExchType).map(([et, tokens]) => ({
      exchangeType: Number(et),
      tokens,
    }));

    if (tokenList.length === 0) return;

    const subMsg = {
      correlationID: `tradingzone_sub_${Date.now()}`,
      action: 1,
      params: {
        mode: 2,
        tokenList,
      },
    };

    this.ws.send(JSON.stringify(subMsg));
    console.log('[SmartAPI] Subscribed to active instruments (Mode 2 Quote):', tokenList.map(t => `${t.exchangeType}:${t.tokens.length}`));
  }

  private handleWebSocketMessage(raw: Buffer | string): void {
    if (typeof raw === 'string') return;

    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (buf.length < 51) return;

    try {
      const subscriptionMode = buf.readUInt8(0);
      if (subscriptionMode < 1 || subscriptionMode > 4) return;

      const token = buf.toString('ascii', 2, 27).replace(/\0/g, '').trim();
      const exchangeTimestamp = Number(buf.readBigInt64LE(35));
      const ltpPaise = Number(buf.readBigInt64LE(43));
      const ltpRupees = ltpPaise / 100;
      if (!Number.isFinite(ltpRupees) || ltpRupees <= 0) return;

      let openRupees = ltpRupees;
      let highRupees = ltpRupees;
      let lowRupees = ltpRupees;
      let closeRupees = ltpRupees;
      let volume = 0;

      if (subscriptionMode >= 2 && buf.length >= 123) {
        const volRaw = Number(buf.readBigInt64LE(67));
        const openRaw = Number(buf.readBigInt64LE(91)) / 100;
        const highRaw = Number(buf.readBigInt64LE(99)) / 100;
        const lowRaw = Number(buf.readBigInt64LE(107)) / 100;
        const closeRaw = Number(buf.readBigInt64LE(115)) / 100;

        if (volRaw >= 0) volume = volRaw;
        if (openRaw > 0) openRupees = openRaw;
        if (highRaw > 0) highRupees = highRaw;
        if (lowRaw > 0) lowRupees = lowRaw;
        if (closeRaw > 0) closeRupees = closeRaw;
      }

      const now = Date.now();
      this.lastPacketReceivedAt = now;
      const marketOpen = isIndianMarketOpen();
      if (marketOpen) {
        this.lastTickTimestamp = now;
      }

      const globalId = this.tokenToGlobalId.get(token);
      if (!globalId) return;

      const inst =
      this.instrumentsMap.get(globalId) ||
      this.instrumentsMap.get(globalId.toUpperCase()) ||
      this.instrumentsMap.get(this.tokenToGlobalId.get(globalId.split(':').pop() || '') || '');
      const tickSize = inst?.tickSize || 0.05;

      const quote: QuoteSnapshot = {
        globalId,
        token,
        ltp: ltpRupees,
        open: openRupees,
        high: highRupees,
        low: lowRupees,
        close: closeRupees,
        bidPrice: Number((ltpRupees - tickSize).toFixed(2)),
        askPrice: Number((ltpRupees + tickSize).toFixed(2)),
        volume,
        providerTimestamp: exchangeTimestamp > 0 ? exchangeTimestamp : now,
        receiveTimestamp: now,
        source: 'SMARTAPI',
        isSimulated: false,
      };

      this.cachedQuotes.set(globalId, quote);

      if (marketOpen) {
        const listeners = this.listeners.get(globalId);
        if (listeners) {
          for (const fn of listeners) {
            try {
              fn(quote);
            } catch {}
          }
        }
      }
    } catch {
      // Ignore malformed binary frames
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000);
  }

  private stopHeartbeat(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectAttempts++;
    const backoff = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts) + Math.random() * 1000, 30000);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.session && Date.now() > this.session.expiresAt) {
        await this.refreshTokens();
      }
      await this.connectWebSocket();
    }, backoff);
  }

  public getFeedHealth(): FeedHealth {
    if (!this.isConfigured) {
      return {
        source: 'SMARTAPI',
        status: 'NOT_LIVE_VERIFIED',
        latencyMs: 0,
        lastTickTimestamp: 0,
        isSimulated: false,
        activeSubscriptionsCount: 0,
        uiBannerLabel: 'SMARTAPI — CREDENTIALS NOT CONFIGURED IN .ENV',
        message:
          this.authError ||
          'SmartAPI credentials missing. Fill in packages/backend/.env to activate live market data for private development.',
      };
    }

    if (this.authError) {
      return {
        source: 'SMARTAPI',
        status: 'DISCONNECTED',
        latencyMs: 0,
        lastTickTimestamp: 0,
        isSimulated: false,
        activeSubscriptionsCount: 0,
        uiBannerLabel: 'SMARTAPI — AUTHENTICATION ERROR',
        message: `SmartAPI Authentication Failed: ${this.authError}`,
      };
    }

    if (this.lastDataError) {
      return {
        source: 'SMARTAPI',
        status: 'DISCONNECTED',
        latencyMs: 0,
        lastTickTimestamp: this.lastTickTimestamp,
        isSimulated: false,
        activeSubscriptionsCount: this.subscribedGlobalIds.size,
        uiBannerLabel: 'SMARTAPI — CANDLE API ERROR (CHECK SMARTAPI_API_KEY)',
        message: this.lastDataError,
      };
    }

    const marketOpen = isIndianMarketOpen();
    const now = Date.now();
    const isStale = this.lastTickTimestamp > 0 && now - this.lastTickTimestamp > 15000;

    let status: 'LIVE' | 'STALE' | 'DISCONNECTED' = 'DISCONNECTED';
    let banner = 'SMARTAPI — CONNECTING';

    if (this.session) {
      if (marketOpen) {
        if (this.wsConnected) {
          status = isStale ? 'STALE' : 'LIVE';
          banner = isStale ? 'SMARTAPI — STALE DATA (MARKET OPEN)' : 'SMARTAPI — LIVE MARKET OPEN';
        } else {
          status = 'DISCONNECTED';
          banner = 'SMARTAPI — WEBSOCKET CONNECTING';
        }
      } else {
        status = 'LIVE';
        const sessionLabel = this.lastSessionDateIST ? ` (SESSION ${this.lastSessionDateIST})` : '';
        banner = `SMARTAPI — MARKET CLOSED — LAST AVAILABLE DATA${sessionLabel}`;
      }
    }

    return {
      source: 'SMARTAPI',
      status,
      latencyMs: this.lastTickTimestamp > 0 ? Math.max(1, now - this.lastTickTimestamp) : 0,
      lastTickTimestamp: this.lastTickTimestamp,
      isSimulated: false,
      activeSubscriptionsCount: this.subscribedGlobalIds.size,
      uiBannerLabel: banner,
      message: marketOpen
        ? 'Connected to Angel One SmartStream live feed.'
        : `Market closed — last available data (NSE/NFO hours: 09:15 to 15:30 IST).${
            this.lastSessionDateIST ? ` Latest session date: ${this.lastSessionDateIST}.` : ''
          } WebSocket connected: ${this.wsConnected} (Last snapshot received: ${
            this.lastPacketReceivedAt > 0 ? new Date(this.lastPacketReceivedAt).toISOString() : 'none'
          }).`,
    };
  }

  public async dispose(): Promise<void> {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.session = null;
  }
}
