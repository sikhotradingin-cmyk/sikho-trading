import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const appJsPath = path.resolve(__dirname, '../android/app/src/main/assets/www/app.js');
const stylesCssPath = path.resolve(__dirname, '../android/app/src/main/assets/www/styles.css');

test('TASK 1 & 2: Correct P&L Calculations & Formatting across Instruments and Sides', () => {
  const appJsCode = fs.readFileSync(appJsPath, 'utf8');

  // Extract calculation functions
  const ctx = vm.createContext({
    Math,
    Number,
    String,
    Boolean,
    Intl,
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

  // 1. Prompt Example 1: LONG entry at ₹100 with 65 units
  const longPos = {
    quantity: 65,
    averageEntryPrice: 100,
    pnlMultiplier: 1,
  };

  // Target Profit at ₹120 -> +₹1,300
  const tpPnl = ctx.calcPositionPnlAtPrice(longPos, 120);
  assert.equal(tpPnl.grossPnl, 1300);
  assert.equal(tpPnl.isProfit, true);
  assert.equal(tpPnl.formatted, '+₹1,300');

  // Stop Loss at ₹90 -> -₹650
  const slPnl = ctx.calcPositionPnlAtPrice(longPos, 90);
  assert.equal(slPnl.grossPnl, -650);
  assert.equal(slPnl.isProfit, false);
  assert.equal(slPnl.formatted, '−₹650');

  // Profit-protecting Stop Loss trailed to ₹105 -> +₹325
  const profitSl = ctx.calcPositionPnlAtPrice(longPos, 105);
  assert.equal(profitSl.grossPnl, 325);
  assert.equal(profitSl.isProfit, true);
  assert.equal(profitSl.formatted, '+₹325');

  // 2. SHORT position: Entry at ₹200 with 50 units
  const shortPos = {
    quantity: -50,
    averageEntryPrice: 200,
    pnlMultiplier: 1,
  };

  // Target at ₹180 -> +₹1,000 profit
  const shortTp = ctx.calcPositionPnlAtPrice(shortPos, 180);
  assert.equal(shortTp.grossPnl, 1000);
  assert.equal(shortTp.isProfit, true);
  assert.equal(shortTp.formatted, '+₹1,000');

  // Stop Loss at ₹215 -> -₹750
  const shortSl = ctx.calcPositionPnlAtPrice(shortPos, 215);
  assert.equal(shortSl.grossPnl, -750);
  assert.equal(shortSl.isProfit, false);
  assert.equal(shortSl.formatted, '−₹750');

  // Profit-protecting Stop Loss for short trailed to ₹195 -> +₹250
  const shortProfitSl = ctx.calcPositionPnlAtPrice(shortPos, 195);
  assert.equal(shortProfitSl.grossPnl, 250);
  assert.equal(shortProfitSl.isProfit, true);
  assert.equal(shortProfitSl.formatted, '+₹250');

  // 3. Commodity / contract with pnlMultiplier
  const goldPos = {
    quantity: 1,
    averageEntryPrice: 75000,
    pnlMultiplier: 0.1, // quotation unit conversion
  };
  const goldTp = ctx.calcPositionPnlAtPrice(goldPos, 76000);
  assert.equal(goldTp.grossPnl, 100);
  assert.equal(goldTp.formatted, '+₹100');

  // 4. Reward-to-Risk ratio calculations
  // Long: Entry 100, TP 120 (Reward 20), SL 90 (Risk 10) -> 1:2.0
  const rr = ctx.calcRewardRiskRatio(100, 120, 90, true);
  assert.equal(rr, '1:2.0');

  // Short: Entry 200, TP 180 (Reward 20), SL 210 (Risk 10) -> 1:2.0
  const rrShort = ctx.calcRewardRiskRatio(200, 180, 210, false);
  assert.equal(rrShort, '1:2.0');

  // Profit-protecting Stop Loss: Long Entry 100, TP 120, SL 105 -> Risk is negative (-5)
  // Must return null to avoid misleading ratio
  const rrProtecting = ctx.calcRewardRiskRatio(100, 120, 105, true);
  assert.equal(rrProtecting, null, 'Profit-protecting SL must return null for R:R');

  // Missing level: Target or SL missing
  assert.equal(ctx.calcRewardRiskRatio(100, 120, null, true), null);
  assert.equal(ctx.calcRewardRiskRatio(100, null, 90, true), null);
});

test('TASK 3 & 4: Overlay Markup, Subtle Zones, and Live Drag Preview', () => {
  const appJsCode = fs.readFileSync(appJsPath, 'utf8');

  // Setup DOM mock and VM environment
  const elements = new Map();
  const getOrCreate = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        innerHTML: '',
        style: { display: 'none' },
        className: '',
        textContent: '',
        classList: {
          contains: () => false,
          add: () => {},
          remove: () => {},
        },
      });
    }
    return elements.get(id);
  };

  const candleSeriesMock = {
    priceToCoordinate: (price) => {
      // Linear mapping: price 100 -> Y 200, price 120 -> Y 100, price 90 -> Y 250
      return 200 - (Number(price) - 100) * 5;
    },
    coordinateToPrice: (y) => {
      return 100 + (200 - Number(y)) / 5;
    },
  };

  const tvChartMock = {
    paneSize: () => ({ width: 360, height: 400 }),
    applyOptions: () => {},
  };

  const state = {
    chartOpen: true,
    activeInstrument: { globalId: 'NSE:INFY:1', symbol: 'INFY', tickSize: 0.05 },
    candles: [{ time: 1700000000, open: 99, high: 101, low: 98, close: 100 }],
    positionsData: {
      positions: [
        {
          id: 'pos-1',
          globalInstrumentId: 'NSE:INFY:1',
          symbol: 'INFY',
          quantity: 65,
          averageEntryPrice: 100,
          targetPrice: 120,
          stopLossPrice: 90,
          pnlMultiplier: 1,
          currentPrice: 102,
          currentLtpINR: 102,
        },
      ],
    },
    protectionDrag: null,
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

  // 1. Initial render of the compact levels
  ctx.renderChartProtectionOverlay();
  const layer = getOrCreate('chart-protection-layer');
  const html = layer.innerHTML;

  // Entry reference line with compact quantity and live unrealized P&L
  assert.ok(html.includes('data-prot-line="ENTRY"'), 'Entry line must exist');
  assert.ok(html.includes('65 qty ·'), 'Entry badge must show compact quantity');
  assert.ok(html.includes('id="chart-prot-live-pnl"'), 'Live P&L span with chart-prot-live-pnl must exist');

  // TP line with compact outcome badge (e.g. "TP · +₹1,300")
  assert.ok(html.includes('data-prot-line="TP_SAVED"'), 'Take Profit line must exist');
  assert.ok(html.includes('TP · +₹1,300'), 'TP badge must show compact outcome');

  // SL line with compact outcome badge (e.g. "SL · −₹650")
  assert.ok(html.includes('data-prot-line="SL_SAVED"'), 'Stop Loss line must exist');
  assert.ok(html.includes('SL · −₹650'), 'SL badge must show compact outcome');

  // 2. Drag TP to ₹125 preview
  ctx.previewChartProtectionDrag('pos-1', 'TP', 125.02);
  const dragHtml = getOrCreate('chart-protection-layer').innerHTML;
  assert.ok(dragHtml.includes('data-prot-line="PREVIEW"'), 'Drag preview line must exist');
  assert.ok(dragHtml.includes('TP ₹125.00 · Est. +₹1,625'), 'Drag preview badge must show live estimated outcome');

  // Confirmation bar displays proposed outcome
  const confirmBar = getOrCreate('chart-protection-confirm-bar');
  assert.equal(confirmBar.style.display, 'flex');
  assert.ok(confirmBar.innerHTML.includes('Update TP:'));
  assert.ok(confirmBar.innerHTML.includes('120.00'));
  assert.ok(confirmBar.innerHTML.includes('125.00'));
  assert.ok(confirmBar.innerHTML.includes('+₹1,625'));

  // Cancel restores saved levels
  ctx.cancelChartProtectionDrag();
  assert.equal(confirmBar.style.display, 'none');

  // 3. Profit-protecting Stop Loss trailed to ₹105
  state.positionsData.positions[0].stopLossPrice = 105;
  ctx.renderChartProtectionOverlay();
  const protSlHtml = getOrCreate('chart-protection-layer').innerHTML;
  assert.ok(protSlHtml.includes('SL · +₹325'), 'Profit-protecting SL must display positive estimate');
  assert.ok(protSlHtml.includes('is-profit-protecting'), 'Profit-protecting SL must have is-profit-protecting class');
  assert.ok(!protSlHtml.includes('R:R'), 'Profit-protecting SL must not show misleading R:R ratio');

  // 4. Live Tick update
  ctx.updateChartPositionLivePnl(108);
  const livePnlSpan = getOrCreate('chart-prot-live-pnl');
  assert.equal(livePnlSpan.textContent, '+₹520');
  assert.ok(livePnlSpan.className.includes('is-pos'));
});

test('TASK 5: Multi-Position Support and Theme CSS', () => {
  const css = fs.readFileSync(stylesCssPath, 'utf8');

  // Check CSS styles for subtle zones and themes
  assert.ok(css.includes('.prot-zone'), 'CSS must define .prot-zone');
  assert.ok(css.includes('.prot-zone.is-profit'), 'CSS must define .prot-zone.is-profit');
  assert.ok(css.includes('.prot-zone.is-loss'), 'CSS must define .prot-zone.is-loss');
  assert.ok(css.includes('[data-theme="dark"] .prot-zone.is-profit'), 'CSS must define dark mode .prot-zone.is-profit');
  assert.ok(css.includes('.prot-drag-handle.is-sl.is-profit-protecting'), 'CSS must define .is-profit-protecting');
  assert.ok(css.includes('.prot-badge-rr'), 'CSS must define .prot-badge-rr');
  assert.ok(css.includes('.prot-pos-selector'), 'CSS must define .prot-pos-selector for multi-positions');
  assert.ok(css.includes('.prot-pos-pill.is-selected'), 'CSS must define .prot-pos-pill.is-selected');

  // Check invisible mobile touch target of at least 44px
  assert.ok(css.includes('min-height: 44px;'), 'Touch handle must have min 44px invisible touch target');
  assert.ok(css.includes('min-width: 44px;'), 'Touch handle must have min 44px invisible touch target');
});
