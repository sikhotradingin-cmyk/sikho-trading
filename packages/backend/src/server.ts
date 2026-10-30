import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import {
  Money,
  OrderValidator,
  PlaceOrderRequest,
  Timeframe,
} from '@trading/shared';
import { config } from './config.js';
import { DeterministicProvider } from './providers/deterministic-provider.js';
import { IMarketDataProvider } from './providers/types.js';
import { SmartAPIAdapter } from './providers/smartapi-adapter.js';
import { VirtualAccountEngine } from './engine/virtual-account-engine.js';
import { SimulationEngine } from './engine/simulation-engine.js';
import { WebSocket } from 'ws';

// Ensure BigInt can be serialized to JSON safely
if (!(BigInt.prototype as any).toJSON) {
  (BigInt.prototype as any).toJSON = function () {
    return this.toString();
  };
}

export async function buildServer(): Promise<{
  app: FastifyInstance;
  provider: IMarketDataProvider;
  accountEngine: VirtualAccountEngine;
  simEngine: SimulationEngine;
}> {
  const app = Fastify({ logger: false });

  await app.register(cors, { origin: true });
  await app.register(jwt, { secret: config.jwtSecret });
  await app.register(websocket);

  // Initialize Providers
  const demoProvider = new DeterministicProvider();
  await demoProvider.init();

  const smartApiAdapter = new SmartAPIAdapter(config.smartApi);
  await smartApiAdapter.init();

  // Active provider selection: Default to demoProvider
  const activeProvider: IMarketDataProvider = demoProvider;

  app.addHook('onClose', async () => {
    await demoProvider.dispose();
    await smartApiAdapter.dispose();
  });

  // Initialize Engines
  const accountEngine = new VirtualAccountEngine();
  const simEngine = new SimulationEngine(accountEngine);

  // Connect Market Ticks to Simulation Engine
  const instruments = await activeProvider.getInstruments();
  for (const inst of instruments) {
    activeProvider.subscribe(inst.globalId, (quote) => {
      simEngine.onMarketTick(quote);
    });
  }

  // Active WebSocket clients
  const wsClients = new Set<{ ws: WebSocket; subscriptions: Set<string> }>();

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
    };
  });

  // 2. Authentication (Safe Dev Login)
  app.post('/api/v1/auth/dev-login', async (req, reply) => {
    if (!config.enableDevAuth) {
      return reply.status(403).send({ error: 'Development authentication is disabled in production.' });
    }
    const body = req.body as { userId?: string; name?: string } | undefined;
    const userId = body?.userId || 'dev-trader-01';
    const userName = body?.name || 'Practicing Retail Trader';

    const account = accountEngine.provisionInitialAccount(userId, `${userName}'s Virtual Account`);
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

  // 3. Instruments Master
  app.get('/api/v1/instruments', async () => {
    const list = await activeProvider.getInstruments();
    return {
      instruments: list,
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
    const account = accountEngine.getAccount(req.user.accountId);
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
    const positions = simEngine.getPositions(accountId);
    const quotes = new Map<string, number>();
    for (const p of positions) {
      const q = await activeProvider.getQuote(p.globalInstrumentId);
      if (q) quotes.set(p.globalInstrumentId, q.ltp);
    }

    const resetResult = accountEngine.resetAccount(accountId, positions, quotes);
    if (!resetResult.success) {
      return reply.status(400).send({ error: resetResult.error });
    }

    const updated = accountEngine.getAccount(accountId);
    return {
      message: 'Account reset successfully to ₹100,000.00',
      account: updated,
    };
  });

  // 8. Account Audit Ledger
  app.get('/api/v1/account/ledger', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const entries = accountEngine.getLedger(req.user.accountId);
    return {
      ledger: entries.map((e) => ({
        ...e,
        amountINR: Money.toRupees(e.amountPaise),
        balanceAfterINR: Money.toRupees(e.balanceAfterPaise),
      })),
    };
  });

  // 9. Place Simulated Order
  app.post('/api/v1/orders/place', { preHandler: [(app as any).authenticate] }, async (req: any, reply) => {
    const body = req.body as PlaceOrderRequest;
    const accountId = req.user.accountId;

    const account = accountEngine.getAccount(accountId);
    if (!account) return reply.status(404).send({ error: 'Account not found' });

    const instList = await activeProvider.getInstruments();
    const instrument = instList.find((i) => i.globalId === body.globalInstrumentId);
    if (!instrument) {
      return reply.status(404).send({ error: `Instrument ${body.globalInstrumentId} not found` });
    }

    const quote = await activeProvider.getQuote(body.globalInstrumentId);
    if (!quote) {
      return reply.status(400).send({ error: 'No live quote available for instrument.' });
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
      const result = simEngine.squareOffPosition(accountId, body.globalInstrumentId, quote);
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
    const orders = simEngine.getOrders(req.user.accountId);
    return {
      orders: orders.map((o) => ({
        ...o,
        estimatedChargesINR: Money.toRupees(o.estimatedChargesPaise),
      })),
    };
  });

  app.get('/api/v1/positions', { preHandler: [(app as any).authenticate] }, async (req: any) => {
    const positions = simEngine.getPositions(req.user.accountId);
    return {
      positions: positions.map((p) => ({
        ...p,
        realizedPnlINR: Money.toRupees(p.realizedPnlPaise),
        unrealizedPnlINR: Money.toRupees(p.unrealizedPnlPaise),
      })),
    };
  });

  // 12. WebSocket Real-time Channel
  app.get('/ws', { websocket: true }, (connection: any) => {
    const ws = (connection.socket || connection) as WebSocket;
    const clientState = { ws, subscriptions: new Set<string>() };
    wsClients.add(clientState);

    // Default subscription: NIFTY Futures and NIFTY Spot
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

  return { app, provider: activeProvider, accountEngine, simEngine };
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
