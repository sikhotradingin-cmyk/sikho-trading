const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'../android/app/src/main/assets/www/app.js'),'utf8');
function context(names,extra={}){const ast=ts.createSourceFile('app.js',src,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),c=vm.createContext({Boolean,Number,Intl,Date,state:{},...extra});function walk(n){if(ts.isFunctionDeclaration(n)&&names.includes(n.name?.text))vm.runInContext(n.getText(ast),c);ts.forEachChild(n,walk)}walk(ast);return c;}
test('Free Launch grants feature access without changing verified Free ad policy',()=>{
  const calls=[],state={token:'isolated',user:{userId:'free',tier:'FREE'},subscription:{tier:'FREE'},entitlementResolved:true,access:{fullFeatureAccess:true,accessMode:'FREE_LAUNCH',adsRequired:true}};
  const c=context(['hasFullFeatureAccess','isProUser','notifyNativeUserTier'],{state,window:{TradingzoneNative:{updateUserTier:(...args)=>calls.push(args)}}});
  assert.equal(c.hasFullFeatureAccess(),true);assert.equal(c.isProUser(),false);c.notifyNativeUserTier();assert.deepEqual(calls,[['FREE','free']]);state.user.tier='PRO';state.subscription.tier='PRO';state.access.adsRequired=false;c.notifyNativeUserTier();assert.deepEqual(calls[1],['PRO','free']);state.entitlementResolved=false;c.notifyNativeUserTier();assert.deepEqual(calls[2],['UNKNOWN','']);
});
test('missing previous close remains unavailable while genuine zero and signed moves remain accurate',()=>{
  const c=context(['calcChange','formatChangePct']);assert.equal(c.formatChangePct(null),'Unavailable');assert.equal(c.formatChangePct(0),'0.00%');assert.equal(c.formatChangePct(.001),'+<0.01%');assert.equal(c.formatChangePct(-.001),'−<0.01%');assert.equal(c.calcChange({ltp:100}).pct,null);assert.equal(c.calcChange({ltp:100,close:0,open:100}).pct,null);assert.equal(c.calcChange({ltp:100,close:100}).pct,0);assert.equal(c.calcChange({ltp:110,close:100}).sign,'+');assert.equal(c.calcChange({ltp:90,close:100}).pct,-10);
});
test('chart time formatting uses original epochs and formats IST exactly once',()=>{
  const state={activeTimeframe:'5m'},c=context(['formatChartTime'],{state});const time=Date.parse('2026-11-17T06:30:00Z')/1000;assert.match(c.formatChartTime(time),/12:00/);assert.match(c.formatChartTime(time,true),/17.*Nov.*2026.*12:00.*IST/);state.activeTimeframe='1D';assert.match(c.formatChartTime(time,true),/17.*Nov.*2026.*IST/);
});
