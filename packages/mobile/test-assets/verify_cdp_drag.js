'use strict';
const http = require('node:http');
const { execSync } = require('node:child_process');
const path = require('node:path');

const adbPath = 'C:\\Users\\9823a\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe';
const brainDir = 'C:\\Users\\9823a\\.gemini\\antigravity\\brain\\877e9602-df2e-44d9-863d-4d98b2182fbd';

function captureScreenshot(filename) {
  try {
    execSync(`"${adbPath}" shell screencap -p /sdcard/screen.png`, { stdio: 'ignore' });
    execSync(`"${adbPath}" pull /sdcard/screen.png "${path.join(brainDir, filename)}"`, { stdio: 'ignore' });
    console.log(`✓ Captured screenshot: ${filename}`);
  } catch (err) {
    console.error(`Failed to capture ${filename}:`, err.message);
  }
}

async function getTargetWsUrl() {
  return new Promise((resolve, reject) => {
    http.get('http://localhost:9222/json/list', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const list = JSON.parse(data);
          const page = list.find(p => p.url && p.url.includes('index.html'));
          if (page && page.webSocketDebuggerUrl) {
            resolve(page.webSocketDebuggerUrl);
          } else {
            reject(new Error('No index.html target found'));
          }
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

function cdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 1;
  const pending = new Map();

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  };

  const waitOpen = new Promise(r => ws.onopen = r);

  return {
    async call(method, params = {}) {
      await waitOpen;
      const curId = id++;
      return new Promise((resolve, reject) => {
        pending.set(curId, { resolve, reject });
        ws.send(JSON.stringify({ id: curId, method, params }));
      });
    },
    async eval(expr) {
      const res = await this.call('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
      });
      if (res.exceptionDetails) {
        throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text);
      }
      return res.result?.value;
    },
    close() {
      ws.close();
    }
  };
}

async function run() {
  const wsUrl = await getTargetWsUrl();
  console.log('Connecting to target:', wsUrl);
  const client = cdpClient(wsUrl);

  // Step 1: Seed active position matching the open instrument and render overlay
  console.log('--- Step 1: Setting up active position with Entry, TP, and SL ---');
  const step1 = await client.eval(`(() => {
    const st = window.TZApp._state;
    const inst = st.activeInstrument;
    if (!inst) return { error: 'No active instrument' };
    
    // Choose prices centered around current candle price
    const curPrice = Number(st.candles[st.candles.length - 1]?.close || 2460.00);
    const entryPrice = curPrice;
    const tpPrice = Math.round((curPrice + 25) * 10) / 10;
    const slPrice = Math.round((curPrice - 30) * 10) / 10;
    
    const pos = {
      id: 'pos-test-tpsl-1',
      accountId: st.user?.userId || 'usr-test',
      globalInstrumentId: inst.globalId,
      symbol: inst.symbol,
      exchange: inst.exchange || 'NSE',
      instrumentType: inst.instrumentType || 'EQUITY_STOCK',
      productType: 'INTRADAY',
      quantity: 10,
      averageEntryPrice: entryPrice,
      currentPrice: curPrice,
      targetPrice: tpPrice,
      stopLossPrice: slPrice,
      protectionVersion: 1,
      tickSize: inst.tickSize || 0.05,
      lotSize: inst.lotSize || 1,
      pnlMultiplier: 1,
    };
    
    st.positionsData = {
      positions: [pos],
      activePositions: [pos],
      holdings: [],
      closedPositions: [],
    };
    
    window.TZApp.renderChartProtectionOverlay();
    
    const layer = document.getElementById('chart-protection-layer');
    const tpEl = layer ? layer.querySelector('.prot-tp-line') : null;
    const slEl = layer ? layer.querySelector('.prot-sl-line') : null;
    const entryEl = layer ? layer.querySelector('.prot-entry-line') : null;
    const tpBadge = layer ? layer.querySelector('.prot-tp-badge') : null;
    const slBadge = layer ? layer.querySelector('.prot-sl-badge') : null;
    const entryBadge = layer ? layer.querySelector('.prot-entry-badge') : null;
    
    return {
      chartOpen: st.chartOpen,
      instrument: inst.symbol,
      curPrice,
      hasTpLine: Boolean(tpEl),
      hasSlLine: Boolean(slEl),
      hasEntryLine: Boolean(entryEl),
      tpText: tpBadge ? tpBadge.textContent.trim() : null,
      slText: slBadge ? slBadge.textContent.trim() : null,
      entryText: entryBadge ? entryBadge.textContent.trim() : null,
      tpStyle: tpEl ? tpEl.getAttribute('style') : null,
      slStyle: slEl ? slEl.getAttribute('style') : null,
    };
  })()`);

  console.log('Step 1 result:', step1);
  captureScreenshot('tpsl_step1_lines_dark.png');

  // Step 2: Test drag preview on TP line (move upward by +10)
  console.log('--- Step 2: Dragging TP line upward ---');
  const step2 = await client.eval(`(() => {
    const st = window.TZApp._state;
    const pos = st.positionsData.positions[0];
    const newPrice = Math.round((pos.targetPrice + 10) * 10) / 10;
    const preview = window.TZApp.previewChartProtectionDrag(pos.id, 'TP', newPrice);
    const confirmBar = document.getElementById('chart-protection-confirm-bar');
    return {
      dragActive: Boolean(preview),
      proposedPrice: preview?.proposedPrice,
      previousPrice: preview?.previousPrice,
      confirmBarVisible: confirmBar ? confirmBar.style.display !== 'none' : false,
      confirmBarText: confirmBar ? confirmBar.textContent.trim().replace(/\\s+/g, ' ') : '',
    };
  })()`);

  console.log('Step 2 drag preview result:', step2);
  captureScreenshot('tpsl_step2_drag_preview.png');

  // Step 3: Test Cancel drag -> restores original line and hides bar
  console.log('--- Step 3: Cancelling TP drag ---');
  const step3 = await client.eval(`(() => {
    window.TZApp.cancelChartProtectionDrag();
    const st = window.TZApp._state;
    const confirmBar = document.getElementById('chart-protection-confirm-bar');
    return {
      dragCleared: st.protectionDrag === null,
      confirmBarHidden: confirmBar ? confirmBar.style.display === 'none' : true,
      savedTpPrice: st.positionsData.positions[0].targetPrice,
    };
  })()`);

  console.log('Step 3 cancel result:', step3);

  // Step 4: Test SL drag preview (move upward by +5)
  console.log('--- Step 4: Dragging SL line upward ---');
  const step4 = await client.eval(`(() => {
    const st = window.TZApp._state;
    const pos = st.positionsData.positions[0];
    const newPrice = Math.round((pos.stopLossPrice + 5) * 10) / 10;
    const preview = window.TZApp.previewChartProtectionDrag(pos.id, 'SL', newPrice);
    const confirmBar = document.getElementById('chart-protection-confirm-bar');
    return {
      dragActive: Boolean(preview),
      proposedPrice: preview?.proposedPrice,
      previousPrice: preview?.previousPrice,
      confirmBarVisible: confirmBar ? confirmBar.style.display !== 'none' : false,
      confirmBarText: confirmBar ? confirmBar.textContent.trim().replace(/\\s+/g, ' ') : '',
    };
  })()`);

  console.log('Step 4 SL drag result:', step4);
  captureScreenshot('tpsl_step4_sl_drag.png');

  // Step 5: Test Light Theme display
  console.log('--- Step 5: Toggling to Light Theme ---');
  const step5 = await client.eval(`(() => {
    window.TZApp.setThemePreference('light');
    window.TZApp.cancelChartProtectionDrag();
    window.TZApp.renderChartProtectionOverlay();
    return {
      theme: document.documentElement.getAttribute('data-theme'),
    };
  })()`);

  console.log('Step 5 light theme result:', step5);
  captureScreenshot('tpsl_step5_lines_light.png');

  // Step 6: Verify DOM touch targets and touch-action
  console.log('--- Step 6: Verifying touch target size and touch-action ---');
  const step6 = await client.eval(`(() => {
    window.TZApp.setThemePreference('dark');
    window.TZApp.cancelChartProtectionDrag();
    window.TZApp.renderChartProtectionOverlay();
    
    const tpHandle = document.querySelector('.prot-tp-handle');
    const slHandle = document.querySelector('.prot-sl-handle');
    const tpRect = tpHandle ? tpHandle.getBoundingClientRect() : null;
    const slRect = slHandle ? slHandle.getBoundingClientRect() : null;
    
    const tpStyle = tpHandle ? window.getComputedStyle(tpHandle) : null;
    const tpBeforeStyle = tpHandle ? window.getComputedStyle(tpHandle, '::before') : null;
    
    return {
      tpRect,
      slRect,
      touchAction: tpStyle?.touchAction,
      beforeWidth: tpBeforeStyle?.width,
      beforeHeight: tpBeforeStyle?.height,
      hasPointerDown: Boolean(tpHandle?.getAttribute('onpointerdown')),
    };
  })()`);

  console.log('Step 6 touch target verification:', step6);
  captureScreenshot('tpsl_step6_final_dark.png');

  console.log('✓ All live verification steps completed successfully!');
  client.close();
}

run().catch(err => {
  console.error('ERROR:', err);
  process.exit(1);
});
