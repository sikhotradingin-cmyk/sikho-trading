import { Candle, InstrumentMetadata, QuoteSnapshot, Timeframe } from '@trading/shared';
import { FeedHealth, IMarketDataProvider } from './types.js';

/**
 * Angel One SmartAPI Market Data Adapter (Specification-Compliant Connector)
 *
 * Official Technical Specifications & Sources:
 * - Authentication & Token Lifecycle: https://smartapi.angelbroking.com/docs/User
 *   * Login: POST /rest/auth/angelbroking/user/v1/loginByPassword (apiKey, clientCode, password, totp)
 *   * Token Refresh: POST /rest/auth/angelbroking/jwt/v1/generateTokens (refreshToken)
 * - Instrument Master: https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json
 * - Historical Data: POST /rest/secure/angelbroking/historical/v1/getCandleData
 *   * Rate Limits: 3 req/sec, 180 req/min, 5,000 req/hr
 * - Live Streaming: WebSocket 2.0 (wss://smartapisocket.angelone.in/smart-stream)
 *   * Protocol: Binary byte-packed feed (Mode 1: LTP, Mode 2: Quote, Mode 3: SnapQuote)
 *   * Limit: Maximum 3 active concurrent WebSocket sessions per client code
 * - Security & Redistribution:
 *   * STRICT DISCLAIMER: SmartAPI access is strictly for active Angel One client automated trading.
 *   * Public redistribution of real-time market data to mobile users requires an explicit Exchange
 *     Market Data License (e.g. NSE Data & Analytics Level 1/2 License) or authorized distributor agreement.
 */

export interface SmartAPIConfig {
  apiKey?: string;
  clientCode?: string;
  password?: string;
  totpSecret?: string;
}

export class SmartAPIAdapter implements IMarketDataProvider {
  public readonly providerId = 'SMARTAPI';
  public readonly config: SmartAPIConfig;
  private isConfigured: boolean;
  public jwtToken: string | null = null;
  public refreshToken: string | null = null;
  public feedToken: string | null = null;
  private lastTickTimestamp: number = 0;

  constructor(config: SmartAPIConfig = {}) {
    this.config = config;
    this.isConfigured = Boolean(
      config.apiKey && config.clientCode && config.password && config.totpSecret
    );
  }

  public async init(): Promise<void> {
    if (!this.isConfigured) {
      // In accordance with specification: DO NOT invent credentials, a sandbox, or successful live tests.
      // Record status as NOT_LIVE_VERIFIED.
      return;
    }
    // If live credentials are supplied in backend environment, authentication would be invoked here.
  }

  public async getInstruments(): Promise<InstrumentMetadata[]> {
    if (!this.isConfigured) {
      return [];
    }
    throw new Error('SmartAPI credentials configured but live network ingestion is disabled pending redistribution agreement.');
  }

  /**
   * Resolves currently eligible contracts dynamically from the official Angel One Scrip Master.
   * Filters by exchange segment, instruments, and guarantees contracts are not expired relative to today.
   */
  public resolveCurrentContracts(scripMaster: any[]): InstrumentMetadata[] {
    const today = new Date().toISOString().split('T')[0];
    const niftyFutures = scripMaster.filter((item: any) => 
      item.exch_seg === 'NFO' &&
      item.instrumenttype === 'FUTIDX' &&
      item.name === 'NIFTY' &&
      item.expiry >= today
    );
    // Sort ascending by expiry date to pick near-month contract first
    niftyFutures.sort((a: any, b: any) => a.expiry.localeCompare(b.expiry));

    return niftyFutures.map((item: any) => ({
      globalId: `NFO:${item.symbol}:${item.token}`,
      provider: 'SMARTAPI' as const,
      exchange: 'NFO' as const,
      token: item.token,
      symbol: item.symbol,
      name: item.name,
      instrumentType: 'FUTIDX' as const,
      isTradable: true,
      lotSize: parseInt(item.lotsize || '25', 10),
      tickSize: parseFloat(item.tick_size || '0.05'),
      expiry: item.expiry,
      underlying: 'NIFTY',
      isSimulatedFixture: false,
    }));
  }

  public async getCandles(_globalId: string, _timeframe: Timeframe, _count?: number): Promise<Candle[]> {
    if (!this.isConfigured) {
      return [];
    }
    throw new Error('SmartAPI live candle retrieval requires verified active credentials and static IP.');
  }

  public async getQuote(_globalId: string): Promise<QuoteSnapshot | null> {
    if (!this.isConfigured) {
      return null;
    }
    return null;
  }

  public subscribe(_globalId: string, _listener: (quote: QuoteSnapshot) => void): () => void {
    return () => {};
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
        uiBannerLabel: 'SMARTAPI — NOT LIVE-VERIFIED (CREDENTIALS NOT PROVIDED)',
        message: 'No live SmartAPI credentials supplied in backend environment. Fallback to Deterministic Demo Provider.',
      };
    }

    return {
      source: 'SMARTAPI',
      status: 'DISCONNECTED',
      latencyMs: 0,
      lastTickTimestamp: this.lastTickTimestamp,
      isSimulated: false,
      activeSubscriptionsCount: 0,
      uiBannerLabel: 'SMARTAPI — REDISTRIBUTION PERMISSION REQUIRED',
      message: 'Broker connection awaiting official exchange redistribution agreement.',
    };
  }

  public async dispose(): Promise<void> {
    this.jwtToken = null;
    this.refreshToken = null;
    this.feedToken = null;
  }
}
