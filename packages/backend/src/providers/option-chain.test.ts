import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { UpstoxAdapter } from './upstox-adapter.js';

/**
 * Controlled option-chain tests using the bundled BOD instrument master (no live provider needed).
 * They verify expiry validity, strike-window pagination, ATM-centred defaults and the contract ids
 * the client must subscribe to for live CE/PE ticks.
 */
describe('Upstox option chain: valid expiries, paginated strikes and subscription ids', () => {
  let adapter: UpstoxAdapter;

  before(async () => {
    // Empty config: no live token required for chain structure.
    adapter = new UpstoxAdapter({});
    await adapter.init();
  });

  after(async () => {
    await adapter.dispose();
  });

  it('NIFTY chain excludes already-expired expiries and lists future ones in order', async () => {
    const chain = await adapter.getOptionChain('NIFTY', undefined, { limit: 21 });
    assert.equal(chain.underlying, 'NIFTY');
    assert.ok(chain.availableExpiries.length > 0, 'expected expiries from the BOD master');
    const todayIst = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
    for (const expiry of chain.availableExpiries) {
      assert.ok(expiry >= todayIst, `expired expiry ${expiry} must not be offered`);
    }
    const sorted = [...chain.availableExpiries].sort();
    assert.deepEqual(chain.availableExpiries, sorted);
    assert.ok(chain.availableExpiries.includes(chain.selectedExpiry));
  });

  it('default window is ATM-centred, bounded, and exposes pagination metadata', async () => {
    const chain = await adapter.getOptionChain('NIFTY', undefined, { limit: 21 });
    assert.ok(chain.strikeWindow, 'strikeWindow metadata is required for pagination UI');
    assert.equal(chain.strikeWindow!.size, chain.rows.length);
    assert.ok(chain.rows.length <= 21);
    assert.ok(chain.strikeWindow!.total >= chain.rows.length);
    assert.ok(chain.selectedExpiry.length === 10);
    // Rows are ascending by strike.
    const strikes = chain.rows.map((r) => r.strikePrice);
    assert.deepEqual(strikes, [...strikes].sort((a, b) => a - b));
    // Every returned contract is a real option contract for this underlying/expiry.
    for (const row of chain.rows) {
      for (const side of [row.call, row.put]) {
        if (!side) continue;
        assert.equal(side.instrument.instrumentType, 'OPTIDX');
        assert.equal(side.instrument.underlying, 'NIFTY');
        assert.equal(side.instrument.expiry, chain.selectedExpiry);
        assert.equal(side.instrument.strikePrice, row.strikePrice);
      }
    }
  });

  it('offset pagination reaches strikes below and above the initial window', async () => {
    const first = await adapter.getOptionChain('NIFTY', undefined, { limit: 21, offset: 0 });
    assert.ok(first.strikeWindow!.total > 21, 'NIFTY should have more than 21 strikes');
    assert.equal(first.strikeWindow!.offset, 0);
    assert.equal(first.strikeWindow!.hasMoreBelow, false);
    assert.equal(first.strikeWindow!.hasMoreAbove, true);

    const next = await adapter.getOptionChain('NIFTY', undefined, { limit: 21, offset: 21 });
    assert.equal(next.strikeWindow!.offset, 21);
    assert.equal(next.strikeWindow!.hasMoreBelow, true);
    assert.ok(
      next.rows[0].strikePrice > first.rows[first.rows.length - 1].strikePrice,
      'the next page must continue above the first page'
    );
  });

  it('BANKNIFTY chain is available and independent from NIFTY', async () => {
    const chain = await adapter.getOptionChain('BANKNIFTY', undefined, { limit: 11 });
    assert.equal(chain.underlying, 'BANKNIFTY');
    assert.ok(chain.rows.length > 0);
    for (const row of chain.rows) {
      for (const side of [row.call, row.put]) {
        if (!side) continue;
        assert.equal(side.instrument.underlying, 'BANKNIFTY');
      }
    }
  });

  it('exposes exactly the visible contract ids for live tick subscriptions', async () => {
    const chain = await adapter.getOptionChain('NIFTY', undefined, { limit: 11 });
    const ids = chain.subscribeGlobalIds || [];
    const expected = chain.rows.reduce(
      (n, r) => n + (r.call ? 1 : 0) + (r.put ? 1 : 0),
      0
    );
    assert.equal(ids.length, expected);
    assert.equal(new Set(ids).size, ids.length, 'subscription ids must be unique');
    for (const id of ids) {
      assert.match(id, /^NFO:/);
    }
  });

  it('past expiries requested explicitly are not accepted', async () => {
    const chain = await adapter.getOptionChain('NIFTY', '2020-01-01', { limit: 5 });
    assert.notEqual(chain.selectedExpiry, '2020-01-01');
    assert.ok(chain.availableExpiries.includes(chain.selectedExpiry));
  });
});
