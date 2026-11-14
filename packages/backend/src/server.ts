import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import {
  DisciplineGuard,
  Money,
  OrderValidator,
  PerformanceAnalytics,
  PlaceOrderRequest,
  Timeframe,
  ClosedTradeRecord,
  QuoteSnapshot,
  COMMODITY_CONTRACT_SPECS,
  getExchangeSessionStatus,
  InstrumentMetadata,
  isFreeTierAllowedInstrument,
  UserTier,
} from '@trading/shared';
import { config, isPlaceholderCredential, validateSmartApiEnv, validateUpstoxEnv } from './config.js';
import { DeterministicProvider } from './providers/deterministic-provider.js';
import { IMarketDataProvider } from './providers/types.js';
import { SmartAPIAdapter, isIndianMarketOpen } from './providers/smartapi-adapter.js';
import { UpstoxAdapter } from './providers/upstox-adapter.js';
import { SimulationEngine } from './engine/simulation-engine.js';
import { VirtualAccountEngine } from './engine/virtual-account-engine.js';
import { initializeDatabase, IDatabase } from './db/database.js';
import { PostgresRepository } from './db/postgres-repository.js';
import { BillingService } from './monetization/billing-service.js';
import { AdsCoordinator } from './monetization/ads-coordinator.js';
import { FormingCandleTracker } from './market/forming-candles.js';
import { WebSocket } from 'ws';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { OAuth2Client } from 'google-auth-library';

// Ensure BigInt can be serialized to JSON safely
if (!(BigInt.prototype as any).toJSON) {
  (BigInt.prototype as any).toJSON = function () {
    return this.toString();
  };
}

/** Application version advertised by /health (kept in sync with the Android versionName). */
export const SERVICE_VERSION = '1.0.7';
const SERVICE_STARTED_AT = new Date().toISOString();

/** Browser/WebSocket clients must be told the server clock so countdowns can be corrected. */
export const WS_HEARTBEAT_INTERVAL_MS = 25000;

/**
 * Pure validation of an already cryptographically verified Google ID token payload.
 * Exported so the identity rules are unit-testable without network access to Google.
 */
export function validateGoogleIdTokenPayload(
  payload: any,
  configuredClientId: string
): { ok: true } | { ok: false; code: string; error: string } {
  if (!payload || !payload.email) {
    return { ok: false, code: 'ERR_INVALID_GOOGLE_TOKEN', error: 'Google ID token payload could not be verified.' };
  }
  if (payload.aud !== configuredClientId) {
    return { ok: false, code: 'ERR_GOOGLE_AUDIENCE_MISMATCH', error: 'Google ID token audience mismatch.' };
  }
  if (payload.email_verified === false) {
    return {
      ok: false,
      code: 'ERR_GOOGLE_EMAIL_UNVERIFIED',
      error: 'Google account email address is not verified by Google.',
    };
  }
  if (!payload.sub || typeof payload.sub !== 'string') {
    return {
      ok: false,
      code: 'ERR_GOOGLE_SUBJECT_MISSING',
      error: 'Google ID token is missing the immutable subject identifier.',
    };
  }
  return { ok: true };
}

export async function buildServer(
  customDb?: IDatabase,
  customProviderMode?: 'UPSTOX' | 'SMARTAPI' | 'DEMO'
): Promise<{
  app: FastifyInstance;
  provider: IMarketDataProvider;
  accountEngine: VirtualAccountEngine;
  simEngine: SimulationEngine;
  repo: PostgresRepository;
  db: IDatabase;
  billingService: BillingService;
}> {
  const app = Fastify({ logger: false });

  const corsOrigin = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim())
    : true;
  await app.register(cors, { origin: corsOrigin });
  await app.register(jwt, { secret: config.jwtSecret });
  await app.register(websocket);

  // Security: Restrict development access strictly to loopback and RFC 1918 private LAN addresses ONLY in local dev if explicitly requested
  if (process.env.ENFORCE_LOCAL_DEV_IP === 'true') {
    app.addHook('onRequest', async (req, reply) => {
      const rawIp = req.ip || req.socket.remoteAddress || '';
      const cleanIp = rawIp.replace(/^::ffff:/, ''); // normalize IPv4-mapped IPv6
      const isPrivate =
        cleanIp === '127.0.0.1' ||
        cleanIp === '::1' ||
        cleanIp.startsWith('10.') ||
        cleanIp.startsWith('192.168.') ||
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(cleanIp);

      if (!isPrivate) {
        return reply.status(403).send({
          error: 'ERR_NON_LOCAL_DEV_ACCESS',
          message: 'Development server is restricted to loopback and local private networks only.',
        });
      }
    });
  }

  // Database & Repositories (automatically connects pool and executes pending migrations if DATABASE_URL is configured)
  // Use the validated config value: in test execution this resolves to TEST_DATABASE_URL (or the emulated
  // database), never the production DATABASE_URL that may be present in a shell or .env file.
  const db = customDb || (await initializeDatabase(config.databaseUrl));
  const repo = new PostgresRepository(db);
  const accountEngine = new VirtualAccountEngine();
  const simEngine = new SimulationEngine(repo);
  const billingService = new BillingService(db);
  const adsCoordinator = new AdsCoordinator();

  const isNodeTestContext = Boolean(process.env.NODE_TEST_CONTEXT) && !customProviderMode;

  // Initialize Providers
  const demoProvider = new DeterministicProvider();
  await demoProvider.init();

  const smartApiAdapter = new SmartAPIAdapter(isNodeTestContext ? {} : config.smartApi);
  if (!isNodeTestContext && (customProviderMode === 'SMARTAPI' || config.providerMode === 'SMARTAPI')) {
    await smartApiAdapter.init();
  }

  const upstoxAdapter = new UpstoxAdapter(isNodeTestContext ? {} : config.upstox);
  if (
    customProviderMode === 'UPSTOX' ||
    (!isNodeTestContext && (config.providerMode === 'UPSTOX' || !config.providerMode))
  ) {
    await upstoxAdapter.init();
  }

  // Resolve Active Provider without silent cross-provider fallback
  let activeProvider: IMarketDataProvider = demoProvider;
  const effectiveMode = customProviderMode || (isNodeTestContext ? 'DEMO' : config.providerMode || 'UPSTOX');
  if (effectiveMode === 'UPSTOX') {
    activeProvider = upstoxAdapter;
  } else if (effectiveMode === 'SMARTAPI') {
    activeProvider = smartApiAdapter;
  } else {
    activeProvider = demoProvider;
  }

  // Sync default instruments to PostgreSQL
  const instruments = await activeProvider.getInstruments();
  await repo.syncInstruments(instruments);

  app.addHook('onClose', async () => {
    await demoProvider.dispose();
    await smartApiAdapter.dispose();
    await upstoxAdapter.dispose();
    await db.close();
  });

  // Active WebSocket clients
  const wsClients = new Set<{
    ws: WebSocket;
    userId?: string;
    accountId?: string;
    tier: UserTier;
    subscriptions: Set<string>;
  }>();
  const engineSubscribedIds = new Set<string>();

  const notifyActiveUserWebSocketsTierChanged = async (userId: string) => {
    const entitlement = await billingService.resolveEntitlement(userId);
    let openPositionSymbols = new Set<string>();
    try {
      const account = await repo.provisionInitialAccount(userId);
      if (account) {
        const userPositions = await repo.getPositions(account.id);
        for (const pos of userPositions) {
          if (pos.quantity !== 0) {
            openPositionSymbols.add(pos.globalInstrumentId);
          }
        }
      }
    } catch { }

    for (const client of wsClients) {
      if (client.userId === userId) {
        client.tier = entitlement.tier;
        if (entitlement.tier === 'FREE') {
          for (const sym of Array.from(client.subscriptions)) {
            if (openPositionSymbols.has(sym)) continue;
            const inst =
              instruments.find((i) => i.globalId === sym || i.symbol === sym) ||
              parseFallbackInstrument(sym);
            if (!isFreeTierAllowedInstrument(inst)) {
              client.subscriptions.delete(sym);
            }
          }
        }
        if (client.ws.readyState === WebSocket.OPEN) {
          client.ws.send(
            JSON.stringify({
              type: 'ENTITLEMENT_UPDATED',
              tier: entitlement.tier,
              entitlement,
            })
          );
        }
      }
    }
  };

  // Centralised (server-side) forming-candle aggregation. Session-open aligned, true-epoch bars so
  // that snapshots reconcile with provider history instead of creating phantom future candles.
  const formingTracker = new FormingCandleTracker();
  let wsTicksEmitted = 0;
  let lastWsEmitTime = 0;

  const ensureEngineSubscription = (globalId: string) => {
    if (engineSubscribedIds.has(globalId)) return;
    engineSubscribedIds.add(globalId);
    activeProvider.subscribe(globalId, (quote: QuoteSnapshot) => {
      simEngine.onMarketTick(quote).catch(() => { });
      formingTracker.applyTick(quote);
      const msg = JSON.stringify({ type: 'QUOTE_TICK', data: quote });
      for (const client of wsClients) {
        if (client.subscriptions.has(globalId) || client.subscriptions.has(quote.globalId)) {
          if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(msg);
            wsTicksEmitted += 1;
            lastWsEmitTime = Date.now();
          }
        }
      }
    });
  };

  for (const inst of instruments) {
    ensureEngineSubscription(inst.globalId);
  }

  const openInstIds = await repo.getAllOpenPositionInstrumentIds();
  for (const gid of openInstIds) {
    ensureEngineSubscription(gid);
  }

  const formatAccountResponse = (account: any) => ({
    ...account,
    startingBalanceINR: Money.toRupees(account.startingBalancePaise),
    cashBalanceINR: Money.toRupees(account.cashBalancePaise),
    lockedMarginINR: Money.toRupees(account.lockedMarginPaise),
    availableBalanceINR: Money.toRupees(account.availableBalancePaise),
  });

  // Serve bundled Android WebView assets on root for local inspection & visual verification
  const wwwRootCandidates = [
    path.resolve(process.cwd(), 'packages/mobile/android/app/src/main/assets/www'),
    path.resolve(__dirname, '../../mobile/android/app/src/main/assets/www'),
    path.resolve(__dirname, '../../../mobile/android/app/src/main/assets/www'),
  ];
  const wwwDir = wwwRootCandidates.find((p) => fs.existsSync(p));
  if (wwwDir) {
    const serveAsset = (fileName: string, contentType: string) => async (_req: any, reply: any) => {
      const fullPath = path.join(wwwDir, fileName);
      if (!fs.existsSync(fullPath)) return reply.status(404).send('Not found');
      reply.header('Content-Type', contentType);
      return fs.readFileSync(fullPath);
    };
    app.get('/', serveAsset('index.html', 'text/html; charset=utf-8'));
    app.get('/index.html', serveAsset('index.html', 'text/html; charset=utf-8'));
    app.get('/styles.css', serveAsset('styles.css', 'text/css; charset=utf-8'));
    app.get('/app.js', serveAsset('app.js', 'application/javascript; charset=utf-8'));
    app.get('/instrument-identity.js', serveAsset('instrument-identity.js', 'application/javascript; charset=utf-8'));
    app.get('/app-icon.png', serveAsset('app-icon.png', 'image/png'));
    app.get('/lightweight-charts.standalone.production.js', serveAsset('lightweight-charts.standalone.production.js', 'application/javascript; charset=utf-8'));
    app.get('/lightweight-charts.js', serveAsset('lightweight-charts.standalone.production.js', 'application/javascript; charset=utf-8'));
  }

  // Lightweight Health Check (for device connectivity & auto-discovery probes)
  app.get('/health', async () => {
    return {
      status: 'ok',
      serverTimestamp: Date.now(),
      mode: activeProvider.providerId,
      // Deployment identity so the delivered revision can be verified independently of a
      // hosting dashboard (Render exposes RENDER_GIT_COMMIT to the running service).
      revision: (process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || 'unknown').trim(),
      version: SERVICE_VERSION,
      startedAt: SERVICE_STARTED_AT,
    };
  });

  // 1. Health & Feed Status
  app.get('/api/v1/feed-health', async () => {
    const upstoxValidation = validateUpstoxEnv(config.upstox);
    const smartApiValidation = validateSmartApiEnv(config.smartApi);
    return {
      activeProvider: activeProvider.getFeedHealth(),
      upstoxStatus: {
        ...upstoxAdapter.getFeedHealth(),
        hasTokenConfigured: upstoxValidation.isFullyValid,
      },
      smartApiStatus: {
        ...smartApiAdapter.getFeedHealth(),
        hasCredentialsConfigured: smartApiValidation.isFullyValid,
      },
      googleOAuthConfigured: Boolean(config.googleClientId && config.googleClientId.trim().length > 0),
      googleClientId: config.googleClientId?.trim() || null,
      databaseEmulated: db.isEmulated(),
      serverTimestamp: Date.now(),
      telemetry: {
        ...upstoxAdapter.getTelemetry(),
        wsTicksEmitted,
        lastWsEmitTime,
        wsClientsCount: wsClients.size,
        ...formingTracker.getTelemetry(),
      },
      marketSession: {
        isMarketOpen: isIndianMarketOpen(),
        exchange: 'NSE',
        tradingHoursIST: '09:15 - 15:30',
        note: isIndianMarketOpen()
          ? 'Market is currently OPEN'
          : 'Market is currently CLOSED (09:15 - 15:30 IST). Showing latest available session data.',
      },
    };
  });

  // 2A. Safe Dev Login (Preserved for automated test suites; disabled in production)
  app.post('/api/v1/auth/dev-login', async (req, reply) => {
    if (process.env.NODE_ENV === 'production' || !config.enableDevAuth) {
      return reply.status(403).send({ error: 'Development authentication is disabled in production.' });
    }
    const body = req.body as { userId?: string; name?: string; tier?: 'FREE' | 'PRO' } | undefined;
    const rawUserId = body?.userId || 'dev-trader-01';
    const userId =
      activeProvider.providerId !== 'DEMO' && !rawUserId.includes(':')
        ? `${rawUserId}:${activeProvider.providerId.toLowerCase()}`
        : rawUserId;
    const userName = body?.name || 'Practicing Retail Trader';
    const tier = body?.tier || 'FREE';

    const account = await repo.provisionInitialAccount(
      userId,
      `${userName}'s Virtual Account (${activeProvider.providerId})`,
      tier
    );
    accountEngine.provisionInitialAccount(userId, `${userName}'s Virtual Account (${activeProvider.providerId})`);

    const token = app.jwt.sign({ userId, accountId: account.id, name: userName, isDevAccount: true });

    return {
      token,
      user: {
        userId,
        name: userName,
        email: `${rawUserId}@dev.tradingzone.local`,
        isDevAccount: true,
        providerMode: activeProvider.providerId,
      },
      account: formatAccountResponse(account),
    };
  });

  // 2B. Real User Sign-Up (Email + Password + Name)
  app.post('/api/v1/auth/register', async (req, reply) => {
    const body = (req.body as { email?: string; password?: string; name?: string }) || {};
    const email = (body.email || '').trim().toLowerCase();
    const password = body.password || '';
    const name = (body.name || email.split('@')[0] || 'Tradingzone Trader').trim();

    if (!email || !email.includes('@')) {
      return reply.status(400).send({ error: 'Please enter a valid email address.', code: 'ERR_INVALID_EMAIL' });
    }
    if (password.length < 6) {
      return reply
        .status(400)
        .send({ error: 'Password must be at least 6 characters long.', code: 'ERR_WEAK_PASSWORD' });
    }

    try {
      const user = await repo.registerUser({ email, name, password });
      const account = await repo.provisionInitialAccount(user.id, `${user.name}'s Practice Account`, 'FREE');
      const entitlement = await billingService.resolveEntitlement(user.id);
      account.tier = entitlement.tier;
      accountEngine.provisionInitialAccount(user.id, `${user.name}'s Practice Account`);

      const token = app.jwt.sign({
        userId: user.id,
        accountId: account.id,
        name: user.name,
        email: user.email,
        isDevAccount: false,
      });

      return {
        token,
        user: {
          userId: user.id,
          name: user.name,
          email: user.email,
          tier: entitlement.tier,
          hasPin: false,
          biometricEnabled: false,
          isDevAccount: false,
          providerMode: activeProvider.providerId,
        },
        account: formatAccountResponse(account),
        entitlement,
      };
    } catch (err: any) {
      return reply.status(400).send({
        error: err.message || 'Registration failed.',
        code: err.message?.split(':')[0] || 'ERR_REGISTER_FAILED',
      });
    }
  });

  // 2C. Real User Sign-In (Email + Password, with rate limiting protection)
  app.post('/api/v1/auth/login', async (req, reply) => {
    const body = (req.body as { email?: string; password?: string; name?: string }) || {};
    const email = (body.email || '').trim().toLowerCase();
    const password = body.password;

    if (!email || !email.includes('@')) {
      return reply.status(400).send({ error: 'Please enter a valid email address.', code: 'ERR_INVALID_EMAIL' });
    }

    const rateKey = `login:${email}`;
    const rl = checkRateLimit(rateKey, 5, 60000, 300000);
    if (!rl.allowed) {
      return reply.status(429).send({ error: rl.error, code: 'ERR_RATE_LIMIT_EXCEEDED', retryAfter: rl.retryAfterSec });
    }

    try {
      let user = await repo.getUserByEmail(email);

      // Password is mandatory. There is deliberately NO passwordless/implicit-registration path:
      // an unauthenticated caller must never be able to claim an email address or obtain a token
      // for an existing account. New users must use /api/v1/auth/register or Google Sign-In.
      if (!password || password.length === 0) {
        return reply.status(401).send({
          error: 'Password is required to sign in. Use "Create new account" to register.',
          code: 'ERR_PASSWORD_REQUIRED',
        });
      }
      if (!user) {
        return reply.status(401).send({
          error: 'No account found for this email. Please create an account first.',
          code: 'ERR_USER_NOT_FOUND',
        });
      }
      user = await repo.authenticateUser(email, password);

      resetRateLimit(rateKey);

      const account = await repo.provisionInitialAccount(user.id, `${user.name}'s Practice Account`, 'FREE');
      const entitlement = await billingService.resolveEntitlement(user.id);
      account.tier = entitlement.tier;
      accountEngine.provisionInitialAccount(user.id, `${user.name}'s Practice Account`);

      const token = app.jwt.sign({
        userId: user.id,
        accountId: account.id,
        name: user.name,
        email: user.email,
        isDevAccount: false,
      });

      return {
        token,
        user: {
          userId: user.id,
          name: user.name,
          email: user.email,
          tier: entitlement.tier,
          hasPin: false,
          biometricEnabled: false,
          isDevAccount: false,
          providerMode: activeProvider.providerId,
        },
        account: formatAccountResponse(account),
        entitlement,
      };
    } catch (err: any) {
      return reply.status(401).send({
        error: err.message || 'Authentication failed.',
        code: err.message?.split(':')[0] || 'ERR_AUTH_FAILED',
      });
    }
  });

  // In-memory rate limiting map for login, PIN verify, and recovery: key -> { count: number, resetAt: number, lockedUntil?: number }
  const rateLimitStore = new Map<string, { count: number; resetAt: number; lockedUntil?: number }>();

  function checkRateLimit(key: string, maxAttempts: number = 5, windowMs: number = 60000, lockoutMs: number = 300000): { allowed: boolean; retryAfterSec?: number; error?: string } {
    const now = Date.now();
    const entry = rateLimitStore.get(key);

    if (entry && entry.lockedUntil && entry.lockedUntil > now) {
      const retryAfterSec = Math.ceil((entry.lockedUntil - now) / 1000);
      return {
        allowed: false,
        retryAfterSec,
        error: `ERR_TOO_MANY_ATTEMPTS: Too many failed attempts. Try again in ${retryAfterSec} seconds.`,
      };
    }

    if (!entry || entry.resetAt <= now) {
      rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true };
    }

    entry.count++;
    if (entry.count > maxAttempts) {
      entry.lockedUntil = now + lockoutMs;
      const retryAfterSec = Math.ceil(lockoutMs / 1000);
      return {
        allowed: false,
        retryAfterSec,
        error: `ERR_RATE_LIMIT_EXCEEDED: Maximum attempts exceeded. Action locked for ${retryAfterSec} seconds.`,
      };
    }

    return { allowed: true };
  }

  function resetRateLimit(key: string): void {
    rateLimitStore.delete(key);
  }

  // 2D. Google Sign-In ID Token Verification (fails closed if audience/client ID unconfigured)
  app.post('/api/v1/auth/google', async (req, reply) => {
    const body = (req.body as { idToken?: string }) || {};
    const configuredClientId = config.googleClientId?.trim();

    if (!configuredClientId || isPlaceholderCredential(configuredClientId)) {
      return reply.status(503).send({
        error:
          'ERR_GOOGLE_OAUTH_NOT_CONFIGURED: Google Sign-In requires a valid GOOGLE_CLIENT_ID configured in packages/backend/.env and matching Google Cloud OAuth 2.0 Client credentials. Request rejected (fails closed).',
        code: 'ERR_GOOGLE_OAUTH_NOT_CONFIGURED',
      });
    }

    if (!body.idToken) {
      return reply.status(400).send({ error: 'Missing Google ID token.', code: 'ERR_MISSING_ID_TOKEN' });
    }

    const rateKey = `google:${req.ip}`;
    const rl = checkRateLimit(rateKey, 10, 60000, 300000);
    if (!rl.allowed) {
      return reply.status(429).send({ error: rl.error, code: 'ERR_RATE_LIMIT_EXCEEDED', retryAfter: rl.retryAfterSec });
    }

    try {
      // Use official maintained Google OAuth2Client library for cryptographic signature, issuer, audience, and expiry verification
      const googleClient = new OAuth2Client(configuredClientId);
      const ticket = await googleClient.verifyIdToken({
        idToken: body.idToken,
        audience: configuredClientId,
      });

      const payload = ticket.getPayload();
      if (!payload) {
        return reply.status(401).send({
          error: 'Google ID token payload could not be verified.',
          code: 'ERR_INVALID_GOOGLE_TOKEN',
        });
      }
      const payloadCheck = validateGoogleIdTokenPayload(payload, configuredClientId);
      if (!payloadCheck.ok) {
        return reply.status(401).send({ error: payloadCheck.error, code: payloadCheck.code });
      }

      resetRateLimit(rateKey);

      const googleEmail = String(payload.email);
      const googleName = payload.name || googleEmail.split('@')[0];
      const user = await repo.upsertGoogleUser({
        email: googleEmail,
        name: googleName,
        googleSub: String(payload.sub),
        avatarUrl: payload.picture,
      });

      const account = await repo.provisionInitialAccount(user.id, `${user.name}'s Practice Account`, 'FREE');
      const entitlement = await billingService.resolveEntitlement(user.id);
      account.tier = entitlement.tier;
      accountEngine.provisionInitialAccount(user.id, `${user.name}'s Practice Account`);

      const token = app.jwt.sign({
        userId: user.id,
        accountId: account.id,
        name: user.name,
        email: user.email,
        isDevAccount: false,
      });

      return {
        token,
        user: {
          userId: user.id,
          name: user.name,
          email: user.email,
          avatarUrl: user.avatarUrl,
          tier: entitlement.tier,
          hasPin: false,
          biometricEnabled: false,
          isDevAccount: false,
          providerMode: activeProvider.providerId,
        },
        account: formatAccountResponse(account),
        entitlement,
      };
    } catch (err: any) {
      return reply.status(401).send({
        error: `Google verification failed: ${err.message}`,
        code: 'ERR_GOOGLE_AUTH_ERROR',
      });
    }
  });

  // 2E. Authenticated Password Change (with rate limiting protection)
  // SECURITY: a bare email is not proof of account ownership. No email-verification provider is
  // configured, so an unauthenticated "reset by email" flow would be a trivial account-takeover
  // vector. Proof of the current password is therefore mandatory (fail closed).
  app.post('/api/v1/auth/recover', async (req, reply) => {
    const body = (req.body as { email?: string; newPassword?: string; currentPassword?: string }) || {};
    const email = (body.email || '').trim().toLowerCase();
    const newPassword = body.newPassword || '';
    const currentPassword = body.currentPassword || '';

    if (!email || !email.includes('@')) {
      return reply.status(400).send({ error: 'Valid email is required.', code: 'ERR_INVALID_EMAIL' });
    }
    if (newPassword.length < 6) {
      return reply
        .status(400)
        .send({ error: 'New password must be at least 6 characters.', code: 'ERR_WEAK_PASSWORD' });
    }
    if (!currentPassword) {
      return reply.status(403).send({
        error:
          'ERR_RECOVERY_PROOF_REQUIRED: Email ownership verification is not configured, so a password change requires your current password. Sign in with Google if this account was created with Google, or contact the owner.',
        code: 'ERR_RECOVERY_PROOF_REQUIRED',
      });
    }

    const rateKey = `recover:${email}`;
    const rl = checkRateLimit(rateKey, 3, 60000, 600000); // 3 attempts per min, 10 min lockout
    if (!rl.allowed) {
      return reply.status(429).send({ error: rl.error, code: 'ERR_RATE_LIMIT_EXCEEDED', retryAfter: rl.retryAfterSec });
    }

    try {
      await repo.authenticateUser(email, currentPassword);
      const user = await repo.resetUserPassword(email, newPassword);
      resetRateLimit(rateKey);
      const account = await repo.provisionInitialAccount(user.id, `${user.name}'s Practice Account`, 'FREE');
      const entitlement = await billingService.resolveEntitlement(user.id);
      account.tier = entitlement.tier;
      const token = app.jwt.sign({
        userId: user.id,
        accountId: account.id,
        name: user.name,
        email: user.email,
        isDevAccount: false,
      });
      return {
        success: true,
        message: 'Account credentials updated. Your virtual portfolio and history have been preserved.',
        token,
        user: {
          userId: user.id,
          name: user.name,
          email: user.email,
          tier: entitlement.tier,
          hasPin: false,
          biometricEnabled: false,
          isDevAccount: false,
          providerMode: activeProvider.providerId,
        },
        account: formatAccountResponse(account),
        entitlement,
      };
    } catch (err: any) {
      const isCredentialError = String(err?.message || '').startsWith('ERR_INVALID_CREDENTIALS');
      return reply.status(isCredentialError ? 401 : 404).send({
        error: err.message || 'Recovery failed.',
        code: isCredentialError ? 'ERR_INVALID_CREDENTIALS' : 'ERR_RECOVERY_FAILED',
      });
    }
  });

  // Authentication Hook for Protected Routes
  app.decorate('authenticate', async (request: any, reply: any) => {
    try {
      await request.jwtVerify();
    } catch {
      reply.status(401).send({ error: 'Unauthorized: Valid JWT Bearer token required.', code: 'ERR_SESSION_EXPIRED' });
    }
  });

  // 2F. Authenticated Session Profile
  app.get('/api/v1/auth/me', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    const user = await repo.getUserById(req.user.userId);
    const account = await repo.getAccount(req.user.accountId);
    if (!account) {
      return reply.status(404).send({ error: 'Account not found', code: 'ERR_ACCOUNT_NOT_FOUND' });
    }
    const entitlement = await billingService.resolveEntitlement(req.user.userId);
    account.tier = entitlement.tier;
    return {
      user: user
        ? {
          userId: user.id,
          name: user.name,
          email: user.email,
          avatarUrl: user.avatarUrl,
          tier: entitlement.tier,
          hasPin: false,
          biometricEnabled: false,
          providerMode: activeProvider.providerId,
        }
        : {
          userId: req.user.userId,
          name: req.user.name,
          email: req.user.email,
          tier: entitlement.tier,
          hasPin: false,
          biometricEnabled: false,
          providerMode: activeProvider.providerId,
        },
      account: formatAccountResponse(account),
      entitlement,
    };
  });

  // 3. Instruments Master with Search, Multi-Facet Filtering, and Pagination
  app.get('/api/v1/instruments', async (req) => {
    const query = req.query as {
      q?: string;
      exchange?: string;
      segment?: string;
      underlying?: string;
      expiry?: string;
      optionType?: string;
      strike?: string;
      page?: string;
      limit?: string;
    };

    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '25', 10)));
    const strikeNum = query.strike ? parseFloat(query.strike) : undefined;

    if (activeProvider.searchInstruments) {
      const searchRes = await activeProvider.searchInstruments({
        q: query.q,
        exchange: query.exchange,
        segment: query.segment,
        underlying: query.underlying,
        expiry: query.expiry,
        optionType: query.optionType,
        strike: strikeNum,
        page,
        limit,
      });

      // Hydrate quotes for top 15 results so search remains snappy
      const enriched = await Promise.all(
        searchRes.instruments.map(async (inst, idx) => {
          const quote = idx < 15 ? await activeProvider.getQuote(inst.globalId) : null;
          return { ...inst, latestQuote: quote };
        })
      );

      return {
        instruments: enriched,
        totalCount: searchRes.totalCount,
        page: searchRes.page,
        limit: searchRes.limit,
        availableFilters: searchRes.availableFilters,
        feedHealth: activeProvider.getFeedHealth(),
      };
    }

    let list = await activeProvider.getInstruments();

    if (query.q) {
      const needle = query.q.toLowerCase();
      list = list.filter(
        (i) =>
          i.symbol.toLowerCase().includes(needle) ||
          i.name.toLowerCase().includes(needle) ||
          i.globalId.toLowerCase().includes(needle)
      );
    }

    const start = (page - 1) * limit;
    const paginated = list.slice(start, start + limit);
    const enriched = await Promise.all(
      paginated.map(async (inst) => {
        const quote = await activeProvider.getQuote(inst.globalId);
        return { ...inst, latestQuote: quote };
      })
    );

    return {
      instruments: enriched,
      totalCount: list.length,
      page,
      limit,
      feedHealth: activeProvider.getFeedHealth(),
    };
  });

  // 3B. All Indian Indices Endpoint
  app.get('/api/v1/indices', async (req) => {
    const query = req.query as { q?: string; limit?: string };
    const limit = Math.min(150, Math.max(1, parseInt(query.limit || '40', 10)));
    let list = activeProvider.getIndices
      ? await activeProvider.getIndices()
      : (await activeProvider.getInstruments()).filter((i) => i.instrumentType === 'INDEX_SPOT');

    if (query.q) {
      const needle = query.q.trim().toLowerCase();
      list = list.filter(
        (i) => i.symbol.toLowerCase().includes(needle) || i.name.toLowerCase().includes(needle)
      );
    }

    const sliced = list.slice(0, limit);
    const enriched = await Promise.all(
      sliced.map(async (inst, idx) => {
        const quote = idx < 16 ? await activeProvider.getQuote(inst.globalId) : null;
        return { ...inst, latestQuote: quote };
      })
    );

    return {
      indices: enriched,
      totalCount: list.length,
      feedHealth: activeProvider.getFeedHealth(),
    };
  });

  const resolveUserTierFromReq = async (req: any): Promise<UserTier> => {
    try {
      const authHeader = req.headers?.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        const decoded = (app as any).jwt?.verify(token);
        if (decoded && decoded.userId) {
          return await billingService.getAccountTier(decoded.userId);
        }
      }
    } catch {
      // Unauthenticated or invalid token
    }
    return 'FREE';
  };

  const parseFallbackInstrument = (globalId: string): { globalId: string; symbol: string; exchange: string; instrumentType: string } => {
    const parts = (globalId || '').split(':');
    const exch = parts[0] || 'NSE';
    const sym = parts[1] || globalId;
    let it = 'EQUITY_STOCK';
    if (globalId.includes('999') || globalId.endsWith('000') || sym.includes('INDEX') || sym.includes('SENSEX') || sym.includes('NIFTY')) {
      it = 'INDEX_SPOT';
    } else if (exch === 'NFO' || exch === 'BFO') {
      it = sym.includes('CE') || sym.includes('PE') ? 'OPTIDX' : 'FUTIDX';
    } else if (exch === 'MCX') {
      it = sym.includes('CE') || sym.includes('PE') ? 'OPTCOM' : 'FUTCOM';
    }
    return { globalId, exchange: exch, symbol: sym, instrumentType: it };
  };

  // 3B. Commodities Discovery Endpoint (Grouped into Metals, Energy, Agriculture)
  app.get('/api/v1/commodities', async () => {
    let allCom: InstrumentMetadata[] = [];
    if (activeProvider.searchInstruments) {
      const res = await activeProvider.searchInstruments({
        exchange: 'MCX',
        segment: 'COMMODITY',
        limit: 150,
      });
      allCom = res.instruments.filter((i) => i.instrumentType === 'FUTCOM');
    }

    const byCategory = {
      metals: [] as InstrumentMetadata[],
      energy: [] as InstrumentMetadata[],
      agriculture: [] as InstrumentMetadata[],
    };

    const seenUnderlyings = new Set<string>();
    const sorted = allCom.sort((a, b) => (a.expiry || '').localeCompare(b.expiry || ''));

    for (const inst of sorted) {
      const und = inst.underlying || inst.symbol.split(' ')[0];
      if (seenUnderlyings.has(und)) continue;
      seenUnderlyings.add(und);

      const cat = inst.commodityCategory || 'METALS';
      if (cat === 'METALS') byCategory.metals.push(inst);
      else if (cat === 'ENERGY') byCategory.energy.push(inst);
      else byCategory.agriculture.push(inst);
    }

    const enrichList = async (list: InstrumentMetadata[]) => {
      return Promise.all(
        list.map(async (inst) => {
          const quote = await activeProvider.getQuote(inst.globalId);
          return { ...inst, latestQuote: quote };
        })
      );
    };

    const [metals, energy, agriculture] = await Promise.all([
      enrichList(byCategory.metals),
      enrichList(byCategory.energy),
      enrichList(byCategory.agriculture),
    ]);

    return {
      metals,
      energy,
      agriculture,
      totalCount: metals.length + energy.length + agriculture.length,
      feedHealth: activeProvider.getFeedHealth(),
    };
  });

  app.get('/api/v1/commodities/specs', async () => {
    return {
      specs: COMMODITY_CONTRACT_SPECS,
      exchange: 'MCX',
      marketSession: getExchangeSessionStatus('MCX', new Date()),
    };
  });

  // 3C. Option Chain Endpoint
  app.get('/api/v1/option-chain', async (req, reply) => {
    const query = req.query as { underlying?: string; expiry?: string };
    const underlying = (query.underlying || 'NIFTY').trim().toUpperCase();

    const tier = await resolveUserTierFromReq(req);
    if (tier === 'FREE') {
      const isAllowed = underlying === 'NIFTY' || underlying === 'BANKNIFTY';
      if (!isAllowed) {
        return reply.status(403).send({
          error: 'UPGRADE_REQUIRED: Option chains for equities and other indices are exclusive to Premium subscribers.',
          code: 'UPGRADE_REQUIRED',
        });
      }
    }

    if (activeProvider.getOptionChain) {
      const chain = await activeProvider.getOptionChain(underlying, query.expiry);
      return chain;
    }
    return reply.status(400).send({
      error: `Option chain is not supported by active provider ${activeProvider.providerId}`,
    });
  });

  // 4. Market Data: Paginated & Range-Aware Historical Candles
  app.get('/api/v1/market-data/candles', async (req, reply) => {
    const query = req.query as {
      globalId?: string;
      timeframe?: Timeframe;
      count?: string;
      limit?: string;
      before?: string;
      from?: string;
      to?: string;
      range?: any;
    };
    if (!query.globalId) {
      return reply.status(400).send({ error: 'Missing globalId query parameter' });
    }

    const tier = await resolveUserTierFromReq(req);
    if (tier === 'FREE') {
      const inst =
        (activeProvider.getInstrumentById
          ? await activeProvider.getInstrumentById(query.globalId)
          : (await activeProvider.getInstruments()).find((i) => i.globalId === query.globalId)) ||
        parseFallbackInstrument(query.globalId);
      if (!isFreeTierAllowedInstrument(inst)) {
        return reply.status(403).send({
          error: 'UPGRADE_REQUIRED: Historical charts for equities, commodities, and other indices are exclusive to Premium subscribers.',
          code: 'UPGRADE_REQUIRED',
        });
      }
    }

    const timeframe: Timeframe = query.timeframe || '5m';
    const rawLimit = query.limit || query.count;
    const limit = rawLimit ? parseInt(rawLimit, 10) : undefined;
    const before = query.before ? parseInt(query.before, 10) : undefined;
    const from = query.from ? parseInt(query.from, 10) : undefined;
    const to = query.to ? parseInt(query.to, 10) : undefined;

    ensureEngineSubscription(query.globalId);

    if (activeProvider.getCandlesPaginated) {
      const pageRes = await activeProvider.getCandlesPaginated(query.globalId, timeframe, {
        before,
        from,
        to,
        limit,
        range: query.range,
      });
      const quote = await activeProvider.getQuote(query.globalId);

      return {
        globalId: query.globalId,
        timeframe,
        range: query.range || null,
        candles: pageRes.candles,
        hasMore: pageRes.hasMore,
        earliestTime: pageRes.earliestTime,
        latestTime: pageRes.latestTime,
        sessionDateIST: pageRes.sessionDateIST,
        prevSessionClose: pageRes.prevSessionClose,
        latestQuote: quote,
        providerError: pageRes.providerError,
        feedHealth: activeProvider.getFeedHealth(),
      };
    }

    const candles = await activeProvider.getCandles(query.globalId, timeframe, limit || 500);
    const quote = await activeProvider.getQuote(query.globalId);
    const providerError =
      activeProvider.providerId === 'SMARTAPI' ? smartApiAdapter.getLastDataError() : null;
    const sessionDateIST =
      activeProvider.providerId === 'SMARTAPI' ? smartApiAdapter.getLastSessionDateIST() : null;

    return {
      globalId: query.globalId,
      timeframe,
      candles,
      hasMore: false,
      earliestTime: candles.length > 0 ? candles[0].time : null,
      latestTime: candles.length > 0 ? candles[candles.length - 1].time : null,
      latestQuote: quote,
      sessionDateIST,
      prevSessionClose: quote?.close || (candles.length > 1 ? candles[0].close : null),
      providerError,
      feedHealth: activeProvider.getFeedHealth(),
    };
  });

  // 5. Market Data: Current Quote
  app.get('/api/v1/market-data/quote', async (req, reply) => {
    const query = req.query as { globalId?: string };
    if (!query.globalId) {
      return reply.status(400).send({ error: 'Missing globalId query parameter' });
    }

    const tier = await resolveUserTierFromReq(req);
    if (tier === 'FREE') {
      const inst =
        (activeProvider.getInstrumentById
          ? await activeProvider.getInstrumentById(query.globalId)
          : (await activeProvider.getInstruments()).find((i) => i.globalId === query.globalId)) ||
        parseFallbackInstrument(query.globalId);
      if (!isFreeTierAllowedInstrument(inst)) {
        return reply.status(403).send({
          error: 'UPGRADE_REQUIRED: Live quotes for equities, commodities, and other indices are exclusive to Premium subscribers.',
          code: 'UPGRADE_REQUIRED',
        });
      }
    }

    const quote = await activeProvider.getQuote(query.globalId);
    if (!quote) {
      return reply.status(404).send({ error: 'Quote not found' });
    }
    return { quote, feedHealth: activeProvider.getFeedHealth() };
  });

  // 5B. Per-User Chart Drawings Persistence
  app.get('/api/v1/drawings', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    const query = req.query as { instrumentId?: string };
    if (!query.instrumentId) {
      return reply.status(400).send({ error: 'Missing instrumentId query parameter' });
    }
    const drawings = await repo.getDrawings(req.user.userId, query.instrumentId);
    return { instrumentId: query.instrumentId, drawings };
  });

  app.post('/api/v1/drawings', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    const body = (req.body as { instrumentId?: string; drawings?: any[] }) || {};
    if (!body.instrumentId) {
      return reply.status(400).send({ error: 'Missing instrumentId' });
    }
    await repo.saveDrawings(req.user.userId, body.instrumentId, body.drawings || []);
    return { success: true, instrumentId: body.instrumentId, count: (body.drawings || []).length };
  });

  // 5C. User Selected Benchmark Indices Preferences (Exactly 3 unique benchmark indices)
  const DEFAULT_INDEX_GLOBAL_IDS = [
    'NSE:NIFTY 50:99926000',
    'NSE:BANKNIFTY:99926009',
    'BSE:SENSEX:99919000',
  ];

  app.get('/api/v1/user/preferences/indices', async (req: any) => {
    let selectedIndices = [...DEFAULT_INDEX_GLOBAL_IDS];
    try {
      const authHeader = req.headers?.authorization;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const decoded = (app as any).jwt?.verify(authHeader.slice(7));
        if (decoded && decoded.userId) {
          const saved = await repo.getUserIndexPreferences(decoded.userId);
          if (saved && saved.length === 3) {
            selectedIndices = saved;
          }
        }
      }
    } catch { }

    const allIndices = activeProvider.getIndices
      ? await activeProvider.getIndices()
      : (await activeProvider.getInstruments()).filter((i) => i.instrumentType === 'INDEX_SPOT');

    const enrichedIndices = await Promise.all(
      selectedIndices.map(async (gid) => {
        const match = allIndices.find((i) => i.globalId === gid);
        const quote = await activeProvider.getQuote(gid);
        return match
          ? { ...match, latestQuote: quote }
          : { globalId: gid, symbol: gid.split(':')[1] || gid, name: gid.split(':')[1] || gid, instrumentType: 'INDEX_SPOT', latestQuote: quote };
      })
    );

    return {
      selectedIndices,
      indices: enrichedIndices,
    };
  });

  app.put('/api/v1/user/preferences/indices', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    const body = req.body as { selectedIndices?: string[] };
    if (!body || !Array.isArray(body.selectedIndices) || body.selectedIndices.length !== 3) {
      return reply.status(400).send({
        error: 'Exactly three unique benchmark index global IDs must be selected.',
        code: 'ERR_INVALID_INDICES_COUNT',
      });
    }

    const uniqueSet = new Set(body.selectedIndices);
    if (uniqueSet.size !== 3) {
      return reply.status(400).send({
        error: 'All three selected indices must be distinct and unique.',
        code: 'ERR_DUPLICATE_INDICES',
      });
    }

    const allIndices = activeProvider.getIndices
      ? await activeProvider.getIndices()
      : (await activeProvider.getInstruments()).filter((i) => i.instrumentType === 'INDEX_SPOT');

    const validGlobalIds = new Set(allIndices.map((i) => i.globalId));
    DEFAULT_INDEX_GLOBAL_IDS.forEach((id) => validGlobalIds.add(id));

    for (const gid of body.selectedIndices) {
      if (!validGlobalIds.has(gid)) {
        return reply.status(400).send({
          error: `Invalid benchmark index ID: ${gid}`,
          code: 'ERR_UNKNOWN_INDEX',
        });
      }
    }

    await repo.setUserIndexPreferences(req.user.userId, body.selectedIndices);

    return {
      success: true,
      selectedIndices: body.selectedIndices,
    };
  });

  // 6. Virtual Account
  app.get('/api/v1/account', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const account = await repo.getAccount(req.user.accountId);
    if (!account) return { error: 'Account not found' };
    const entitlement = await billingService.resolveEntitlement(req.user.userId);
    account.tier = entitlement.tier;
    return {
      ...formatAccountResponse(account),
      entitlement,
    };
  });

  // 7. Virtual Account Reset & Performance
  app.get('/api/v1/account/performance', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const accountId = req.user.accountId;
    const session = await repo.getActiveSession(accountId);
    const lifetime = await repo.getLifetimePerformance(req.user.userId);
    return { session, lifetime };
  });

  app.post('/api/v1/account/reset', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    const accountId = req.user.accountId;
    const body = (req.body as { startingCapitalINR?: number }) || {};
    const requestedCapitalINR = body.startingCapitalINR || 100000;
    const tier = await billingService.getAccountTier(req.user.userId);

    const positions = await repo.getPositions(accountId);
    const quotes = new Map<string, number>();
    for (const p of positions) {
      if (p.quantity !== 0) {
        const q = await activeProvider.getQuote(p.globalInstrumentId);
        if (q) quotes.set(p.globalInstrumentId, q.ltp);
        else if (p.currentPrice > 0) quotes.set(p.globalInstrumentId, p.currentPrice);
      }
    }

    const resetResult = await repo.resetAccount(
      accountId,
      positions,
      quotes,
      requestedCapitalINR,
      tier
    );
    if (!resetResult.success) {
      const isPositionErr = resetResult.error?.includes('positions');
      const isTierErr = resetResult.error?.includes('Premium') || resetResult.error?.includes('20,00,000') || resetResult.error?.includes('preset');
      const code = isPositionErr
        ? 'ERR_OPEN_POSITIONS_EXIST'
        : isTierErr
          ? 'ERR_PRO_TIER_REQUIRED'
          : 'ERR_RESET_FAILED';
      return reply.status(isTierErr ? 403 : 400).send({
        error: resetResult.error,
        code,
      });
    }

    accountEngine.resetAccount(accountId, positions, quotes);

    const updated = await repo.getAccount(accountId);
    const session = await repo.getActiveSession(accountId);
    const lifetime = await repo.getLifetimePerformance(req.user.userId);

    return {
      success: true,
      message: `Account reset successfully to ₹${requestedCapitalINR.toLocaleString('en-IN')}`,
      account: updated ? formatAccountResponse(updated) : null,
      session,
      lifetime,
      newSessionId: resetResult.newSessionId,
    };
  });

  // 8. Account Audit Ledger
  app.get('/api/v1/account/ledger', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const entries = await repo.getLedger(req.user.accountId);
    return {
      ledger: entries.map((e) => ({
        ...e,
        amountINR: Money.toRupees(e.amountPaise),
        balanceAfterINR: Money.toRupees(e.balanceAfterPaise),
      })),
    };
  });

  // 9. Place Simulated Order (with Free vs Pro tier & Discipline checks)
  app.post('/api/v1/orders/place', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    const body = req.body as PlaceOrderRequest;
    const accountId = req.user.accountId;
    const userId = req.user.userId;

    const account = await repo.getAccount(accountId);
    if (!account) return reply.status(404).send({ error: 'Account not found' });

    const instrument = activeProvider.getInstrumentById
      ? await activeProvider.getInstrumentById(body.globalInstrumentId)
      : (await activeProvider.getInstruments()).find((i) => i.globalId === body.globalInstrumentId);
    if (!instrument) {
      return reply.status(404).send({ error: `Instrument ${body.globalInstrumentId} not found` });
    }
    await repo.syncInstruments([instrument]);
    ensureEngineSubscription(instrument.globalId);

    // 1. Spot Index Check: Spot is reference only and cannot be traded by anyone
    if (instrument.instrumentType === 'INDEX_SPOT') {
      return reply.status(400).send({
        error: 'Spot indices are reference only and cannot be traded. Please trade NIFTY or BANKNIFTY Futures or Options contracts.',
        code: 'ERR_SPOT_NOT_TRADABLE',
      });
    }

    // Check existing position to determine if this order is a risk-reducing exit
    const existingPositions = await repo.getPositions(accountId);
    const existingPos = existingPositions.find((p) => p.globalInstrumentId === instrument.globalId);
    const existingPosQty = existingPos?.quantity ?? 0;
    const isRiskReducingExit =
      (existingPosQty > 0 && body.side === 'SELL' && body.quantity <= existingPosQty) ||
      (existingPosQty < 0 && body.side === 'BUY' && body.quantity <= Math.abs(existingPosQty));

    // 2. Server-Enforced Tier Gate: Free users can ONLY trade NIFTY and BANKNIFTY derivatives.
    // If a user's Premium subscription expired, they are permitted to view and square off / reduce existing
    // restricted positions, but are strictly prohibited from opening new exposure or adding to existing positions.
    const userTier = await billingService.getAccountTier(userId);
    if (userTier === 'FREE' && !isFreeTierAllowedInstrument(instrument) && !isRiskReducingExit) {
      return reply.status(403).send({
        error: `ERR_PRO_TIER_REQUIRED: Free tier users can only trade NIFTY and BANKNIFTY futures and options. Upgrade to Premium to trade ${instrument.symbol}.`,
        code: 'ERR_PRO_TIER_REQUIRED',
      });
    }

    const quote = await activeProvider.getQuote(instrument.globalId);
    if (!quote) {
      return reply.status(400).send({ error: 'No live quote available for instrument.' });
    }

    const existingDeliveryHoldingQty =
      existingPos && existingPos.productType === 'DELIVERY' && existingPos.quantity > 0
        ? existingPos.quantity
        : 0;

    // Discipline Guard: Check daily loss & trade limits after last baseline reset (never blocks risk-reducing exits)
    const baselineResetAt = account.baselineResetAt || 0;
    const windowStart = Math.max(baselineResetAt, Date.now() - 86400000);
    const existingOrders = await repo.getOrders(accountId);
    const todayOrdersCount = existingOrders.filter(
      (o) => o.createdAt >= windowStart && o.status === 'EXECUTED'
    ).length;

    const isOpening = !isRiskReducingExit;
    const maxTrades = userTier === 'PRO' ? 1000 : 50;
    const discipline = DisciplineGuard.evaluateOrder(isOpening, 0, todayOrdersCount, {
      maxDailyLossRupees: 25000,
      maxDailyTrades: maxTrades,
    });

    if (!discipline.isAllowed) {
      return reply.status(400).send({
        error: discipline.reason,
        code: 'ERR_DISCIPLINE_LIMIT',
      });
    }

    // Server-side strict order validation
    const validation = OrderValidator.validate(
      { ...body, accountId, globalInstrumentId: instrument.globalId },
      instrument,
      account.availableBalancePaise,
      quote.ltp,
      {
        existingPositionQuantity: existingPosQty,
        existingDeliveryHoldingQuantity: existingDeliveryHoldingQty,
        underlyingPrice: instrument.strikePrice || quote.ltp,
      }
    );

    if (!validation.isValid) {
      return reply.status(400).send({
        error: validation.errorMessage,
        code: validation.errorCode,
      });
    }

    try {
      const result = await simEngine.submitOrder(
        { ...body, accountId, globalInstrumentId: instrument.globalId },
        instrument,
        quote,
        validation.requiredMarginPaise,
        validation.estimatedChargesPaise
      );

      if (result.order.status === 'REJECTED') {
        return reply.status(400).send({
          success: false,
          error: result.order.rejectionReason || 'Order rejected by simulation engine.',
          code: result.order.rejectionReason?.split(':')[0] || 'ERR_ORDER_REJECTED',
          order: {
            ...result.order,
            estimatedChargesINR: Money.toRupees(result.order.estimatedChargesPaise),
          },
        });
      }

      return {
        success: true,
        order: {
          ...result.order,
          estimatedChargesINR: Money.toRupees(result.order.estimatedChargesPaise),
          requiredMarginINR: Money.toRupees(validation.requiredMarginPaise),
        },
        position: result.position
          ? {
            ...result.position,
            realizedPnlINR: Money.toRupees(result.position.realizedPnlPaise),
            unrealizedPnlINR: Money.toRupees(result.position.unrealizedPnlPaise),
          }
          : undefined,
      };
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // 9B. Cancel Pending Order
  app.post('/api/v1/orders/:orderId/cancel', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    const { orderId } = req.params as { orderId: string };
    try {
      const cancelled = await simEngine.cancelOrder(req.user.accountId, orderId);
      return {
        success: true,
        order: {
          ...cancelled,
          estimatedChargesINR: Money.toRupees(cancelled.estimatedChargesPaise),
        },
      };
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  app.post('/api/v1/orders/cancel', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    const body = (req.body as { orderId?: string }) || {};
    if (!body.orderId) return reply.status(400).send({ error: 'Missing orderId' });
    try {
      const cancelled = await simEngine.cancelOrder(req.user.accountId, body.orderId);
      return {
        success: true,
        order: {
          ...cancelled,
          estimatedChargesINR: Money.toRupees(cancelled.estimatedChargesPaise),
        },
      };
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // 10. Square-off Position
  app.post('/api/v1/positions/square-off', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    const body = req.body as { globalInstrumentId: string };
    const accountId = req.user.accountId;

    const instrument = activeProvider.getInstrumentById
      ? await activeProvider.getInstrumentById(body.globalInstrumentId)
      : (await activeProvider.getInstruments()).find((i) => i.globalId === body.globalInstrumentId);

    const targetId = instrument?.globalId || body.globalInstrumentId;
    const quote = await activeProvider.getQuote(targetId);
    if (!quote) {
      return reply.status(400).send({ error: 'No quote available to square off position.' });
    }

    try {
      const result = await simEngine.squareOffPosition(accountId, targetId, quote, instrument);
      return {
        success: true,
        order: result.order,
        position: result.position,
      };
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // 11. Orders & Positions Retrieval (with Holdings vs Positions separation)
  app.get('/api/v1/orders', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const orders = await repo.getOrders(req.user.accountId);
    const enriched = await Promise.all(
      orders.map(async (o) => {
        const inst = activeProvider.getInstrumentById
          ? await activeProvider.getInstrumentById(o.globalInstrumentId)
          : undefined;
        return {
          ...o,
          symbol: inst?.symbol || o.globalInstrumentId.split(':')[1] || o.globalInstrumentId,
          instrumentName: inst?.name || o.globalInstrumentId,
          instrumentType: inst?.instrumentType || 'EQUITY_STOCK',
          exchange: inst?.exchange || o.globalInstrumentId.split(':')[0] || 'NSE',
          estimatedChargesINR: Money.toRupees(o.estimatedChargesPaise),
        };
      })
    );
    return { orders: enriched };
  });

  app.get('/api/v1/positions', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const positions = await repo.getPositions(req.user.accountId);
    const now = Date.now();
    const enriched = await Promise.all(
      positions.map(async (p) => {
        const inst = activeProvider.getInstrumentById
          ? await activeProvider.getInstrumentById(p.globalInstrumentId)
          : undefined;
        const quote = p.quantity !== 0 ? await activeProvider.getQuote(p.globalInstrumentId) : null;

        // Server-authoritative P&L: provider quote when available, otherwise the honest last
        // persisted price - never a fabricated one and never silently erased.
        const hasLiveQuote = Boolean(quote && Number(quote.ltp) > 0);
        const ltp = hasLiveQuote
          ? Number(quote!.ltp)
          : Number(p.currentPrice) > 0
            ? Number(p.currentPrice)
            : Number(p.averageEntryPrice);

        // Commodity contracts quote per unit but settle per contract multiplier. Mirror the
        // simulation engine's math exactly so the REST view and realized P&L never disagree.
        const pnlMultiplier =
          inst?.exchange === 'MCX' && inst?.priceQuoteMultiplier
            ? Number(inst.priceQuoteMultiplier) / (Number(inst.lotSize) || 1)
            : 1;

        const diff = p.quantity > 0 ? ltp - p.averageEntryPrice : p.averageEntryPrice - ltp;
        const unrealizedINR =
          p.quantity !== 0 ? Number((diff * pnlMultiplier * Math.abs(p.quantity)).toFixed(2)) : 0;

        const priceTimestamp = hasLiveQuote
          ? Number(quote!.providerTimestamp || quote!.receiveTimestamp) || null
          : null;
        const priceAgeMs = priceTimestamp ? Math.max(0, now - priceTimestamp) : null;
        const marketOpen = isIndianMarketOpen();
        const priceStale = priceTimestamp
          ? marketOpen
            ? priceAgeMs! > 15000
            : false
          : true;

        return {
          ...p,
          currentPrice: ltp,
          pnlMultiplier,
          symbol: inst?.symbol || p.globalInstrumentId.split(':')[1] || p.globalInstrumentId,
          instrumentName: inst?.name || p.globalInstrumentId,
          instrumentType: inst?.instrumentType || 'EQUITY_STOCK',
          exchange: inst?.exchange || p.globalInstrumentId.split(':')[0] || 'NSE',
          lotSize: inst?.lotSize || 1,
          realizedPnlINR: Money.toRupees(p.realizedPnlPaise),
          unrealizedPnlINR: unrealizedINR,
          priceSource: hasLiveQuote ? 'LIVE_PROVIDER' : 'LAST_KNOWN_PERSISTED',
          priceTimestamp,
          priceAgeMs,
          priceStale,
          pnlTimestamp: now,
        };
      })
    );

    const holdings = enriched.filter((p) => p.productType === 'DELIVERY' && p.quantity > 0);
    const activePositions = enriched.filter((p) => p.productType !== 'DELIVERY' && p.quantity !== 0);
    const closedPositions = enriched.filter((p) => p.quantity === 0);

    return {
      positions: enriched,
      holdings,
      activePositions,
      closedPositions,
    };
  });

  // 12. Journal Endpoints: Notes, Tags, Analytics, and CSV Export
  app.post('/api/v1/journal/notes', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const body = req.body as { referenceId?: string; strategyTag?: string; notes?: string; screenshotUrl?: string };
    const accountId = req.user.accountId;

    const entryId = randomUUID();
    const now = Date.now();
    await db.query(
      `INSERT INTO journal_entries (id, account_id, reference_id, strategy_tag, notes, screenshot_url, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entryId,
        accountId,
        body.referenceId ?? null,
        body.strategyTag ?? 'Untagged',
        body.notes ?? '',
        body.screenshotUrl ?? null,
        now,
      ]
    );

    return { success: true, journalEntryId: entryId };
  });

  app.get('/api/v1/journal/entries', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const accountId = req.user.accountId;
    const res = await db.query(
      `SELECT id, account_id as "accountId", reference_id as "referenceId", strategy_tag as "strategyTag", notes, screenshot_url as "screenshotUrl", created_at as "createdAt"
       FROM journal_entries WHERE account_id = $1 ORDER BY created_at DESC`,
      [accountId]
    );
    return { entries: res.rows };
  });

  app.get('/api/v1/journal/analytics', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const accountId = req.user.accountId;
    const orders = await repo.getOrders(accountId);
    const executedExits = orders.filter((o) => o.status === 'EXECUTED');

    const trades: ClosedTradeRecord[] = executedExits.map((o) => ({
      id: o.id,
      globalInstrumentId: o.globalInstrumentId,
      symbol: o.globalInstrumentId.split(':')[1] || 'NIFTY',
      side: o.side,
      quantity: o.quantity,
      entryPrice: o.executedPrice || 24500,
      exitPrice: o.executedPrice || 24500,
      realizedPnlPaise: 0n,
      chargesPaise: o.estimatedChargesPaise,
      netPnlPaise: -o.estimatedChargesPaise,
      entryTimestamp: o.createdAt,
      exitTimestamp: o.executedAt || o.createdAt,
    }));

    const metrics = PerformanceAnalytics.calculate(trades, 10000000n);
    return { metrics };
  });

  app.get('/api/v1/journal/export.csv', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    const accountId = req.user.accountId;
    const orders = await repo.getOrders(accountId);
    const trades: ClosedTradeRecord[] = orders.map((o) => ({
      id: o.id,
      globalInstrumentId: o.globalInstrumentId,
      symbol: o.globalInstrumentId.split(':')[1] || 'NIFTY',
      side: o.side,
      quantity: o.quantity,
      entryPrice: o.executedPrice || 24500,
      exitPrice: o.executedPrice || 24500,
      realizedPnlPaise: 0n,
      chargesPaise: o.estimatedChargesPaise,
      netPnlPaise: -o.estimatedChargesPaise,
      entryTimestamp: o.createdAt,
      exitTimestamp: o.executedAt || o.createdAt,
    }));

    const csvData = PerformanceAnalytics.exportToCSV(trades);
    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', 'attachment; filename="simulated-trades-journal.csv"');
    return csvData;
  });

  // 13. Multi-Watchlists (with add/remove item support)
  app.get('/api/v1/watchlists', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const res = await db.query(
      'SELECT * FROM watchlists WHERE user_id = $1 ORDER BY created_at ASC',
      [req.user.userId]
    );
    const watchlists = await Promise.all(
      res.rows.map(async (r) => {
        const ids: string[] = JSON.parse(r.instruments_json || '[]');
        const hydrated = await Promise.all(
          ids.map(async (gid) => {
            const inst = activeProvider.getInstrumentById
              ? await activeProvider.getInstrumentById(gid)
              : undefined;
            const quote = await activeProvider.getQuote(gid);
            return inst ? { ...inst, latestQuote: quote } : { globalId: gid, symbol: gid, latestQuote: quote };
          })
        );
        return {
          id: r.id,
          name: r.name,
          instruments: ids,
          hydratedInstruments: hydrated,
          isDefault: r.is_default,
        };
      })
    );
    return { watchlists };
  });

  app.post('/api/v1/watchlists', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    const body = req.body as { id?: string; name: string; instruments?: string[] };
    const userId = req.user.userId;

    if (body.id) {
      await db.query(
        'UPDATE watchlists SET name = $1, instruments_json = $2 WHERE id = $3 AND user_id = $4',
        [body.name, JSON.stringify(body.instruments || []), body.id, userId]
      );
      return { success: true, watchlistId: body.id };
    }

    const tier = await billingService.getAccountTier(userId);
    const existing = await db.query('SELECT COUNT(*) as count FROM watchlists WHERE user_id = $1', [userId]);
    const count = parseInt(existing.rows[0].count, 10);

    const maxWatchlists = tier === 'PRO' ? 10 : 1;
    if (count >= maxWatchlists) {
      return reply.status(403).send({
        error: `Watchlist limit reached (${maxWatchlists} allowed for ${tier} tier). Upgrade to Pro for additional watchlists.`,
      });
    }

    const id = randomUUID();
    await db.query(
      `INSERT INTO watchlists (id, user_id, name, instruments_json, is_default, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, userId, body.name, JSON.stringify(body.instruments || []), count === 0, Date.now()]
    );

    return { success: true, watchlistId: id };
  });

  // 14. Monetization & Ads Endpoints
  app.get('/api/v1/billing/plans', async () => {
    return { plans: billingService.getPlans() };
  });

  app.post('/api/v1/billing/verify-purchase', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    const body = req.body as { productId?: string; planId?: string; purchaseToken: string };
    const productId = body.productId || body.planId || 'plan_month_100';
    const res = await billingService.verifyPurchaseToken(req.user.userId, productId, body.purchaseToken);
    if (!res.success) {
      const statusCode = res.code === 'CONFIGURATION_REQUIRED' ? 503 : 400;
      return reply.status(statusCode).send(res);
    }
    await notifyActiveUserWebSocketsTierChanged(req.user.userId);
    return res;
  });

  // 14B. Narrowly Scoped Owner-Admin Complimentary Grant Endpoints (Protected by ADMIN_GRANT_SECRET)
  const verifyAdminSecret = (req: any, reply: any): boolean => {
    const configuredSecret = (process.env.ADMIN_GRANT_SECRET || '').trim();
    const headerSecret = String(req.headers['x-admin-secret'] || '').trim();
    if (!configuredSecret || configuredSecret.length < 16) {
      reply.status(403).send({
        error: 'Admin entitlement endpoints are disabled because ADMIN_GRANT_SECRET is not configured.',
        code: 'ERR_ADMIN_NOT_CONFIGURED',
      });
      return false;
    }
    const bufA = Buffer.from(configuredSecret, 'utf8');
    const bufB = Buffer.from(headerSecret, 'utf8');
    if (bufA.length !== bufB.length || !timingSafeEqual(bufA, bufB)) {
      reply.status(403).send({
        error: 'Forbidden: Invalid administrative credentials.',
        code: 'ERR_ADMIN_UNAUTHORIZED',
      });
      return false;
    }
    return true;
  };

  app.post('/api/v1/admin/entitlements/grant', async (req: any, reply) => {
    if (!verifyAdminSecret(req, reply)) return;
    const body = (req.body as {
      userId?: string;
      email?: string;
      reason?: string;
      grantedBy?: string;
      expiresAt?: number | null;
    }) || {};
    const res = await billingService.grantComplimentaryPro({
      userId: body.userId,
      email: body.email || '',
      reason: body.reason || '',
      grantedBy: body.grantedBy || 'OWNER_ADMIN',
      expiresAt: body.expiresAt ?? null,
    });
    if (!res.success) {
      const code = res.code === 'ERR_USER_NOT_FOUND' ? 404 : 400;
      return reply.status(code).send(res);
    }
    if (res.grant?.userId) {
      await notifyActiveUserWebSocketsTierChanged(res.grant.userId);
    }
    return res;
  });

  app.post('/api/v1/admin/entitlements/revoke', async (req: any, reply) => {
    if (!verifyAdminSecret(req, reply)) return;
    const body = (req.body as {
      userId?: string;
      email?: string;
      reason?: string;
      revokedBy?: string;
    }) || {};
    const res = await billingService.revokeComplimentaryPro({
      userId: body.userId,
      email: body.email,
      reason: body.reason || 'Revoked by owner administrator',
      revokedBy: body.revokedBy || 'OWNER_ADMIN',
    });
    if (!res.success) {
      return reply.status(404).send(res);
    }
    if (res.userId) {
      await notifyActiveUserWebSocketsTierChanged(res.userId);
    }
    return res;
  });

  app.get('/api/v1/admin/entitlements', async (req: any, reply) => {
    if (!verifyAdminSecret(req, reply)) return;
    const grants = await billingService.listComplimentaryGrants();
    return { grants };
  });

  app.get('/api/v1/billing/status', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const status = await billingService.getSubscriptionStatus(req.user.userId);
    return status;
  });

  app.post('/api/v1/billing/restore-purchases', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const status = await billingService.getSubscriptionStatus(req.user.userId);
    return {
      success: true,
      restored: status.tier === 'PRO',
      status,
    };
  });

  app.post('/api/v1/ads/app-open/opportunity', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const tier = await billingService.getAccountTier(req.user.userId);
    const opp = adsCoordinator.reserveAppOpenOpportunity(req.user.userId, tier);
    return opp;
  });

  app.post('/api/v1/ads/app-open/impression', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const body = req.body as { opportunityToken: string };
    const recorded = adsCoordinator.confirmImpression(body.opportunityToken);
    return { recorded };
  });

  // 15. WebSocket Real-time Channel (with token-based client ownership & entitlement gating)
  app.get('/ws', { websocket: true }, (connection: any) => {
    const ws = (connection.socket || connection) as WebSocket;
    const clientState: { ws: WebSocket; userId?: string; tier: UserTier; subscriptions: Set<string> } = {
      ws,
      tier: 'FREE',
      subscriptions: new Set<string>(),
    };
    wsClients.add(clientState as any);

    for (const inst of instruments) {
      if (isFreeTierAllowedInstrument(inst)) {
        clientState.subscriptions.add(inst.globalId);
      }
    }

    // Serialize messages per socket so AUTH always finishes before subsequent SUBSCRIBE messages
    let messageQueue: Promise<void> = Promise.resolve();

    const processClientMessage = async (raw: any) => {
      try {
        const msg = JSON.parse(raw.toString());
        const actionType = (msg.action || msg.type || '').toUpperCase();

        if (actionType === 'AUTH' && msg.token) {
          try {
            const decoded = (app as any).jwt?.verify(msg.token);
            if (decoded && decoded.userId) {
              clientState.userId = decoded.userId;
              clientState.tier = await billingService.getAccountTier(decoded.userId);
              // Auto-subscribe client to their open positions so live P&L streams even when chart is closed
              const accountId = decoded.accountId || (await repo.provisionInitialAccount(decoded.userId))?.id;
              if (accountId) {
                const userPositions = await repo.getPositions(accountId);
                for (const pos of userPositions) {
                  if (pos.quantity !== 0) {
                    clientState.subscriptions.add(pos.globalInstrumentId);
                    ensureEngineSubscription(pos.globalInstrumentId);
                    activeProvider
                      .getQuote(pos.globalInstrumentId)
                      .then((snap) => {
                        if (snap && ws.readyState === WebSocket.OPEN && clientState.subscriptions.has(pos.globalInstrumentId)) {
                          ws.send(JSON.stringify({ type: 'QUOTE_TICK', data: snap }));
                          wsTicksEmitted += 1;
                          lastWsEmitTime = Date.now();
                        }
                      })
                      .catch(() => {});
                  }
                }
              }
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: 'AUTH_SUCCESS',
                    tier: clientState.tier,
                    serverTimestamp: Date.now(),
                  })
                );
              }
            }
          } catch {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'AUTH_ERROR', error: 'Invalid token' }));
            }
          }
        } else if (actionType === 'SUBSCRIBE' && Array.isArray(msg.symbols)) {
          if (clientState.userId) {
            clientState.tier = await billingService.getAccountTier(clientState.userId);
          }
          for (const s of msg.symbols) {
            if (!s || typeof s !== 'string') continue;
            const resolvedInst = activeProvider.getInstrumentById
              ? await activeProvider.getInstrumentById(s)
              : undefined;
            const inst =
              resolvedInst ||
              instruments.find((i) => i.globalId === s || i.symbol === s) ||
              parseFallbackInstrument(s);

            if (clientState.tier === 'FREE' && !isFreeTierAllowedInstrument(inst)) {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'RESTRICTED_ACCESS', symbol: s, error: 'UPGRADE_REQUIRED' }));
              }
              continue;
            }
            const canonicalId = inst.globalId || s;
            clientState.subscriptions.add(s);
            clientState.subscriptions.add(canonicalId);
            ensureEngineSubscription(canonicalId);

            // Immediately emit initial quote snapshot + forming candle snapshot so active charts & watchlists reconcile after reconnect
            const cachedForming = formingTracker.snapshot(canonicalId);
            if (cachedForming && ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: 'FORMING_CANDLE_SNAPSHOT',
                  globalId: canonicalId,
                  candles: cachedForming,
                  serverTimestamp: Date.now(),
                })
              );
            }
            activeProvider
              .getQuote(canonicalId)
              .then((snap) => {
                if (snap && ws.readyState === WebSocket.OPEN && clientState.subscriptions.has(canonicalId)) {
                  ws.send(JSON.stringify({ type: 'QUOTE_TICK', data: snap }));
                  wsTicksEmitted += 1;
                  lastWsEmitTime = Date.now();
                }
              })
              .catch(() => { });
          }
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'SUBSCRIBED', symbols: Array.from(clientState.subscriptions) }));
          }
        } else if (actionType === 'UNSUBSCRIBE' && Array.isArray(msg.symbols)) {
          for (const s of msg.symbols) {
            if (!s || typeof s !== 'string') continue;
            clientState.subscriptions.delete(s);
          }
        }
      } catch {
        // ignore malformed message
      }
    };

    ws.on('message', (raw: any) => {
      messageQueue = messageQueue.then(() => processClientMessage(raw)).catch(() => { });
    });

    // Heartbeat: mobile networks silently drop idle sockets. Without a keepalive the client only
    // notices a dead feed when it next tries to send, which surfaces as "quotes only appear after
    // tapping/reopening". Pinging also lets the server reap half-open sockets.
    let lastPongAt = Date.now();
    ws.on('pong', () => {
      lastPongAt = Date.now();
    });
    const heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastPongAt > WS_HEARTBEAT_INTERVAL_MS * 3) {
        try {
          ws.terminate();
        } catch { }
        return;
      }
      try {
        ws.ping();
      } catch { }
    }, WS_HEARTBEAT_INTERVAL_MS);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    ws.on('close', () => {
      clearInterval(heartbeat);
      wsClients.delete(clientState as any);
    });
  });

  return { app, provider: activeProvider, accountEngine, simEngine, repo, db, billingService };
}

// Start standalone server if invoked directly
if (process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts')) {
  buildServer().then(({ app }) => {
    app.listen({ port: config.port, host: config.host }, (err, address) => {
      if (err) {
        console.error(err);
        process.exit(1);
      }
      console.log(`[Backend] Paper-Trading Gateway running on ${address}`);
      console.log(`[Backend] Security Air-Gap Active: Broker trading endpoints locked.`);
    });
  });
}
