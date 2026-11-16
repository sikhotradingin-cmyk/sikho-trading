// Controlled API checks against owner-device-harness.cjs only. Never production.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const base = 'http://127.0.0.1:4100';
(async () => {
  const result = [];
  let token;
  async function request(path, body, auth = token) {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  const health = await request('/api/v1/feed-health');
  assert.equal(health.body.databaseEmulated, true, 'refuse any non-emulated database');
  assert.equal(health.body.activeProvider.isSimulated, true, 'require controlled QA provider');
  const registration = await request('/api/v1/auth/register', { name: 'Isolated Order QA',
    email: `orders-${crypto.randomUUID()}@example.test`, password: crypto.randomBytes(18).toString('hex') });
  assert.equal(registration.status, 200);
  assert.equal(registration.body.entitlement.tier, 'FREE');
  token = registration.body.token;
  result.push({ test: 'new genuinely unpaid local registration', result: 'PASS', tier: 'FREE' });
  const reset = await request('/api/v1/account/reset', { startingCapitalINR: 2000000 });
  assert.equal(reset.status, 200);
  const spot = await request('/api/v1/orders/place', { globalInstrumentId: 'NSE:NIFTY 50:99926000', side: 'BUY',
    quantity: 1, orderType: 'MARKET', idempotencyKey: crypto.randomUUID() });
  assert.equal(spot.body.code, 'ERR_SPOT_NOT_TRADABLE');
  result.push({ test: 'spot remains reference only', result: 'PASS', status: spot.status, code: spot.body.code });
  for (const underlying of ['NIFTY', 'BANKNIFTY']) {
    const discovery = await request(`/api/v1/instruments?segment=FUTIDX&underlying=${underlying}&limit=10`);
    const future = discovery.body.instruments.find(i => i.underlying === underlying);
    assert.ok(future);
    const chain = await request(`/api/v1/option-chain?underlying=${underlying}&limit=21`);
    assert.equal(chain.status, 200);
    assert.ok(chain.body.rows.length > 0);
    const rows = chain.body.rows;
    const middle = rows[Math.floor(rows.length / 2)];
    for (const contract of [future, middle.call.instrument, middle.put.instrument]) {
      for (const side of ['BUY', 'SELL']) {
        const order = await request('/api/v1/orders/place', { globalInstrumentId: contract.globalId,
          side, quantity: contract.lotSize, productType: 'MARGIN', orderType: 'MARKET', idempotencyKey: crypto.randomUUID() });
        assert.equal(order.status, 200, `${contract.globalId} ${side}: ${order.body.code || order.body.error}`);
        assert.equal(order.body.order.status, 'EXECUTED');
        result.push({ test: 'controlled simulated order', result: 'PASS', underlying, type: contract.instrumentType,
          optionType: contract.optionType || null, expiry: contract.expiry, lotSize: contract.lotSize, side, status: order.status });
      }
    }
    const strikes = new Set();
    for (let offset = 0; offset < chain.body.strikeWindow.total; offset += 21) {
      const page = await request(`/api/v1/option-chain?underlying=${underlying}&expiry=${chain.body.selectedExpiry}&offset=${offset}&limit=21`);
      for (const row of page.body.rows) strikes.add(row.strikePrice);
    }
    assert.equal(strikes.size, chain.body.strikeWindow.total);
    result.push({ test: 'all returned strikes reachable', result: 'PASS', underlying, strikes: strikes.size, expiry: chain.body.selectedExpiry });
    for (const timeframe of ['1m', '3m', '5m', '15m', '30m', '1h', '1D']) {
      const history = await request(`/api/v1/market-data/candles?globalId=${encodeURIComponent(future.globalId)}&timeframe=${timeframe}`);
      assert.equal(history.status, 200);
      assert.equal(history.body.timeframe, timeframe);
      const expected = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '1D': 86400 }[timeframe];
      assert.equal(history.body.candles[1].time - history.body.candles[0].time, expected);
      result.push({ test: 'controlled history interval', result: 'PASS', underlying, timeframe, seconds: expected });
    }
  }
  const locked = await request('/api/v1/option-chain?underlying=SENSEX');
  assert.equal(locked.status, 403);
  assert.equal(locked.body.code, 'UPGRADE_REQUIRED');
  result.push({ test: 'FREE SENSEX remains locked', result: 'PASS', status: locked.status, code: locked.body.code });
  const pro = JSON.parse(fs.readFileSync('C:/tmp/sikho-isolated-device-sessions.json', 'utf8')).PRO;
  const sensex = await request('/api/v1/option-chain?underlying=SENSEX&limit=21', null, pro.token);
  assert.equal(sensex.status, 200);
  assert.ok(sensex.body.rows.length > 0);
  result.push({ test: 'isolated approved Premium SENSEX chain', result: 'PASS', rows: sensex.body.rows.length });
  console.log(JSON.stringify({ environment: 'isolated pg-mem, controlled simulated prices; NSE CLOSED during verification', results: result }, null, 2));
})().catch(e => { console.error(e.constructor.name, e.message); process.exitCode = 1; });
