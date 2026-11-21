const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '../android/app/src/main/assets/www/app.js'), 'utf8');

function extractContext(names, extra = {}) {
  const ast = ts.createSourceFile('app.js', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const c = vm.createContext({ Boolean, Number, Math, Intl, Date, Object, Map, Set, Array, String, state: {}, ...extra });
  function walk(n) {
    if (ts.isFunctionDeclaration(n) && names.includes(n.name?.text)) {
      vm.runInContext(n.getText(ast), c);
    }
    ts.forEachChild(n, walk);
  }
  walk(ast);
  return c;
}

test('Priority 1: Unresolved access never locks charts or opens upgrade modal; out-of-order and unauth fallbacks are rejected', () => {
  const alerts = [];
  const notifications = [];
  let rerenders = 0;
  let polled = 0;
  const state = {
    token: 'valid-jwt',
    user: { tier: 'FREE' },
    subscription: null,
    entitlementResolved: false,
    access: null,
    accessResolved: false,
    accessSeq: 0,
  };

  const c = extractContext(
    ['hasFullFeatureAccess', 'isProUser', 'isInstrumentRestrictedForFree', 'showSubscriptionUpgradePrompt', 'applyAccessPolicy'],
    {
      state,
      window: {
        TzFreeAccess: { isFreeTierAllowedInstrument: () => false },
        SikhoUX: { notify: (m) => notifications.push(m) },
        TradingzoneNative: {},
      },
      document: { getElementById: () => null },
      showBrandedAlert: (t, m) => alerts.push({ t, m }),
      openSubscriptionPlansModal: () => alerts.push({ modal: true }),
      pollAccessPolicy: () => { polled++; },
      renderBenchmarkIndexStrip: () => { rerenders++; },
      renderExploreStocksList: () => {},
      renderExploreFnoLists: () => {},
      renderCommoditiesList: () => {},
      renderWatchlistsTab: () => {},
    }
  );

  // While accessResolved is false, RELIANCE must NOT be marked restricted and prompt must NOT open upgrade modal
  assert.equal(c.isInstrumentRestrictedForFree({ globalId: 'NSE:RELIANCE', symbol: 'RELIANCE' }), false);
  c.showSubscriptionUpgradePrompt('RELIANCE');
  assert.equal(alerts.length, 0);
  assert.equal(polled, 1);

  // Apply FREE_LAUNCH at seq=5 -> resolves and triggers re-render
  c.applyAccessPolicy({ accessMode: 'FREE_LAUNCH', fullFeatureAccess: true, adsRequired: true, label: 'Free Launch' }, 5);
  assert.equal(state.accessResolved, true);
  assert.equal(c.hasFullFeatureAccess(), true);
  assert.equal(rerenders, 1);

  // Out-of-order stale STANDARD response at seq=2 must be ignored
  c.applyAccessPolicy({ accessMode: 'STANDARD', fullFeatureAccess: false, adsRequired: true, label: 'Free plan' }, 2);
  assert.equal(state.access.accessMode, 'FREE_LAUNCH');
  assert.equal(c.hasFullFeatureAccess(), true);

  // Unauthenticated FREE_LAUNCH fallback (fullFeatureAccess:false) must NOT overwrite authenticated session
  c.applyAccessPolicy({ accessMode: 'FREE_LAUNCH', fullFeatureAccess: false, adsRequired: true, label: 'Free Launch' }, 6);
  assert.equal(state.access.fullFeatureAccess, true);
});

test('Priority 3: formatPointsAndPct formats signed points and percentage accurately and reports Unavailable without previous close', () => {
  const c = extractContext(['fmtNum', 'calcChange', 'formatChangePct', 'formatPointsAndPct']);

  const gain = c.formatPointsAndPct({ ltp: 25300, close: 24700 });
  assert.equal(gain.available, true);
  assert.equal(gain.cls, 'val-pos');
  assert.equal(gain.text, '+600.00 (+2.43%)');

  const loss = c.formatPointsAndPct({ ltp: 24574.5, close: 24700 });
  assert.equal(loss.available, true);
  assert.equal(loss.cls, 'val-neg');
  assert.equal(loss.text, '-125.50 (-0.51%)');

  const missing = c.formatPointsAndPct({ ltp: 25300, close: 0 });
  assert.equal(missing.available, false);
  assert.equal(missing.cls, 'val-neutral');
  assert.equal(missing.text, 'Unavailable');
});

test('Priority 5: Day/Night/System theme persists, updates system bars, and updates chart in-place without recreating it', () => {
  const storage = new Map();
  const barCalls = [];
  const chartOpts = [];
  const candleOpts = [];
  let attrs = {};

  const c = extractContext(
    ['getThemePreference', 'resolveEffectiveTheme', 'syncNativeSystemBarTheme', 'getChartThemeOptions', 'applyChartTheme', 'applyTheme', 'setThemePreference', 'toggleThemeQuick'],
    {
      THEME_STORAGE_KEY: 'sikho_theme_pref',
      localStorage: {
        getItem: (k) => storage.get(k) ?? null,
        setItem: (k, v) => storage.set(k, v),
      },
      window: {
        matchMedia: () => ({ matches: true }),
        TradingzoneNative: { setSystemBarTheme: (isLight, hex) => barCalls.push({ isLight, hex }) },
      },
      document: {
        documentElement: { setAttribute: (k, v) => { attrs[k] = v; } },
        getElementById: () => null,
      },
      tvChart: { applyOptions: (o) => chartOpts.push(o) },
      candleSeries: { applyOptions: (o) => candleOpts.push(o) },
    }
  );

  // Switch to dark
  c.setThemePreference('dark');
  assert.equal(storage.get('sikho_theme_pref'), 'dark');
  assert.equal(attrs['data-theme'], 'dark');
  assert.equal(barCalls.at(-1).isLight, false);
  assert.equal(chartOpts.at(-1).layout.background.color, '#080C12');

  // Switch to light (day mode chart is genuinely light!)
  c.setThemePreference('light');
  assert.equal(storage.get('sikho_theme_pref'), 'light');
  assert.equal(attrs['data-theme'], 'light');
  assert.equal(barCalls.at(-1).isLight, true);
  assert.equal(chartOpts.at(-1).layout.background.color, '#FFFFFF');
  assert.equal(candleOpts.length, 2);

  // System mode follows matchMedia (dark=true in mock)
  c.setThemePreference('system');
  assert.equal(storage.get('sikho_theme_pref'), 'system');
  assert.equal(attrs['data-theme'], 'dark');
});
