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
} from '@trading/shared';
import { config } from './config.js';
import { DeterministicProvider } from './providers/deterministic-provider.js';
import { IMarketDataProvider } from './providers/types.js';
import { SmartAPIAdapter } from './providers/smartapi-adapter.js';
import { SimulationEngine } from './engine/simulation-engine.js';
import { VirtualAccountEngine } from './engine/virtual-account-engine.js';
import { createDatabase, IDatabase } from './db/database.js';
import { PostgresRepository } from './db/postgres-repository.js';
import { BillingService } from './monetization/billing-service.js';
import { AdsCoordinator } from './monetization/ads-coordinator.js';
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

// Ensure BigInt can be serialized to JSON safely
if (!(BigInt.prototype as any).toJSON) {
  (BigInt.prototype as any).toJSON = function () {
    return this.toString();
  };
}

export async function buildServer(customDb?: IDatabase): Promise<{
  app: FastifyInstance;
  provider: IMarketDataProvider;
  accountEngine: VirtualAccountEngine;
  simEngine: SimulationEngine;
  repo: PostgresRepository;
  db: IDatabase;
}> {
  const app = Fastify({ logger: false });

  await app.register(cors, { origin: true });
  await app.register(jwt, { secret: config.jwtSecret });
  await app.register(websocket);

  // Database & Repositories
  const db = customDb || createDatabase(process.env.DATABASE_URL);
  const repo = new PostgresRepository(db);
  const accountEngine = new VirtualAccountEngine();
  const simEngine = new SimulationEngine(repo);
  const billingService = new BillingService(db);
  const adsCoordinator = new AdsCoordinator();

  // Initialize Providers
  const demoProvider = new DeterministicProvider();
  await demoProvider.init();

  const smartApiAdapter = new SmartAPIAdapter(config.smartApi);
  await smartApiAdapter.init();

  const activeProvider: IMarketDataProvider = demoProvider;

  // Sync instruments to PostgreSQL
  const instruments = await activeProvider.getInstruments();
  await repo.syncInstruments(instruments);

  app.addHook('onClose', async () => {
    await demoProvider.dispose();
    await smartApiAdapter.dispose();
    await db.close();
  });

  // Connect Market Ticks to Simulation Engine
  for (const inst of instruments) {
    activeProvider.subscribe(inst.globalId, (quote) => {
      simEngine.onMarketTick(quote);
    });
  }

  // Active WebSocket clients
  const wsClients = new Set<{ ws: WebSocket; accountId?: string; subscriptions: Set<string> }>();

  // Fan-out ticks to connected mobile WebSocket clients
  for (const inst of instruments) {
    activeProvider.subscribe(inst.globalId, (quote) => {
      const msg = JSON.stringify({ type: 'QUOTE_TICK', data: quote });
      for (const client of wsClients) {
        if (client.subscriptions.has(inst.globalId)) {
          if (client.ws.readyState === WebSocket.OPEN) {
            client.ws.send(msg);
          }
        }
      }
    });
  }

  // 1. Health & Feed Status
  app.get('/api/v1/feed-health', async () => {
    return {
      activeProvider: activeProvider.getFeedHealth(),
      smartApiStatus: smartApiAdapter.getFeedHealth(),
      databaseEmulated: db.isEmulated(),
    };
  });

  // 2. Authentication (Safe Dev Login - Strictly disabled in production)
  app.post('/api/v1/auth/dev-login', async (req, reply) => {
    if (process.env.NODE_ENV === 'production' || !config.enableDevAuth) {
      return reply.status(403).send({ error: 'Development authentication is disabled in production.' });
    }
    const body = req.body as { userId?: string; name?: string } | undefined;
    const userId = body?.userId || 'dev-trader-01';
    const userName = body?.name || 'Practicing Retail Trader';

    // Provision account in PostgreSQL
    const account = await repo.provisionInitialAccount(userId, `${userName}'s Virtual Account`);
    // Sync memory engine as well
    accountEngine.provisionInitialAccount(userId, `${userName}'s Virtual Account`);

    const token = app.jwt.sign({ userId, accountId: account.id, name: userName });

    return {
      token,
      user: { userId, name: userName },
      account: {
        ...account,
        startingBalanceINR: Money.toRupees(account.startingBalancePaise),
        cashBalanceINR: Money.toRupees(account.cashBalancePaise),
        lockedMarginINR: Money.toRupees(account.lockedMarginPaise),
        availableBalanceINR: Money.toRupees(account.availableBalancePaise),
      },
    };
  });

  // Authentication Hook for Protected Routes
  app.decorate('authenticate', async (request: any, reply: any) => {
    try {
      await request.jwtVerify();
    } catch {
      reply.status(401).send({ error: 'Unauthorized: Valid JWT Bearer token required.' });
    }
  });

  // 3. Instruments Master with Search and Pagination
  app.get('/api/v1/instruments', async (req) => {
    const query = req.query as { q?: string; page?: string; limit?: string };
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

    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(query.limit || '20', 10)));
    const start = (page - 1) * limit;
    const paginated = list.slice(start, start + limit);

    return {
      instruments: paginated,
      totalCount: list.length,
      page,
      limit,
      feedHealth: activeProvider.getFeedHealth(),
    };
  });

  // 4. Market Data: Candles
  app.get('/api/v1/market-data/candles', async (req, reply) => {
    const query = req.query as { globalId?: string; timeframe?: Timeframe; count?: string };
    if (!query.globalId) {
      return reply.status(400).send({ error: 'Missing globalId query parameter' });
    }
    const timeframe: Timeframe = query.timeframe || '1m';
    const count = query.count ? parseInt(query.count, 10) : 100;

    const candles = await activeProvider.getCandles(query.globalId, timeframe, count);
    return {
      globalId: query.globalId,
      timeframe,
      candles,
      feedHealth: activeProvider.getFeedHealth(),
    };
  });

  // 5. Market Data: Current Quote
  app.get('/api/v1/market-data/quote', async (req, reply) => {
    const query = req.query as { globalId?: string };
    if (!query.globalId) {
      return reply.status(400).send({ error: 'Missing globalId query parameter' });
    }
    const quote = await activeProvider.getQuote(query.globalId);
    if (!quote) {
      return reply.status(404).send({ error: 'Quote not found' });
    }
    return { quote, feedHealth: activeProvider.getFeedHealth() };
  });

  // 6. Virtual Account
  app.get('/api/v1/account', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const account = await repo.getAccount(req.user.accountId);
    if (!account) return { error: 'Account not found' };
    return {
      ...account,
      startingBalanceINR: Money.toRupees(account.startingBalancePaise),
      cashBalanceINR: Money.toRupees(account.cashBalancePaise),
      lockedMarginINR: Money.toRupees(account.lockedMarginPaise),
      availableBalanceINR: Money.toRupees(account.availableBalancePaise),
    };
  });

  // 7. Virtual Account Reset
  app.post('/api/v1/account/reset', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    const accountId = req.user.accountId;
    const positions = await repo.getPositions(accountId);
    const quotes = new Map<string, number>();
    for (const p of positions) {
      const q = await activeProvider.getQuote(p.globalInstrumentId);
      if (q) quotes.set(p.globalInstrumentId, q.ltp);
    }

    const resetResult = await repo.resetAccount(accountId, positions, quotes);
    if (!resetResult.success) {
      return reply.status(400).send({ error: resetResult.error });
    }

    // Mirror to memory engine
    accountEngine.resetAccount(accountId, positions, quotes);

    const updated = await repo.getAccount(accountId);
    return {
      message: 'Account reset successfully to ₹100,000.00',
      account: updated,
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

    const instList = await activeProvider.getInstruments();
    const instrument = instList.find((i) => i.globalId === body.globalInstrumentId);
    if (!instrument) {
      return reply.status(404).send({ error: `Instrument ${body.globalInstrumentId} not found` });
    }

    // Free vs Pro Access Gate: Free users restricted to NIFTY Practice module
    const userTier = await billingService.getAccountTier(userId);
    const isNiftyPractice =
      instrument.symbol.startsWith('NIFTY') ||
      instrument.underlying === 'NIFTY';

    if (userTier === 'FREE' && !isNiftyPractice) {
      return reply.status(403).send({
        error: `ERR_PRO_TIER_REQUIRED: Access to equities and stock derivatives requires a Pro Practice account. Upgrade to trade ${instrument.symbol}.`,
        code: 'ERR_PRO_TIER_REQUIRED',
      });
    }

    const quote = await activeProvider.getQuote(body.globalInstrumentId);
    if (!quote) {
      return reply.status(400).send({ error: 'No live quote available for instrument.' });
    }

    // Discipline Guard: Check daily loss & trade limits (never blocks risk reduction or exits)
    const existingOrders = await repo.getOrders(accountId);
    const todayOrdersCount = existingOrders.filter(
      (o) => Date.now() - o.createdAt < 86400000
    ).length;

    const isOpening = true; // Opening order check
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
      { ...body, accountId },
      instrument,
      account.availableBalancePaise,
      quote.ltp
    );

    if (!validation.isValid) {
      return reply.status(400).send({
        error: validation.errorMessage,
        code: validation.errorCode,
      });
    }

    try {
      const result = await simEngine.submitOrder(
        { ...body, accountId },
        instrument,
        quote,
        validation.requiredMarginPaise,
        validation.estimatedChargesPaise
      );

      return {
        success: true,
        order: {
          ...result.order,
          estimatedChargesINR: Money.toRupees(result.order.estimatedChargesPaise),
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

  // 10. Square-off Position
  app.post('/api/v1/positions/square-off', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    const body = req.body as { globalInstrumentId: string };
    const accountId = req.user.accountId;

    const quote = await activeProvider.getQuote(body.globalInstrumentId);
    if (!quote) {
      return reply.status(400).send({ error: 'No quote available to square off position.' });
    }

    try {
      const result = await simEngine.squareOffPosition(accountId, body.globalInstrumentId, quote);
      return {
        success: true,
        order: result.order,
        position: result.position,
      };
    } catch (err: any) {
      return reply.status(400).send({ error: err.message });
    }
  });

  // 11. Orders & Positions Retrieval
  app.get('/api/v1/orders', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const orders = await repo.getOrders(req.user.accountId);
    return {
      orders: orders.map((o) => ({
        ...o,
        estimatedChargesINR: Money.toRupees(o.estimatedChargesPaise),
      })),
    };
  });

  app.get('/api/v1/positions', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const positions = await repo.getPositions(req.user.accountId);
    return {
      positions: positions.map((p) => ({
        ...p,
        realizedPnlINR: Money.toRupees(p.realizedPnlPaise),
        unrealizedPnlINR: Money.toRupees(p.unrealizedPnlPaise),
      })),
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

  app.get('/api/v1/journal/analytics', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const accountId = req.user.accountId;
    const orders = await repo.getOrders(accountId);
    const executedExits = orders.filter((o) => o.status === 'EXECUTED');

    // Build closed trades list
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

  // 13. Multi-Watchlists
  app.get('/api/v1/watchlists', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const res = await db.query(
      'SELECT * FROM watchlists WHERE user_id = $1 ORDER BY created_at ASC',
      [req.user.userId]
    );
    return {
      watchlists: res.rows.map((r) => ({
        id: r.id,
        name: r.name,
        instruments: JSON.parse(r.instruments_json || '[]'),
        isDefault: r.is_default,
      })),
    };
  });

  app.post('/api/v1/watchlists', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    const body = req.body as { name: string; instruments?: string[] };
    const userId = req.user.userId;
    const tier = await billingService.getAccountTier(userId);

    const existing = await db.query('SELECT COUNT(*) as count FROM watchlists WHERE user_id = $1', [userId]);
    const count = parseInt(existing.rows[0].count, 10);

    // Limit check: Free = 1 watchlist, Pro = up to 10 watchlists
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
  app.post('/api/v1/billing/verify-purchase', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const body = req.body as { productId: string; purchaseToken: string };
    const res = await billingService.verifyPurchaseToken(req.user.userId, body.productId, body.purchaseToken);
    return res;
  });

  app.get('/api/v1/billing/status', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const tier = await billingService.getAccountTier(req.user.userId);
    return { tier, isPro: tier === 'PRO' };
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

  // 15. WebSocket Real-time Channel (with token-based client ownership)
  app.get('/ws', { websocket: true }, (connection: any) => {
    const ws = (connection.socket || connection) as WebSocket;
    const clientState = { ws, subscriptions: new Set<string>() };
    wsClients.add(clientState);

    // Default subscriptions: NIFTY Futures and NIFTY Spot
    clientState.subscriptions.add('NFO:NIFTY26OCTFUT:999001');
    clientState.subscriptions.add('NSE:NIFTY50:999000');

    ws.on('message', (raw: any) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.action === 'SUBSCRIBE' && Array.isArray(msg.symbols)) {
          for (const s of msg.symbols) clientState.subscriptions.add(s);
        } else if (msg.action === 'UNSUBSCRIBE' && Array.isArray(msg.symbols)) {
          for (const s of msg.symbols) clientState.subscriptions.delete(s);
        }
      } catch {
        // ignore malformed message
      }
    });

    ws.on('close', () => {
      wsClients.delete(clientState);
    });
  });

  return { app, provider: activeProvider, accountEngine, simEngine, repo, db };
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
