import { performance } from 'node:perf_hooks';
import { buildServer } from '../server.js';
import { InstrumentMetadata } from '@trading/shared';

function calculatePercentiles(latencies: number[]) {
  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p90 = latencies[Math.floor(latencies.length * 0.9)];
  const p99 = latencies[Math.floor(latencies.length * 0.99)];
  const min = latencies[0];
  const max = latencies[latencies.length - 1];
  const avg = latencies.reduce((sum, v) => sum + v, 0) / latencies.length;
  return { min, avg, p50, p90, p99, max };
}

export async function runBenchmarks() {
  console.log('===============================================================');
  console.log('   INDIAN PAPER-TRADING PLATFORM: PERFORMANCE BENCHMARKS       ');
  console.log('===============================================================');

  const { app, provider } = await buildServer();
  await app.ready();

  // 1. Authenticate dev user
  const loginRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/dev-login',
    payload: { userId: 'benchmark-user', name: 'Benchmark Trader' },
  });
  const { token } = JSON.parse(loginRes.body);

  const instruments: InstrumentMetadata[] = await provider.getInstruments();
  const fut = instruments.find((i) => i.instrumentType === 'FUTIDX')!;

  // 2. Measure Chart Candles Backfill (Uncached vs Subsequent)
  const uncachedStart = performance.now();
  await app.inject({
    method: 'GET',
    url: `/api/v1/market-data/candles?globalId=${encodeURIComponent(fut.globalId)}&timeframe=5m&count=150`,
  });
  const uncachedDuration = performance.now() - uncachedStart;

  const candleLatencies: number[] = [];
  for (let i = 0; i < 50; i++) {
    const start = performance.now();
    await app.inject({
      method: 'GET',
      url: `/api/v1/market-data/candles?globalId=${encodeURIComponent(fut.globalId)}&timeframe=5m&count=150`,
    });
    candleLatencies.push(performance.now() - start);
  }
  const candleStats = calculatePercentiles(candleLatencies);

  // 3. Measure Simulated Order Placement & Atomic Ledger Throughput
  const orderLatencies: number[] = [];
  const TOTAL_ORDERS = 500;
  const benchmarkStart = performance.now();

  for (let i = 0; i < TOTAL_ORDERS; i++) {
    const start = performance.now();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders/place',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        globalInstrumentId: fut.globalId,
        side: i % 2 === 0 ? 'BUY' : 'SELL',
        orderType: 'MARKET',
        quantity: fut.lotSize,
        idempotencyKey: `bench-order-${i}`,
      },
    });
    const duration = performance.now() - start;
    if (res.statusCode === 200) {
      orderLatencies.push(duration);
    }
  }

  const totalTimeSec = (performance.now() - benchmarkStart) / 1000;
  const orderStats = calculatePercentiles(orderLatencies);
  const throughput = TOTAL_ORDERS / totalTimeSec;

  console.log(`\n1. Market Data Chart Backfill Latency (Sample size: 50):`);
  console.log(`   - First Uncached Chart Request: ${uncachedDuration.toFixed(2)} ms`);
  console.log(`   - In-Memory Serving p50: ${candleStats.p50.toFixed(2)} ms`);
  console.log(`   - In-Memory Serving p90: ${candleStats.p90.toFixed(2)} ms`);
  console.log(`   - In-Memory Serving p99: ${candleStats.p99.toFixed(2)} ms`);

  console.log(`\n2. Simulated Order Placement & Margin Lock (Sample size: ${TOTAL_ORDERS}):`);
  console.log(`   - Mean Order Latency: ${orderStats.avg.toFixed(2)} ms`);
  console.log(`   - Median (p50): ${orderStats.p50.toFixed(2)} ms`);
  console.log(`   - 90th Percentile (p90): ${orderStats.p90.toFixed(2)} ms`);
  console.log(`   - 99th Percentile (p99): ${orderStats.p99.toFixed(2)} ms`);
  console.log(`   - Maximum Latency: ${orderStats.max.toFixed(2)} ms`);
  console.log(`   - Order Engine Throughput: ${throughput.toFixed(1)} orders / second`);

  await app.close();
  console.log('\n===============================================================');
}

if (process.argv[1]?.includes('load-test')) {
  runBenchmarks().then(() => process.exit(0));
}
