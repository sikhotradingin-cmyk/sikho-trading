// Same-device/debug-build benchmark. Requires the isolated owner-device-harness and saved session.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const WebSocket = require('ws');
const adb = 'C:/Users/9823a/AppData/Local/Android/Sdk/platform-tools/adb.exe';
const device = 'emulator-5554';
const component = 'com.indianpapertrading.debug/com.indianpapertrading.MainActivity';
const call = (...args) => execFileSync(adb, ['-s', device, ...args], { encoding: 'utf8', timeout: 30000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function connect() {
  const pid = call('shell', 'pidof', 'com.indianpapertrading.debug').trim();
  call('forward', 'tcp:9222', `localabstract:webview_devtools_remote_${pid}`);
  for (let i = 0; i < 80; i++) {
    try {
      const tabs = await (await fetch('http://127.0.0.1:9222/json')).json();
      const tab = tabs.find(t => t.url === 'file:///android_asset/www/index.html');
      if (tab) {
        const ws = new WebSocket(tab.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
        let seq = 0;
        return { close: () => ws.close(), evaluate: expression => new Promise((resolve, reject) => {
          const id = ++seq;
          const handler = raw => { const m = JSON.parse(raw); if (m.id !== id) return; ws.off('message', handler); if (m.result?.exceptionDetails) reject(Error(m.result.exceptionDetails.text)); else resolve(m.result?.result?.value); };
          ws.on('message', handler);
          ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
        }) };
      }
    } catch {}
    await sleep(50);
  }
  throw Error('DevTools did not become ready');
}
async function until(cdp, condition) {
  for (let i = 0; i < 300; i++) { if (await cdp.evaluate(condition)) return performance.now(); await sleep(25); }
  throw Error('Usable/data-ready condition timed out');
}
(async () => {
  const trials = [];
  for (let i = 0; i < 3; i++) {
    call('shell', 'am', 'force-stop', 'com.indianpapertrading.debug');
    const t = performance.now();
    const native = call('shell', 'am', 'start', '-W', '-n', component);
    const c = await connect();
    const shell = await until(c, "document.getElementById('screen-main')?.classList.contains('active')");
    const ready = await until(c, "document.querySelectorAll('#explore-stocks-list .instrument-row-white').length > 0");
    await c.evaluate(`window.__benchmarkFetch=window.fetch;window.fetch=async function(...args){const response=await window.__benchmarkFetch.apply(this,args);if(String(args[0]).includes('/market-data/candles?')){const read=response.json.bind(response);response.json=async()=>{const data=await read();window.__benchmarkHistoryReady=true;return data;};}return response;};true`);
    const charts = [];
    for (let open = 0; open < 2; open++) {
      await c.evaluate('window.__benchmarkHistoryReady=false; true');
      const chartStart = performance.now();
      await c.evaluate("TZApp.openChartByGlobalId('NSE:NIFTY 50:99926000'); true");
      const visible = await until(c, "document.getElementById('screen-chart').classList.contains('active') && document.querySelector('#tv-main-chart canvas') !== null");
      const data = await until(c, "window.__benchmarkHistoryReady && document.getElementById('chart-ohlc-legend').textContent.includes('O ') && !document.getElementById('chart-ohlc-legend').textContent.includes('—')");
      charts.push({ visibleMs: Math.round(visible - chartStart), dataReadyMs: Math.round(data - chartStart) });
      await c.evaluate('TZApp.closeChartWorkspace(); true');
    }
    call('shell', 'input', 'keyevent', 'KEYCODE_HOME');
    const warmStart = performance.now();
    call('shell', 'am', 'start', '-W', '-n', component);
    const warm = await until(c, "document.getElementById('screen-main').classList.contains('active')");
    trials.push({ coldNativeDisplayMs: Number(native.match(/TotalTime: (\d+)/)?.[1]), coldUsableMs: Math.round(shell - t), currentDataReadyMs: Math.round(ready - t), warmResumeMs: Math.round(warm - warmStart), charts });
    c.close();
  }
  const evidence = { device, buildType: 'debug', backend: 'isolated pg-mem / controlled quotes on same host', samples: 3, includesAdSdkWork: true, trials };
  fs.mkdirSync('evidence/polish', { recursive: true });
  fs.writeFileSync(`evidence/polish/${process.argv[2] || 'benchmark'}.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
})().catch(e => { console.error(e.message); process.exitCode = 1; });
