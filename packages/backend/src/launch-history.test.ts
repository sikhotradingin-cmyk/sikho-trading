import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resolveAccessPolicy} from './monetization/access-policy.js';
import {EmulatedPostgresDatabase} from './db/database.js';
import {PostgresRepository} from './db/postgres-repository.js';
import {SimulationEngine} from './engine/simulation-engine.js';
import {readTradeHistory,historyBounds} from './history.js';
import {buildServer} from './server.js';
import {WebSocket} from 'ws';

test('launch access leaves Free billing intact, ads required, and Standard remains reversible',()=>{
  process.env.SIKHO_ACCESS_MODE='FREE_LAUNCH';assert.equal(resolveAccessPolicy('FREE').fullFeatureAccess,true);assert.equal(resolveAccessPolicy('FREE').adsRequired,true);assert.equal(resolveAccessPolicy('PRO').adsRequired,false);assert.equal(resolveAccessPolicy('FREE').capitalTier,'PRO');
  process.env.SIKHO_ACCESS_MODE='STANDARD';assert.equal(resolveAccessPolicy('FREE').fullFeatureAccess,false);assert.equal(resolveAccessPolicy('PRO').fullFeatureAccess,true);
});

test('pending execution context survives engine restart and preserves exact metadata and margin release',async()=>{
  const db=new EmulatedPostgresDatabase(),repo=new PostgresRepository(db),engine=new SimulationEngine(repo);
  const inst:any={globalId:'NSE:RESTORE:2',provider:'DEMO',exchange:'NSE',token:'2',symbol:'RESTORE',name:'Restore test',instrumentType:'EQUITY_STOCK',isTradable:true,lotSize:1,tickSize:.05};await repo.syncInstruments([inst]);const account=await repo.provisionInitialAccount('pending-restart');
  const quote:any={globalId:inst.globalId,ltp:100,bidPrice:100,askPrice:100,receiveTimestamp:Date.now(),providerTimestamp:Date.now(),source:'DEMO',isSimulated:true};
  const pending=await engine.submitOrder({accountId:account.id,globalInstrumentId:inst.globalId,side:'BUY',quantity:1,orderType:'LIMIT',requestedPrice:90,idempotencyKey:'pending-restored'},inst,quote,1000n,100n);assert.equal(pending.order.status,'PENDING');
  const restored=new SimulationEngine(repo);await restored.restorePendingOrders();await restored.cancelOrder(account.id,pending.order.id);assert.equal((await repo.getAccount(account.id))?.lockedMarginPaise,0n);
  const p2=await engine.submitOrder({accountId:account.id,globalInstrumentId:inst.globalId,side:'BUY',quantity:1,orderType:'LIMIT',requestedPrice:90,idempotencyKey:'fill-restored'},inst,quote,1000n,100n);const restored2=new SimulationEngine(repo);await restored2.restorePendingOrders();await restored2.onMarketTick({...quote,ltp:89,askPrice:89,bidPrice:89,providerTimestamp:Date.now()+1,receiveTimestamp:Date.now()});assert.equal((await repo.getOrders(account.id)).find(o=>o.id===p2.order.id)?.status,'EXECUTED');assert.equal((await repo.getPositions(account.id))[0].quantity,1);await db.close();
});

test('launch WSS requires authentication and Standard preserves exposure views and risk-reducing exits',async()=>{
  process.env.SIKHO_ACCESS_MODE='FREE_LAUNCH';const b=await buildServer(new EmulatedPostgresDatabase(),'DEMO');const address=await b.app.listen({port:0,host:'127.0.0.1'});let ws:WebSocket|undefined;
  try{const auth=(await b.app.inject({method:'POST',url:'/api/v1/auth/register',payload:{name:'Socket user',email:'socket-launch@example.test',password:'isolated-test-password'}})).json();const headers={authorization:'Bearer '+auth.token};const inst=(await b.provider.getInstruments()).find(i=>i.instrumentType==='EQUITY_STOCK')!;assert.ok(inst);
    b.provider.getQuote=async id=>({globalId:id,token:'1',ltp:100,open:100,high:100,low:100,close:99,bidPrice:100,askPrice:100,receiveTimestamp:Date.now(),providerTimestamp:Date.now(),source:'DEMO',isSimulated:true});
    assert.equal((await b.app.inject({url:'/api/v1/access'})).json().access.fullFeatureAccess,false);
    ws=new WebSocket(address.replace('http:','ws:')+'/ws');const messages:any[]=[];ws.on('message',raw=>messages.push(JSON.parse(raw.toString())));await new Promise<void>(resolve=>ws!.once('open',resolve));const delay=()=>new Promise(r=>setTimeout(r,100));
    ws.send(JSON.stringify({type:'SUBSCRIBE',symbols:[inst.globalId]}));await delay();assert.ok(messages.some(m=>m.type==='RESTRICTED_ACCESS'));
    ws.send(JSON.stringify({type:'AUTH',token:auth.token}));ws.send(JSON.stringify({type:'SUBSCRIBE',symbols:[inst.globalId]}));await delay();assert.ok(messages.some(m=>m.type==='AUTH_SUCCESS'&&m.access.fullFeatureAccess));assert.ok(messages.some(m=>m.type==='SUBSCRIBED'&&m.symbols.includes(inst.globalId)));
    const place=(side:string,key:string)=>b.app.inject({method:'POST',url:'/api/v1/orders/place',headers,payload:{globalInstrumentId:inst.globalId,side,quantity:1,orderType:'MARKET',idempotencyKey:key}});assert.equal((await place('BUY','launch-buy')).json().order.status,'EXECUTED');
    process.env.SIKHO_ACCESS_MODE='STANDARD';assert.equal((await place('BUY','standard-add')).statusCode,403);assert.equal((await b.app.inject({url:'/api/v1/market-data/quote?globalId='+encodeURIComponent(inst.globalId),headers})).statusCode,200);assert.equal((await place('SELL','standard-exit')).json().order.status,'EXECUTED');assert.equal((await b.billingService.resolveEntitlement(auth.user.userId)).tier,'FREE');
  }finally{ws?.terminate();process.env.SIKHO_ACCESS_MODE='STANDARD';await b.app.close();}
});
test('IST range boundaries are half-open and custom dates validated',()=>{
  const now=Date.parse('2026-11-17T00:10:00+05:30');const bounds=historyBounds({range:'TODAY'},now);
  assert.equal(bounds.from,Date.parse('2026-11-17T00:00:00+05:30'));assert.equal(bounds.to-bounds.from,86400000);assert.throws(()=>historyBounds({from:'bad',to:0}));
});
test('actual closing executions allocate entry costs, remain idempotent, isolated and survive resets',async()=>{
  const db=new EmulatedPostgresDatabase(),repo=new PostgresRepository(db),engine=new SimulationEngine(repo);
  const inst:any={globalId:'NSE:TEST:1',provider:'DEMO',exchange:'NSE',token:'1',symbol:'TEST',name:'Test',instrumentType:'EQUITY_STOCK',isTradable:true,lotSize:1,tickSize:.05};
  await repo.syncInstruments([inst]);const account=await repo.provisionInitialAccount('history-a');const other=await repo.provisionInitialAccount('history-b');
  let n=0;async function fill(side:'BUY'|'SELL',quantity:number,price:number,key?:string){return engine.submitOrder({accountId:account.id,globalInstrumentId:inst.globalId,side,quantity,orderType:'MARKET',idempotencyKey:key||'fill-'+(++n)},inst,{globalId:inst.globalId,token:'1',ltp:price,open:price,high:price,low:price,close:price,bidPrice:price,askPrice:price,providerTimestamp:Date.now(),receiveTimestamp:Date.now(),source:'DEMO',isSimulated:true} as any,0n,100n);}
  await fill('BUY',10,100);await fill('SELL',4,110,'partial-exit');await fill('SELL',6,90);
  let h=await readTradeHistory(db,account.id,{range:'TODAY',limit:1});assert.equal(h.total,2);assert.equal(h.trades.length,1);assert.equal(h.summary.grossPaise,'-2000');assert.equal(h.summary.chargesPaise,'300');assert.equal(h.summary.netPaise,'-2300');assert.equal(h.summary.wins,1);assert.equal(h.summary.losses,1);assert.equal(h.summary.winRatePct,50);
  await fill('SELL',4,110,'partial-exit');assert.equal((await readTradeHistory(db,account.id,{range:'TODAY'})).total,2);
  assert.equal((await readTradeHistory(db,other.id,{range:'TODAY'})).total,0);
  await repo.resetAccount(account.id,await repo.getPositions(account.id),new Map(),100000,'FREE');h=await readTradeHistory(db,account.id,{range:'TODAY'});assert.equal(h.total,2);assert.equal(h.summary.netPaise,'-2300');
  const engineAfterRestart=new SimulationEngine(repo);await engineAfterRestart.submitOrder({accountId:account.id,globalInstrumentId:inst.globalId,side:'BUY',quantity:1,orderType:'MARKET',idempotencyKey:'restart-fill'},inst,{globalId:inst.globalId,ltp:100,bidPrice:100,askPrice:100,receiveTimestamp:Date.now(),providerTimestamp:Date.now(),source:'DEMO',isSimulated:true} as any,0n,0n);assert.equal((await readTradeHistory(db,account.id,{range:'TODAY'})).total,2);await db.close();
});
test('legacy ledger realizes actual gross without fabricating entry or net details',async()=>{
  const db=new EmulatedPostgresDatabase(),repo=new PostgresRepository(db),account=await repo.provisionInitialAccount('legacy');
  await repo.applyTradeSettlement(account.id,12345n,100n,'older-exit','Existing real settlement');const h=await readTradeHistory(db,account.id,{range:'TODAY'});assert.equal(h.legacyRealizations.length,1);assert.equal(h.legacyRealizations[0].grossPaise,'12345');assert.equal(h.legacyRealizations[0].coverage,'LEGACY_ENTRY_DETAILS_UNAVAILABLE');await db.close();
});
test('ordinary registration stays Free while launch REST access and capital expand, Standard returns restrictions',async()=>{
  process.env.SIKHO_ACCESS_MODE='FREE_LAUNCH';const b=await buildServer(new EmulatedPostgresDatabase(),'DEMO');await b.app.ready();
  try{const r=await b.app.inject({method:'POST',url:'/api/v1/auth/register',payload:{name:'Launch Test',email:'launch-unpaid@example.test',password:'isolated-test-password'}});assert.equal(r.statusCode,200);const auth=r.json();assert.equal(auth.entitlement.tier,'FREE');assert.equal(auth.access.adsRequired,true);assert.equal(auth.access.fullFeatureAccess,true);const headers={authorization:'Bearer '+auth.token};
    assert.deepEqual((await b.app.inject({url:'/api/v1/watchlists',headers})).json().watchlists,[]);
    assert.equal((await b.app.inject({url:'/api/v1/access',headers})).json().access.accessMode,'FREE_LAUNCH');
    const reset=await b.app.inject({method:'POST',url:'/api/v1/account/reset',headers,payload:{startingCapitalINR:10000000}});assert.equal(reset.statusCode,200);
    assert.equal((await b.billingService.resolveEntitlement(auth.user.userId)).tier,'FREE');
    process.env.SIKHO_ACCESS_MODE='STANDARD';assert.equal((await b.app.inject({url:'/api/v1/access',headers})).json().access.fullFeatureAccess,false);
    assert.equal((await b.app.inject({method:'POST',url:'/api/v1/account/reset',headers,payload:{startingCapitalINR:10000000}})).statusCode,403);
  }finally{process.env.SIKHO_ACCESS_MODE='STANDARD';await b.app.close();}
});
