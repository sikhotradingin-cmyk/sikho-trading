// Debug-only DevTools driver. Does not enable or access release WebViews.
const fs = require('node:fs');
const WebSocket = require('ws');
(async () => {
  const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
  const target = targets.find(t => t.url === 'file:///android_asset/www/index.html');
  if (!target) throw Error('Debug Sikho WebView not found');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  let expression;
  if (process.argv[2] === 'session') {
    const sessions = JSON.parse(fs.readFileSync('C:/tmp/sikho-isolated-device-sessions.json', 'utf8'));
    const sessionLiteral = JSON.stringify(JSON.stringify(sessions[process.argv[3] || 'FREE']));
    expression = `if (JSON.parse(TradingzoneNative.getGoogleSignInDiagnostics()).packageName !== 'com.indianpapertrading.debug') throw Error('Refusing fixture injection into release'); TradingzoneNative.saveSession(${sessionLiteral}); location.reload(); 'isolated session restored through encrypted storage'`;
  } else expression = fs.readFileSync(process.argv[2], 'utf8');
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  const timeout = setTimeout(() => { ws.close(); console.error('Debug evaluation timed out'); process.exitCode = 1; }, 45000);
  ws.on('message', raw => {
    const msg = JSON.parse(raw);
    if (msg.id !== 1) return;
    clearTimeout(timeout);
    if (msg.error || msg.result?.exceptionDetails) { console.error(JSON.stringify(msg.error || msg.result.exceptionDetails)); process.exitCode = 1; }
    else console.log(JSON.stringify(msg.result?.result?.value ?? msg.result?.result?.description));
    ws.close();
  });
})().catch(e => { console.error(e.constructor.name, e.message); process.exitCode = 1; });
