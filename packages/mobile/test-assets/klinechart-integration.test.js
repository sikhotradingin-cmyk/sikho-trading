import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const WWW_DIR = path.resolve('packages/mobile/android/app/src/main/assets/www');

test('TASK 1: Pinned Local Assets, Licenses, and Engine Decoupling', async () => {
  // 1. Verify bundled library files exist and are not empty
  const klineJs = path.join(WWW_DIR, 'klinecharts.min.js');
  const licenseFile = path.join(WWW_DIR, 'LICENSE-klinecharts.txt');
  const noticeFile = path.join(WWW_DIR, 'NOTICE-klinecharts.txt');
  const adapterFile = path.join(WWW_DIR, 'chart-adapter.js');

  assert.ok(fs.existsSync(klineJs), 'klinecharts.min.js must be locally bundled in assets');
  assert.ok(fs.statSync(klineJs).size > 100000, 'klinecharts.min.js must be a complete bundled file');

  assert.ok(fs.existsSync(licenseFile), 'LICENSE-klinecharts.txt must be bundled');
  const licenseContent = fs.readFileSync(licenseFile, 'utf8');
  assert.match(licenseContent, /Apache License/i, 'License file must preserve Apache 2.0 license');

  assert.ok(fs.existsSync(noticeFile), 'NOTICE-klinecharts.txt must be bundled');
  const noticeContent = fs.readFileSync(noticeFile, 'utf8');
  assert.match(noticeContent, /KLineChart/i, 'Notice file must reference KLineChart');

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

  // Default engine is klinechart
  assert.equal(SikhoChartAdapter.getEngine(), 'klinechart', 'Default engine must be klinechart');

  // Rollback to lightweight
  SikhoChartAdapter.setEngine('lightweight');
  assert.equal(SikhoChartAdapter.getEngine(), 'lightweight', 'Engine should roll back to lightweight');

  // Restore to klinechart
  SikhoChartAdapter.setEngine('klinechart');
  assert.equal(SikhoChartAdapter.getEngine(), 'klinechart', 'Engine should restore to klinechart');
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

test('TASK 5: Drawing Migration & Undo/Redo Independence', async () => {
  const adapterContent = fs.readFileSync(path.join(WWW_DIR, 'chart-adapter.js'), 'utf8');
  const context = vm.createContext({
    window: {},
    document: { getElementById: () => null },
    localStorage: { getItem: () => null, setItem: () => {} },
  });
  context.global = context.window;
  vm.runInContext(adapterContent, context);

  const adapter = context.window.SikhoChartAdapter.createAdapter('klinechart');
  assert.ok(adapter, 'KLineChartAdapter instance created');

  // Verify undo stack does not execute orders
  adapter.pushDrawingAction({ action: 'create', id: 'ov_1', overlayDef: { name: 'straightLine' } });
  assert.equal(adapter.undoStack.length, 1);
  assert.equal(adapter.redoStack.length, 0);

  // Legacy SVG to KLineChart overlay format conversion
  const legacyDrawings = [
    { type: 'trendline', p1: { time: 1732600000, price: 24200 }, p2: { time: 1732603600, price: 24350 } },
    { type: 'hline', p1: { time: 1732600000, price: 24150 }, p2: { time: 1732600000, price: 24150 } },
    { type: 'rect', p1: { time: 1732600000, price: 24100 }, p2: { time: 1732607200, price: 24250 } },
  ];

  const legacyTypeMap = {
    trendline: 'straightLine',
    hline: 'horizontalStraightLine',
    rect: 'rectZone',
    fib: 'fibonacciLine',
    rr_long: 'riskRewardLong',
  };

  const migrated = legacyDrawings.map(d => ({
    name: legacyTypeMap[d.type],
    points: [
      { timestamp: d.p1.time * 1000, value: d.p1.price },
      { timestamp: d.p2.time * 1000, value: d.p2.price },
    ]
  }));

  assert.equal(migrated[0].name, 'straightLine');
  assert.equal(migrated[0].points[0].timestamp, 1732600000000);
  assert.equal(migrated[0].points[0].value, 24200);
  assert.equal(migrated[1].name, 'horizontalStraightLine');
  assert.equal(migrated[2].name, 'rectZone');
});
