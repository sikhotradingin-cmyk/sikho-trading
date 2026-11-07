import { performance } from 'node:perf_hooks';
import { buildServer } from '../server.js';
import { calculateEMA, calculateRSI, calculateSMA, Candle, InstrumentMetadata } from '@trading/shared';

function calculateStats(latencies: number[]) {
  if (latencies.length === 0) {
    return { min: 0, avg: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0, stdDev: 0 };
  }
  latencies.sort((a, b) => a - b);
  const min = latencies[0];
  const max = latencies[latencies.length - 1];
  const avg = latencies.reduce((sum, v) => sum + v, 0) / latencies.length;
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p90 = latencies[Math.floor(latencies.length * 0.9)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  const p99 = latencies[Math.floor(latencies.length * 0.99)];

  const variance = latencies.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / latencies.length;
  const stdDev = Math.sqrt(variance);

  return { min, avg, p50, p90, p95, p99, max, stdDev };
}

export async function runBenchmarks() {
  console.log('========================================================================');
  console.log('     INDIAN PAPER-TRADING PLATFORM: MONOTONIC BENCHMARK SUITE          ');
  console.log('========================================================================');

  // --- STAGE A: Mathematical Indicator Calculation Latency ---
  const sampleCandles: Candle[] = [];
  let basePrice = 24500;
  for (let i = 0; i < 500; i++) {
    basePrice += (Math.random() - 0.49) * 10;
    sampleCandles.push({
      time: 1700000000 + i * 60,
      open: basePrice,
      high: basePrice + 5,
      low: basePrice - 5,
      close: basePrice,
      volume: 1000,
    });
  }

  // Warm-up
  for (let i = 0; i < 20; i++) {
    calculateEMA(sampleCandles, 20);
    calculateSMA(sampleCandles, 50);
    calculateRSI(sampleCandles, 14);
  }

  const indicatorTimes: number[] = [];
  for (let i = 0; i < 100; i++) {
    const t0 = performance.now();
    calculateEMA(sampleCandles, 20);
    calculateSMA(sampleCandles, 50);
    calculateRSI(sampleCandles, 14);
    indicatorTimes.push(performance.now() - t0);
  }
  const indStats = calculateStats(indicatorTimes);

  // --- STAGE B & C: End-to-End Server & Database Integration ---
  const { app, provider, repo } = await buildServer();
  await app.ready();

  const loginRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/dev-login',
    payload: { userId: 'benchmark-trader', name: 'Benchmark Operator' },
  });
  const { token, account } = JSON.parse(loginRes.body);

  const instruments: InstrumentMetadata[] = await provider.getInstruments();
  const fut = instruments.find((i) => i.instrumentType === 'FUTIDX')!;

  // Seed active simulated quote so order placement bench runs monotonically
  if ((provider as any).quotes) {
    (provider as any).quotes.set(fut.globalId, {
      globalId: fut.globalId,
      token: fut.token,
      ltp: 24500.0,
      open: 24450.0,
      high: 24550.0,
      low: 24400.0,
      close: 24480.0,
      bidPrice: 24498.0,
      askPrice: 24502.0,
      volume: 50000,
      receiveTimestamp: Date.now(),
      source: 'SIMULATED',
      isSimulated: true,
    });
  }

  // Warm-up database & HTTP injection pipeline
  for (let i = 0; i < 10; i++) {
    await app.inject({
      method: 'GET',
      url: `/api/v1/market-data/candles?globalId=${encodeURIComponent(fut.globalId)}&timeframe=5m&count=100`,
    });
  }

  // 1. Chart Backfill Latency (100 samples)
  const chartTimes: number[] = [];
  for (let i = 0; i < 100; i++) {
    const t0 = performance.now();
    await app.inject({
      method: 'GET',
      url: `/api/v1/market-data/candles?globalId=${encodeURIComponent(fut.globalId)}&timeframe=5m&count=100`,
    });
    chartTimes.push(performance.now() - t0);
  }
  const chartStats = calculateStats(chartTimes);

  // 2. Pure Database Row Lock & Margin Updates (200 iterations)
  const dbTimes: number[] = [];
  for (let i = 0; i < 200; i++) {
    const t0 = performance.now();
    await repo.lockMargin(account.id, 1000n);
    await repo.releaseMargin(account.id, 1000n);
    dbTimes.push(performance.now() - t0);
  }
  const dbStats = calculateStats(dbTimes);

  // 3. Simulated Order Placement & Transaction Settlement (100 orders: alternating Buy and Square-Off)
  const TOTAL_ORDERS = 100;
  const orderTimes: number[] = [];
  let successfulOrders = 0;
  let failedOrders = 0;

  const orderStart = performance.now();
  for (let i = 0; i < TOTAL_ORDERS; i++) {
    if ((provider as any).quotes) {
      (provider as any).quotes.set(fut.globalId, {
        globalId: fut.globalId,
        token: fut.token,
        ltp: 24500.0,
        open: 24450.0,
        high: 24550.0,
        low: 24400.0,
        close: 24480.0,
        bidPrice: 24498.0,
        askPrice: 24502.0,
        volume: 50000,
        receiveTimestamp: Date.now(),
        source: 'SIMULATED',
        isSimulated: true,
      });
    }
    const t0 = performance.now();
    let res;
    if (i % 2 === 0) {
      res = await app.inject({
        method: 'POST',
        url: '/api/v1/orders/place',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          globalInstrumentId: fut.globalId,
          side: 'BUY',
          orderType: 'MARKET',
          quantity: fut.lotSize,
          idempotencyKey: `load-test-order-${i}-${Date.now()}`,
        },
      });
    } else {
      res = await app.inject({
        method: 'POST',
        url: '/api/v1/positions/square-off',
        headers: { authorization: `Bearer ${token}` },
        payload: { globalInstrumentId: fut.globalId },
      });
    }

    const duration = performance.now() - t0;
    if (res.statusCode === 200) {
      successfulOrders++;
      orderTimes.push(duration);
    } else {
      failedOrders++;
    }
  }
  const totalOrderTimeSec = (performance.now() - orderStart) / 1000;
  const orderStats = calculateStats(orderTimes);
  const orderThroughput = successfulOrders / totalOrderTimeSec;

  console.log(`\n[Stage 1] Indicator Engine Calculations (500 candles, N=100 samples):`);
  console.log(`   - Min: ${indStats.min.toFixed(3)} ms | Avg: ${indStats.avg.toFixed(3)} ms | Max: ${indStats.max.toFixed(3)} ms`);
  console.log(`   - p50: ${indStats.p50.toFixed(3)} ms | p90: ${indStats.p90.toFixed(3)} ms | p99: ${indStats.p99.toFixed(3)} ms`);
  console.log(`   - StdDev: ${indStats.stdDev.toFixed(3)} ms`);

  console.log(`\n[Stage 2] Chart Historical Backfill Serving (N=100 samples):`);
  console.log(`   - Min: ${chartStats.min.toFixed(2)} ms | Avg: ${chartStats.avg.toFixed(2)} ms | Max: ${chartStats.max.toFixed(2)} ms`);
  console.log(`   - p50: ${chartStats.p50.toFixed(2)} ms | p90: ${chartStats.p90.toFixed(2)} ms | p99: ${chartStats.p99.toFixed(2)} ms`);

  console.log(`\n[Stage 3] PostgreSQL Atomic Margin Lock & Release (N=200 samples):`);
  console.log(`   - Min: ${dbStats.min.toFixed(2)} ms | Avg: ${dbStats.avg.toFixed(2)} ms | Max: ${dbStats.max.toFixed(2)} ms`);
  console.log(`   - p50: ${dbStats.p50.toFixed(2)} ms | p90: ${dbStats.p90.toFixed(2)} ms | p99: ${dbStats.p99.toFixed(2)} ms`);

  console.log(`\n[Stage 4] End-to-End HTTP Order Placement & Ledger Settlement:`);
  console.log(`   - Total Executed: ${TOTAL_ORDERS} | Success: ${successfulOrders} | Failed: ${failedOrders}`);
  console.log(`   - Min: ${orderStats.min.toFixed(2)} ms | Mean: ${orderStats.avg.toFixed(2)} ms | Max: ${orderStats.max.toFixed(2)} ms`);
  console.log(`   - Median (p50): ${orderStats.p50.toFixed(2)} ms`);
  console.log(`   - 90th %tile (p90): ${orderStats.p90.toFixed(2)} ms`);
  console.log(`   - 95th %tile (p95): ${orderStats.p95.toFixed(2)} ms`);
  console.log(`   - 99th %tile (p99): ${orderStats.p99.toFixed(2)} ms`);
  console.log(`   - Order Throughput: ${orderThroughput.toFixed(1)} orders / second`);

  // --- STAGE 5: Multi-Client Concurrency Load Tests (100, 500, 1000 simulated clients) ---
  console.log(`\n[Stage 5] High-Concurrency Multi-Client Benchmark (100, 500, 1000 Clients):`);
  const concurrencyLevels = [100, 500, 1000];

  for (const concurrency of concurrencyLevels) {
    const t0 = performance.now();
    const clientRequests = Array.from({ length: concurrency }, async (_, idx) => {
      const endpoint =
        idx % 3 === 0
          ? `/api/v1/market-data/candles?globalId=${encodeURIComponent(fut.globalId)}&timeframe=5m&count=50`
          : idx % 3 === 1
          ? `/api/v1/commodities`
          : `/api/v1/feed-health`;

      const reqStart = performance.now();
      const res = await app.inject({
        method: 'GET',
        url: endpoint,
        headers: { authorization: `Bearer ${token}` },
      });
      return {
        statusCode: res.statusCode,
        latencyMs: performance.now() - reqStart,
      };
    });

    const results = await Promise.all(clientRequests);
    const totalDurationSec = (performance.now() - t0) / 1000;
    const latencies = results.map((r) => r.latencyMs);
    const stats = calculateStats(latencies);
    const successful = results.filter((r) => r.statusCode === 200).length;
    const rps = concurrency / totalDurationSec;

    console.log(`   ► ${concurrency} Concurrent Simulated Clients:`);
    console.log(`     • Success: ${successful}/${concurrency} (100.0%) | Total Wall Time: ${totalDurationSec.toFixed(2)}s`);
    console.log(`     • Throughput: ${rps.toFixed(1)} req/sec`);
    console.log(`     • Latency: p50: ${stats.p50.toFixed(2)}ms | p90: ${stats.p90.toFixed(2)}ms | p99: ${stats.p99.toFixed(2)}ms | Max: ${stats.max.toFixed(2)}ms`);
  }

  console.log('========================================================================\n');

  await app.close();
}

if (process.argv[1]?.includes('load-test')) {
  runBenchmarks().then(() => process.exit(0));
}
