import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const appJsPath = path.resolve(__dirname, '../android/app/src/main/assets/www/app.js');
const historyJsPath = path.resolve(__dirname, '../android/app/src/main/assets/www/history.js');
const stylesCssPath = path.resolve(__dirname, '../android/app/src/main/assets/www/styles.css');

test('TASK 1: Trade History 30-Day Retention Notice, Filters, and Clamped Range', () => {
  const historyCode = fs.readFileSync(historyJsPath, 'utf8');

  // Verify 30-day notice is present
  assert.ok(historyCode.includes('Trade history is retained for 30 days.'), 'Must display 30-day retention notice');
  assert.ok(historyCode.includes('history-retention-notice'), 'Must have history-retention-notice container');

  // Verify ranges do not offer ALL time or multi-month intervals beyond 30 days
  assert.ok(!historyCode.includes('value="ALL"'), 'Must not offer ALL time range in trade history');
  assert.ok(historyCode.includes('value="TODAY"'), 'Must offer Today');
  assert.ok(historyCode.includes('value="WEEK"'), 'Must offer Last 7 Days');
  assert.ok(historyCode.includes('value="MONTH"'), 'Must offer Last 30 Days');
  assert.ok(historyCode.includes('value="CUSTOM"'), 'Must offer Custom (within 30 days)');

  // Verify custom range clamps to rolling 30-day window
  assert.ok(historyCode.includes('30*86400000') || historyCode.includes('30 * 86400000'), 'Must enforce 30-day millisecond cutoff on custom dates');
});

test('TASK 2: Compact & Professional Orders and History Cards Layout', () => {
  const historyCode = fs.readFileSync(historyJsPath, 'utf8');
  const css = fs.readFileSync(stylesCssPath, 'utf8');

  // 1. Full instrument identity on clean second line without ellipsis truncation
  assert.ok(historyCode.includes('history-card-sub'), 'Must render clean 2nd line for contract details');
  assert.ok(css.includes('.history-card-sub'), 'CSS must style .history-card-sub');
  assert.ok(css.includes('word-break: break-word'), 'CSS must allow clean word-break without truncation');

  // 2. Linked TP/SL chips
  assert.ok(historyCode.includes('order-chip is-tp') && historyCode.includes('Linked TP'), 'Must render Linked TP badge for target orders');
  assert.ok(historyCode.includes('order-chip is-sl') && historyCode.includes('Linked SL'), 'Must render Linked SL badge for stop loss orders');

  // 3. Concise user-facing cancel/update reasons
  assert.ok(historyCode.includes('TP/SL updated.'), 'Must format PROTECTION_UPDATED to user-facing TP/SL updated.');
  assert.ok(historyCode.includes('Companion order filled.'), 'Must format OCO_COMPANION_FILLED to user-facing string');

  // 4. Expandable details
  assert.ok(historyCode.includes('btn-card-details'), 'Must provide collapsible details button');
  assert.ok(historyCode.includes('history-card-details'), 'Must wrap details in collapsible element');
  assert.ok(historyCode.includes('btn-card-cancel'), 'Must provide Cancel button for pending orders');
});

test('TASK 3 & 4: Simplified Chart Overlay Badges and Clean Offscreen Behavior', () => {
  const appJsCode = fs.readFileSync(appJsPath, 'utf8');

  // Elements mock
  const elements = new Map();
  const getOrCreate = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        innerHTML: '',
        style: { display: 'none', top: '' },
        className: '',
        textContent: '',
        classList: {
          contains: (cls) => (elements.get(id).className || '').includes(cls),
          add: (cls) => { elements.get(id).className = `${elements.get(id).className} ${cls}`.trim(); },
          remove: (cls) => { elements.get(id).className = (elements.get(id).className || '').replace(cls, '').trim(); },
        },
      });
    }
    return elements.get(id);
  };

  const candleSeriesMock = {
    priceToCoordinate: (price) => {
      // 100 -> Y 200. Visible range [0, 400]
      const y = 200 - (Number(price) - 100) * 5;
      return y;
    },
    coordinateToPrice: (y) => 100 + (200 - Number(y)) / 5,
  };

  const tvChartMock = {
    paneSize: () => ({ width: 360, height: 400 }),
    applyOptions: () => {},
  };

  const state = {
    chartOpen: true,
    activeInstrument: { globalId: 'NSE:RELIANCE:1', symbol: 'RELIANCE', tickSize: 0.05 },
    candles: [{ time: 1700000000, open: 100, high: 105, low: 95, close: 102 }],
    positionsData: {
      positions: [
        {
          id: 'pos-1',
          globalInstrumentId: 'NSE:RELIANCE:1',
          symbol: 'RELIANCE',
          quantity: 8,
          averageEntryPrice: 100,
          targetPrice: 120,
          stopLossPrice: 90,
          pnlMultiplier: 1,
          currentPrice: 98,
          currentLtpINR: 98,
        },
      ],
    },
    protectionDrag: null,
    showRiskRewardZones: false,
  };

  const ctx = vm.createContext({
    state,
    tvChart: tvChartMock,
    candleSeries: candleSeriesMock,
    document: {
      getElementById: (id) => getOrCreate(id),
      querySelectorAll: () => [],
    },
    window: {
      SikhoUX: { escape: (s) => String(s ?? '') },
      requestAnimationFrame: (cb) => { cb(); return 1; },
    },
    Math,
    Number,
    String,
    Boolean,
    Intl,
    fmtNum: (n) => Number(n).toFixed(2),
  });

  const extractFn = (name) => {
    const rx = new RegExp(`function\\s+${name}\\s*\\([\\s\\S]*?\\n  \\}`, 'm');
    const m = appJsCode.match(rx);
    if (!m) throw new Error(`Function ${name} not found in app.js`);
    vm.runInContext(m[0], ctx);
  };

  extractFn('calcPositionPnlAtPrice');
  extractFn('fmtCompactPnl');
  extractFn('calcRewardRiskRatio');
  extractFn('selectChartPosition');
  extractFn('updateChartPositionLivePnl');
  extractFn('alignPriceToTick');
  extractFn('getOpenPositionForInstrument');
  extractFn('getPositionById');
  extractFn('syncProtectionLinePositions');
  extractFn('renderChartProtectionOverlay');
  extractFn('previewChartProtectionDrag');
  extractFn('cancelChartProtectionDrag');

  // 1. Initial render with compact badges
  ctx.renderChartProtectionOverlay();
  const layer = getOrCreate('chart-protection-layer');
  const html = layer.innerHTML;

  // Entry badge: compact "8 qty · −₹16" (matching reference format: Qty and live P&L)
  assert.ok(html.includes('8 qty ·'), 'Entry badge must display compact quantity');
  assert.ok(html.includes('id="chart-prot-live-pnl"'), 'Must have chart-prot-live-pnl');

  // TP badge: compact "TP · +₹160"
  assert.ok(html.includes('TP · +₹160'), 'TP badge must be compact with estimated P&L');

  // SL badge: compact "SL · −₹80"
  assert.ok(html.includes('SL · −₹80'), 'SL badge must be compact with estimated P&L');

  // Verify no large PROFIT ZONE or RISK ZONE blocks in HTML by default
  assert.ok(!html.includes('data-prot-zone="TP"'), 'Reward zones must be disabled by default');
  assert.ok(!html.includes('data-prot-zone="SL"'), 'Risk zones must be disabled by default');

  // 2. Clean offscreen hiding (no boundary false lines)
  // When targetPrice is far away (e.g. 500 -> Y -1800, offscreen above)
  state.positionsData.positions[0].targetPrice = 500;
  ctx.renderChartProtectionOverlay();
  const tpLine = getOrCreate('prot-tp-line');
  assert.equal(tpLine.style.display, 'none', 'Offscreen levels must be cleanly hidden with display:none');

  // 3. Drag preview maintains confirmed level and separate preview
  state.positionsData.positions[0].targetPrice = 120;
  ctx.previewChartProtectionDrag('pos-1', 'TP', 125);
  const dragHtml = getOrCreate('chart-protection-layer').innerHTML;
  assert.ok(dragHtml.includes('data-prot-line="TP_SAVED"'), 'Confirmed TP line must remain intact');
  assert.ok(dragHtml.includes('data-prot-line="PREVIEW"'), 'Drag preview line must exist separately');
  assert.ok(dragHtml.includes('TP ₹125.00 · Est. +₹200'), 'Preview badge must show proposed price and outcome');

  // Cancel restores original confirmed level
  ctx.cancelChartProtectionDrag();
  const postCancelHtml = getOrCreate('chart-protection-layer').innerHTML;
  assert.ok(!postCancelHtml.includes('data-prot-line="PREVIEW"'), 'Preview line must be removed upon cancel');
  assert.ok(postCancelHtml.includes('data-prot-line="TP_SAVED"'), 'Authoritative TP level remains intact');
});
