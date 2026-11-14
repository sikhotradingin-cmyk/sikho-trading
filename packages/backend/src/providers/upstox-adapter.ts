import {
  Candle,
  Exchange,
  InstrumentMetadata,
  InstrumentType,
  QuoteSnapshot,
  Timeframe,
  makeGlobalInstrumentId,
  resolveCommoditySpec,
  getExchangeSessionStatus,
} from '@trading/shared';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import WebSocket from 'ws';
import {
  CandlePageResult,
  CandleQueryOptions,
  FeedHealth,
  FeedStatus,
  IMarketDataProvider,
  InstrumentSearchOptions,
  InstrumentSearchResult,
  OptionChainContractSide,
  OptionChainResult,
  OptionChainRow,
} from './types.js';
import { isPlaceholderCredential } from '../config.js';

export interface UpstoxConfig {
  analyticsToken?: string;
}

interface RawUpstoxBodItem {
  segment: string;
  name: string;
  exchange: string;
  isin?: string;
  instrument_type: string;
  instrument_key: string;
  lot_size?: number;
  freeze_quantity?: number;
  exchange_token: string;
  tick_size?: number;
  trading_symbol: string;
  short_name?: string;
  expiry?: number;
  strike_price?: number;
  underlying_symbol?: string;
  asset_symbol?: string;
  underlying_key?: string;
  asset_key?: string;
  qty_multiplier?: number;
  asset_type?: string;
  weekly?: boolean;
}

export interface DecodedUpstoxFeedTick {
  instrumentKey: string;
  ltp: number;
  ltt: number;
  cp: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  oi?: number;
  bidPrice?: number;
  bidQty?: number;
  askPrice?: number;
  askQty?: number;
}

/**
 * Pure TypeScript Protobuf wire decoder for Upstox MarketDataFeedV3.proto (FeedResponse)
 */
export function decodeUpstoxFeedResponseProto(buf: Buffer): DecodedUpstoxFeedTick[] {
  const results: DecodedUpstoxFeedTick[] = [];
  let offset = 0;

  const readVarint = (b: Buffer, pos: number): [bigint, number] => {
    let result = 0n;
    let shift = 0n;
    let p = pos;
    while (p < b.length) {
      const byte = b[p++];
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7n;
    }
    return [result, p];
  };

  const skipField = (b: Buffer, pos: number, wireType: number): number => {
    if (wireType === 0) {
      const [, next] = readVarint(b, pos);
      return next;
    }
    if (wireType === 1) return pos + 8;
    if (wireType === 2) {
      const [len, next] = readVarint(b, pos);
      return next + Number(len);
    }
    if (wireType === 5) return pos + 4;
    return b.length;
  };

  const parseLTPC = (b: Buffer): { ltp: number; ltt: number; cp: number } => {
    let p = 0;
    let ltp = 0;
    let ltt = 0;
    let cp = 0;
    while (p < b.length) {
      const [tag, nextP] = readVarint(b, p);
      p = nextP;
      const fieldNo = Number(tag >> 3n);
      const wireType = Number(tag & 7n);
      if (fieldNo === 1 && wireType === 1 && p + 8 <= b.length) {
        ltp = b.readDoubleLE(p);
        p += 8;
      } else if (fieldNo === 2 && wireType === 0) {
        const [v, np] = readVarint(b, p);
        ltt = Number(v);
        p = np;
      } else if (fieldNo === 4 && wireType === 1 && p + 8 <= b.length) {
        cp = b.readDoubleLE(p);
        p += 8;
      } else {
        p = skipField(b, p, wireType);
      }
    }
    return { ltp, ltt, cp };
  };

  const parseQuote = (b: Buffer): { bidQty?: number; bidPrice?: number; askQty?: number; askPrice?: number } => {
    let p = 0;
    let bidQty: number | undefined;
    let bidPrice: number | undefined;
    let askQty: number | undefined;
    let askPrice: number | undefined;
    while (p < b.length) {
      const [tag, nextP] = readVarint(b, p);
      p = nextP;
      const fieldNo = Number(tag >> 3n);
      const wireType = Number(tag & 7n);
      if (fieldNo === 1 && wireType === 0) {
        const [v, np] = readVarint(b, p);
        bidQty = Number(v);
        p = np;
      } else if (fieldNo === 2 && wireType === 1 && p + 8 <= b.length) {
        bidPrice = b.readDoubleLE(p);
        p += 8;
      } else if (fieldNo === 3 && wireType === 0) {
        const [v, np] = readVarint(b, p);
        askQty = Number(v);
        p = np;
      } else if (fieldNo === 4 && wireType === 1 && p + 8 <= b.length) {
        askPrice = b.readDoubleLE(p);
        p += 8;
      } else {
        p = skipField(b, p, wireType);
      }
    }
    return { bidQty, bidPrice, askQty, askPrice };
  };

  const parseOHLC = (b: Buffer): { interval: string; open: number; high: number; low: number; close: number; vol: number } => {
    let p = 0;
    let interval = '';
    let open = 0;
    let high = 0;
    let low = 0;
    let close = 0;
    let vol = 0;
    while (p < b.length) {
      const [tag, nextP] = readVarint(b, p);
      p = nextP;
      const fieldNo = Number(tag >> 3n);
      const wireType = Number(tag & 7n);
      if (fieldNo === 1 && wireType === 2) {
        const [len, np] = readVarint(b, p);
        interval = b.subarray(np, np + Number(len)).toString('utf8');
        p = np + Number(len);
      } else if (fieldNo === 2 && wireType === 1 && p + 8 <= b.length) {
        open = b.readDoubleLE(p);
        p += 8;
      } else if (fieldNo === 3 && wireType === 1 && p + 8 <= b.length) {
        high = b.readDoubleLE(p);
        p += 8;
      } else if (fieldNo === 4 && wireType === 1 && p + 8 <= b.length) {
        low = b.readDoubleLE(p);
        p += 8;
      } else if (fieldNo === 5 && wireType === 1 && p + 8 <= b.length) {
        close = b.readDoubleLE(p);
        p += 8;
      } else if (fieldNo === 6 && wireType === 0) {
        const [v, np] = readVarint(b, p);
        vol = Number(v);
        p = np;
      } else {
        p = skipField(b, p, wireType);
      }
    }
    return { interval, open, high, low, close, vol };
  };

  const parseMarketOHLC = (b: Buffer, target: Partial<DecodedUpstoxFeedTick>): void => {
    let p = 0;
    while (p < b.length) {
      const [tag, nextP] = readVarint(b, p);
      p = nextP;
      const fieldNo = Number(tag >> 3n);
      const wireType = Number(tag & 7n);
      if (fieldNo === 1 && wireType === 2) {
        const [len, np] = readVarint(b, p);
        const ohlc = parseOHLC(b.subarray(np, np + Number(len)));
        if (ohlc.interval === '1d' || ohlc.interval === 'd1' || !target.open) {
          target.open = ohlc.open;
          target.high = ohlc.high;
          target.low = ohlc.low;
          target.close = ohlc.close;
          if (ohlc.vol > 0 && !target.volume) target.volume = ohlc.vol;
        }
        p = np + Number(len);
      } else {
        p = skipField(b, p, wireType);
      }
    }
  };

  const parseMarketFullFeed = (b: Buffer, target: DecodedUpstoxFeedTick): void => {
    let p = 0;
    while (p < b.length) {
      const [tag, nextP] = readVarint(b, p);
      p = nextP;
      const fieldNo = Number(tag >> 3n);
      const wireType = Number(tag & 7n);
      if (fieldNo === 1 && wireType === 2) {
        const [len, np] = readVarint(b, p);
        const ltpc = parseLTPC(b.subarray(np, np + Number(len)));
        target.ltp = ltpc.ltp;
        target.ltt = ltpc.ltt;
        target.cp = ltpc.cp;
        p = np + Number(len);
      } else if (fieldNo === 2 && wireType === 2) {
        // MarketLevel
        const [len, np] = readVarint(b, p);
        const mlBuf = b.subarray(np, np + Number(len));
        let mp = 0;
        while (mp < mlBuf.length) {
          const [mtag, mnp] = readVarint(mlBuf, mp);
          mp = mnp;
          const mf = Number(mtag >> 3n);
          const mw = Number(mtag & 7n);
          if (mf === 1 && mw === 2) {
            const [qlen, qnp] = readVarint(mlBuf, mp);
            if (target.bidPrice === undefined) {
              const q = parseQuote(mlBuf.subarray(qnp, qnp + Number(qlen)));
              target.bidPrice = q.bidPrice;
              target.bidQty = q.bidQty;
              target.askPrice = q.askPrice;
              target.askQty = q.askQty;
            }
            mp = qnp + Number(qlen);
          } else {
            mp = skipField(mlBuf, mp, mw);
          }
        }
        p = np + Number(len);
      } else if (fieldNo === 4 && wireType === 2) {
        const [len, np] = readVarint(b, p);
        parseMarketOHLC(b.subarray(np, np + Number(len)), target);
        p = np + Number(len);
      } else if (fieldNo === 6 && wireType === 0) {
        const [v, np] = readVarint(b, p);
        target.volume = Number(v);
        p = np;
      } else if (fieldNo === 7 && wireType === 1 && p + 8 <= b.length) {
        target.oi = b.readDoubleLE(p);
        p += 8;
      } else {
        p = skipField(b, p, wireType);
      }
    }
  };

  const parseIndexFullFeed = (b: Buffer, target: DecodedUpstoxFeedTick): void => {
    let p = 0;
    while (p < b.length) {
      const [tag, nextP] = readVarint(b, p);
      p = nextP;
      const fieldNo = Number(tag >> 3n);
      const wireType = Number(tag & 7n);
      if (fieldNo === 1 && wireType === 2) {
        const [len, np] = readVarint(b, p);
        const ltpc = parseLTPC(b.subarray(np, np + Number(len)));
        target.ltp = ltpc.ltp;
        target.ltt = ltpc.ltt;
        target.cp = ltpc.cp;
        p = np + Number(len);
      } else if (fieldNo === 2 && wireType === 2) {
        const [len, np] = readVarint(b, p);
        parseMarketOHLC(b.subarray(np, np + Number(len)), target);
        p = np + Number(len);
      } else {
        p = skipField(b, p, wireType);
      }
    }
  };

  const parseFeed = (instrumentKey: string, b: Buffer): DecodedUpstoxFeedTick | null => {
    const tick: DecodedUpstoxFeedTick = {
      instrumentKey,
      ltp: 0,
      ltt: Date.now(),
      cp: 0,
    };
    let p = 0;
    while (p < b.length) {
      const [tag, nextP] = readVarint(b, p);
      p = nextP;
      const fieldNo = Number(tag >> 3n);
      const wireType = Number(tag & 7n);
      if (fieldNo === 1 && wireType === 2) {
        const [len, np] = readVarint(b, p);
        const ltpc = parseLTPC(b.subarray(np, np + Number(len)));
        tick.ltp = ltpc.ltp;
        tick.ltt = ltpc.ltt;
        tick.cp = ltpc.cp;
        p = np + Number(len);
      } else if (fieldNo === 2 && wireType === 2) {
        // FullFeed
        const [len, np] = readVarint(b, p);
        const ffBuf = b.subarray(np, np + Number(len));
        let fp = 0;
        while (fp < ffBuf.length) {
          const [ftag, fnp] = readVarint(ffBuf, fp);
          fp = fnp;
          const ffNo = Number(ftag >> 3n);
          const fw = Number(ftag & 7n);
          if (ffNo === 1 && fw === 2) {
            const [mlen, mnp] = readVarint(ffBuf, fp);
            parseMarketFullFeed(ffBuf.subarray(mnp, mnp + Number(mlen)), tick);
            fp = mnp + Number(mlen);
          } else if (ffNo === 2 && fw === 2) {
            const [ilen, inp] = readVarint(ffBuf, fp);
            parseIndexFullFeed(ffBuf.subarray(inp, inp + Number(ilen)), tick);
            fp = inp + Number(ilen);
          } else {
            fp = skipField(ffBuf, fp, fw);
          }
        }
        p = np + Number(len);
      } else if (fieldNo === 3 && wireType === 2) {
        // FirstLevelWithGreeks
        const [len, np] = readVarint(b, p);
        const flBuf = b.subarray(np, np + Number(len));
        let fp = 0;
        while (fp < flBuf.length) {
          const [ftag, fnp] = readVarint(flBuf, fp);
          fp = fnp;
          const ffNo = Number(ftag >> 3n);
          const fw = Number(ftag & 7n);
          if (ffNo === 1 && fw === 2) {
            const [llen, lnp] = readVarint(flBuf, fp);
            const ltpc = parseLTPC(flBuf.subarray(lnp, lnp + Number(llen)));
            tick.ltp = ltpc.ltp;
            tick.ltt = ltpc.ltt;
            tick.cp = ltpc.cp;
            fp = lnp + Number(llen);
          } else if (ffNo === 2 && fw === 2) {
            const [qlen, qnp] = readVarint(flBuf, fp);
            const q = parseQuote(flBuf.subarray(qnp, qnp + Number(qlen)));
            tick.bidPrice = q.bidPrice;
            tick.bidQty = q.bidQty;
            tick.askPrice = q.askPrice;
            tick.askQty = q.askQty;
            fp = qnp + Number(qlen);
          } else if (ffNo === 4 && fw === 0) {
            const [v, vnp] = readVarint(flBuf, fp);
            tick.volume = Number(v);
            fp = vnp;
          } else if (ffNo === 5 && fw === 1 && fp + 8 <= flBuf.length) {
            tick.oi = flBuf.readDoubleLE(fp);
            fp += 8;
          } else {
            fp = skipField(flBuf, fp, fw);
          }
        }
        p = np + Number(len);
      } else {
        p = skipField(b, p, wireType);
      }
    }
    return tick.ltp > 0 ? tick : null;
  };

  while (offset < buf.length) {
    const [tag, nextOffset] = readVarint(buf, offset);
    offset = nextOffset;
    const fieldNo = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (fieldNo === 2 && wireType === 2) {
      // map<string, Feed> feeds entry
      const [entryLen, entryStart] = readVarint(buf, offset);
      const entryEnd = entryStart + Number(entryLen);
      let ep = entryStart;
      let key = '';
      let feedBytes: Buffer | null = null;
      while (ep < entryEnd) {
        const [etag, enext] = readVarint(buf, ep);
        ep = enext;
        const ef = Number(etag >> 3n);
        const ew = Number(etag & 7n);
        if (ef === 1 && ew === 2) {
          const [klen, knp] = readVarint(buf, ep);
          key = buf.subarray(knp, knp + Number(klen)).toString('utf8');
          ep = knp + Number(klen);
        } else if (ef === 2 && ew === 2) {
          const [vlen, vnp] = readVarint(buf, ep);
          feedBytes = buf.subarray(vnp, vnp + Number(vlen));
          ep = vnp + Number(vlen);
        } else {
          ep = skipField(buf, ep, ew);
        }
      }
      if (key && feedBytes) {
        const parsed = parseFeed(key, feedBytes);
        if (parsed) results.push(parsed);
      }
      offset = entryEnd;
    } else {
      offset = skipField(buf, offset, wireType);
    }
  }
  return results;
}

export class UpstoxAdapter implements IMarketDataProvider {
  public readonly providerId = 'UPSTOX';
  private allInstruments: Map<string, InstrumentMetadata> = new Map();
  private defaultWatchlistIds: string[] = [];
  private byUpstoxKey: Map<string, InstrumentMetadata> = new Map();
  private byExchangeToken: Map<string, InstrumentMetadata> = new Map();
  private byAliasId: Map<string, InstrumentMetadata> = new Map();

  private quotes: Map<string, QuoteSnapshot> = new Map();
  private listeners: Map<string, Set<(q: QuoteSnapshot) => void>> = new Map();
  private ws: WebSocket | null = null;
  private isConnected = false;
  private isTokenVerified = false;
  private lastTickTime = 0;
  private providerEventsCount = 0;
  private decodedTicksCount = 0;
  private droppedOutOfOrderCount = 0;
  private duplicateTickCount = 0;
  private lastProviderEventAt = 0;
  private lastDecodeAt = 0;
  private lastErrorReason: string | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private wsReconnectTimer: NodeJS.Timeout | null = null;
  private wsHeartbeatTimer: NodeJS.Timeout | null = null;
  private lastPongAt = 0;
  private wsReconnectAttempts = 0;
  private isDisposed = false;
  private availableFilters = {
    exchanges: ['NSE', 'NFO', 'BSE', 'BFO'],
    segments: ['INDEX_SPOT', 'EQUITY_STOCK', 'FUTIDX', 'OPTIDX', 'FUTSTK', 'OPTSTK'],
    underlyings: [] as string[],
    expiries: [] as string[],
  };

  constructor(private cfg: UpstoxConfig) { }

  private hasConfiguredToken(): boolean {
    const t = this.cfg.analyticsToken?.trim();
    return Boolean(t && !isPlaceholderCredential(t));
  }

  private getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (this.hasConfiguredToken()) {
      headers['Authorization'] = `Bearer ${this.cfg.analyticsToken!.trim()}`;
    }
    return headers;
  }

  public async init(): Promise<void> {
    await this.loadInstrumentsFromMaster();

    if (!this.hasConfiguredToken()) {
      this.isConnected = false;
      this.isTokenVerified = false;
      this.lastErrorReason =
        'UPSTOX_ANALYTICS_TOKEN is not configured in packages/backend/.env. Upstox V3 Historical & Intraday candles and BOD Instrument Master are active; configure UPSTOX_ANALYTICS_TOKEN to enable Market Data Feed V3 WebSocket streaming.';
    } else {
      await this.connectWebSocket();
    }

    // If token is configured, start polling quote sync for instruments when WebSocket is not yet connected
    if (this.hasConfiguredToken() && !this.pollTimer) {
      this.pollTimer = setInterval(() => {
        this.pollSubscribedIntradayQuotes().catch(() => { });
      }, 2500);
    }
  }

  private formatCompactFuturesSymbol(underlying: string, expiryIso: string): string {
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const [yyyy, mm, dd] = expiryIso.split('-');
    const mName = months[parseInt(mm, 10) - 1] || 'NOV';
    return `${underlying}${dd}${mName}${yyyy.slice(2)}FUT`;
  }

  private async loadInstrumentsFromMaster(): Promise<void> {
    const cacheCandidates = [
      path.resolve(process.cwd(), 'packages/backend/data/upstox_bod_master.json.gz'),
      path.resolve(__dirname, '../../data/upstox_bod_master.json.gz'),
      path.resolve(__dirname, '../../../data/upstox_bod_master.json.gz'),
    ];
    let cachePath = cacheCandidates.find((p) => fs.existsSync(p));

    let rawList: RawUpstoxBodItem[] = [];
    if (cachePath) {
      try {
        const compressed = fs.readFileSync(cachePath);
        rawList = JSON.parse(zlib.gunzipSync(compressed).toString('utf8'));
      } catch (err) {
        console.warn('[UpstoxAdapter] Failed reading local BOD cache, downloading fresh:', err);
      }
    }

    if (rawList.length === 0) {
      try {
        const [nseRes, bseRes, mcxRes] = await Promise.all([
          fetch('https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz'),
          fetch('https://assets.upstox.com/market-quote/instruments/exchange/BSE.json.gz'),
          fetch('https://assets.upstox.com/market-quote/instruments/exchange/MCX.json.gz'),
        ]);
        const nseData = JSON.parse(
          zlib.gunzipSync(Buffer.from(await nseRes.arrayBuffer())).toString('utf8')
        ) as RawUpstoxBodItem[];
        const bseData = JSON.parse(
          zlib.gunzipSync(Buffer.from(await bseRes.arrayBuffer())).toString('utf8')
        ) as RawUpstoxBodItem[];
        const mcxData = JSON.parse(
          zlib.gunzipSync(Buffer.from(await mcxRes.arrayBuffer())).toString('utf8')
        ) as RawUpstoxBodItem[];
        rawList = [
          ...nseData.filter(
            (x) =>
              x.segment === 'NSE_INDEX' ||
              (x.segment === 'NSE_EQ' && x.instrument_type === 'EQ') ||
              x.segment === 'NSE_FO'
          ),
          ...bseData.filter(
            (x) =>
              x.segment === 'BSE_INDEX' ||
              (x.segment === 'BSE_FO' &&
                (x.underlying_symbol === 'SENSEX' || x.underlying_symbol === 'BANKEX'))
          ),
          ...mcxData.filter((x) => x.segment === 'MCX_FO'),
        ];
        const saveTarget = cacheCandidates[0];
        fs.mkdirSync(path.dirname(saveTarget), { recursive: true });
        fs.writeFileSync(saveTarget, zlib.gzipSync(Buffer.from(JSON.stringify(rawList), 'utf8')));
      } catch (err: any) {
        console.error('[UpstoxAdapter] Could not download Upstox BOD master:', err?.message);
      }
    }

    this.allInstruments.clear();
    this.byUpstoxKey.clear();
    this.byExchangeToken.clear();
    this.byAliasId.clear();

    const underlyingsSet = new Set<string>();
    const expiriesSet = new Set<string>();
    const derivativeIndices = new Set([
      'NIFTY',
      'NIFTY 50',
      'BANKNIFTY',
      'NIFTY BANK',
      'FINNIFTY',
      'NIFTY FIN SERVICE',
      'MIDCPNIFTY',
      'NIFTY MID SELECT',
      'SENSEX',
      'BSE SENSEX',
      'BANKEX',
      'BSE BANKEX',
    ]);

    for (const raw of rawList) {
      if (!raw.instrument_key || !raw.exchange_token) continue;

      let exchange: Exchange = 'NSE';
      let instType: InstrumentType | null = null;
      let isTradable = true;
      let hasDerivatives = false;
      let optionType: 'CE' | 'PE' | undefined;
      let strikePrice: number | undefined;
      let expiryIso: string | undefined;
      let underlying: string | undefined;
      let symbol = raw.trading_symbol;
      let displayName = raw.short_name || raw.name || raw.trading_symbol;
      let token = String(raw.exchange_token);

      if (raw.segment === 'NSE_INDEX' || raw.segment === 'BSE_INDEX') {
        exchange = raw.segment === 'BSE_INDEX' ? 'BSE' : 'NSE';
        instType = 'INDEX_SPOT';
        isTradable = false;
        const upperName = (raw.name || '').toUpperCase();
        const upperSym = (raw.trading_symbol || '').toUpperCase();
        hasDerivatives =
          derivativeIndices.has(upperName) ||
          derivativeIndices.has(upperSym) ||
          upperName === 'NIFTY 50' ||
          upperName === 'NIFTY BANK';

        if (upperName === 'NIFTY 50' || upperSym === 'NIFTY') {
          symbol = 'NIFTY 50';
          displayName = 'NIFTY 50 Spot Index';
          token = '99926000';
          underlying = 'NIFTY';
        } else if (upperName === 'NIFTY BANK' || upperSym === 'BANKNIFTY') {
          symbol = 'BANKNIFTY';
          displayName = 'NIFTY Bank Spot Index';
          token = '99926009';
          underlying = 'BANKNIFTY';
        } else if (upperName === 'NIFTY FIN SERVICE' || upperSym === 'FINNIFTY') {
          symbol = 'FINNIFTY';
          displayName = 'NIFTY Financial Services';
          token = '99926037';
          underlying = 'FINNIFTY';
        } else if (upperName === 'NIFTY MID SELECT' || upperSym === 'MIDCPNIFTY') {
          symbol = 'MIDCPNIFTY';
          displayName = 'NIFTY Midcap Select';
          token = '99926074';
          underlying = 'MIDCPNIFTY';
        } else if (exchange === 'BSE' && upperSym === 'SENSEX') {
          symbol = 'SENSEX';
          displayName = 'BSE SENSEX';
          token = '99919000';
          underlying = 'SENSEX';
        } else if (exchange === 'BSE' && upperSym === 'BANKEX') {
          symbol = 'BANKEX';
          displayName = 'BSE BANKEX';
          token = '99919012';
          underlying = 'BANKEX';
        }
      } else if (raw.segment === 'NSE_EQ') {
        if (raw.instrument_type !== 'EQ') continue;
        exchange = 'NSE';
        instType = 'EQUITY_STOCK';
        isTradable = true;
        symbol = raw.trading_symbol;
        underlying = raw.trading_symbol;
      } else if (raw.segment === 'NSE_FO' || raw.segment === 'BSE_FO') {
        exchange = raw.segment === 'BSE_FO' ? 'BFO' : 'NFO';
        isTradable = true;
        underlying = raw.underlying_symbol || raw.asset_symbol || raw.name;
        if (underlying) underlyingsSet.add(underlying);

        if (raw.expiry) {
          // Convert UTC ms to IST YYYY-MM-DD
          expiryIso = new Date(raw.expiry + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
          expiriesSet.add(expiryIso);
        }

        const isIndexAsset =
          raw.asset_type === 'INDEX' ||
          ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX', 'NIFTYNXT50'].includes(
            underlying || ''
          );

        if (raw.instrument_type === 'FUT') {
          instType = isIndexAsset ? 'FUTIDX' : 'FUTSTK';
          if (underlying && expiryIso) {
            symbol = this.formatCompactFuturesSymbol(underlying, expiryIso);
          }
          displayName = raw.trading_symbol;
        } else if (raw.instrument_type === 'CE' || raw.instrument_type === 'PE') {
          instType = isIndexAsset ? 'OPTIDX' : 'OPTSTK';
          optionType = raw.instrument_type;
          strikePrice = Number(raw.strike_price || 0);
          displayName = raw.trading_symbol;
        }
      } else if (raw.segment === 'MCX_FO' || raw.exchange === 'MCX') {
        exchange = 'MCX';
        isTradable = true;
        underlying = (raw.asset_symbol || raw.underlying_symbol || raw.name || '').toUpperCase().trim();
        if (underlying) underlyingsSet.add(underlying);

        if (raw.expiry) {
          expiryIso = new Date(raw.expiry + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
          expiriesSet.add(expiryIso);
        }

        if (raw.instrument_type === 'FUT') {
          instType = 'FUTCOM';
          displayName = raw.trading_symbol;
          symbol = raw.trading_symbol;
        } else if (raw.instrument_type === 'CE' || raw.instrument_type === 'PE') {
          instType = 'OPTCOM';
          optionType = raw.instrument_type;
          strikePrice = Number(raw.strike_price || 0);
          displayName = raw.trading_symbol;
          symbol = raw.trading_symbol;
        }
      }

      if (!instType) continue;

      const lotSize = Math.max(1, Number(raw.lot_size || 1));
      // Upstox BOD tick_size is in paise (e.g. 5 -> 0.05, 10 -> 0.10)
      const rawTick = Number(raw.tick_size || 5);
      const tickSize = rawTick >= 1 ? Number((rawTick / 100).toFixed(2)) : Math.max(0.01, rawTick);
      const globalId = makeGlobalInstrumentId(exchange, symbol, token);

      const spec = (exchange === 'MCX' && underlying) ? resolveCommoditySpec(underlying) : null;
      const segment: 'EQUITY' | 'FNO' | 'COMMODITY' =
        exchange === 'MCX' ? 'COMMODITY' : (instType === 'EQUITY_STOCK' || instType === 'INDEX_SPOT') ? 'EQUITY' : 'FNO';

      const meta: InstrumentMetadata = {
        globalId,
        provider: 'UPSTOX',
        exchange,
        token,
        symbol,
        name: displayName,
        instrumentType: instType,
        isTradable,
        lotSize,
        tickSize: tickSize || 0.05,
        expiry: expiryIso,
        strikePrice,
        optionType,
        underlying,
        hasDerivatives,
        marginMultiplier: instType === 'FUTCOM' ? (spec?.simulatedMarginRate ?? 0.05) : instType === 'FUTIDX' ? 0.05 : undefined,
        upstoxInstrumentKey: raw.instrument_key,
        isin: raw.isin,
        canonicalId: `${exchange}:${raw.exchange_token}`,
        isSimulatedFixture: false,
        segment,
        commodityCategory: spec?.category,
        quotationUnit: spec?.quotationUnit || (exchange === 'MCX' ? '₹ / unit' : '₹ / share'),
        tradingUnit: spec?.tradingUnit || (exchange === 'MCX' ? 'units' : 'shares'),
        qtyMultiplier: raw.qty_multiplier || spec?.priceQuoteMultiplier || 1,
        priceQuoteMultiplier: spec?.priceQuoteMultiplier || 1,
        tickValue: spec?.tickValuePerLot || ((tickSize || 0.05) * (spec?.priceQuoteMultiplier || 1)),
        underlyingKey: raw.underlying_key || raw.asset_key,
      };

      this.allInstruments.set(globalId, meta);
      this.byUpstoxKey.set(raw.instrument_key, meta);
      this.byExchangeToken.set(`${exchange}:${raw.exchange_token}`, meta);
      this.byExchangeToken.set(`${exchange}:${token}`, meta);

      // Register cross-provider aliases (e.g. NSE:RELIANCE-EQ:2885 -> NSE:RELIANCE:2885)
      if (instType === 'EQUITY_STOCK') {
        this.byAliasId.set(`NSE:${symbol.toUpperCase()}-EQ:${raw.exchange_token}`, meta);
      }
      if (instType === 'INDEX_SPOT') {
        this.byAliasId.set(`${exchange}:${raw.trading_symbol.toUpperCase()}:${raw.exchange_token}`, meta);
      }
    }

    this.availableFilters.underlyings = Array.from(underlyingsSet).sort();
    this.availableFilters.expiries = Array.from(expiriesSet).sort();

    // Build default discovery list
    const defaults: string[] = [];
    const spotNifty = this.allInstruments.get('NSE:NIFTY 50:99926000');
    if (spotNifty) defaults.push(spotNifty.globalId);
    const spotSensex = this.allInstruments.get('BSE:SENSEX:99919000');
    if (spotSensex) defaults.push(spotSensex.globalId);
    const spotBank = this.allInstruments.get('NSE:BANKNIFTY:99926009');
    if (spotBank) defaults.push(spotBank.globalId);

    // Nearest NIFTY and BANKNIFTY Futures
    for (const u of ['NIFTY', 'BANKNIFTY', 'SENSEX']) {
      const futs = Array.from(this.allInstruments.values())
        .filter((i) => i.instrumentType === 'FUTIDX' && i.underlying === u && i.expiry)
        .sort((a, b) => (a.expiry || '').localeCompare(b.expiry || ''));
      if (futs.length > 0) defaults.push(futs[0].globalId);
    }

    // Major Equities
    for (const eqSym of ['RELIANCE', 'HDFCBANK', 'TCS', 'INFY', 'ICICIBANK', 'SBIN', 'BHARTIARTL', 'ITC', 'LT', 'AXISBANK']) {
      const found = Array.from(this.allInstruments.values()).find(
        (i) => i.instrumentType === 'EQUITY_STOCK' && i.symbol === eqSym
      );
      if (found) defaults.push(found.globalId);
    }

    // Representative MCX Commodities (Bullion, Energy, Base Metals)
    for (const comSym of ['CRUDEOIL', 'GOLD', 'NATURALGAS', 'SILVER', 'COPPER']) {
      const futs = Array.from(this.allInstruments.values())
        .filter((i) => i.instrumentType === 'FUTCOM' && (i.underlying === comSym || i.symbol.startsWith(comSym)) && i.expiry)
        .sort((a, b) => (a.expiry || '').localeCompare(b.expiry || ''));
      if (futs.length > 0) defaults.push(futs[0].globalId);
    }

    this.defaultWatchlistIds = defaults;
  }

  public resolveInstrument(globalIdOrKey: string): InstrumentMetadata | undefined {
    const direct = this.allInstruments.get(globalIdOrKey);
    if (direct) return direct;
    const byKey = this.byUpstoxKey.get(globalIdOrKey);
    if (byKey) return byKey;
    const byAlias = this.byAliasId.get(globalIdOrKey);
    if (byAlias) return byAlias;

    // Strict cross-provider mapping: Validate exchange, token, and contract identity
    const parts = globalIdOrKey.split(':');
    if (parts.length >= 3) {
      const exch = parts[0];
      const sym = parts[1];
      const tok = parts.slice(2).join(':');

      const byTok = this.byExchangeToken.get(`${exch}:${tok}`);
      if (byTok) {
        // If symbol matches or starts with same root (e.g. RELIANCE vs RELIANCE-EQ), allow
        const rootSym = sym.split('-')[0].toUpperCase();
        const candRoot = byTok.symbol.split('-')[0].toUpperCase();
        if (rootSym === candRoot || byTok.token === tok) {
          return byTok;
        }
      }

      // If token alone did not resolve identically, match across exchange + underlying/symbol + expiry + strike + optionType
      const candidates = Array.from(this.allInstruments.values()).filter(
        (i) => i.exchange === exch && (i.symbol.toUpperCase() === sym.toUpperCase() || i.underlying?.toUpperCase() === sym.toUpperCase())
      );
      if (candidates.length === 1) return candidates[0];
    }
    return undefined;
  }

  public async getInstruments(): Promise<InstrumentMetadata[]> {
    return this.defaultWatchlistIds
      .map((id) => this.allInstruments.get(id))
      .filter((x): x is InstrumentMetadata => Boolean(x));
  }

  public async getInstrumentById(globalId: string): Promise<InstrumentMetadata | undefined> {
    return this.resolveInstrument(globalId);
  }

  public async getIndices(): Promise<InstrumentMetadata[]> {
    const priorityNames = [
      'NIFTY 50',
      'SENSEX',
      'BANKNIFTY',
      'FINNIFTY',
      'MIDCPNIFTY',
      'BANKEX',
      'NIFTY IT',
      'NIFTY PHARMA',
      'NIFTY METAL',
      'NIFTY AUTO',
      'NIFTY FMCG',
      'NIFTY PVT BANK',
      'NIFTY PSU BANK',
      'NIFTY REALTY',
      'NIFTY ENERGY',
      'INDIA VIX',
      'NIFTYNXT50',
    ];
    const allIdx = Array.from(this.allInstruments.values()).filter(
      (i) => i.instrumentType === 'INDEX_SPOT'
    );
    allIdx.sort((a, b) => {
      const ia = priorityNames.indexOf(a.symbol);
      const ib = priorityNames.indexOf(b.symbol);
      if (ia !== -1 && ib !== -1) return ia - ib;
      if (ia !== -1) return -1;
      if (ib !== -1) return 1;
      return a.name.localeCompare(b.name);
    });
    return allIdx;
  }

  public async searchInstruments(opts: InstrumentSearchOptions): Promise<InstrumentSearchResult> {
    const q = (opts.q || '').trim().toUpperCase();
    const exchange = opts.exchange?.trim().toUpperCase();
    const segment = opts.segment?.trim().toUpperCase();
    const underlying = opts.underlying?.trim().toUpperCase();
    const expiry = opts.expiry?.trim().toUpperCase();
    const optionType = opts.optionType?.trim().toUpperCase();
    const strike = opts.strike !== undefined && !isNaN(opts.strike) ? Number(opts.strike) : undefined;
    const page = Math.max(1, opts.page || 1);
    const limit = Math.min(200, Math.max(1, opts.limit || 50));

    const matched: Array<{ inst: InstrumentMetadata; score: number }> = [];

    for (const inst of this.allInstruments.values()) {
      if (exchange && inst.exchange !== exchange) continue;
      if (segment) {
        if (segment === 'COMMODITY' && inst.exchange !== 'MCX' && inst.segment !== 'COMMODITY') continue;
        else if (segment === 'EQUITY' && inst.instrumentType !== 'EQUITY_STOCK' && inst.instrumentType !== 'INDEX_SPOT') continue;
        else if (segment === 'FNO' && inst.instrumentType !== 'FUTIDX' && inst.instrumentType !== 'OPTIDX' && inst.instrumentType !== 'FUTSTK' && inst.instrumentType !== 'OPTSTK') continue;
        else if (segment !== 'COMMODITY' && segment !== 'EQUITY' && segment !== 'FNO' && inst.instrumentType !== segment) continue;
      }
      if (underlying && (inst.underlying || '').toUpperCase() !== underlying) continue;
      if (expiry && (inst.expiry || '').toUpperCase() !== expiry) continue;
      if (optionType && (inst.optionType || '').toUpperCase() !== optionType) continue;
      if (strike !== undefined && inst.strikePrice !== strike) continue;

      let score = 0;
      if (q) {
        const sym = inst.symbol.toUpperCase();
        const name = inst.name.toUpperCase();
        const und = (inst.underlying || '').toUpperCase();
        if (sym === q || und === q) {
          score = 1000;
        } else if (sym.startsWith(q) || name.startsWith(q)) {
          score = 500;
        } else if (sym.includes(q) || name.includes(q)) {
          score = 200;
        } else {
          const tokens = q.split(/\s+/).filter(Boolean);
          const hay = `${sym} ${name} ${und} ${inst.expiry || ''} ${inst.strikePrice || ''} ${inst.optionType || ''}`;
          if (tokens.length > 1 && tokens.every((t) => hay.includes(t))) {
            score = 150;
          } else {
            continue;
          }
        }
      } else {
        score = 100;
      }

      if (inst.instrumentType === 'INDEX_SPOT' && inst.hasDerivatives) score += 60;
      else if (inst.instrumentType === 'FUTIDX') score += 50;
      else if (inst.instrumentType === 'FUTCOM') score += 48;
      else if (inst.instrumentType === 'EQUITY_STOCK') {
        const prominentSet = new Set(['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'SBIN', 'BHARTIARTL', 'ITC', 'KOTAKBANK', 'LT', 'TATAMOTORS', 'HINDUNILVR', 'BAJFINANCE', 'MARUTI', 'SUNPHARMA', 'TITAN', 'WIPRO', 'TTML']);
        score += prominentSet.has(inst.symbol.toUpperCase()) ? 58 : 40;
      }
      else if (inst.instrumentType === 'FUTSTK') score += 30;
      else if (inst.instrumentType === 'OPTIDX') score += 20;
      else if (inst.instrumentType === 'OPTCOM') score += 18;

      matched.push({ inst, score });
    }

    matched.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.inst.expiry && b.inst.expiry && a.inst.expiry !== b.inst.expiry) {
        return a.inst.expiry.localeCompare(b.inst.expiry);
      }
      return a.inst.symbol.localeCompare(b.inst.symbol);
    });

    const totalCount = matched.length;
    const offset = (page - 1) * limit;
    const slice = matched.slice(offset, offset + limit).map((m) => m.inst);

    return {
      instruments: slice,
      totalCount,
      page,
      limit,
      availableFilters: this.availableFilters,
    };
  }

  public async getOptionChain(underlyingInput: string, requestedExpiry?: string): Promise<OptionChainResult> {
    const normUnderlying = underlyingInput.trim().toUpperCase() === 'NIFTY 50'
      ? 'NIFTY'
      : underlyingInput.trim().toUpperCase() === 'NIFTY BANK'
        ? 'BANKNIFTY'
        : underlyingInput.trim().toUpperCase();

    // Find spot or equity underlying instrument, or near-month futures contract (for commodities)
    let spotInst = Array.from(this.allInstruments.values()).find(
      (i) =>
        (i.instrumentType === 'INDEX_SPOT' && (i.underlying === normUnderlying || i.symbol === normUnderlying)) ||
        (i.instrumentType === 'EQUITY_STOCK' && i.symbol === normUnderlying)
    );

    // For commodities (MCX), options are on futures! Find the active near-month futures contract:
    if (!spotInst) {
      const nearFut = Array.from(this.allInstruments.values())
        .filter((i) => (i.instrumentType === 'FUTCOM' || i.instrumentType === 'FUTIDX' || i.instrumentType === 'FUTSTK') && (i.underlying === normUnderlying || i.symbol.startsWith(normUnderlying)) && i.expiry)
        .sort((a, b) => (a.expiry || '').localeCompare(b.expiry || ''))[0];
      if (nearFut) {
        spotInst = nearFut;
      }
    }

    let spotLtp: number | null = null;
    if (spotInst) {
      const sq = await this.getQuote(spotInst.globalId);
      if (sq && sq.ltp > 0) spotLtp = sq.ltp;
      if (!spotLtp) {
        try {
          const c = await this.getCandles(spotInst.globalId, '1D', 1);
          if (c.length > 0) spotLtp = c[c.length - 1].close;
        } catch { }
      }
    }

    // Collect all option contracts for this underlying (equities, indices, commodities)
    const options = Array.from(this.allInstruments.values()).filter(
      (i) =>
        (i.instrumentType === 'OPTIDX' || i.instrumentType === 'OPTSTK' || i.instrumentType === 'OPTCOM') &&
        (i.underlying || '').toUpperCase() === normUnderlying &&
        Boolean(i.expiry) &&
        i.strikePrice !== undefined
    );

    const expiries = Array.from(new Set(options.map((o) => o.expiry!))).sort();
    const selectedExpiry =
      requestedExpiry && expiries.includes(requestedExpiry) ? requestedExpiry : expiries[0] || '';

    const expiryOptions = options.filter((o) => o.expiry === selectedExpiry);
    const strikes = Array.from(new Set(expiryOptions.map((o) => o.strikePrice!))).sort((a, b) => a - b);

    // Select 21 strikes centered around ATM if spotLtp is known
    let visibleStrikes = strikes;
    if (spotLtp && strikes.length > 21) {
      let closestIdx = 0;
      let minDiff = Infinity;
      strikes.forEach((s, idx) => {
        const d = Math.abs(s - spotLtp!);
        if (d < minDiff) {
          minDiff = d;
          closestIdx = idx;
        }
      });
      const start = Math.max(0, closestIdx - 10);
      visibleStrikes = strikes.slice(start, start + 21);
    } else if (strikes.length > 25) {
      const mid = Math.floor(strikes.length / 2);
      visibleStrikes = strikes.slice(Math.max(0, mid - 12), mid + 13);
    }

    const byStrike = new Map<number, { ce?: InstrumentMetadata; pe?: InstrumentMetadata }>();
    for (const s of visibleStrikes) byStrike.set(s, {});
    for (const o of expiryOptions) {
      const entry = byStrike.get(o.strikePrice!);
      if (!entry) continue;
      if (o.optionType === 'CE') entry.ce = o;
      else if (o.optionType === 'PE') entry.pe = o;
    }

    // Hydrate quotes in parallel for ATM neighborhood (up to 15 strikes around ATM for fast response)
    const contractsToHydrate: InstrumentMetadata[] = [];
    for (const s of visibleStrikes) {
      const pair = byStrike.get(s);
      if (pair?.ce) contractsToHydrate.push(pair.ce);
      if (pair?.pe) contractsToHydrate.push(pair.pe);
    }

    const hydratedQuotes = new Map<string, QuoteSnapshot>();
    await Promise.all(
      contractsToHydrate.slice(0, 30).map(async (inst) => {
        try {
          const q = await this.getQuote(inst.globalId);
          if (q) hydratedQuotes.set(inst.globalId, q);
        } catch {
          // ignore individual contract errors
        }
      })
    );

    let contractsWithQuotesCount = 0;
    const buildSide = (inst?: InstrumentMetadata): OptionChainContractSide | null => {
      if (!inst) return null;
      const q = hydratedQuotes.get(inst.globalId) || this.quotes.get(inst.globalId);
      const ltp = q ? q.ltp : null;
      if (ltp !== null) contractsWithQuotesCount++;
      const prevClose = q ? q.close : null;
      const changePct =
        ltp !== null && prevClose && prevClose > 0
          ? Number((((ltp - prevClose) / prevClose) * 100).toFixed(2))
          : null;
      return {
        instrument: inst,
        ltp,
        changePct,
        openInterest: q && q.openInterest !== undefined ? q.openInterest : null,
        volume: q && q.volume !== undefined ? q.volume : null,
        bidPrice: q?.bidPrice ?? null,
        askPrice: q?.askPrice ?? null,
        quoteTimestamp: q?.providerTimestamp ?? null,
        source: q?.source ?? 'UNAUTHENTICATED',
      };
    };

    const rows: OptionChainRow[] = visibleStrikes.map((strikePrice) => {
      const pair = byStrike.get(strikePrice)!;
      return {
        strikePrice,
        call: buildSide(pair.ce),
        put: buildSide(pair.pe),
      };
    });

    const isWsStreamed = this.isConnected && this.ws?.readyState === WebSocket.OPEN;

    return {
      underlying: normUnderlying,
      underlyingSpotInstrument: spotInst,
      underlyingSpotLtp: spotLtp,
      selectedExpiry,
      availableExpiries: expiries,
      rows,
      providerSource: 'UPSTOX',
      deliveryMode: isWsStreamed ? 'STREAMED' : 'POLLED',
      provenance: {
        spotSource: spotInst ? 'UPSTOX_BOD_MASTER' : 'UNKNOWN',
        spotTimestamp: spotLtp ? Date.now() : null,
        contractsTotal: contractsToHydrate.length,
        contractsWithRealQuotes: contractsWithQuotesCount,
        note: isWsStreamed
          ? 'Streamed in real-time via Upstox MarketDataFeedV3 Protobuf WebSocket.'
          : 'Polled via Upstox Market Quote V2. Missing open interest is represented as unavailable (null), not zero.',
      },
    };
  }

  private mapTimeframeToUpstoxV3(timeframe: Timeframe): { unit: string; interval: string; chunkDays: number; maxLookbackDays: number } {
    switch (timeframe) {
      case '1m':
        return { unit: 'minutes', interval: '1', chunkDays: 28, maxLookbackDays: 1800 };
      case '3m':
        return { unit: 'minutes', interval: '3', chunkDays: 28, maxLookbackDays: 1800 };
      case '5m':
        return { unit: 'minutes', interval: '5', chunkDays: 28, maxLookbackDays: 1800 };
      case '15m':
        return { unit: 'minutes', interval: '15', chunkDays: 28, maxLookbackDays: 1800 };
      case '30m':
        return { unit: 'minutes', interval: '30', chunkDays: 85, maxLookbackDays: 1800 };
      case '1h':
        return { unit: 'hours', interval: '1', chunkDays: 85, maxLookbackDays: 1800 };
      case '1D':
        return { unit: 'days', interval: '1', chunkDays: 3600, maxLookbackDays: 9500 };
      default:
        return { unit: 'minutes', interval: '5', chunkDays: 28, maxLookbackDays: 1800 };
    }
  }

  private formatISTDate(ms: number): string {
    const istDate = new Date(ms + 5.5 * 3600 * 1000);
    return istDate.toISOString().slice(0, 10);
  }

  private parseUpstoxCandleRows(rawRows: any[]): { candles: Candle[]; latestOi?: number } {
    const byTime = new Map<number, Candle>();
    let latestOi: number | undefined;
    for (const row of rawRows) {
      if (!Array.isArray(row) || row.length < 5) continue;
      const tSec = Math.floor(new Date(row[0]).getTime() / 1000);
      if (isNaN(tSec)) continue;
      byTime.set(tSec, {
        time: tSec,
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5] || 0),
      });
      if (row[6] !== undefined && latestOi === undefined) {
        latestOi = Number(row[6]);
      }
    }
    const sorted = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
    return { candles: sorted, latestOi };
  }

  private async fetchUpstoxHistoricalChunk(
    upstoxKey: string,
    unit: string,
    interval: string,
    fromDateStr: string,
    toDateStr: string
  ): Promise<Candle[]> {
    const encodedKey = encodeURIComponent(upstoxKey);
    const url = `https://api.upstox.com/v3/historical-candle/${encodedKey}/${unit}/${interval}/${toDateStr}/${fromDateStr}`;
    const res = await fetch(url, { headers: this.getAuthHeaders() });
    if (!res.ok) return [];
    const json = (await res.json()) as any;
    if (json?.status === 'success' && Array.isArray(json.data?.candles)) {
      return this.parseUpstoxCandleRows(json.data.candles).candles;
    }
    return [];
  }

  private async fetchUpstoxIntraday(
    upstoxKey: string,
    unit: string,
    interval: string
  ): Promise<{ candles: Candle[]; latestOi?: number }> {
    const encodedKey = encodeURIComponent(upstoxKey);
    const url = `https://api.upstox.com/v3/historical-candle/intraday/${encodedKey}/${unit}/${interval}`;
    const res = await fetch(url, { headers: this.getAuthHeaders() });
    if (!res.ok) return { candles: [] };
    const json = (await res.json()) as any;
    if (json?.status === 'success' && Array.isArray(json.data?.candles)) {
      return this.parseUpstoxCandleRows(json.data.candles);
    }
    return { candles: [] };
  }

  public async getCandlesPaginated(
    globalId: string,
    timeframe: Timeframe,
    opts: CandleQueryOptions = {}
  ): Promise<CandlePageResult> {
    const inst = this.resolveInstrument(globalId);
    if (!inst || !inst.upstoxInstrumentKey) {
      return {
        candles: [],
        hasMore: false,
        earliestTime: null,
        latestTime: null,
        sessionDateIST: null,
        prevSessionClose: null,
        providerError: `Instrument ${globalId} not found in Upstox BOD master.`,
      };
    }

    const upstoxKey = inst.upstoxInstrumentKey;
    const { unit, interval, chunkDays, maxLookbackDays } = this.mapTimeframeToUpstoxV3(timeframe);
    const nowMs = Date.now();
    const minAllowedMs = nowMs - maxLookbackDays * 86400 * 1000;

    let endMs = opts.to ? opts.to * 1000 : opts.before ? opts.before * 1000 - 1000 : nowMs;
    if (endMs > nowMs) endMs = nowMs;

    let targetDays = chunkDays;
    if (opts.range && !opts.before) {
      const rangeDaysMap: Record<string, number> = {
        '1D': 5,
        '5D': 10,
        '1M': 32,
        '3M': 95,
        '6M': 185,
        '1Y': 370,
        ALL: maxLookbackDays,
      };
      targetDays = Math.min(maxLookbackDays, rangeDaysMap[opts.range] || chunkDays);
    }

    const startTargetMs = Math.max(minAllowedMs, endMs - targetDays * 86400 * 1000);
    const mergedMap = new Map<number, Candle>();

    // Fetch today's intraday candles if loading latest window on an intraday timeframe
    if (!opts.before && timeframe !== '1D') {
      try {
        const intra = await this.fetchUpstoxIntraday(upstoxKey, unit, interval);
        for (const c of intra.candles) {
          if (!opts.before || c.time < opts.before) {
            mergedMap.set(c.time, c);
          }
        }
      } catch {
        // continue with historical endpoint
      }
    }

    let cursorEndMs = endMs;
    let chunksFetched = 0;
    const maxChunks = opts.range === 'ALL' ? 8 : 4;

    while (cursorEndMs > minAllowedMs && chunksFetched < maxChunks) {
      const cursorStartMs = Math.max(
        opts.before ? minAllowedMs : startTargetMs,
        cursorEndMs - chunkDays * 86400 * 1000
      );
      const fromStr = this.formatISTDate(cursorStartMs);
      const toStr = this.formatISTDate(cursorEndMs);
      const chunk = await this.fetchUpstoxHistoricalChunk(upstoxKey, unit, interval, fromStr, toStr);
      chunksFetched++;

      for (const c of chunk) {
        if (opts.before && c.time >= opts.before) continue;
        if (opts.from && c.time < opts.from) continue;
        if (opts.to && c.time > opts.to) continue;
        mergedMap.set(c.time, c);
      }

      cursorEndMs = cursorStartMs - 86400 * 1000;

      if (opts.before) {
        if (mergedMap.size >= (opts.limit || 300)) break;
        if (chunksFetched >= 2 && mergedMap.size > 0) break;
      } else if (cursorEndMs <= startTargetMs) {
        break;
      }
    }

    let sorted = Array.from(mergedMap.values()).sort((a, b) => a.time - b.time);
    let hasMore = cursorEndMs > minAllowedMs && sorted.length > 0;

    if (opts.limit && sorted.length > opts.limit) {
      sorted = sorted.slice(-opts.limit);
      hasMore = true;
    }

    let sessionDateIST: string | null = null;
    let prevSessionClose: number | null = null;

    if (sorted.length > 0) {
      const latestBar = sorted[sorted.length - 1];
      sessionDateIST = this.formatISTDate(latestBar.time * 1000);
      for (let i = sorted.length - 2; i >= 0; i--) {
        const dStr = this.formatISTDate(sorted[i].time * 1000);
        if (dStr < sessionDateIST) {
          prevSessionClose = sorted[i].close;
          break;
        }
      }

      if (!opts.before) {
        const existingQuote = this.quotes.get(inst.globalId);
        const latestTimeMs = latestBar.time * 1000;
        if (!existingQuote || latestTimeMs >= existingQuote.providerTimestamp) {
          // Honest last-known snapshot derived from the latest provider candle. We deliberately do
          // NOT synthesise a bid/ask spread from a candle close - that would look like an
          // executable live book. Only ltp/OHLC/volume are populated.
          this.quotes.set(inst.globalId, {
            globalId: inst.globalId,
            token: inst.token,
            ltp: latestBar.close,
            open: existingQuote?.open ?? latestBar.open,
            high: existingQuote ? Math.max(existingQuote.high, latestBar.high) : latestBar.high,
            low: existingQuote ? Math.min(existingQuote.low, latestBar.low) : latestBar.low,
            close: prevSessionClose ?? existingQuote?.close ?? latestBar.open,
            volume: latestBar.volume,
            providerTimestamp: latestTimeMs,
            receiveTimestamp: Date.now(),
            source: 'UPSTOX',
            isSimulated: false,
          });
        }
      }
    }

    return {
      candles: sorted,
      hasMore,
      earliestTime: sorted.length > 0 ? sorted[0].time : null,
      latestTime: sorted.length > 0 ? sorted[sorted.length - 1].time : null,
      sessionDateIST,
      prevSessionClose,
      providerError: null,
    };
  }

  public async getCandles(globalId: string, timeframe: Timeframe, count: number = 500): Promise<Candle[]> {
    const page = await this.getCandlesPaginated(globalId, timeframe, { limit: count });
    return page.candles;
  }

  public async getQuote(globalId: string): Promise<QuoteSnapshot | null> {
    const inst = this.resolveInstrument(globalId);
    if (!inst || !inst.upstoxInstrumentKey) return null;

    const cached = this.quotes.get(inst.globalId);
    if (cached && Date.now() - cached.receiveTimestamp < 2500) {
      return cached;
    }

    const upstoxKey = inst.upstoxInstrumentKey;

    // 1. Authenticated Upstox Market Quote V2 if token is configured
    if (this.hasConfiguredToken()) {
      try {
        const url = `https://api.upstox.com/v2/market-quote/quotes?instrument_key=${encodeURIComponent(upstoxKey)}`;
        const res = await fetch(url, { headers: this.getAuthHeaders() });
        if (res.ok) {
          const json = (await res.json()) as any;
          const dataMap = json?.data || {};
          const item = dataMap[upstoxKey] || Object.values(dataMap)[0] as any;
          if (item && Number(item.last_price) > 0) {
            this.isTokenVerified = true;
            const ltp = Number(item.last_price);
            const ohlc = item.ohlc || {};
            const depthBuy = item.depth?.buy?.[0];
            const depthSell = item.depth?.sell?.[0];
            const snap: QuoteSnapshot = {
              globalId: inst.globalId,
              token: inst.token,
              ltp,
              open: Number(ohlc.open || ltp),
              high: Number(ohlc.high || ltp),
              low: Number(ohlc.low || ltp),
              close: Number(ohlc.close || ltp),
              bidPrice: depthBuy?.price ? Number(depthBuy.price) : Number((ltp - inst.tickSize).toFixed(2)),
              bidQty: depthBuy?.quantity ? Number(depthBuy.quantity) : undefined,
              askPrice: depthSell?.price ? Number(depthSell.price) : Number((ltp + inst.tickSize).toFixed(2)),
              askQty: depthSell?.quantity ? Number(depthSell.quantity) : undefined,
              volume: item.volume !== undefined ? Number(item.volume) : undefined,
              openInterest: item.oi !== undefined ? Number(item.oi) : undefined,
              providerTimestamp: item.last_trade_time ? Number(item.last_trade_time) : Date.now(),
              receiveTimestamp: Date.now(),
              source: 'UPSTOX',
              isSimulated: false,
            };
            this.quotes.set(inst.globalId, snap);
            return snap;
          }
        }
      } catch {
        // Fall through
      }
    }

    // 2. Unauthenticated Mode: Do NOT synthesize executable "LIVE" quotes from candle closes.
    // If the token is missing, return cached quote if available or null.
    // Historical candle-derived values can be viewed in the chart, but are NOT served as fresh executable live quotes.
    return cached || null;
  }

  private scheduleWebSocketReconnect(): void {
    if (this.isDisposed || !this.hasConfiguredToken()) return;
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
    }
    const delayMs = Math.min(30000, 2000 * Math.pow(1.6, Math.min(this.wsReconnectAttempts, 6)));
    this.wsReconnectAttempts++;
    this.wsReconnectTimer = setTimeout(() => {
      this.wsReconnectTimer = null;
      if (!this.isDisposed && !this.isConnected) {
        this.connectWebSocket().catch(() => {});
      }
    }, delayMs);
  }

  private async connectWebSocket(): Promise<void> {
    if (!this.hasConfiguredToken() || this.isDisposed) return;
    try {
      const authRes = await fetch('https://api.upstox.com/v3/feed/market-data-feed/authorize', {
        headers: this.getAuthHeaders(),
      });
      if (!authRes.ok) {
        this.isConnected = false;
        this.isTokenVerified = false;
        this.lastErrorReason = `Upstox Market Data Feed V3 authorization failed (HTTP ${authRes.status}). Verify UPSTOX_ANALYTICS_TOKEN in packages/backend/.env.`;
        this.scheduleWebSocketReconnect();
        return;
      }
      const authJson = (await authRes.json()) as any;
      const wsUrl = authJson?.data?.authorizedRedirectUri || authJson?.data?.authorized_redirect_uri;
      if (!wsUrl) {
        this.isConnected = false;
        this.lastErrorReason = 'Upstox authorize endpoint did not return an authorizedRedirectUri.';
        this.scheduleWebSocketReconnect();
        return;
      }

      this.isTokenVerified = true;
      if (this.ws) {
        try {
          this.ws.removeAllListeners();
          this.ws.close();
        } catch {}
      }
      this.clearWsHeartbeat();
      this.ws = new WebSocket(wsUrl, { followRedirects: true });

      this.ws.on('open', () => {
        this.isConnected = true;
        this.wsReconnectAttempts = 0;
        this.lastErrorReason = null;
        this.lastPongAt = Date.now();
        this.startWsHeartbeat();
        this.sendActiveWebSocketSubscriptions();
      });

      this.ws.on('pong', () => {
        this.lastPongAt = Date.now();
      });

      this.ws.on('message', (data: Buffer) => {
        this.lastPongAt = Date.now();
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as any);
        this.handleBinaryFeedPacket(buf);
      });

      this.ws.on('error', (err) => {
        this.isConnected = false;
        this.lastErrorReason = `Upstox WebSocket error: ${err.message}`;
      });

      this.ws.on('close', () => {
        this.isConnected = false;
        this.clearWsHeartbeat();
        this.scheduleWebSocketReconnect();
      });
    } catch (err: any) {
      this.isConnected = false;
      this.lastErrorReason = `Upstox WebSocket connection error: ${err?.message || 'Unknown'}`;
      this.scheduleWebSocketReconnect();
    }
  }

  /**
   * Upstox (and mobile/NAT paths) silently drop half-open sockets. A heartbeat lets us notice a
   * dead feed and reconnect instead of serving stale quotes until the next user action.
   */
  private startWsHeartbeat(): void {
    this.clearWsHeartbeat();
    this.wsHeartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      const lastActivity = Math.max(this.lastPongAt, this.lastProviderEventAt);
      if (Date.now() - lastActivity > 90000) {
        this.lastErrorReason = 'Upstox WebSocket heartbeat timeout; reconnecting.';
        this.isConnected = false;
        try {
          this.ws.terminate();
        } catch {}
        return;
      }
      try {
        this.ws.ping();
      } catch {}
    }, 25000);
    if (typeof this.wsHeartbeatTimer.unref === 'function') this.wsHeartbeatTimer.unref();
  }

  private clearWsHeartbeat(): void {
    if (this.wsHeartbeatTimer) {
      clearInterval(this.wsHeartbeatTimer);
      this.wsHeartbeatTimer = null;
    }
  }

  private sendActiveWebSocketSubscriptions(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const keys: string[] = [];
    for (const globalId of this.listeners.keys()) {
      const inst = this.resolveInstrument(globalId);
      if (inst?.upstoxInstrumentKey) keys.push(inst.upstoxInstrumentKey);
    }
    if (keys.length === 0) return;
    const uniqueKeys = Array.from(new Set(keys));
    for (let i = 0; i < uniqueKeys.length; i += 100) {
      const batch = uniqueKeys.slice(i, i + 100);
      const payload = {
        guid: `tz-${Date.now()}-${i}`,
        method: 'sub',
        data: {
          mode: 'full',
          instrumentKeys: batch,
        },
      };
      this.ws.send(Buffer.from(JSON.stringify(payload), 'utf8'));
    }
  }

  public handleBinaryFeedPacket(buf: Buffer): void {
    const now = Date.now();
    this.providerEventsCount += 1;
    this.lastProviderEventAt = now;
    const ticks = decodeUpstoxFeedResponseProto(buf);
    if (ticks.length > 0) {
      this.decodedTicksCount += ticks.length;
      this.lastDecodeAt = now;
    }
    for (const t of ticks) {
      const inst = this.byUpstoxKey.get(t.instrumentKey);
      if (!inst || !Number.isFinite(t.ltp) || t.ltp <= 0) continue;
      const prev = this.quotes.get(inst.globalId);
      const providerTs = t.ltt > 0 ? t.ltt : now;
      if (prev && t.ltt > 0 && prev.providerTimestamp > 0 && t.ltt < prev.providerTimestamp) {
        this.droppedOutOfOrderCount += 1;
        continue;
      }
      if (
        prev &&
        t.ltt > 0 &&
        prev.providerTimestamp === providerTs &&
        prev.ltp === t.ltp &&
        (t.volume === undefined || prev.volume === t.volume) &&
        (t.bidPrice === undefined || prev.bidPrice === t.bidPrice) &&
        (t.askPrice === undefined || prev.askPrice === t.askPrice)
      ) {
        this.duplicateTickCount += 1;
        continue;
      }
      this.lastTickTime = now;
      const snap: QuoteSnapshot = {
        globalId: inst.globalId,
        token: inst.token,
        ltp: t.ltp,
        open: t.open ?? prev?.open ?? t.ltp,
        high: t.high ?? Math.max(prev?.high ?? t.ltp, t.ltp),
        low: t.low ?? Math.min(prev?.low ?? t.ltp, t.ltp),
        close: t.cp > 0 ? t.cp : prev?.close ?? t.ltp,
        bidPrice: t.bidPrice ?? prev?.bidPrice ?? Number((t.ltp - inst.tickSize).toFixed(2)),
        bidQty: t.bidQty ?? prev?.bidQty,
        askPrice: t.askPrice ?? prev?.askPrice ?? Number((t.ltp + inst.tickSize).toFixed(2)),
        askQty: t.askQty ?? prev?.askQty,
        volume: t.volume ?? prev?.volume,
        openInterest: t.oi ?? prev?.openInterest,
        providerTimestamp: providerTs,
        receiveTimestamp: now,
        source: 'UPSTOX',
        isSimulated: false,
      };
      this.quotes.set(inst.globalId, snap);
      const subs = this.listeners.get(inst.globalId);
      if (subs) subs.forEach((cb) => cb(snap));
    }
  }

  public getTelemetry() {
    return {
      providerEventsCount: this.providerEventsCount,
      decodedTicksCount: this.decodedTicksCount,
      droppedOutOfOrderCount: this.droppedOutOfOrderCount,
      duplicateTickCount: this.duplicateTickCount,
      lastProviderEventAt: this.lastProviderEventAt,
      lastDecodeAt: this.lastDecodeAt,
      cachedQuotesCount: this.quotes.size,
      wsConnected: this.isConnected,
    };
  }

  private async pollSubscribedIntradayQuotes(): Promise<void> {
    if (this.isConnected || this.isDisposed) return; // WebSocket is streaming directly
    const activeIds = Array.from(this.listeners.keys()).filter(
      (id) => (this.listeners.get(id)?.size || 0) > 0
    );
    if (activeIds.length === 0) return;

    // Poll in reverse registration order so newly subscribed chart/position instruments get highest priority
    const prioritizedIds = [...activeIds].reverse().slice(0, 16);
    for (const globalId of prioritizedIds) {
      try {
        const q = await this.getQuote(globalId);
        if (q) {
          this.lastTickTime = q.receiveTimestamp;
          const subs = this.listeners.get(globalId);
          if (subs) subs.forEach((cb) => cb(q));
        }
      } catch {
        // Ignore individual quote errors during background polling
      }
    }
  }

  public subscribe(globalId: string, listener: (quote: QuoteSnapshot) => void): () => void {
    const inst = this.resolveInstrument(globalId);
    const key = inst ? inst.globalId : globalId;
    if (!this.listeners.has(key)) {
      this.listeners.set(key, new Set());
    }
    this.listeners.get(key)!.add(listener);

    if (this.isConnected && this.ws?.readyState === WebSocket.OPEN && inst?.upstoxInstrumentKey) {
      const payload = {
        guid: `tz-sub-${Date.now()}`,
        method: 'sub',
        data: {
          mode: 'full',
          instrumentKeys: [inst.upstoxInstrumentKey],
        },
      };
      this.ws.send(Buffer.from(JSON.stringify(payload), 'utf8'));
    }

    // Immediately deliver cached or freshly fetched snapshot so newly subscribed charts/positions reconcile right away
    this.getQuote(key)
      .then((snap) => {
        if (snap && this.listeners.get(key)?.has(listener)) {
          listener(snap);
        }
      })
      .catch(() => {});

    return () => {
      this.listeners.get(key)?.delete(listener);
    };
  }

  public getFeedHealth(): FeedHealth {
    const now = Date.now();
    const age = this.lastTickTime > 0 ? now - this.lastTickTime : Infinity;

    const nseSession = getExchangeSessionStatus('NSE', new Date());
    const mcxSession = getExchangeSessionStatus('MCX', new Date());
    const isAnyExchangeOpen = nseSession.isOpen || mcxSession.isOpen;

    if (!this.hasConfiguredToken()) {
      return {
        source: 'UPSTOX',
        status: 'CONFIGURATION_REQUIRED',
        latencyMs: 0,
        lastTickTimestamp: this.lastTickTime,
        lastProviderEventTime: this.lastTickTime,
        lastServerReceiveTime: now,
        isSimulated: false,
        activeSubscriptionsCount: this.listeners.size,
        uiBannerLabel: 'UPSTOX V3: CONFIGURATION REQUIRED — ADD TOKEN FOR LIVE STREAMING',
        message:
          this.lastErrorReason ||
          'UPSTOX_ANALYTICS_TOKEN is not configured in packages/backend/.env. Historical Upstox V3 candles are accessible for analysis, but live executable quotes and WebSocket streaming require a valid token.',
        marketSession: {
          isMarketOpen: isAnyExchangeOpen,
          sessionName: mcxSession.isOpen ? mcxSession.sessionName : nseSession.sessionName,
          nextTransitionIST: mcxSession.isOpen ? mcxSession.nextEventDescription : nseSession.nextEventDescription,
          message: isAnyExchangeOpen ? 'Market Open' : 'Market Closed',
        },
        supportedSegments: { equity: true, fno: true, commodities: true },
      };
    }

    let status: FeedStatus;
    if (!this.isTokenVerified) {
      status = 'NOT_LIVE_VERIFIED';
    } else if (!this.isConnected) {
      status = 'DISCONNECTED';
    } else if (!isAnyExchangeOpen) {
      status = 'MARKET_CLOSED';
    } else if (age > 15000) {
      status = 'STALE';
    } else if (age > 5000) {
      status = 'DELAYED';
    } else {
      status = 'LIVE';
    }

    const sessionDesc = mcxSession.isOpen
      ? `MCX Open (${mcxSession.sessionName}) • NSE Closed`
      : nseSession.isOpen
        ? `NSE Open (${nseSession.sessionName}) • MCX Closed`
        : `All Indian Exchanges Closed • Next: ${nseSession.nextEventDescription}`;

    return {
      source: 'UPSTOX',
      status,
      latencyMs: this.isConnected ? Math.min(age, 999) : 0,
      lastTickTimestamp: this.lastTickTime,
      lastProviderEventTime: this.lastTickTime,
      lastServerReceiveTime: now,
      isSimulated: false,
      activeSubscriptionsCount: this.listeners.size,
      uiBannerLabel:
        status === 'LIVE'
          ? 'LIVE MARKET DATA (UPSTOX V3)'
          : `UPSTOX FEED ${status} — PAPER TRADING ONLY`,
      message: this.lastErrorReason || sessionDesc,
      marketSession: {
        isMarketOpen: isAnyExchangeOpen,
        sessionName: mcxSession.isOpen ? mcxSession.sessionName : nseSession.sessionName,
        nextTransitionIST: mcxSession.isOpen ? mcxSession.nextEventDescription : nseSession.nextEventDescription,
        message: sessionDesc,
      },
      supportedSegments: { equity: true, fno: true, commodities: true },
    };
  }

  public async dispose(): Promise<void> {
    this.isDisposed = true;
    this.clearWsHeartbeat();
    if (this.wsReconnectTimer) {
      clearTimeout(this.wsReconnectTimer);
      this.wsReconnectTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.isConnected = false;
    this.listeners.clear();
  }
}

