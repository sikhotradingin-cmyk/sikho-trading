const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');
const assets = path.join(__dirname, '../android/app/src/main/assets/www');
function identity() { const c = vm.createContext({ window: {} }); vm.runInContext(fs.readFileSync(path.join(assets, 'instrument-identity.js'), 'utf8'), c); return c.window.InstrumentIdentity; }
test('all requested issuer logos are bundled, authenticated by source/hash, and prefer ISIN', () => {
  const api = identity();
  const manifest = JSON.parse(fs.readFileSync(path.join(assets, 'logos/sources.json')));
  const crypto = require('node:crypto');
  for (const entry of manifest) {
    assert.match(entry.assetUrl, /^https:/);
    const bytes = fs.readFileSync(path.join(assets, 'logos', entry.file));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.sha256);
  }
  for (const symbol of ['AADHARHFC','HDFCBANK','ICICIBANK','SBIN','ITC','BAJFINANCE']) assert.match(api.resolveInstrumentSvgUri({symbol,instrumentType:'EQUITY_STOCK'},40), /^logos\//);
  assert.equal(api.resolveInstrumentSvgUri({symbol:'500180',isin:'INE040A01034',exchange:'BSE'},40), 'logos/HDFCBANK.png');
  assert.equal(api.resolveInstrumentSvgUri({symbol:'provider-format',underlying:'HDFCBANK',instrumentType:'OPTSTK'},40), 'logos/HDFCBANK.png');
  assert.match(api.resolveInstrumentSvgUri({symbol:'HDFCLIFE',instrumentType:'EQUITY_STOCK'},40), /^data:/);
  assert.match(api.resolveInstrumentSvgUri({symbol:'BAJAJFINSV',instrumentType:'EQUITY_STOCK'},40), /^data:/);
});
test('shared locked rows expose identity and one upgrade affordance without price nodes', () => {
  const c = vm.createContext({window:{},document:{addEventListener(){},querySelectorAll:()=>[]},MutationObserver:class{observe(){}},WeakMap,clearTimeout,setTimeout});
  vm.runInContext(fs.readFileSync(path.join(assets,'ux.js'),'utf8'),c);
  const html=c.window.SikhoUX.row({symbol:'SBIN',name:'State Bank of India',globalId:'NSE:SBIN:3045',exchange:'NSE'},{restricted:true,avatar:'<img />',price:'SECRET PRICE'});
  assert.ok(!html.includes('SECRET PRICE'));
  assert.ok(!html.includes('data-ltp-id'));
  assert.equal((html.match(/Upgrade →/g)||[]).length,1);
  assert.ok(html.includes('inst-details-row'));
  assert.ok(c.window.SikhoUX.escape('<"injected">').includes('&lt;'));
});
function apiHarness(fetch) {
  const source=fs.readFileSync(path.join(assets,'app.js'),'utf8');
  const ast=ts.createSourceFile('app.js',source,99,true,1);
  const c=vm.createContext({state:{token:'old-session'},API_BASE:'http://isolated.test',fetch,AbortController,DOMException,setTimeout,clearTimeout,signOut:()=>{c.signedOut=true;},Object,Error});
  function visit(n){if(ts.isFunctionDeclaration(n)&&n.name?.text==='apiFetch')vm.runInContext(n.getText(ast),c);ts.forEachChild(n,visit);}visit(ast);return c;
}
test('superseded requests report AbortError and do not sign out', async()=>{
  const c=apiHarness((_url,opts)=>new Promise((_r,reject)=>opts.signal.addEventListener('abort',()=>reject(new DOMException('cancelled','AbortError')))));
  const controller=new AbortController();const request=c.apiFetch('/api/v1/instruments',{signal:controller.signal});controller.abort();
  await assert.rejects(request,{name:'AbortError'});assert.equal(c.signedOut,undefined);
});
test('an old account 401 cannot clear the newly switched account session', async()=>{
  let resolve;const c=apiHarness(()=>new Promise(r=>resolve=r));const pending=c.apiFetch('/api/v1/account');c.state.token='new-session';resolve({status:401,ok:false,json:async()=>({error:'expired'})});
  await assert.rejects(pending);assert.equal(c.signedOut,undefined);assert.equal(c.state.token,'new-session');
});
