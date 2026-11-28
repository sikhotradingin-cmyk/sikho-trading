const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');

const appSrc = fs.readFileSync(path.join(__dirname, '../android/app/src/main/assets/www/app.js'), 'utf8');

function extractContext(names, extra = {}) {
  const ast = ts.createSourceFile('app.js', appSrc, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const c = vm.createContext({ Boolean, Number, Math, Intl, Date, Object, Map, Set, Array, String, JSON, state: {}, ...extra });
  function walk(n) {
    if (ts.isFunctionDeclaration(n) && names.includes(n.name?.text)) {
      vm.runInContext(n.getText(ast), c);
    }
    ts.forEachChild(n, walk);
  }
  walk(ast);
  return c;
}

test('States 11/12/23/31/35: Status banner enforces Maintenance > Offline > Reconnecting > Stale > Update precedence', () => {
  const el = { className: '', innerHTML: '', hidden: true };
  const state = {
    token: 't1',
    wsConnected: true,
    maintenance: { active: true, message: 'DB upgrade' },
    clientVersion: { latestCode: 99, updateUrl: 'https://sikhotrading.in/' },
    feedHealth: { marketSession: { isMarketOpen: true } },
    lastAnyTickReceiveMs: Date.now() - 30000,
  };
  const navigator = { onLine: false };
  const c = extractContext(['updateAppStatusBanner'], {
    state,
    navigator,
    wsReconnectAttempts: 2,
    window: { SikhoUX: { escape: (s) => String(s) }, TradingzoneNative: { getVersionCode: () => 26 } },
    document: { getElementById: (id) => (id === 'app-connectivity-banner' ? el : null) },
  });

  // 1. Maintenance wins over offline/reconnecting/stale/update
  c.updateAppStatusBanner();
  assert.equal(el.hidden, false);
  assert.match(el.className, /is-maintenance/);

  // 2. Offline wins when maintenance is off
  state.maintenance.active = false;
  c.updateAppStatusBanner();
  assert.match(el.className, /is-offline/);

  // 3. Reconnecting wins when online & WS disconnected
  navigator.onLine = true;
  state.wsConnected = false;
  c.updateAppStatusBanner();
  assert.match(el.className, /is-reconnecting/);
  assert.match(el.innerHTML, /Attempt 2/);

  // 4. Delayed banner shows when genuinely receiving delayed quotes
  state.wsConnected = true;
  state.feedHealth.delayed = true;
  c.updateAppStatusBanner();
  assert.match(el.className, /is-stale/);

  // Auto-hides when live WebSocket is connected without delayed quotes
  state.feedHealth.delayed = false;
  state.lastAnyTickReceiveMs = Date.now();
  c.updateAppStatusBanner();
  assert.match(el.className, /is-update/);

  // 6. Banner hides once dismissed
  state.updateBannerDismissed = true;
  c.updateAppStatusBanner();
  assert.equal(el.hidden, true);
});

test('States 27 & 28: Watchlist optimistic removal supports 6s Undo and rolls back on server failure', async () => {
  let undoCb = null;
  let shouldFail = false;
  const notices = [];
  const state = {
    watchlists: [{
      id: 'wl-1',
      name: 'Default',
      instruments: ['NSE:RELIANCE', 'NSE:TCS'],
      hydratedInstruments: [{ globalId: 'NSE:RELIANCE', symbol: 'RELIANCE' }, { globalId: 'NSE:TCS', symbol: 'TCS' }],
    }],
  };

  const c = extractContext(['removeSymbolFromWatchlist'], {
    state,
    renderWatchlistsTab: () => {},
    apiFetch: async () => {
      if (shouldFail) throw new Error('Server 500');
      return { ok: true };
    },
    window: {
      SikhoUX: {
        notify: (m) => notices.push(m),
        notifyWithUndo: (m, cb) => { notices.push(m); undoCb = cb; },
      },
    },
  });

  // Optimistic remove + Undo restore
  await c.removeSymbolFromWatchlist('NSE:TCS', 'TCS');
  assert.deepEqual(Array.from(state.watchlists[0].instruments), ['NSE:RELIANCE']);
  assert.ok(typeof undoCb === 'function');
  undoCb();
  assert.deepEqual(Array.from(state.watchlists[0].instruments), ['NSE:RELIANCE', 'NSE:TCS']);

  // Server failure rolls back gracefully
  shouldFail = true;
  await c.removeSymbolFromWatchlist('NSE:TCS', 'TCS');
  assert.deepEqual(Array.from(state.watchlists[0].instruments), ['NSE:RELIANCE', 'NSE:TCS']);
  assert.ok(notices.some((n) => n.includes('restored')));
});

test('States 14, 24 & 25: Journal drafts and onboarding progress are scoped per immutable userId', () => {
  const storage = new Map();
  const slot = { innerHTML: '' };
  const state = { user: { userId: 'user-A', name: 'Arbaz' }, orders: [], watchlists: [{ instruments: [] }] };
  const c = extractContext(['getJournalDraftKey', 'getOnboardingKey', 'markOnboardingStep', 'renderOnboardingCard', 'dismissOnboardingCard'], {
    state,
    localStorage: {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, v),
      removeItem: (k) => storage.delete(k),
    },
    window: { SikhoUX: { escape: (s) => String(s) } },
    document: { getElementById: (id) => (id === 'onboarding-card-slot' ? slot : null) },
  });

  assert.equal(c.getJournalDraftKey(), 'sikho_journal_draft_user-A');
  c.renderOnboardingCard();
  assert.match(slot.innerHTML, /Welcome, Arbaz!/);

  c.markOnboardingStep('chart');
  c.markOnboardingStep('watchlist');
  c.markOnboardingStep('trade');
  assert.match(slot.innerHTML, /All 3 setup steps complete!/);

  // Switch to User B -> clean independent draft key and fresh onboarding
  state.user = { userId: 'user-B', name: 'Priya' };
  assert.equal(c.getJournalDraftKey(), 'sikho_journal_draft_user-B');
  c.renderOnboardingCard();
  assert.match(slot.innerHTML, /Welcome, Priya!/);
});
