// Explicitly isolated device QA. Never loads .env, production databases or provider tokens.
// Controlled prices are deliberately marked simulated; this is NOT live-market evidence.
if (process.env.SIKHO_OWNER_DEVICE_HARNESS !== 'true') throw Error('Set SIKHO_OWNER_DEVICE_HARNESS=true to run isolated device QA');
process.env.NODE_ENV = 'test';
process.env.SIKHO_TEST_MODE = 'true';
for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL', 'TEST_USE_REAL_PG', 'UPSTOX_ANALYTICS_TOKEN',
  'SMARTAPI_API_KEY', 'SMARTAPI_CLIENT_CODE', 'SMARTAPI_PASSWORD', 'SMARTAPI_TOTP_SECRET', 'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON']) delete process.env[key];
const { buildServer } = require('../packages/backend/dist/server.js');
const { EmulatedPostgresDatabase } = require('../packages/backend/dist/db/database.js');
const { computeIntervalBucketSec } = require('../packages/backend/dist/market/forming-candles.js');
const fs = require('node:fs');
const crypto = require('node:crypto');
(async () => {
  const db = new EmulatedPostgresDatabase();
  const bundle = await buildServer(db, 'UPSTOX');
  const { app, provider, billingService } = bundle;
  let sequence = 0;
  const quoteFor = async (id) => {
    const inst = await provider.getInstrumentById(id);
    if (!inst) return null;
    const root = inst.underlying || inst.symbol;
    const spot = /BANKNIFTY|NIFTY BANK/.test(root) ? 61575 : /SENSEX/.test(root) ? 82000 : 25291;
    const base = inst.optionType ? 125 + Math.abs(Number(inst.strikePrice || spot) - spot) * 0.015 : spot;
    const ltp = Math.round((base + ((sequence % 11) - 5) * (inst.optionType ? 0.05 : 0.5)) * 20) / 20;
    return { globalId: inst.globalId, token: inst.token, ltp, open: base, high: base + 20, low: base - 20,
      close: base, bidPrice: ltp - 0.05, askPrice: ltp + 0.05, bidQty: inst.lotSize * 10,
      askQty: inst.lotSize * 10, volume: 10000 + sequence * 100, openInterest: 25000 + sequence,
      providerTimestamp: Date.now(), receiveTimestamp: Date.now(), source: 'DEMO', isSimulated: true };
  };
  provider.getQuote = quoteFor;
  provider.getFeedHealth = () => ({ source: 'DEMO', status: 'SIMULATED', isSimulated: true,
    uiBannerLabel: 'CONTROLLED QA — SIMULATED PRICES', message: 'Isolated in-memory database; controlled fixture ticks',
    lastTickTimestamp: Date.now(), latencyMs: 0 });
  provider.getCandlesPaginated = async (id, tf, opts = {}) => {
    const q = await quoteFor(id);
    const interval = ({ '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '1D': 86400 })[tf];
    if (!q || !interval) throw Error('Invalid controlled fixture contract or interval');
    const end = opts.before ? opts.before - interval : computeIntervalBucketSec(Date.now(), tf, id);
    const candles = Array.from({ length: Math.min(opts.limit || 120, 120) }, (_, i) => {
      const close = q.ltp + (i % 9) * 0.05;
      return { time: end - (119 - i) * interval, open: close - 0.05, high: close + 0.1, low: close - 0.1, close, volume: 1000 };
    });
    return { candles, hasMore: true, earliestTime: candles[0].time, latestTime: end,
      sessionDateIST: new Date(Date.now() + 19800000).toISOString().slice(0, 10), prevSessionClose: q.close };
  };
  const timer = setInterval(async () => {
    sequence++;
    for (const [gid, listeners] of provider.listeners) {
      if (!listeners.size) continue;
      const q = await quoteFor(gid);
      if (q) { provider.quotes.set(gid, q); for (const listener of listeners) listener(q); }
    }
  }, 1000);
  app.addHook('onClose', async () => clearInterval(timer));
  const sessions = {};
  for (const tier of ['FREE', 'PRO']) {
    const email = `device-qa-${tier.toLowerCase()}@example.test`;
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/register',
      payload: { email, name: `Isolated QA ${tier}`, password: crypto.randomBytes(18).toString('hex') } });
    if (res.statusCode !== 200) throw Error(`Fixture registration failed: ${res.statusCode}`);
    const auth = JSON.parse(res.body);
    if (auth.entitlement.tier !== 'FREE') throw Error('New unpaid account must be FREE');
    if (tier === 'PRO') {
      await billingService.grantComplimentaryPro({ email, userId: auth.user.userId,
        reason: 'Isolated owner-requested device QA only', grantedBy: 'ISOLATED_DEVICE_HARNESS', expiresAt: Date.now() + 3600000 });
    }
    sessions[tier] = { token: auth.token, user: auth.user, account: auth.account };
  }
  fs.writeFileSync('C:/tmp/sikho-isolated-device-sessions.json', JSON.stringify(sessions));
  await app.listen({ port: 4100, host: '127.0.0.1' });
  console.info('ISOLATED_QA_READY port=4100 database=pg-mem controlledPrices=true newUnpaidAccounts=FREE');
})().catch(err => { console.error(err.constructor.name, err.message); process.exit(1); });
