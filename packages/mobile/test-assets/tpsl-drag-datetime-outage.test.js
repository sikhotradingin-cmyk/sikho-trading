'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');

const assetsDir = path.join(__dirname, '../android/app/src/main/assets/www');
const appSrc = fs.readFileSync(path.join(assetsDir, 'app.js'), 'utf8');
const ast = ts.createSourceFile('app.js', appSrc, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

function createProtectionAndChartHarness(apiFetchImpl) {
  const nodes = new Map();
  const getNode = (id) => {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, {
        id,
        innerHTML: '',
        textContent: '',
        value: '',
        disabled: false,
        step: '0.05',
        style: { display: 'none', color: '' },
        clientWidth: 390,
        clientHeight: 440,
        attrs: {},
        setAttribute(k, v) { this.attrs[k] = v; },
        removeAttribute(k) { delete this.attrs[k]; },
        getAttribute(k) { return this.attrs[k]; },
        classList: {
          add: (...c) => c.forEach((x) => classes.add(x)),
          remove: (...c) => c.forEach((x) => classes.delete(x)),
          toggle: (c, force) => {
            const on = force !== undefined ? Boolean(force) : !classes.has(c);
            if (on) classes.add(c); else classes.delete(c);
            return on;
          },
          contains: (c) => classes.has(c),
        },
      });
    }
    return nodes.get(id);
  };

  let seriesData = [];
  const notices = [];
  const alerts = [];

  const candleSeriesMock = {
    setData: (d) => { seriesData = Array.from(d || [], (b) => ({ ...b })); },
    update: (bar) => {
      if (seriesData.length && seriesData[seriesData.length - 1].time === bar.time) {
        seriesData[seriesData.length - 1] = { ...bar };
      } else {
        seriesData.push({ ...bar });
      }
    },
    applyOptions: () => {},
    priceScale: () => ({ applyOptions: () => {} }),
    priceToCoordinate: (price) => 200 - (Number(price) - 25000),
    coordinateToPrice: (y) => 25000 + (200 - Number(y)),
  };

  const tvChartMock = {
    applyOptions: () => {},
    priceScale: () => ({ applyOptions: () => {} }),
    timeScale: () => ({
      resetTimeScale: () => {},
      setVisibleLogicalRange: () => {},
      timeToCoordinate: () => 100,
    }),
  };

  const state = {
    token: 'jwt-user-a',
    user: { userId: 'usr-a', tier: 'PRO' },
    activeTimeframe: '5m',
    activeInstrument: { globalId: 'NFO:NIFTY26NOVFUT:101', symbol: 'NIFTY26NOVFUT', exchange: 'NFO', instrumentType: 'FUTIDX', isTradable: true, lotSize: 65, tickSize: 0.05 },
    chartOpen: true,
    chartLoadSeq: 0,
    chartDataKey: 'NFO:NIFTY26NOVFUT:101:5m',
    candles: [
      { time: Date.parse('2026-11-16T09:55:00Z') / 1000, open: 24980, high: 25010, low: 24970, close: 25000 },
      { time: Date.parse('2026-11-17T03:45:00Z') / 1000, open: 25010, high: 25040, low: 25000, close: 25030 },
      { time: Date.parse('2026-11-17T07:00:00Z') / 1000, open: 25030, high: 25080, low: 25020, close: 25060 },
    ],
    quotesMap: new Map([
      ['NFO:NIFTY26NOVFUT:101', { globalId: 'NFO:NIFTY26NOVFUT:101', ltp: 25060, close: 25000, providerTimestamp: Date.now(), receiveTimestamp: Date.now() }],
    ]),
    positionsData: {
      positions: [
        {
          id: 'pos-fut-1',
          accountId: 'acc-a',
          globalInstrumentId: 'NFO:NIFTY26NOVFUT:101',
          symbol: 'NIFTY26NOVFUT',
          exchange: 'NFO',
          instrumentType: 'FUTIDX',
          productType: 'MARGIN',
          quantity: 65,
          averageEntryPrice: 25000,
          currentPrice: 25060,
          targetPrice: 25150,
          stopLossPrice: 24920,
          protectionVersion: 1,
          tickSize: 0.05,
          lotSize: 65,
          pnlMultiplier: 1,
        },
      ],
      activePositions: [],
      holdings: [],
    },
    protectionModal: null,
    protectionDrag: null,
    activeDrawingTool: 'cursor',
  };
  state.positionsData.activePositions = state.positionsData.positions;

  const fnNames = [
    'formatChartTime',
    'formatChartAxisTick',
    'alignPriceToTick',
    'getPositionById',
    'getOpenPositionForInstrument',
    'applyRemotePositionProtectionUpdate',
    'reconcileActiveProtectionState',
    'openProtectionModal',
    'closeProtectionModal',
    'renderProtectionModalLiveQuote',
    'renderProtectionModalState',
    'toggleRemoveProtectionField',
    'applyProtectionPointsOffset',
    'onProtectionInputChanged',
    'submitPositionProtectionModal',
    'checkTimedOutProtectionStatus',
    'renderChartProtectionOverlay',
    'previewChartProtectionDrag',
    'cancelChartProtectionDrag',
    'confirmChartProtectionDrag',
    'loadChartCandlesInitial',
  ];

  const ctx = vm.createContext({
    state,
    Boolean,
    Number,
    String,
    Array,
    Object,
    Map,
    Set,
    Math,
    Date,
    Intl,
    JSON,
    AbortController,
    tvChart: tvChartMock,
    candleSeries: candleSeriesMock,
    chartRequestController: null,
    chartViewportCache: new Map(),
    chartCandleCache: new Map(),
    inspectedCandleTime: null,
    window: {
      SikhoUX: {
        escape: (s) => String(s ?? ''),
        notify: (m) => notices.push(m),
      },
    },
    document: {
      getElementById: getNode,
      querySelectorAll: () => [],
    },
    apiFetch: apiFetchImpl,
    sanitizeChartCandles: (b) => b,
    fmtNum: (n) => Number(n).toFixed(2),
    fmtINR: (n) => '₹' + Number(n).toFixed(2),
    fmtIstClock: () => '12:30:00',
    quoteFreshnessMs: () => 120,
    noteServerClock: () => {},
    handleIncomingQuoteTick: () => {},
    sendWsSubscribe: () => {},
    notifyNativeScreenState: () => {},
    refreshAccountAndPortfolio: async () => {},
    renderPortfolioTab: () => {},
    renderChartBottomTradeBar: () => {},
    updateChartCountdownUI: () => {},
    updateChartHeaderQuote: () => {},
    reconcileCandleWithTick: () => {},
    recalculateAndRenderIndicators: () => {},
    renderDrawingsSvgOverlay: () => {},
    showBrandedAlert: (t, m) => alerts.push({ t, m }),
  });

  function visit(n) {
    if (ts.isFunctionDeclaration(n) && fnNames.includes(n.name?.text)) {
      vm.runInContext(n.getText(ast), ctx);
    }
    ts.forEachChild(n, visit);
  }
  visit(ast);

  return { ctx, state, getNode, notices, alerts, getSeriesData: () => seriesData };
}

test('Requirement 5: IST chart date & time labels show dates at trading-day boundaries and full IST opening timestamps', () => {
  const h = createProtectionAndChartHarness(async () => ({}));
  // Bar 0: 16 Nov 2026 15:25 IST (first bar in series -> day boundary)
  // Bar 1: 17 Nov 2026 09:15 IST (new IST trading day & 09:15 session open -> day boundary)
  // Bar 2: 17 Nov 2026 12:30 IST (same trading day -> time only on axis, full date+time on crosshair)
  const tNov16Close = h.state.candles[0].time;
  const tNov17Open = h.state.candles[1].time;
  const tNov17Noon = h.state.candles[2].time;

  assert.match(h.ctx.formatChartAxisTick(tNov17Open, 3), /17.*Nov.*09:15/, '09:15 IST day boundary must include date + time');
  assert.equal(h.ctx.formatChartAxisTick(tNov17Noon, 3), '12:30', 'Intra-day bar within same session displays HH:mm');
  assert.match(h.ctx.formatChartTime(tNov17Noon, true), /17.*Nov.*2026.*12:30.*IST/, 'Crosshair full timestamp shows DD Mon YYYY, HH:mm IST');

  h.state.activeTimeframe = '1D';
  assert.match(h.ctx.formatChartAxisTick(tNov17Open, 2), /17.*Nov/, 'Daily timeframe shows date');
  assert.doesNotMatch(h.ctx.formatChartTime(tNov16Close, true), /15:25/, 'Daily full timestamp omits intraday clock');
});

test('Requirement 3: Draggable chart TP/SL preview, cancel, confirm, and position-close reconciliation', async () => {
  const putPayloads = [];
  const h = createProtectionAndChartHarness(async (url, opts) => {
    if (opts?.method === 'PUT' && url.includes('/protection')) {
      const body = JSON.parse(opts.body);
      putPayloads.push(body);
      return {
        success: true,
        position: {
          ...h.state.positionsData.positions[0],
          targetPrice: body.targetPrice ?? h.state.positionsData.positions[0].targetPrice,
          stopLossPrice: body.stopLossPrice ?? h.state.positionsData.positions[0].stopLossPrice,
          protectionVersion: (h.state.positionsData.positions[0].protectionVersion || 1) + 1,
        },
      };
    }
    return {};
  });

  // 1. Render initial protection overlay (Entry, Saved TP, Saved SL)
  h.ctx.renderChartProtectionOverlay();
  const layerHtml1 = h.getNode('chart-protection-layer').innerHTML;
  assert.match(layerHtml1, /ENTRY LONG 65/);
  assert.match(layerHtml1, /TP \(Saved\) ₹25150\.00/);
  assert.match(layerHtml1, /SL \(Saved\) ₹24920\.00/);
  assert.equal(h.getNode('chart-protection-confirm-bar').style.display, 'none');

  // 2. Drag TP to an off-tick raw price 25210.03 -> snaps to 25210.05 preview without calling backend
  const dragPreview = h.ctx.previewChartProtectionDrag('pos-fut-1', 'TP', 25210.03);
  assert.equal(dragPreview.proposedPrice, 25210.05);
  assert.equal(putPayloads.length, 0, 'Dragging without confirmation must never call backend');
  assert.equal(h.state.positionsData.positions[0].targetPrice, 25150, 'Saved TP must remain unchanged until confirmed');
  assert.equal(h.getNode('chart-protection-confirm-bar').style.display, 'flex');
  assert.match(h.getNode('chart-protection-confirm-bar').innerHTML, /Saved ₹25150\.00 → Proposed ₹25210\.05/);

  // 3. Cancel drag -> restores original saved line and hides confirmation bar
  h.ctx.cancelChartProtectionDrag();
  assert.equal(h.state.protectionDrag, null);
  assert.equal(h.getNode('chart-protection-confirm-bar').style.display, 'none');
  assert.equal(h.state.positionsData.positions[0].targetPrice, 25150);

  // 4. Drag SL to profit-protecting 25025.00 and Confirm -> sends PUT and updates saved SL
  h.ctx.previewChartProtectionDrag('pos-fut-1', 'SL', 25025.00);
  await h.ctx.confirmChartProtectionDrag();
  assert.equal(putPayloads.length, 1);
  assert.equal(putPayloads[0].stopLossPrice, 25025);
  assert.equal(putPayloads[0].source, 'CHART_DRAG');
  assert.equal(h.state.positionsData.positions[0].stopLossPrice, 25025);
  assert.equal(h.state.positionsData.positions[0].protectionVersion, 2);

  // 5. If position closes while a drag confirmation is open, reconcileActiveProtectionState cancels it immediately
  h.ctx.previewChartProtectionDrag('pos-fut-1', 'TP', 25300);
  assert.equal(h.getNode('chart-protection-confirm-bar').style.display, 'flex');
  h.state.positionsData.positions[0].quantity = 0;
  h.ctx.reconcileActiveProtectionState();
  assert.equal(h.state.protectionDrag, null);
  assert.equal(h.getNode('chart-protection-confirm-bar').style.display, 'none');
});

test('Requirement 2 & 4: Numeric TP/SL modal supports point offsets from entry, explicit removal, and timeout reconciliation', async () => {
  let shouldTimeout = false;
  let lookupFound = false;
  const sentBodies = [];

  const h = createProtectionAndChartHarness(async (url, opts) => {
    if (opts?.method === 'PUT' && url.includes('/protection')) {
      const b = JSON.parse(opts.body);
      sentBodies.push(b);
      if (shouldTimeout) {
        const err = new Error('Request timed out');
        err.code = 'ERR_SERVER_TIMEOUT';
        throw err;
      }
      return {
        success: true,
        position: {
          ...h.state.positionsData.positions[0],
          targetPrice: b.removeTarget ? undefined : (b.targetPrice ?? h.state.positionsData.positions[0].targetPrice),
          stopLossPrice: b.removeStopLoss ? undefined : (b.stopLossPrice ?? h.state.positionsData.positions[0].stopLossPrice),
          protectionVersion: 3,
        },
      };
    }
    if (url.includes('/api/v1/positions/protection-by-idempotency/')) {
      return { found: lookupFound, result: lookupFound ? { ok: true } : null };
    }
    return {};
  });

  // Open modal for pos-fut-1 (Entry = 25000)
  h.ctx.openProtectionModal('pos-fut-1');
  assert.equal(h.state.protectionModal.open, true);
  assert.equal(h.getNode('prot-input-tp').value, '25150');
  assert.equal(h.getNode('prot-input-sl').value, '24920');

  // Apply +50 pts TP offset from Executed Entry (25000 + 50 = 25050)
  h.ctx.applyProtectionPointsOffset('TP', 50);
  assert.equal(h.getNode('prot-input-tp').value, '25050');

  // Toggle explicit removal of SL
  h.ctx.toggleRemoveProtectionField('SL');
  assert.equal(h.state.protectionModal.removeSl, true);

  // Simulate timeout on submit -> must show timeout reconciliation box and NOT close modal as false success
  shouldTimeout = true;
  await h.ctx.submitPositionProtectionModal();
  assert.equal(h.state.protectionModal.open, true);
  assert.ok(h.state.protectionModal.timedOutKey);
  assert.equal(h.getNode('prot-timeout-box').style.display, 'block');

  // Reconcile timed-out status when server confirms it was saved
  lookupFound = true;
  await h.ctx.checkTimedOutProtectionStatus();
  assert.equal(h.state.protectionModal.open, false);
  assert.equal(h.state.protectionModal.timedOutKey, null);
});

test('Requirement 7: Same-instrument refresh failure retains valid candles while cross-instrument failure never leaks old instrument candles', async () => {
  let failNetwork = false;
  const h = createProtectionAndChartHarness(async () => {
    if (failNetwork) throw new Error('HTTP 503 Service Unavailable');
    return {
      candles: [
        { time: 1700000000, open: 25000, high: 25050, low: 24990, close: 25040 },
        { time: 1700000300, open: 25040, high: 25090, low: 25030, close: 25080 },
      ],
      sessionDateIST: '2026-11-24',
    };
  });

  // 1. Initial load succeeds for NIFTY26NOVFUT
  await h.ctx.loadChartCandlesInitial();
  assert.equal(h.state.candles.length, 2);
  assert.equal(h.state.candles[1].close, 25080);

  // 2. Refresh fails on the SAME instrument -> valid candles remain visible!
  failNetwork = true;
  await h.ctx.loadChartCandlesInitial({ isRefresh: true });
  assert.equal(h.state.candles.length, 2, 'Same-instrument refresh failure must retain already-rendered valid candles');
  assert.equal(h.state.candles[1].close, 25080);
  assert.match(h.getNode('chart-ohlc-legend').textContent, /Showing last verified candles/);

  // 3. Switch to an uncached instrument (SENSEX) while network is down -> must NOT display NIFTY candles!
  h.state.activeInstrument = { globalId: 'BSE:SENSEX:99919000', symbol: 'SENSEX', exchange: 'BSE', instrumentType: 'INDEX_SPOT' };
  await h.ctx.loadChartCandlesInitial();
  assert.equal(h.state.candles.length, 0, 'Switching to uncached instrument on failure must never leak previous instrument candles');
});
