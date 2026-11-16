import test from 'node:test';
import assert from 'node:assert/strict';
import { UpstoxAdapter } from './upstox-adapter.js';

test('Upstox shares one provider subscription and unsubscribes the last consumer', async () => {
  const adapter = new UpstoxAdapter({});
  const internal = adapter as any;
  const gid = 'NFO:NIFTY 25000 CE 24 NOV 26:123';
  const inst = { globalId: gid, symbol: 'NIFTY 25000 CE 24 NOV 26', exchange: 'NFO', token: '123',
    underlying: 'NIFTY', instrumentType: 'OPTIDX', upstoxInstrumentKey: 'NSE_FO|123' };
  internal.allInstruments.set(gid, inst);
  internal.getQuote = async () => null;
  internal.isConnected = true;
  const sent: any[] = [];
  internal.ws = { readyState: 1, send: (raw: Buffer) => sent.push(JSON.parse(raw.toString())) };
  const releaseFirst = adapter.subscribe(gid, () => {});
  const releaseLast = adapter.subscribe(gid, () => {});
  assert.deepEqual(sent.map(s => s.method), ['sub']);
  releaseFirst();
  assert.equal(internal.listeners.get(gid).size, 1);
  assert.equal(sent.length, 1);
  releaseLast();
  assert.equal(internal.listeners.has(gid), false);
  assert.deepEqual(sent.map(s => s.method), ['sub', 'unsub']);
  assert.deepEqual(sent[1].data.instrumentKeys, ['NSE_FO|123']);
  internal.sendActiveWebSocketSubscriptions();
  assert.equal(sent.length, 2, 'reconnect must not restore obsolete contracts');
  internal.listeners = new Map(Array.from({ length: 2000 }, (_, i) => [`capacity-${i}`, new Set([() => {}])]));
  assert.throws(() => adapter.subscribe(gid, () => {}), /ERR_MARKET_DATA_CAPACITY/);
  assert.equal(sent.length, 2, 'never send beyond the full-mode provider limit');
  internal.ws = null;
  await adapter.dispose();
});
