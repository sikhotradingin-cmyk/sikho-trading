import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const WWW_DIR = path.resolve('packages/mobile/android/app/src/main/assets/www');

test('TASK 1: Pinned Local Assets, Licenses, and Engine Decoupling', async () => {
  // 1. Verify HQChart bundled library files exist and KLineChart is completely removed
  const hqJs = path.join(WWW_DIR, 'libs/hqchart/umychart.js');
  const hqComplierJs = path.join(WWW_DIR, 'libs/hqchart/umychart.complier.js');
  const hqStyleJs = path.join(WWW_DIR, 'libs/hqchart/umychart.style.js');
  const klineJs = path.join(WWW_DIR, 'klinecharts.min.js');

  assert.ok(fs.existsSync(hqJs), 'umychart.js must be locally bundled in assets/libs/hqchart');
  assert.ok(fs.statSync(hqJs).size > 1000000, 'umychart.js must be a complete bundled file');
  assert.ok(fs.existsSync(hqComplierJs), 'umychart.complier.js must be locally bundled');
  assert.ok(fs.existsSync(hqStyleJs), 'umychart.style.js must be locally bundled');

  // Verify KLineChart is completely removed
  assert.ok(!fs.existsSync(klineJs), 'klinecharts.min.js must NOT exist in assets (completely removed)');

  const licenseFile = path.join(WWW_DIR, 'LICENSE-hqchart.txt');
  const noticeFile = path.join(WWW_DIR, 'NOTICE-hqchart.txt');
  const adapterFile = path.join(WWW_DIR, 'chart-adapter.js');

  assert.ok(fs.existsSync(licenseFile), 'LICENSE-hqchart.txt must be bundled');
  const licenseContent = fs.readFileSync(licenseFile, 'utf8');
  assert.match(licenseContent, /Apache License/i, 'License file must preserve Apache 2.0 license');

  assert.ok(fs.existsSync(noticeFile), 'NOTICE-hqchart.txt must be bundled');
  const noticeContent = fs.readFileSync(noticeFile, 'utf8');
  assert.match(noticeContent, /HQChart/i, 'Notice file must reference HQChart');

  assert.ok(fs.existsSync(adapterFile), 'chart-adapter.js must exist');
});

test('TASK 2: Chart Adapter Engine Switching, Persistence & Rollback', async () => {
  const adapterContent = fs.readFileSync(path.join(WWW_DIR, 'chart-adapter.js'), 'utf8');
  
  // Set up mock window environment
  const mockLocalStorage = new Map();
  const context = vm.createContext({
    window: {},
    document: {
      getElementById: () => null,
      createElement: () => ({ appendChild: () => {} }),
    },
    localStorage: {
      getItem: (k) => mockLocalStorage.get(k) || null,
      setItem: (k, v) => mockLocalStorage.set(k, String(v)),
      removeItem: (k) => mockLocalStorage.delete(k),
    },
    navigator: { userAgent: 'Mozilla/5.0' },
    console: { log: () => {}, warn: () => {}, error: () => {} },
  });
  context.global = context.window;
  context.window.window = context.window;

  vm.runInContext(adapterContent, context);

  const SikhoChartAdapter = context.window.SikhoChartAdapter;
  assert.ok(SikhoChartAdapter, 'SikhoChartAdapter must be exposed on window');

  // Default engine is hqchart
  assert.equal(SikhoChartAdapter.getEngine(), 'hqchart', 'Default engine must be hqchart');

  // Rollback to lightweight
  SikhoChartAdapter.setEngine('lightweight');
  assert.equal(SikhoChartAdapter.getEngine(), 'lightweight', 'Engine should roll back to lightweight');

  // Restore to hqchart
  SikhoChartAdapter.setEngine('hqchart');
  assert.equal(SikhoChartAdapter.getEngine(), 'hqchart', 'Engine should restore to hqchart');
});

test('TASK 3: Technical Indicator Registry, Categories & Session VWAP / ATR', async () => {
  const adapterContent = fs.readFileSync(path.join(WWW_DIR, 'chart-adapter.js'), 'utf8');
  const context = vm.createContext({
    window: {},
    document: { getElementById: () => null },
    localStorage: { getItem: () => null, setItem: () => {} },
  });
  context.global = context.window;
  vm.runInContext(adapterContent, context);

  const reg = context.window.SikhoChartAdapter.INDICATOR_REGISTRY;
  assert.ok(reg, 'Indicator registry must be defined');

  // Verify Main Overlays
  assert.ok(reg.MA && reg.MA.category === 'main', 'MA must be registered as main indicator');
  assert.ok(reg.EMA && reg.EMA.category === 'main', 'EMA must be registered as main indicator');
  assert.ok(reg.BOLL && reg.BOLL.category === 'main', 'BOLL must be registered as main indicator');
  assert.ok(reg.SAR && reg.SAR.category === 'main', 'SAR must be registered as main indicator');
  assert.ok(reg.VWAP && reg.VWAP.category === 'main', 'VWAP must be registered as main indicator');
  assert.equal(reg.VWAP.requiresVolume, true, 'VWAP must flag volume requirement');

  // Verify Oscillators & Volume
  assert.ok(reg.RSI && reg.RSI.category === 'oscillator', 'RSI must be an oscillator');
  assert.ok(reg.MACD && reg.MACD.category === 'oscillator', 'MACD must be an oscillator');
  assert.ok(reg.KDJ && reg.KDJ.category === 'oscillator', 'KDJ must be an oscillator');
  assert.ok(reg.VOL && reg.VOL.category === 'volume', 'VOL must be a volume indicator');
  assert.ok(reg.ATR && reg.ATR.category === 'oscillator', 'ATR must be registered');

  // Verify parameter configurations
  assert.ok(Array.isArray(reg.MA.defaultParams) && reg.MA.defaultParams.length === 4, 'MA default params');
  assert.ok(Array.isArray(reg.RSI.defaultParams) && reg.RSI.defaultParams.length >= 1, 'RSI default params');
});

test('TASK 4: Categorized Drawing Workspace & Overlay Tools', async () => {
  const adapterContent = fs.readFileSync(path.join(WWW_DIR, 'chart-adapter.js'), 'utf8');
  const context = vm.createContext({
    window: {},
    document: { getElementById: () => null },
    localStorage: { getItem: () => null, setItem: () => {} },
  });
  context.global = context.window;
  vm.runInContext(adapterContent, context);

  const categories = context.window.SikhoChartAdapter.DRAWING_TOOL_CATEGORIES;
  assert.ok(Array.isArray(categories), 'Categories must be an array');
  assert.equal(categories.length, 5, 'Must contain 5 categorized drawing groups');

  const catIds = Array.from(categories).map(c => String(c.id));
  assert.equal(catIds[0], 'lines');
  assert.equal(catIds[1], 'channels');
  assert.equal(catIds[2], 'zones');
  assert.equal(catIds[3], 'measurement');
  assert.equal(catIds[4], 'annotations');

  // Verify verified custom overlays
  const zonesCat = categories.find(c => c.id === 'zones');
  assert.ok(zonesCat.tools.some(t => t.id === 'rectZone'), 'Rectangle zone must be available');
  assert.ok(zonesCat.tools.some(t => t.id === 'circleZone'), 'Circle zone must be available');

  const measCat = categories.find(c => c.id === 'measurement');
  assert.ok(measCat.tools.some(t => t.id === 'priceMeasurement'), 'Price measurement must be available');
  assert.ok(measCat.tools.some(t => t.id === 'riskRewardLong'), 'Long risk/reward must be available');
  assert.ok(measCat.tools.some(t => t.id === 'riskRewardShort'), 'Short risk/reward must be available');
});

test('TASK 5: Drawing Action Stack & Color Inversion for Indian Convention', async () => {
  const adapterContent = fs.readFileSync(path.join(WWW_DIR, 'chart-adapter.js'), 'utf8');
  const mockResource = {
    UpBarColor: 'rgb(238,21,21)', // Chinese default red
    DownBarColor: 'rgb(25,158,0)', // Chinese default green
    FrameLatestPrice: {},
    HLCArea: {},
  };
  const context = vm.createContext({
    window: {},
    document: { getElementById: () => null },
    localStorage: { getItem: () => null, setItem: () => {} },
    g_JSChartResource: mockResource,
  });
  context.global = context.window;
  vm.runInContext(adapterContent, context);

  const adapter = context.window.SikhoChartAdapter.createAdapter('hqchart');
  assert.ok(adapter, 'HQChartAdapter instance created');

  // Verify undo stack does not execute orders
  adapter.pushDrawingAction({ action: 'create', id: 'ov_1', overlayDef: { name: 'straightLine' } });
  assert.equal(adapter.undoStack.length, 1);
  assert.equal(adapter.redoStack.length, 0);

  // Verify Color Inversion applied to HQChart resources:
  // Green = Up / Bullish (close >= open), Red = Down / Bearish (close < open)
  adapter.applyIndianMarketColors(true); // Dark mode
  assert.match(mockResource.UpBarColor, /52|34|green/i, 'UpBarColor must be inverted to green for bullish');
  assert.match(mockResource.DownBarColor, /251|113|red/i, 'DownBarColor must be inverted to red for bearish');

  adapter.applyIndianMarketColors(false); // Light mode
  assert.match(mockResource.UpBarColor, /4|120|87/i, 'UpBarColor must be dark green for light theme');
  assert.match(mockResource.DownBarColor, /190|18|60/i, 'DownBarColor must be crimson red for light theme');
});
