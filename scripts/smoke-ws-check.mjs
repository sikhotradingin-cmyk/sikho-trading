#!/usr/bin/env node
/**
 * Authorised, read-only production smoke check for the realtime channel.
 * Logs in with an explicitly-created QA account, opens the authenticated /ws channel and
 * verifies protocol message types plus forming-candle time alignment. No writes are performed.
 *
 * Usage: node scripts/smoke-ws-check.mjs <email> <password> [baseUrl]
 */
const email = process.argv[2];
const password = process.argv[3];
const base = (process.argv[4] || 'https://sikho-trading-api.onrender.com').replace(/\/+$/, '');
if (!email || !password) {
  console.error('usage: node smoke-ws-check.mjs <email> <password> [baseUrl]');
  process.exit(2);
}

const log = (...a) => console.log('[smoke]', ...a);

const loginRes = await fetch(`${base}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
if (!loginRes.ok) {
  console.error('[smoke] login failed', loginRes.status, await loginRes.text());
  process.exit(1);
}
const session = await loginRes.json();
log('login ok tier=' + session.user.tier + ' accountTier=' + session.account.tier);

const targets = ['NSE:NIFTY 50:99926000', 'NSE:BANKNIFTY:99926009'];
const wsUrl = base.replace(/^http/, 'ws') + '/ws';
const ws = new WebSocket(wsUrl);

const seen = new Map();
let forming = 0;
let quoteTicks = 0;
let authSuccessAt = 0;
const clockSamples = [];

const timer = setTimeout(() => {
  log('summary', JSON.stringify({ messages: Object.fromEntries(seen), quoteTicks, forming, clockSkewMs: clockSamples[0] ?? null, authSuccessAt }));
  try { ws.close(); } catch { }
  process.exit(0);
}, 15000);

ws.addEventListener('open', () => {
  log('ws open');
  ws.send(JSON.stringify({ action: 'AUTH', token: session.token }));
});

ws.addEventListener('message', (ev) => {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  const type = msg.type || msg.action || 'UNKNOWN';
  seen.set(type, (seen.get(type) || 0) + 1);

  if (type === 'AUTH_SUCCESS') {
    authSuccessAt = Date.now();
    if (msg.serverTimestamp) clockSamples.push(Number(msg.serverTimestamp) - Date.now());
    log('auth success tier=' + msg.tier + ' serverTimestampDeltaMs=' + clockSamples[clockSamples.length - 1]);
    ws.send(JSON.stringify({ action: 'SUBSCRIBE', symbols: targets }));
  } else if (type === 'SUBSCRIBED') {
    log('subscribed count=' + (msg.symbols || []).length);
  } else if (type === 'QUOTE_TICK') {
    quoteTicks++;
    if (quoteTicks <= 2) {
      const q = msg.data || {};
      log('quote', q.globalId, 'ltp=' + q.ltp, 'providerTsAgeMs=' + (Date.now() - Number(q.providerTimestamp || 0)));
    }
  } else if (type === 'FORMING_CANDLE_SNAPSHOT') {
    forming++;
    const tfList = Object.keys(msg.candles || {});
    const sample30 = msg.candles?.['30m'];
    const sample5 = msg.candles?.['5m'];
    log(
      'forming snapshot', msg.globalId,
      'timeframes=' + tfList.join(','),
      '5m mod300=' + (sample5 ? sample5.time % 300 : 'n/a'),
      '30m mod1800=' + (sample30 ? sample30.time % 1800 : 'n/a'),
      'futureSec=' + (sample5 ? sample5.time - Math.floor(Date.now() / 1000) : 'n/a'),
      'serverTimestampDeltaMs=' + (msg.serverTimestamp ? Number(msg.serverTimestamp) - Date.now() : 'n/a')
    );
  } else if (type === 'RESTRICTED_ACCESS') {
    log('restricted', msg.symbol);
  } else {
    log('message', type);
  }
});

ws.addEventListener('error', (e) => {
  console.error('[smoke] ws error', e.message || e);
});
