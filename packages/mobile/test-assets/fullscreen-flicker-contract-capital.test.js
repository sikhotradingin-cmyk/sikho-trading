import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../../');

const indexHtmlPath = path.join(rootDir, 'packages/mobile/android/app/src/main/assets/www/index.html');
const stylesCssPath = path.join(rootDir, 'packages/mobile/android/app/src/main/assets/www/styles.css');
const appJsPath = path.join(rootDir, 'packages/mobile/android/app/src/main/assets/www/app.js');
const historyJsPath = path.join(rootDir, 'packages/mobile/android/app/src/main/assets/www/history.js');
const serverTsPath = path.join(rootDir, 'packages/backend/src/server.ts');
const virtualAccountEngineTsPath = path.join(rootDir, 'packages/backend/src/engine/virtual-account-engine.ts');

test('TASK 1: Chart Fullscreen Toggle & Android Back Navigation', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');
  const css = fs.readFileSync(stylesCssPath, 'utf8');
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  // 1. Toolbar toggle button markup
  assert.ok(html.includes('id="chart-fullscreen-btn"'), 'Fullscreen toggle button must be present in chart toolbar');
  assert.ok(html.includes('id="chart-fullscreen-icon"'), 'Fullscreen toggle icon must be present');
  assert.ok(html.includes('toggleChartFullscreen()'), 'Button must invoke window.TZApp.toggleChartFullscreen()');
  assert.ok(html.includes('aria-label="Toggle full-screen chart"'), 'Button must have accessible label');

  // 2. CSS fullscreen app-layout mode
  assert.ok(css.includes('#screen-chart.is-fullscreen'), 'CSS must define #screen-chart.is-fullscreen');
  assert.ok(css.includes('#screen-chart.is-fullscreen #chart-bottom-trade-bar'), 'Trade bar must be hidden in fullscreen');
  assert.ok(css.includes('#screen-chart.is-fullscreen .range-footer-strip'), 'Range footer strip must be hidden in fullscreen');
  assert.ok(css.includes('env(safe-area-inset-top'), 'Fullscreen mode must respect display cutout/safe area insets');

  // 3. JS toggle, enter, and exit implementations
  assert.ok(appJs.includes('function toggleChartFullscreen()'), 'toggleChartFullscreen must be defined');
  assert.ok(appJs.includes('function enterChartFullscreen()'), 'enterChartFullscreen must be defined');
  assert.ok(appJs.includes('function exitChartFullscreen()'), 'exitChartFullscreen must be defined');
  assert.ok(appJs.includes('state.isChartFullscreen = true'), 'enterChartFullscreen must set state.isChartFullscreen = true');
  assert.ok(appJs.includes('state.isChartFullscreen = false'), 'exitChartFullscreen must set state.isChartFullscreen = false');

  // 4. Android Back Button handling: exits fullscreen first!
  const backBtnMatch = appJs.match(/window\.handleAndroidBackButton\s*=\s*function\s*\(\)\s*\{([\s\S]*?)\};/);
  assert.ok(backBtnMatch, 'handleAndroidBackButton must be defined');
  const backBody = backBtnMatch[1];
  const fsIndex = backBody.indexOf('state.isChartFullscreen');
  const chartCloseIndex = backBody.indexOf('closeChartWorkspace()');
  assert.ok(fsIndex !== -1, 'handleAndroidBackButton must check state.isChartFullscreen');
  assert.ok(fsIndex < chartCloseIndex, 'Fullscreen exit must happen BEFORE closeChartWorkspace() on Android Back');
  assert.ok(backBody.includes('exitChartFullscreen();') && backBody.includes('return true;'), 'Must call exitChartFullscreen() and return true');

  // 5. Exits cleanly on closeChartWorkspace
  assert.ok(appJs.includes('if (state.isChartFullscreen)') && appJs.includes('exitChartFullscreen()'), 'closeChartWorkspace must restore non-fullscreen state');

  // 6. Exported on TZApp
  assert.ok(appJs.includes('toggleChartFullscreen,') && appJs.includes('enterChartFullscreen,'), 'Fullscreen functions must be exposed on window.TZApp');
});

test('TASK 2: Chart Flicker & Vertical Jumping Elimination', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');
  const css = fs.readFileSync(stylesCssPath, 'utf8');
  const appJs = fs.readFileSync(appJsPath, 'utf8');

  // 1. Stable header layout: fixed height, no dynamic vertical wrapping
  assert.ok(html.includes('class="chart-meta-row"'), 'Chart sub-strip must use chart-meta-row');
  assert.ok(css.includes('.chart-top-bar {') && css.includes('min-height: 58px;') && css.includes('max-height: 58px;'), 'chart-top-bar must have stable fixed height to prevent vertical jumping');
  assert.ok(css.includes('.chart-meta-row {') && css.includes('white-space: nowrap;') && css.includes('overflow-x: auto;'), 'chart-meta-row must not wrap to additional lines');

  // 2. Debounced and thresholded ResizeObserver
  assert.ok(appJs.includes('let lastObsChartW = 0;') && appJs.includes('let lastObsChartH = 0;'), 'Must track last observed chart dimensions');
  assert.ok(appJs.includes('Math.abs(curW - lastObsChartW) < 2'), 'ResizeObserver must ignore sub-2px oscillations to break layout loops');
  assert.ok(appJs.includes('chartResizeDebounce = setTimeout('), 'Chart container resizing must be debounced');

  // 3. Indicator series stability: no destroy/recreate on each new candle bar
  const indicatorFunc = appJs.match(/function recalculateAndRenderIndicators\(\)\s*\{([\s\S]*?)\n  \}/);
  assert.ok(indicatorFunc, 'recalculateAndRenderIndicators must be defined');
  const indBody = indicatorFunc[1];
  assert.ok(indBody.includes('if (!indicatorSeriesMap.sma20)'), 'Must check if SMA series already exists before adding');
  assert.ok(indBody.includes('indicatorSeriesMap.sma20.setData(data)'), 'Must update existing SMA series with setData');
  assert.ok(indBody.includes('if (!indicatorSeriesMap.ema50)'), 'Must check if EMA series already exists before adding');
  assert.ok(indBody.includes('indicatorSeriesMap.ema50.setData(data)'), 'Must update existing EMA series with setData');
  assert.ok(!indBody.includes('Object.values(indicatorSeriesMap).forEach'), 'Must not wipe all indicators on every recalculate');
});

test('TASK 3: Complete Traded Contract Identities', () => {
  const appJs = fs.readFileSync(appJsPath, 'utf8');
  const css = fs.readFileSync(stylesCssPath, 'utf8');
  const historyJs = fs.readFileSync(historyJsPath, 'utf8');

  // 1. formatTradedContractIdentity helper
  assert.ok(appJs.includes('function formatTradedContractIdentity(p)'), 'formatTradedContractIdentity must be defined');

  // 2. Position card component CSS and multi-line wrapping
  assert.ok(css.includes('.position-card-white'), 'CSS must define .position-card-white');
  assert.ok(css.includes('.pos-contract-name') && css.includes('white-space: normal;') && css.includes('word-break: break-word;'), 'Contract name must wrap naturally across multiple lines without ellipsis clipping');
  assert.ok(css.includes('.pos-meta-chips'), 'Must provide structured meta badges');
  assert.ok(css.includes('.pos-metrics-row'), 'Must provide distinct 4-metric row for Avg, LTP, TP, and SL');
  assert.ok(css.includes('.pos-actions-row'), 'Must provide dedicated full-width actions row');
  assert.ok(css.includes('.btn-action-edit-tpsl'), 'Must provide styled Edit TP/SL button');
  assert.ok(css.includes('.btn-action-exit'), 'Must provide styled Exit button with red accent');

  // 3. Rendered in portfolio tab
  assert.ok(appJs.includes('class="position-card-white"'), 'renderPortfolioTab must use .position-card-white');
  assert.ok(appJs.includes('class="pos-actions-row"'), 'renderPortfolioTab must include .pos-actions-row');
  assert.ok(appJs.includes('class="btn-action-edit-tpsl"'), 'renderPortfolioTab must include .btn-action-edit-tpsl');
  assert.ok(appJs.includes('class="btn-action-exit"'), 'renderPortfolioTab must include .btn-action-exit');
  assert.ok(appJs.includes('Edit TP/SL'), 'Button text must be concise Edit TP/SL');
  assert.ok(appJs.includes('aria-label="Edit Take Profit and Stop Loss'), 'Full accessibility label must be provided');

  // 4. Order and trade history contract identities
  assert.ok(historyJs.includes('word-break:break-word;white-space:normal;'), 'history.js cards must allow full multi-line contract names');
  assert.ok(historyJs.includes('o.instrument?.expiry'), 'history.js orders must include expiry and strike metadata when available');
});

test('TASK 4: Custom Virtual Capital Flow & Backend Verification', () => {
  const html = fs.readFileSync(indexHtmlPath, 'utf8');
  const appJs = fs.readFileSync(appJsPath, 'utf8');
  const serverTs = fs.readFileSync(serverTsPath, 'utf8');
  const engineTs = fs.readFileSync(virtualAccountEngineTsPath, 'utf8');

  // 1. Frontend markup & preview
  assert.ok(html.includes('id="custom-capital-preview"'), 'Preview element must exist in modal-capital-reset');
  assert.ok(html.includes('Virtual practice capital. Simulated practice balance'), 'Educational notice explaining virtual capital must exist');

  // 2. Custom input handlers
  assert.ok(appJs.includes('function onCustomCapitalInput(val)'), 'onCustomCapitalInput must be defined');
  assert.ok(appJs.includes('function applyCustomCapital()'), 'applyCustomCapital must be defined');
  assert.ok(!appJs.includes("if(state.access?.accessMode==='FREE_LAUNCH'){showBrandedAlert('Choose a preset'"), 'Custom capital must not be blocked in Free Launch');
  assert.ok(appJs.includes('executeCapitalReset()'), 'executeCapitalReset must be defined');

  // 3. Backend reset route allows custom amounts
  assert.ok(!serverTs.includes('!PREMIUM_CAPITAL_PRESETS_INR.includes(requestedCapitalINR)'), 'server.ts must not restrict to static preset array');
  assert.ok(serverTs.includes('validateResetCapitalAmount(requestedCapitalINR, tier)'), 'server.ts must validate custom capital bounds with validateResetCapitalAmount');
  assert.ok(serverTs.includes('accountEngine.resetAccount(accountId, positions, quotes, requestedCapitalINR)'), 'server.ts must pass requestedCapitalINR to accountEngine');

  // 4. Virtual account engine handles custom amount
  assert.ok(engineTs.includes('requestedCapitalRupees: number = 100000'), 'virtual-account-engine resetAccount must accept requestedCapitalRupees');
  assert.ok(engineTs.includes('Money.fromRupees(requestedCapitalRupees)'), 'virtual-account-engine must compute initialPaise from requestedCapitalRupees');
});

test('TASK 5: Consistent Button Styles & Responsive Accessibility', () => {
  const css = fs.readFileSync(stylesCssPath, 'utf8');

  // 1. Primary actions
  assert.ok(css.includes('.btn-lime-primary {') && css.includes('min-height: 48px;'), 'Primary button must have min-height >= 44px');
  assert.ok(css.includes('border-radius: 12px;'), 'Primary button must have 12px radius');

  // 2. Action buttons touch target
  assert.ok(css.includes('.btn-action-exit {') && css.includes('min-height: 40px;') && css.includes('min-width: 84px;'), 'Exit button must have min-height >= 40px');
  assert.ok(css.includes('.btn-action-edit-tpsl {') && css.includes('min-height: 40px;'), 'Edit TP/SL button must have min-height >= 40px');

  // 3. Active pressed state
  assert.ok(css.includes('.btn-action-exit:active'), 'Active feedback must be present');
});
