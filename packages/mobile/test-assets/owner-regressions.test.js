'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(require('node:path').join(__dirname, '../android/app/src/main/assets/www/app.js'), 'utf8');
const ast = ts.createSourceFile('app.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function harness(names, extra = {}) {
  const c = vm.createContext({ state: {}, console, Map, Set, Number, Date, Boolean, String,
    document: { getElementById: () => null }, ...extra });
  const found = new Set();
  function visit(n) {
    if (ts.isFunctionDeclaration(n) && names.includes(n.name?.text)) {
      vm.runInContext(n.getText(ast), c); found.add(n.name.text);
    }
    ts.forEachChild(n, visit);
  }
  visit(ast);
  assert.equal(found.size, names.length);
  return c;
}
function chainHarness(fetch) {
  const nodes = new Map();
  const getNode = (id) => {
    if (!nodes.has(id)) nodes.set(id, { innerHTML: '', style: {}, textContent: '', scrollTop: 0,
      scrollHeight: 100, querySelector: () => null, classList: { contains: () => true } });
    return nodes.get(id);
  };
  const c = harness(['optionChainCanonicalUnderlying', 'optionChainFreeAllowed', 'ensureOptionChainState',
    'mergeOptionChainRows', 'loadOptionChain', 'loadMoreOptionStrikes'], {
    OC_WINDOW_SIZE: 21, apiFetch: fetch, isProUser: () => false,
    document: { getElementById: getNode }, requestAnimationFrame: (f) => f(),
    setOptionChainStatus() {}, ocRegisterContracts() {}, renderOptionChainHeader() {},
    renderOptionChainTable() {}, syncVisibleOptionChainSubscriptions() {},
    unsubscribableOptionChainContracts() {}, ocQuoteAgeText: () => '',
    showSubscriptionUpgradePrompt: () => { throw Error('unexpected upgrade'); },
  });
  c.ensureOptionChainState();
  return c;
}
const page = (expiry, offset, strikes) => ({ selectedExpiry: expiry,
  rows: strikes.map(strikePrice => ({ strikePrice })),
  strikeWindow: { offset, size: strikes.length, total: 100 } });

test('expiry change replaces previous contracts and ignores late previous-expiry response', async () => {
  const pending = [];
  const c = chainHarness(() => new Promise(resolve => pending.push(resolve)));
  const old = c.loadOptionChain('NIFTY', '2026-11-17');
  const current = c.loadOptionChain('NIFTY', '2026-11-24');
  pending[1](page('2026-11-24', 40, [25000])); await current;
  pending[0](page('2026-11-17', 0, [24000])); await old;
  assert.equal(c.state.optionChain.expiry, '2026-11-24');
  assert.deepEqual(Array.from(c.state.optionChain.rows, r => r.strikePrice), [25000]);
  c.apiFetch = async () => page('2026-12-01', 10, [26000]);
  await c.loadOptionChain('NIFTY', '2026-12-01');
  assert.deepEqual(Array.from(c.state.optionChain.rows, r => r.strikePrice), [26000]);
  assert.equal(c.state.optionChain.loadedStart, 10);
});

test('pagination advances independently at both loaded frontiers', async () => {
  const c = chainHarness(async () => page('2026-11-17', 40, [25000]));
  await c.loadOptionChain('NIFTY', '2026-11-17');
  const offsets = [];
  c.loadOptionChain = async (_u, _e, opts) => {
    offsets.push(opts.offset);
    const oc = c.state.optionChain;
    if (opts.appendAbove) oc.loadedStart = opts.offset;
    else oc.loadedEnd = opts.offset + 21;
  };
  await c.loadMoreOptionStrikes('above');
  await c.loadMoreOptionStrikes('below');
  await c.loadMoreOptionStrikes('above');
  await c.loadMoreOptionStrikes('below');
  assert.deepEqual(offsets, [19, 41, 0, 62]);
});

test('desired option subscriptions survive offline and release obsolete contracts when connected', () => {
  const sent = [];
  const c = harness(['ensureOptionChainState', 'syncOptionChainSubscriptions'], {
    OC_MAX_SUBSCRIPTIONS: 62, wsConn: null, WebSocket: { OPEN: 1 },
    ocIsSymbolUsedElsewhere: () => false, sendWsSubscribe: ids => sent.push(['add', Array.from(ids)]),
  });
  c.syncOptionChainSubscriptions(['CE1', 'PE1']);
  assert.deepEqual(Array.from(c.state.optionChain.subscribed), ['CE1', 'PE1']);
  c.wsConn = { readyState: 1, send: raw => sent.push(['remove', JSON.parse(raw).symbols]) };
  c.syncOptionChainSubscriptions(['CE2', 'PE2']);
  assert.deepEqual(sent.at(-1), ['remove', ['CE1', 'PE1']]);
  assert.deepEqual(Array.from(c.state.optionChain.subscribed), ['CE2', 'PE2']);
});

test('visible rows determine bounded subscriptions rather than the last fetched page', () => {
  const row = (top, ids) => ({ getBoundingClientRect: () => ({ top, bottom: top + 40 }),
    querySelectorAll: () => ids.map(id => ({ dataset: { ocLtp: id } })) });
  let selected;
  const c = harness(['syncVisibleOptionChainSubscriptions'], { ocIsOpen: () => true,
    syncOptionChainSubscriptions: ids => { selected = Array.from(ids); },
    document: { getElementById: () => ({ getBoundingClientRect: () => ({ top: 100, bottom: 400 }),
      querySelectorAll: () => [row(-200, ['oldCE']), row(200, ['CE', 'PE']), row(800, ['farPE'])] }) },
  });
  c.syncVisibleOptionChainSubscriptions();
  assert.deepEqual(selected, ['CE', 'PE']);
});

test('missing option prices retain a valid cached LTP and partial ticks do not clear cells', () => {
  const c = harness(['ocLtpText', 'updateOptionChainQuote'], { fmtNum: String, ocIsOpen: () => true });
  c.state.quotesMap = new Map([['CE', { ltp: 123.45 }]]);
  c.state.optionChain = { contracts: new Map([['CE', {}]]) };
  assert.equal(c.ocLtpText({ ltp: null }, 'CE'), '123.45');
  assert.equal(c.ocLtpText({ ltp: null }, 'missing'), '—');
  c.updateOptionChainQuote({ globalId: 'CE', ltp: null });
  assert.equal(c.state.quotesMap.get('CE').ltp, 123.45);
});

test('exact chain metadata is used before lossy symbol lookup', async () => {
  const c = harness(['resolveInstrumentForChart']);
  const instrument = { globalId: 'NFO:EXACT:1', strikePrice: 25000, expiry: '2026-11-24', optionType: 'CE', lotSize: 65, instrumentType: 'OPTIDX' };
  c.state.optionChain = { contracts: new Map([[instrument.globalId, { side: 'CE', row: { call: { instrument } } }]]) };
  assert.equal(await c.resolveInstrumentForChart(instrument.globalId), instrument);
});

test('final hourly candle closes at 15:30 IST and daily countdown never extends to midnight', () => {
  let now = Date.parse('2026-11-16T09:50:00Z'); // 15:20 IST
  const c = harness(['getTimeframeIntervalSec', 'computeCandleBucketSec', 'computeRunningCandleWindow'], {
    serverNowMs: () => now, fmtIstHhMm: ms => new Date(ms + 19800000).toISOString().slice(11, 16),
  });
  c.state.activeInstrument = { exchange: 'NSE' };
  const win = c.computeRunningCandleWindow('1h');
  assert.equal(win.label, '15:15–15:30 IST');
  now = Date.parse('2026-11-16T10:30:00Z');
  const daily = c.computeRunningCandleWindow('1D');
  assert.equal(daily.endSec, Date.parse('2026-11-16T10:00:00Z') / 1000);
  assert.equal(c.computeRunningCandleWindow('1h').label, '15:15–15:30 IST');
});

function googleHarness(fetch) {
  const button = { disabled: true };
  const text = { textContent: '' };
  const stages = [];
  const c = vm.createContext({ window: {}, state: { isGoogleSignInPending: true },
    document: { getElementById: id => id === 'btn-google-signin' ? button : id === 'btn-google-signin-text' ? text : { style: {} } },
    activeGoogleSignInRequestId: 'g_fixture', expiredGoogleRequestIds: new Set(), handledGoogleRequestIds: new Set(),
    googleSignInTimeoutId: null, clearTimeout() {}, JSON, Boolean, String,
    apiFetch: fetch, recordGoogleStage: (stage, req, detail) => stages.push({ stage, req, detail }),
    showAuthError: error => { c.lastError = error; }, logGoogleSignInDiagnostics() {},
    completeAuthenticatedSession: (...args) => { c.savedSession = args; return true; },
  });
  function visit(n) {
    if (ts.isExpressionStatement(n) && n.expression.getText(ast).startsWith('window.onTradingzoneGoogleSignInResult =')) vm.runInContext(n.getText(ast), c);
    ts.forEachChild(n, visit);
  }
  visit(ast);
  return { c, button, stages };
}

test('Google button stays locked through backend verification and successful callback persists one FREE session', async () => {
  let resolve;
  let calls = 0;
  const { c, button, stages } = googleHarness((_url, opts) => {
    calls++;
    assert.equal(opts.headers['X-Auth-Request-Id'], 'g_fixture');
    return new Promise(r => { resolve = r; });
  });
  const payload = JSON.stringify({ idToken: 'controlled-test-only', requestId: 'g_fixture' });
  const result = c.window.onTradingzoneGoogleSignInResult(true, payload, null, 'g_fixture');
  assert.equal(c.state.isGoogleSignInPending, true);
  assert.equal(button.disabled, true);
  resolve({ token: 'isolated-backend-session', user: { tier: 'FREE' }, account: {}, entitlement: { tier: 'FREE' } });
  await result;
  assert.equal(c.savedSession[1].tier, 'FREE');
  assert.equal(c.state.isGoogleSignInPending, false);
  assert.equal(button.disabled, false);
  await c.window.onTradingzoneGoogleSignInResult(true, payload, null, 'g_fixture');
  assert.equal(calls, 1);
  assert.ok(stages.some(s => s.stage === 'JS_SESSION_SAVED'));
});

test('backend failure is not reported as user cancellation and reliably restores Google button', async () => {
  const { c, button, stages } = googleHarness(async () => { throw Object.assign(Error('Audience mismatch'), { status: 401, code: 'ERR_GOOGLE_AUTH_ERROR' }); });
  await c.window.onTradingzoneGoogleSignInResult(true, JSON.stringify({ idToken: 'fixture' }), null, 'g_fixture');
  assert.match(c.lastError, /HTTP 401/);
  assert.doesNotMatch(c.lastError, /cancel/i);
  assert.equal(button.disabled, false);
  assert.equal(c.state.isGoogleSignInPending, false);
  assert.ok(stages.some(s => s.stage === 'JS_BACKEND_ERROR'));
});

test('expired Google callback is rejected without authenticating', async () => {
  const { c } = googleHarness(async () => { throw Error('must not reach backend'); });
  c.expiredGoogleRequestIds.add('g_fixture');
  await c.window.onTradingzoneGoogleSignInResult(true, JSON.stringify({ idToken: 'fixture' }), null, 'g_fixture');
  assert.equal(c.savedSession, undefined);
});
