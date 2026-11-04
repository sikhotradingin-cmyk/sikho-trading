import { Candle, InstrumentMetadata, QuoteSnapshot, Timeframe, makeGlobalInstrumentId } from '@trading/shared';
import { FeedHealth, IMarketDataProvider } from './types.js';
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
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  const key = Buffer.from(output);
  const epochSec = Math.floor(timeMs / 1000);
  const counter = Math.floor(epochSec / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return (binary % 1000000).toString().padStart(6, '0');
}

/**
 * Determines whether the Indian Equities / Derivatives market (NSE/NFO) is currently open.
 * Trading hours: Monday to Friday, 09:15 to 15:30 IST (UTC + 05:30).
 */
export function isIndianMarketOpen(date: Date = new Date()): boolean {
  // Convert to IST
  const utc = date.getTime() + date.getTimezoneOffset() * 60000;
  const istDate = new Date(utc + 5.5 * 3600000);
  const day = istDate.getDay(); // 0 is Sun, 6 is Sat
  if (day === 0 || day === 6) return false;

  const hours = istDate.getHours();
  const minutes = istDate.getMinutes();
  const totalMinutes = hours * 60 + minutes;

  const openMinutes = 9 * 60 + 15; // 09:15 IST
  const closeMinutes = 15 * 60 + 30; // 15:30 IST

  return totalMinutes >= openMinutes && totalMinutes <= closeMinutes;
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
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11
  };
  const month = months[monthStr];
  if (month === undefined || isNaN(day) || isNaN(year)) return 0;

  // Expire at 15:30 IST on the expiry date
  return Date.UTC(year, month, day, 10, 0, 0); // 15:30 IST is 10:00 UTC
}

export class SmartAPIAdapter implements IMarketDataProvider {
  public readonly providerId = 'SMARTAPI' as const;
  public readonly config: SmartAPIConfig;
  public readonly isConfigured: boolean;

  private session: SessionData | null = null;
  private authError: string | null = null;
  private lastTickTimestamp: number = 0;
  private ws: WebSocket | null = null;
  private wsConnected: boolean = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts: number = 0;
  private pingInterval: NodeJS.Timeout | null = null;

  private instrumentsMap: Map<string, InstrumentMetadata> = new Map();
  private tokenToGlobalId: Map<string, string> = new Map();
  private cachedQuotes: Map<string, QuoteSnapshot> = new Map();
  private historicalCandlesCache: Map<string, Candle[]> = new Map();
  private listeners: Map<string, Set<(quote: QuoteSnapshot) => void>> = new Map();

  private scripMasterCachePath: string;

  constructor(config: SmartAPIConfig = {}) {
    const baseDir = process.cwd().endsWith('packages/backend') || process.cwd().endsWith('packages\\backend')
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
    this.isConfigured = Boolean(
      this.config.apiKey &&
      this.config.clientCode &&
      this.config.password &&
      this.config.totpSecret
    );
  }

  public async init(): Promise<void> {
    if (!this.isConfigured) {
      console.log('[SmartAPI] Notice: Credentials not fully configured in environment. Adapter remains idle.');
      return;
    }

    try {
      console.log('[SmartAPI] Initializing authenticated session with registered IP:', this.config.clientPublicIp);
      await this.authenticateWithRetries(3);
      await this.loadAndResolveInstruments();
      await this.connectWebSocket();
    } catch (err: any) {
      this.authError = err.message || 'Authentication failed';
      console.error('[SmartAPI] Initialization Error:', this.authError);
    }
  }

  /**
   * Performs authentication with bounded retries and exponential backoff.
   */
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

    const totp = generateTOTP(this.config.totpSecret);
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

    const payload = {
      clientcode: this.config.clientCode,
      password: this.config.password, // MPIN
      totp: totp,
    };

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    const body: any = await res.json().catch(() => null);

    if (!res.ok || !body || body.status === false) {
      const errCode = body?.errorcode || `HTTP_${res.status}`;
      const errMsg = body?.message || 'Login request rejected by Angel One';
      throw new Error(`AUTH_FAILED [${errCode}]: ${errMsg}`);
    }

    const data = body.data;
    if (!data?.jwtToken || !data?.feedToken) {
      throw new Error('INVALID_AUTH_RESPONSE: Missing jwtToken or feedToken in response payload.');
    }

    const now = Date.now();
    this.session = {
      jwtToken: data.jwtToken.startsWith('Bearer ') ? data.jwtToken.slice(7) : data.jwtToken,
      refreshToken: data.refreshToken || '',
      feedToken: data.feedToken,
      loginTime: now,
      expiresAt: now + 23 * 3600 * 1000, // Tokens valid for ~24 hours
    };
  }

  /**
   * Refreshes the active JWT using the refresh token.
   */
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
   * Downloads or loads cached official Scrip Master and resolves NIFTY Spot and Near-Month Futures.
   */
  public async loadAndResolveInstruments(): Promise<InstrumentMetadata[]> {
    let scripMaster: any[] = [];

    // Try reading local cache if fresh (< 24 hours)
    try {
      if (fs.existsSync(this.scripMasterCachePath)) {
        const stats = fs.statSync(this.scripMasterCachePath);
        const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 3600);
        if (ageHours < 24) {
          const raw = fs.readFileSync(this.scripMasterCachePath, 'utf8');
          scripMaster = JSON.parse(raw);
        }
      }
    } catch (e) {
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

    // 1. Resolve NIFTY 50 Spot Index (Non-tradable reference)
    const spotItem = scripMaster.find(
      (x) => x.name === 'NIFTY' && x.exch_seg === 'NSE' && x.token === '99926000'
    ) || {
      token: '99926000',
      symbol: 'Nifty 50',
      name: 'NIFTY 50 Spot Index',
      exch_seg: 'NSE',
      lotsize: '1',
      tick_size: '0.05',
    };

    const spotMeta: InstrumentMetadata = {
      globalId: makeGlobalInstrumentId('NSE', 'Nifty 50', spotItem.token),
      provider: 'SMARTAPI',
      exchange: 'NSE',
      token: spotItem.token,
      symbol: spotItem.symbol || 'Nifty 50',
      name: 'NIFTY 50 Spot Index (Reference Only)',
      instrumentType: 'INDEX_SPOT',
      isTradable: false,
      lotSize: 1,
      tickSize: 0.05,
      isSimulatedFixture: false,
    };
    this.instrumentsMap.set(spotMeta.globalId, spotMeta);
    this.tokenToGlobalId.set(spotMeta.token, spotMeta.globalId);

    // 2. Resolve Near-Month NIFTY Futures
    const nowMs = Date.now();
    const niftyFutures = scripMaster
      .filter((x) => x.name === 'NIFTY' && x.exch_seg === 'NFO' && x.instrumenttype === 'FUTIDX')
      .map((item) => {
        const expiryTime = parseAngelExpiryDate(item.expiry);
        return { item, expiryTime };
      })
      .filter((x) => x.expiryTime >= nowMs) // Must be unexpired
      .sort((a, b) => a.expiryTime - b.expiryTime); // Nearest expiry first

    if (niftyFutures.length > 0) {
      const active = niftyFutures[0].item;
      // Scrip master tick_size is given in Paise (e.g. 10.000000 = 10 Paise = ₹0.10)
      const rawTick = parseFloat(active.tick_size || '10.0');
      const tickSizeRupees = rawTick >= 1 ? rawTick / 100 : rawTick;
      const lotSize = parseInt(active.lotsize || '65', 10);

      const futMeta: InstrumentMetadata = {
        globalId: makeGlobalInstrumentId('NFO', active.symbol, active.token),
        provider: 'SMARTAPI',
        exchange: 'NFO',
        token: active.token,
        symbol: active.symbol,
        name: `NIFTY Futures (${active.expiry})`,
        instrumentType: 'FUTIDX',
        isTradable: true,
        lotSize: lotSize,
        tickSize: tickSizeRupees,
        expiry: active.expiry,
        underlying: 'NIFTY',
        isSimulatedFixture: false,
      };

      this.instrumentsMap.set(futMeta.globalId, futMeta);
      this.tokenToGlobalId.set(futMeta.token, futMeta.globalId);

      console.log(
        `[SmartAPI] Resolved Active Futures Contract: ${futMeta.symbol} | Token: ${futMeta.token} | Lot: ${futMeta.lotSize} | Expiry: ${futMeta.expiry}`
      );
    }

    return Array.from(this.instrumentsMap.values());
  }

  public async getInstruments(): Promise<InstrumentMetadata[]> {
    if (this.instrumentsMap.size === 0) {
      await this.loadAndResolveInstruments();
    }
    return Array.from(this.instrumentsMap.values());
  }

  /**
   * Fetches real historical candles from Angel One SmartAPI getCandleData endpoint.
   */
  public async getCandles(globalId: string, timeframe: Timeframe, count: number = 150): Promise<Candle[]> {
    const inst = this.instrumentsMap.get(globalId);
    if (!inst || !this.session?.jwtToken || !this.config.apiKey) {
      return this.historicalCandlesCache.get(`${globalId}:${timeframe}`) || [];
    }

    const cacheKey = `${globalId}:${timeframe}`;

    try {
      // Map timeframe to SmartAPI intervals
      const intervalMap: Record<Timeframe, string> = {
        '1m': 'ONE_MINUTE',
        '5m': 'FIVE_MINUTE',
        '15m': 'FIFTEEN_MINUTE',
        '1h': 'ONE_HOUR',
        '1D': 'ONE_DAY',
      };
      const interval = intervalMap[timeframe] || 'FIVE_MINUTE';

      // Format date range in IST (e.g., last 5 days to now)
      const toDate = new Date();
      const fromDate = new Date(toDate.getTime() - 7 * 24 * 3600 * 1000);

      const formatAngelDate = (d: Date) => {
        const ist = new Date(d.getTime() + 5.5 * 3600000);
        const y = ist.getUTCFullYear();
        const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
        const day = String(ist.getUTCDate()).padStart(2, '0');
        const h = String(ist.getUTCHours()).padStart(2, '0');
        const min = String(ist.getUTCMinutes()).padStart(2, '0');
        return `${y}-${m}-${day} ${h}:${min}`;
      };

      const url = 'https://apiconnect.angelone.in/rest/secure/angelbroking/historical/v1/getCandleData';
      const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-UserType': 'USER',
        'X-SourceID': 'WEB',
        'X-ClientLocalIP': '127.0.0.1',
        'X-ClientPublicIP': this.config.clientPublicIp || '45.115.52.180',
        'X-PrivateKey': this.config.apiKey,
        Authorization: `Bearer ${this.session.jwtToken}`,
      };

      const payload = {
        exchange: inst.exchange,
        symboltoken: inst.token,
        interval,
        fromdate: formatAngelDate(fromDate),
        todate: formatAngelDate(toDate),
      };

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });

      const data: any = await res.json().catch(() => null);

      if (res.ok && data?.status === true && Array.isArray(data.data)) {
        // [Timestamp, Open, High, Low, Close, Volume]
        const rawCandles: any[] = data.data;
        const parsed: Candle[] = rawCandles.map((row) => {
          // row[0] is ISO string with offset, e.g. "2026-11-04T09:15:00+0530"
          const epochSec = Math.floor(new Date(row[0]).getTime() / 1000);
          return {
            time: epochSec,
            open: parseFloat(row[1]),
            high: parseFloat(row[2]),
            low: parseFloat(row[3]),
            close: parseFloat(row[4]),
            volume: parseInt(row[5] || '0', 10),
          };
        });

        // Deduplicate and sort ascending by timestamp
        const sorted = parsed
          .filter((c, idx, arr) => idx === 0 || c.time > arr[idx - 1].time)
          .sort((a, b) => a.time - b.time);

        const sliced = sorted.slice(-count);
        this.historicalCandlesCache.set(cacheKey, sliced);
        return sliced;
      }
    } catch (err) {
      console.error(`[SmartAPI] Failed to fetch historical candles for ${globalId}:`, err);
    }

    return this.historicalCandlesCache.get(cacheKey) || [];
  }

  public async getQuote(globalId: string): Promise<QuoteSnapshot | null> {
    return this.cachedQuotes.get(globalId) || null;
  }

  public subscribe(globalId: string, listener: (quote: QuoteSnapshot) => void): () => void {
    if (!this.listeners.has(globalId)) {
      this.listeners.set(globalId, new Set());
    }
    this.listeners.get(globalId)!.add(listener);

    // Immediately push latest cached quote if present
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

  /**
   * Connects to official SmartAPI WebSocket 2.0 (SmartStream).
   */
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

    const nseTokens: string[] = [];
    const nfoTokens: string[] = [];

    for (const inst of this.instrumentsMap.values()) {
      if (inst.exchange === 'NSE') nseTokens.push(inst.token);
      if (inst.exchange === 'NFO') nfoTokens.push(inst.token);
    }

    const tokenList = [];
    if (nseTokens.length > 0) tokenList.push({ exchangeType: 1, tokens: nseTokens });
    if (nfoTokens.length > 0) tokenList.push({ exchangeType: 2, tokens: nfoTokens });

    if (tokenList.length === 0) return;

    const subMsg = {
      correlationID: `tradingzone_sub_${Date.now()}`,
      action: 1, // 1 = Subscribe
      params: {
        mode: 1, // 1 = LTP Mode (high performance tick feed)
        tokenList,
      },
    };

    this.ws.send(JSON.stringify(subMsg));
    console.log('[SmartAPI] Subscribed to instruments:', tokenList);
  }

  /**
   * Parses official SmartStream Little-Endian Binary Packets.
   */
  private handleWebSocketMessage(raw: Buffer | string): void {
    if (typeof raw === 'string') {
      // Possible pong response or error JSON
      return;
    }

    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    if (buf.length < 51) return; // Minimum LTP packet length is 51 bytes

    try {
      const subscriptionMode = buf.readUInt8(0);
      if (subscriptionMode < 1 || subscriptionMode > 4) return;
      // Byte 1 is exchangeType (1 = NSE_CM, 2 = NSE_FO, etc.)

      // Token is 25 bytes string starting at offset 2 (null-padded)
      const token = buf.toString('ascii', 2, 27).replace(/\0/g, '').trim();

      // Exchange timestamp (8 bytes int64 Little-Endian, epoch ms)
      const exchangeTimestamp = Number(buf.readBigInt64LE(35));

      // Last Traded Price (8 bytes int64 Little-Endian, in Paise!)
      const ltpPaise = Number(buf.readBigInt64LE(43));
      const ltpRupees = ltpPaise / 100;

      const now = Date.now();
      this.lastTickTimestamp = now;

      const globalId = this.tokenToGlobalId.get(token);
      if (!globalId) return;

      // Quote Snapshot
      const quote: QuoteSnapshot = {
        globalId,
        token,
        ltp: ltpRupees,
        open: ltpRupees,
        high: ltpRupees,
        low: ltpRupees,
        close: ltpRupees,
        volume: 0,
        providerTimestamp: exchangeTimestamp || now,
        receiveTimestamp: now,
        source: 'SMARTAPI',
        isSimulated: false,
      };

      this.cachedQuotes.set(globalId, quote);

      // Fan out to active listeners
      const listeners = this.listeners.get(globalId);
      if (listeners) {
        for (const fn of listeners) {
          try {
            fn(quote);
          } catch {}
        }
      }
    } catch (err) {
      // Ignore binary malformed frames
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
        message: 'SmartAPI credentials missing. Fill in .env to activate live market data for private development.',
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

    const marketOpen = isIndianMarketOpen();
    const now = Date.now();
    const isStale = this.lastTickTimestamp > 0 && now - this.lastTickTimestamp > 15000;

    let status: 'LIVE' | 'STALE' | 'DISCONNECTED' = 'DISCONNECTED';
    let banner = 'SMARTAPI — CONNECTING';

    if (this.wsConnected) {
      if (marketOpen) {
        status = isStale ? 'STALE' : 'LIVE';
        banner = isStale ? 'SMARTAPI — STALE DATA (MARKET OPEN)' : 'SMARTAPI — LIVE MARKET OPEN';
      } else {
        status = 'LIVE'; // Connected and serving official last available data
        banner = 'SMARTAPI — MARKET CLOSED (LAST AVAILABLE DATA)';
      }
    }

    return {
      source: 'SMARTAPI',
      status,
      latencyMs: this.lastTickTimestamp > 0 ? Math.max(1, now - this.lastTickTimestamp) : 0,
      lastTickTimestamp: this.lastTickTimestamp,
      isSimulated: false,
      activeSubscriptionsCount: this.instrumentsMap.size,
      uiBannerLabel: banner,
      message: marketOpen
        ? 'Connected to Angel One SmartStream feed.'
        : 'NSE/NFO market closed (Session hours: 09:15 to 15:30 IST). Showing latest available session data.',
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
