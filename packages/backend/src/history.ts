import { IDatabase, IDatabaseClient } from './db/database.js';

/** One completed closing execution is one realized trade; scale-outs are distinct exits, never order updates. */
export async function recordExecutionHistory(db: IDatabaseClient, order: any, snapshot: any) {
  if(order.executionContext)await db.query('INSERT INTO order_execution_context (order_id,payload_json) VALUES ($1,$2) ON CONFLICT (order_id) DO NOTHING',[order.id,JSON.stringify(order.executionContext)]);
  if (!snapshot || order.status !== 'EXECUTED') return;
  const existing = await db.query('SELECT order_id FROM execution_history WHERE order_id=$1', [order.id]);
  if (existing.rows.length) return;
  const session = await db.query('SELECT active_session_id FROM virtual_accounts WHERE id=$1', [order.accountId]);
  const sessionId = session.rows[0]?.active_session_id || null;
  const key = order.accountId + ':' + order.globalInstrumentId;
  const stored = await db.query('SELECT payload_json FROM position_history_basis WHERE id=$1', [key]);
  let basis = stored.rows[0] ? JSON.parse(stored.rows[0].payload_json) : null;
  const prev = snapshot.previousQuantity;
  if (!basis || basis.quantity !== prev) basis = { quantity: prev, charges: '0', known: prev === 0, entryAt: null, orders: [] };
  const delta = order.side === 'BUY' ? order.quantity : -order.quantity;
  const charges = BigInt(order.estimatedChargesPaise);
  const opposite = prev && Math.sign(prev) !== Math.sign(delta);
  const closeQty = opposite ? Math.min(Math.abs(prev), order.quantity) : 0;
  const openingQty = order.quantity - closeQty;
  const exitCharges = charges * BigInt(closeQty) / BigInt(order.quantity);
  const entryAllocated = closeQty ? BigInt(basis.charges) * BigInt(closeQty) / BigInt(Math.abs(prev)) : 0n;
  if (closeQty) {
    const totalCharges = basis.known ? entryAllocated + exitCharges : null;
    const payload = { id: order.id, globalInstrumentId: order.globalInstrumentId, instrument: snapshot.instrument,
      side: prev > 0 ? 'LONG' : 'SHORT', quantity: closeQty, entryPrice: snapshot.averageEntryPrice,
      exitPrice: order.executedPrice, entryTimestamp: basis.entryAt, exitTimestamp: order.executedAt,
      entryOrderIds: basis.orders, exitOrderId: order.id, sessionId,
      grossPaise: String(snapshot.realizedPnlPaise), chargesPaise: totalCharges?.toString() ?? null,
      netPaise: totalCharges === null ? null : (BigInt(snapshot.realizedPnlPaise) - totalCharges).toString(),
      coverage: basis.known ? 'COMPLETE' : 'ENTRY_COST_UNAVAILABLE', method: 'WEIGHTED_AVERAGE_CLOSING_EXECUTION' };
    await db.query('INSERT INTO trade_closures (id,account_id,instrument_id,session_id,exited_at,gross_paise,charges_paise,payload_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [order.id,order.accountId,order.globalInstrumentId,sessionId,order.executedAt,payload.grossPaise,payload.chargesPaise,JSON.stringify(payload)]);
  }
  if (!prev || Math.sign(prev) !== Math.sign(snapshot.quantity)) {
    basis = {quantity:snapshot.quantity, charges:(charges-exitCharges).toString(),known:true,entryAt:order.executedAt,orders:openingQty ? [order.id] : []};
  } else {
    basis.quantity=snapshot.quantity; basis.charges=(BigInt(basis.charges)-entryAllocated+(openingQty ? charges-exitCharges : 0n)).toString();
    if(openingQty) basis.orders.push(order.id);
  }
  await db.query('INSERT INTO position_history_basis (id,account_id,payload_json) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET payload_json=$3', [key,order.accountId,JSON.stringify(basis)]);
  await db.query('INSERT INTO execution_history (order_id,account_id,instrument_id,session_id,executed_at,payload_json) VALUES ($1,$2,$3,$4,$5,$6)',
    [order.id,order.accountId,order.globalInstrumentId,sessionId,order.executedAt,JSON.stringify({orderId:order.id,quantity:order.quantity,price:order.executedPrice,side:order.side,chargesPaise:charges.toString(),instrument:snapshot.instrument})]);
}

export function historyBounds(q: any, now = Date.now()) {
  const day = 86400000, midnight = Math.floor((now+19800000)/day)*day-19800000;
  let from = q.range === 'ALL' ? 0 : q.range === 'TODAY' ? midnight : q.range === 'MONTH' ? Date.UTC(new Date(now+19800000).getUTCFullYear(),new Date(now+19800000).getUTCMonth(),1)-19800000 : midnight-6*day;
  let to=midnight+day;
  if(q.from !== undefined) from=Number(q.from); if(q.to !== undefined)to=Number(q.to);
  if(!Number.isFinite(from)||!Number.isFinite(to)||from<0||to<=from||to-from>(q.range==='ALL'?36600:3660)*day)throw Error('Invalid history range (maximum ten years).');
  return {from,to};
}

export async function readTradeHistory(db: IDatabase, accountId: string, q: any) {
  let {from,to}=historyBounds(q);
  if(q.sessionId){const session=await db.query('SELECT started_at,ended_at FROM practice_sessions WHERE account_id=$1 AND id=$2',[accountId,String(q.sessionId)]);if(!session.rows.length)throw Error('Practice session not found');from=Math.max(from,Number(session.rows[0].started_at));to=Math.min(to,Number(session.rows[0].ended_at||to));}
  const limit=Math.max(1,Math.min(100,Math.floor(Number(q.limit)||30))); const offset=Math.max(0,Math.min(1000000,Math.floor(Number(q.offset)||0)));
  const params:any[]=[accountId,from,to];
  const session=q.sessionId ? ' AND session_id=$4' : ''; if(q.sessionId)params.push(String(q.sessionId));
  const aggregate=await db.query(`SELECT COUNT(*) as count,SUM(gross_paise) as gross,SUM(charges_paise) as charges,
    SUM(CASE WHEN charges_paise IS NULL THEN 1 ELSE 0 END) as unknown,
    SUM(CASE WHEN charges_paise IS NOT NULL AND gross_paise > charges_paise THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN charges_paise IS NOT NULL AND gross_paise < charges_paise THEN 1 ELSE 0 END) as losses,
    SUM(CASE WHEN charges_paise IS NOT NULL AND gross_paise = charges_paise THEN 1 ELSE 0 END) as breakeven
    FROM trade_closures WHERE account_id=$1 AND exited_at >= $2 AND exited_at < $3${session}`,params);
  const page=await db.query(`SELECT payload_json FROM trade_closures WHERE account_id=$1 AND exited_at >= $2 AND exited_at < $3${session} ORDER BY exited_at DESC,id DESC LIMIT ${limit} OFFSET ${offset}`,params);
  const a=aggregate.rows[0];const total=Number(a.count),gross=BigInt(a.gross||0),charges=BigInt(a.charges||0),wins=Number(a.wins||0),losses=Number(a.losses||0),breakeven=Number(a.breakeven||0),unknown=Number(a.unknown||0);
  const orderCounts=await db.query('SELECT status,COUNT(*) as count FROM orders WHERE account_id=$1 AND created_at >= $2 AND created_at < $3 GROUP BY status',[accountId,from,to]);
  const legacyOffset=Math.max(0,Math.min(1000000,Math.floor(Number(q.legacyOffset)||0)));
  const legacyCount=await db.query("SELECT COUNT(*) as count,SUM(l.amount_paise) as gross FROM account_ledger_entries l LEFT JOIN trade_closures t ON t.id=l.reference_id WHERE l.account_id=$1 AND l.entry_type='TRADE_PNL' AND l.created_at >= $2 AND l.created_at < $3 AND t.id IS NULL",[accountId,from,to]);
  const legacy=await db.query("SELECT l.id,l.reference_id,l.amount_paise,l.created_at,l.note FROM account_ledger_entries l LEFT JOIN trade_closures t ON t.id=l.reference_id WHERE l.account_id=$1 AND l.entry_type='TRADE_PNL' AND l.created_at >= $2 AND l.created_at < $3 AND t.id IS NULL ORDER BY l.created_at DESC,l.id DESC LIMIT 30 OFFSET "+legacyOffset,[accountId,from,to]);
  return {from,to,timezone:'Asia/Kolkata',methodology:'One realized closing execution; partial reductions count once per executed exit order. Win rate is wins divided by known-cost exits including breakeven, using allocated entry and exit charges. Cancelled/rejected orders and capital resets are excluded.',
    trades:page.rows.map(r=>JSON.parse(r.payload_json)),total,nextOffset:offset+page.rows.length<total?offset+page.rows.length:null,
    summary:{closedTrades:total,wins,losses,breakeven,unknownCostTrades:unknown,winRatePct:wins+losses+breakeven?100*wins/(wins+losses+breakeven):null,grossPaise:(gross+BigInt(legacyCount.rows[0].gross||0)).toString(),chargesPaise:unknown||Number(legacyCount.rows[0].count)?null:charges.toString(),netPaise:unknown||Number(legacyCount.rows[0].count)?null:(gross-charges).toString(),legacySettlements:Number(legacyCount.rows[0].count),orderCounts:Object.fromEntries(orderCounts.rows.map(r=>[r.status,Number(r.count)]))},
    legacyTotal:Number(legacyCount.rows[0].count),legacyGrossPaise:String(legacyCount.rows[0].gross||0),nextLegacyOffset:legacyOffset+legacy.rows.length<Number(legacyCount.rows[0].count)?legacyOffset+legacy.rows.length:null,
    legacyRealizations:legacy.rows.map(r=>({id:r.id,exitOrderId:r.reference_id,grossPaise:String(r.amount_paise),exitTimestamp:Number(r.created_at),note:r.note,coverage:'LEGACY_ENTRY_DETAILS_UNAVAILABLE'})),legacyNote:'Older ledger settlements are shown separately. Entry/exit matches and allocated costs are not invented.'};
}
