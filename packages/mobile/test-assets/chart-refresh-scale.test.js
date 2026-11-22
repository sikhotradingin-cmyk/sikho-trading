'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');

const assetsDir = path.join(__dirname, '../android/app/src/main/assets/www');
const appSrc = fs.readFileSync(path.join(assetsDir, 'app.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(assetsDir, 'index.html'), 'utf8');
const cssSrc = fs.readFileSync(path.join(assetsDir, 'styles.css'), 'utf8');
const ast = ts.createSourceFile('app.js', appSrc, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

function createChartHarness(customApiFetch) {
  const nodes = new Map();
  const getNode = (id) => {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, {
        id,
        innerHTML: '',
        textContent: '',
        style: { display: 'inline-flex' },
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

  let rightScaleOptions = { autoScale: true, mode: 0, scaleMargins: { top: 0.1, bottom: 0.14 } };
  let seriesScaleOptions = { autoScale: true, mode: 0, scaleMargins: { top: 0.1, bottom: 0.14 } };
  let visibleLogicalRange = null;
  let resetTimeScaleCount = 0;
  let createChartCount = 0;
  let seriesData = [];
  let seriesUpdates = [];
  const wsSent = [];

  const candleSeriesMock = {
    setData: (d) => { seriesData = Array.from(d || [], (b) => ({ ...b })); },
    update: (bar) => {
      seriesUpdates.push({ ...bar });
      if (seriesData.length && seriesData[seriesData.length - 1].time === bar.time) {
        seriesData[seriesData.length - 1] = { ...bar };
      } else {
        seriesData.push({ ...bar });
      }
    },
    applyOptions: () => {},
    priceScale: () => ({
      applyOptions: (opts) => { seriesScaleOptions = { ...seriesScaleOptions, ...opts }; },
      options: () => seriesScaleOptions,
    }),
    priceToCoordinate: () => 120,
  };

  const tvChartMock = {
    applyOptions: () => {},
    addCandlestickSeries: () => candleSeriesMock,
    addLineSeries: () => ({ setData: () => {}, update: () => {} }),
    removeSeries: () => {},
    subscribeCrosshairMove: () => {},
    priceScale: (id) => {
      assert.equal(id, 'right');
      return {
        applyOptions: (opts) => { rightScaleOptions = { ...rightScaleOptions, ...opts }; },
        options: () => rightScaleOptions,
      };
    },
    timeScale: () => ({
      resetTimeScale: () => { resetTimeScaleCount++; },
      setVisibleLogicalRange: (r) => { visibleLogicalRange = { ...r }; },
      getVisibleLogicalRange: () => visibleLogicalRange,
      getVisibleRange: () => (seriesData.length ? { from: seriesData[0].time, to: seriesData[seriesData.length - 1].time } : null),
      setVisibleRange: () => {},
      subscribeVisibleLogicalRangeChange: () => {},
      timeToCoordinate: () => 100,
    }),
  };

  const state = {
    token: 'jwt-session-1',
    user: { userId: 'u-1', tier: 'FREE' },
    access: { accessMode: 'FREE_LAUNCH', fullFeatureAccess: true },
    accessResolved: true,
    entitlementResolved: true,
    activeTimeframe: '5m',
    activeInstrument: null,
    chartOpen: false,
    chartLoadSeq: 0,
    chartLoading: false,
    candles: [],
    chartPendingTicks: [],
    chartBarUpdates: {},
    lastChartAppliedPriceMs: 0,
    lastCumulativeVolume: {},
    indicators: { sma20: true, ema50: false },
    drawings: [],
    quotesMap: new Map(),
    wsSubscribed: new Set(),
    feedHealth: { marketSession: { isMarketOpen: true } },
    indices: [
      { globalId: 'BSE:SENSEX:99919000', symbol: 'SENSEX', exchange: 'BSE', instrumentType: 'INDEX_SPOT', isTradable: false },
      { globalId: 'NSE:NIFTY 50:99926000', symbol: 'NIFTY 50', exchange: 'NSE', instrumentType: 'INDEX_SPOT', isTradable: false },
      { globalId: 'NSE:BANKNIFTY:99926009', symbol: 'BANKNIFTY', exchange: 'NSE', instrumentType: 'INDEX_SPOT', isTradable: false },
    ],
    exploreStocks: [],
    exploreFnoIndices: [],
    exploreFnoStocks: [],
    commodities: {},
    positionsData: { positions: [] },
    watchlists: [{ instruments: [] }],
  };

  const fnNames = [
    'resolveInstrumentForChart',
    'openChartByGlobalId',
    'initLightweightChartInstance',
    'resetChartScaleAndFitRecent',
    'loadChartCandlesInitial',
    'refreshActiveChart',
    'scrollToLatestBar',
    'reconcileCandleWithTick',
    'applyFormingCandleSnapshot',
    'recalculateAndRenderIndicators',
    'renderDrawingsSvgOverlay',
    'updateChartHeaderQuote',
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
    JSON,
    AbortController,
    ResizeObserver: class { observe() {} },
    WebSocket: { OPEN: 1 },
    wsConn: {
      readyState: 1,
      send: (raw) => wsSent.push(JSON.parse(raw)),
    },
    LightweightCharts: {
      CrosshairMode: { Normal: 0 },
      createChart: () => {
        createChartCount++;
        return tvChartMock;
      },
    },
    tvChart: null,
    candleSeries: null,
    indicatorSeriesMap: {},
    chartRequestController: null,
    chartViewportCache: new Map(),
    chartNavigationSeq: 0,
    inspectedCandleTime: null,
    localStorage: { getItem: () => null, setItem: () => {} },
    document: {
      getElementById: getNode,
      querySelectorAll: () => [],
    },
    apiFetch: customApiFetch,
    sanitizeChartCandles: (bars) => bars,
    fmtNum: (n) => Number(n).toFixed(2),
    fmtINR: (n) => Number(n).toFixed(2),
    formatChangePct: (p) => `${p >= 0 ? '+' : ''}${p.toFixed(2)}%`,
    formatChartTime: (t) => String(t),
    getChartThemeOptions: () => ({
      layout: {},
      grid: {},
      rightPriceScale: { borderColor: '#ccc' },
      timeScale: { borderColor: '#ccc' },
      candle: {},
    }),
    setupTouchArbitratedDrawingEvents: () => {},
    isProUser: () => false,
    isInstrumentRestrictedForFree: () => false,
    closeAllIndicesModal: () => {},
    closeOptionChainModal: () => {},
    markOnboardingStep: () => {},
    syncNativeSystemBarTheme: () => {},
    notifyNativeScreenState: () => {},
    ocIsSymbolUsedElsewhere: () => false,
    syncLiveSubscriptions: () => {
      if (state.activeInstrument?.globalId) {
        state.wsSubscribed.add(state.activeInstrument.globalId);
      }
    },
    sendWsSubscribe: (syms) => {
      syms.forEach((s) => state.wsSubscribed.add(s));
      wsSent.push({ type: 'SUBSCRIBE', symbols: Array.from(syms) });
    },
    startChartCountdownTimer: () => {},
    renderChartBottomTradeBar: () => {},
    ensureChartLibrary: async () => {},
    loadUserDrawingsForActiveInstrument: async () => {},
    updateChartCountdownUI: () => {},
    updateIndicatorsForLastBar: () => {},
    checkPriceAlerts: () => {},
    computeCandleBucketSec: (ms, _tf, refSec) => refSec,
    getTimeframeIntervalSec: () => 300,
    serverNowMs: () => Date.now(),
  });

  function visit(n) {
    if (ts.isFunctionDeclaration(n) && fnNames.includes(n.name?.text)) {
      vm.runInContext(n.getText(ast), ctx);
    }
    ts.forEachChild(n, visit);
  }
  visit(ast);

  return {
    ctx,
    state,
    getNode,
    wsSent,
    getRightScale: () => rightScaleOptions,
    getSeriesScale: () => seriesScaleOptions,
    setManualPriceScaleOverride: () => {
      rightScaleOptions.autoScale = false;
      seriesScaleOptions.autoScale = false;
    },
    getVisibleLogicalRange: () => visibleLogicalRange,
    setManualLogicalRange: (r) => { visibleLogicalRange = r; },
    getResetTimeScaleCount: () => resetTimeScaleCount,
    getCreateChartCount: () => createChartCount,
    getSeriesData: () => seriesData,
    getSeriesUpdates: () => seriesUpdates,
  };
}

function makeBars(basePrice, count = 120, startSec = 1700000000) {
  const bars = [];
  for (let i = 0; i < count; i++) {
    const p = basePrice + i * 2;
    bars.push({
      time: startSec + i * 300,
      open: p,
      high: p + 15,
      low: p - 12,
      close: p + 5,
      volume: 1000 + i,
    });
  }
  return bars;
}

test('Part 1: Circular refresh control markup and CSS meet visual, theme, and accessibility requirements', () => {
  // Verify button in index.html has aria-label="Refresh chart", only circular ↻ icon, no "Back to Live" or "Go to latest" text
  assert.match(htmlSrc, /id="btn-go-latest"[^>]*aria-label="Refresh chart"/);
  assert.match(htmlSrc, /class="chart-refresh-circle"[^>]*>↻<\/span>/);
  assert.doesNotMatch(htmlSrc, /Back to Live/i);
  assert.doesNotMatch(htmlSrc, /Go to latest/i);

  // Verify accessible 44x44px hit area and compact 32x32px visible circle in styles.css
  assert.match(cssSrc, /\.chart-refresh-fab\s*\{[\s\S]*?min-width:\s*44px;[\s\S]*?min-height:\s*44px;/);
  assert.match(cssSrc, /\.chart-refresh-circle\s*\{[\s\S]*?width:\s*32px;[\s\S]*?height:\s*32px;/);
  assert.match(cssSrc, /\[data-theme="dark"\]\s*\.chart-refresh-circle/);
});

test('Part 2: Switching SENSEX (~82,000) -> NIFTY (~25,000) -> BANKNIFTY (~51,000) resets manual price-scale overrides and fits each instrument', async () => {
  const sensexBars = makeBars(82000, 120);
  const niftyBars = makeBars(25000, 120);
  const bankNiftyBars = makeBars(51000, 120);

  const h = createChartHarness(async (url) => {
    if (url.includes('SENSEX')) return { candles: sensexBars, sessionDateIST: '2026-11-20', latestQuote: { globalId: 'BSE:SENSEX:99919000', ltp: 82245, close: 81900, providerTimestamp: Date.now() } };
    if (url.includes('BANKNIFTY')) return { candles: bankNiftyBars, sessionDateIST: '2026-11-20', latestQuote: { globalId: 'NSE:BANKNIFTY:99926009', ltp: 51245, close: 50900, providerTimestamp: Date.now() } };
    return { candles: niftyBars, sessionDateIST: '2026-11-20', latestQuote: { globalId: 'NSE:NIFTY 50:99926000', ltp: 25245, close: 24950, providerTimestamp: Date.now() } };
  });

  // 1. Open SENSEX (~82,000)
  await h.ctx.openChartByGlobalId('BSE:SENSEX:99919000');
  assert.equal(h.getSeriesData().at(-1).close, 82245);
  assert.equal(h.getRightScale().autoScale, true);
  assert.equal(h.getSeriesScale().autoScale, true);

  // User manually drags/zooms SENSEX vertical price axis (disabling autoScale) and pans back horizontally
  h.setManualPriceScaleOverride();
  h.setManualLogicalRange({ from: 0, to: 20 });
  assert.equal(h.getRightScale().autoScale, false);
  assert.equal(h.getSeriesScale().autoScale, false);

  // 2. Switch to NIFTY (~25,000) -> must reset autoScale: true and fit recent 80 bars
  await h.ctx.openChartByGlobalId('NSE:NIFTY 50:99926000');
  assert.equal(h.state.activeInstrument.globalId, 'NSE:NIFTY 50:99926000');
  assert.equal(h.getRightScale().autoScale, true);
  assert.equal(h.getSeriesScale().autoScale, true);
  assert.equal(h.getSeriesData().length, 120);
  assert.equal(h.getSeriesData()[0].open, 25000);
  assert.equal(h.getSeriesData().at(-1).close, 25245);
  assert.deepEqual(h.getVisibleLogicalRange(), { from: 40, to: 124 });

  // User manually overrides NIFTY price scale again, then switches to BANKNIFTY (~51,000)
  h.setManualPriceScaleOverride();
  await h.ctx.openChartByGlobalId('NSE:BANKNIFTY:99926009');
  assert.equal(h.state.activeInstrument.globalId, 'NSE:BANKNIFTY:99926009');
  assert.equal(h.getRightScale().autoScale, true);
  assert.equal(h.getSeriesScale().autoScale, true);
  assert.equal(h.getSeriesData()[0].open, 51000);
  assert.equal(h.getSeriesData().at(-1).close, 51245);
  assert.equal(h.getCreateChartCount(), 1, 'must reuse singleton LightweightCharts instance without duplicate creation');
});

test('Part 2: Rapid instrument switching discards delayed responses and WebSocket ticks from previous instrument', async () => {
  let resolveSensex;
  let resolveNifty;
  const h = createChartHarness((url) => {
    if (url.includes('SENSEX')) {
      return new Promise((r) => { resolveSensex = r; });
    }
    return new Promise((r) => { resolveNifty = r; });
  });

  // Start opening SENSEX, wait for its candle request to start, then switch to NIFTY while SENSEX request is still in flight
  const pSensex = h.ctx.openChartByGlobalId('BSE:SENSEX:99919000');
  await new Promise((r) => setImmediate(r));
  const pNifty = h.ctx.openChartByGlobalId('NSE:NIFTY 50:99926000');
  await new Promise((r) => setImmediate(r));

  // Resolve NIFTY first
  resolveNifty({
    candles: makeBars(25000, 80),
    sessionDateIST: '2026-11-20',
    latestQuote: { globalId: 'NSE:NIFTY 50:99926000', ltp: 25160, close: 24900, providerTimestamp: Date.now() },
  });
  await pNifty;

  // Now delayed SENSEX response arrives late + delayed SENSEX WebSocket tick arrives
  resolveSensex({
    candles: makeBars(82000, 80),
    sessionDateIST: '2026-11-20',
    latestQuote: { globalId: 'BSE:SENSEX:99919000', ltp: 82500, close: 81900, providerTimestamp: Date.now() },
  });
  await pSensex;

  h.ctx.reconcileCandleWithTick({
    globalId: 'BSE:SENSEX:99919000',
    ltp: 82999,
    providerTimestamp: Date.now() + 1000,
  }, false);

  // Active chart must still be NIFTY (~25,000), completely untouched by SENSEX's late response or tick
  assert.equal(h.state.activeInstrument.globalId, 'NSE:NIFTY 50:99926000');
  assert.equal(h.state.candles[0].open, 25000);
  assert.equal(h.state.candles.at(-1).close, 25160);
});

test('Part 1: Tapping refreshActiveChart resets vertical/horizontal overrides, reloads data, preserves state, and avoids duplicate WS subscriptions', async () => {
  let fetchCount = 0;
  let shouldFail = false;
  const h = createChartHarness(async () => {
    fetchCount++;
    if (shouldFail) throw new Error('Network error');
    return {
      candles: makeBars(25000, 100),
      sessionDateIST: '2026-11-20',
      latestQuote: { globalId: 'NSE:NIFTY 50:99926000', ltp: 25205, close: 24950, providerTimestamp: Date.now() },
    };
  });

  await h.ctx.openChartByGlobalId('NSE:NIFTY 50:99926000');
  h.state.drawings = [{ id: 'd_1', type: 'hline', p1: { time: 1700000000, price: 25100 }, p2: { time: 1700000000, price: 25100 } }];
  h.state.activeTimeframe = '15m';
  h.state.feedHealth = { marketSession: { isMarketOpen: false } };

  // Simulate user scrolling back into history and manually panning vertical price scale
  h.state.historicalInspection = true;
  h.state.isUserScrolledBack = true;
  h.setManualPriceScaleOverride();
  h.setManualLogicalRange({ from: 2, to: 25 });
  const wsCountBeforeRefresh = h.wsSent.length;

  // Tap circular refresh control
  await h.ctx.refreshActiveChart();

  assert.equal(fetchCount, 2);
  assert.equal(h.state.activeInstrument.globalId, 'NSE:NIFTY 50:99926000', 'preserves active instrument');
  assert.equal(h.state.activeTimeframe, '15m', 'preserves active timeframe');
  assert.equal(h.state.token, 'jwt-session-1', 'preserves account session');
  assert.equal(h.state.drawings.length, 1, 'preserves saved drawings');
  assert.equal(h.state.indicators.sma20, true, 'preserves active indicators');
  assert.equal(h.state.historicalInspection, false);
  assert.equal(h.state.isUserScrolledBack, false);
  assert.equal(h.getRightScale().autoScale, true, 'resets right price scale autoScale');
  assert.equal(h.getSeriesScale().autoScale, true, 'resets candle series price scale autoScale');
  assert.deepEqual(h.getVisibleLogicalRange(), { from: 20, to: 104 }, 'returns time axis to readable recent-candle window');
  assert.equal(h.wsSent.length, wsCountBeforeRefresh, 'does not send duplicate WS SUBSCRIBE on refresh when already subscribed');
  assert.equal(h.getCreateChartCount(), 1, 'does not create duplicate chart instance');
  assert.match(h.getNode('chart-candle-stats').textContent, /Market Closed/, 'shows actual Market Closed status during market closure');

  // Verify concise retry message when refresh fails
  shouldFail = true;
  await h.ctx.refreshActiveChart();
  assert.match(h.getNode('chart-ohlc-legend').textContent, /Tap ↻ to retry/);

  // Verify live ticks after initial fitting update the current candle without resetting user's pan/zoom viewport
  shouldFail = false;
  await h.ctx.refreshActiveChart();
  h.setManualLogicalRange({ from: 10, to: 55 });
  h.ctx.reconcileCandleWithTick({
    globalId: 'NSE:NIFTY 50:99926000',
    ltp: 25250,
    providerTimestamp: Date.now() + 5000,
  }, false);
  assert.equal(h.state.candles.at(-1).close, 25250);
  assert.deepEqual(h.getVisibleLogicalRange(), { from: 10, to: 55 }, 'live tick must not reset user pan/zoom viewport');
});
