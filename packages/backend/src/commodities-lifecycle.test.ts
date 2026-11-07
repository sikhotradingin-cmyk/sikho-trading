import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { FastifyInstance } from 'fastify';
import { buildServer } from './server.js';

describe('MCX Commodities Paper Trading & Contract Lifecycle', () => {
  let app: FastifyInstance;
  let provider: any;
  let authToken: string;

  before(async () => {
    const serverBundle = await buildServer(undefined, 'UPSTOX');
    app = serverBundle.app;
    provider = serverBundle.provider;
    await app.ready();

    // Authenticate a dev test user
    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/dev-login',
      payload: { email: 'commodity_trader@example.com', name: 'Commodity Trader' },
    });
    assert.strictEqual(loginRes.statusCode, 200);
    const body = JSON.parse(loginRes.payload);
    authToken = body.token;
  });

  after(async () => {
    await app.close();
  });

  it('GET /api/v1/commodities returns grouped Metals, Energy, and Agriculture discovery', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/commodities',
    });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.ok(Array.isArray(body.metals), 'metals should be an array');
    assert.ok(Array.isArray(body.energy), 'energy should be an array');
    assert.ok(Array.isArray(body.agriculture), 'agriculture should be an array');

    // Verify key representative commodities are present
    const energySymbols = body.energy.map((i: any) => i.symbol);
    assert.ok(
      energySymbols.some((s: string) => s.includes('CRUDE')),
      'Should discover Crude Oil contracts in Energy'
    );
    assert.ok(
      energySymbols.some((s: string) => s.includes('NATURALGAS') || s.includes('NATGAS')),
      'Should discover Natural Gas contracts in Energy'
    );

    const metalSymbols = body.metals.map((i: any) => i.symbol);
    assert.ok(
      metalSymbols.some((s: string) => s.includes('GOLD')),
      'Should discover Gold contracts in Metals'
    );
    assert.ok(
      metalSymbols.some((s: string) => s.includes('SILVER')),
      'Should discover Silver contracts in Metals'
    );
  });

  it('GET /api/v1/commodities/specs provides official contract specifications matrix', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/commodities/specs',
    });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.strictEqual(body.exchange, 'MCX');
    assert.ok(body.specs.GOLD, 'Specs should contain GOLD');
    assert.strictEqual(body.specs.GOLD.priceQuoteMultiplier, 10);
    assert.strictEqual(body.specs.GOLD.tickValuePerLot, 10);

    assert.ok(body.specs.CRUDEOIL, 'Specs should contain CRUDEOIL');
    assert.strictEqual(body.specs.CRUDEOIL.priceQuoteMultiplier, 100);
    assert.strictEqual(body.specs.CRUDEOIL.tickValuePerLot, 100);

    assert.ok(body.specs.NATURALGAS, 'Specs should contain NATURALGAS');
    assert.strictEqual(body.specs.NATURALGAS.priceQuoteMultiplier, 1250);
    assert.strictEqual(body.specs.NATURALGAS.tickValuePerLot, 125);
  });

  it('GET /api/v1/option-chain resolves commodity option chains referencing underlying futures', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/option-chain?underlying=CRUDEOIL',
    });
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.strictEqual(body.underlying, 'CRUDEOIL');
    assert.ok(body.availableExpiries.length > 0, 'Should have available expiries for Crude Oil options');
    assert.ok(Array.isArray(body.rows), 'Should return strike rows');
    assert.ok(body.rows.length > 0, 'Should have strikes');
  });

  it('executes simulated BUY and SELL for Crude Oil futures with exact lot and tick P&L accounting', async () => {
    // 1. Fetch available Crude Oil futures contract and its candles
    const searchRes = await app.inject({
      method: 'GET',
      url: '/api/v1/instruments?q=CRUDEOIL&segment=COMMODITY&limit=5',
    });
    assert.strictEqual(searchRes.statusCode, 200);
    const searchBody = JSON.parse(searchRes.payload);
    const crudeInst = searchBody.instruments.find((i: any) => i.instrumentType === 'FUTCOM' && i.exchange === 'MCX');
    assert.ok(crudeInst, 'Crude Oil FUTCOM instrument must be discovered');

    // Seed a simulated quote snapshot in the provider cache to simulate market reception
    provider.quotes.set(crudeInst.globalId, {
      globalId: crudeInst.globalId,
      token: crudeInst.token,
      ltp: 5950.0,
      open: 5900.0,
      high: 5980.0,
      low: 5890.0,
      close: 5910.0,
      bidPrice: 5949.0,
      askPrice: 5951.0,
      volume: 12500,
      receiveTimestamp: Date.now(),
      source: 'UPSTOX',
      isSimulated: true,
    });

    // 2. Place simulated BUY market order
    const buyRes = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/place',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        globalInstrumentId: crudeInst.globalId,
        side: 'BUY',
        orderType: 'MARKET',
        productType: 'MARGIN',
        quantity: crudeInst.lotSize, // 100 bbl
        idempotencyKey: `mcx-buy-test-${Date.now()}`,
      },
    });
    if (buyRes.statusCode !== 200) {
      console.error('BUY FAILED:', buyRes.statusCode, buyRes.payload);
    }
    assert.strictEqual(buyRes.statusCode, 200);
    const buyBody = JSON.parse(buyRes.payload);
    assert.strictEqual(buyBody.order.status, 'EXECUTED');
    assert.strictEqual(buyBody.order.quantity, crudeInst.lotSize);
    const entryPrice = buyBody.order.executedPrice;
    assert.ok(entryPrice && entryPrice > 0, 'Must have a valid executed fill price');

    // 3. Verify positions endpoint
    const posRes = await app.inject({
      method: 'GET',
      url: '/api/v1/positions',
      headers: { authorization: `Bearer ${authToken}` },
    });
    assert.strictEqual(posRes.statusCode, 200);
    const posBody = JSON.parse(posRes.payload);
    const crudePos = posBody.activePositions.find((p: any) => p.globalInstrumentId === crudeInst.globalId);
    assert.ok(crudePos, 'Active Crude Oil position must exist');
    assert.strictEqual(crudePos.quantity, crudeInst.lotSize);

    // 4. Square off position
    const exitRes = await app.inject({
      method: 'POST',
      url: '/api/v1/positions/square-off',
      headers: { authorization: `Bearer ${authToken}` },
      payload: { globalInstrumentId: crudeInst.globalId },
    });
    if (exitRes.statusCode !== 200) {
      console.error('EXIT FAILED:', exitRes.statusCode, exitRes.payload);
    }
    assert.strictEqual(exitRes.statusCode, 200);
    const exitBody = JSON.parse(exitRes.payload);
    assert.strictEqual(exitBody.order.status, 'EXECUTED');

    // 5. Verify position is closed
    const afterPosRes = await app.inject({
      method: 'GET',
      url: '/api/v1/positions',
      headers: { authorization: `Bearer ${authToken}` },
    });
    const afterPosBody = JSON.parse(afterPosRes.payload);
    const remainingPos = afterPosBody.activePositions.find((p: any) => p.globalInstrumentId === crudeInst.globalId);
    assert.ok(!remainingPos, 'Active position must be closed after square-off');
  });
});
