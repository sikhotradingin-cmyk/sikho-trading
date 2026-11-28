(function(){
  'use strict';
  const esc=s=>window.SikhoUX?.escape ? window.SikhoUX.escape(s) : String(s ?? '');
  const money=p=>p===null||p===undefined?'Unavailable':(Number(p)<0?'−₹':'₹')+(Math.abs(Number(p))/100).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});
  const price=p=>p===null||p===undefined||!Number.isFinite(Number(p))?'Unavailable':'₹'+Number(p).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});
  const date=t=>t?new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',dateStyle:'medium',timeStyle:'short'}).format(Number(t))+' IST':'Unavailable';
  let fetcher,seq=0,lastData=null,ordersSeq=0,legacyOffset=0,currentOrderStatus='ALL';
  const ranges='<option value="TODAY">Today</option><option value="WEEK" selected>Last 7 Days</option><option value="MONTH">Last 30 Days</option><option value="CUSTOM">Custom (within 30 days)</option>';
  function filters(prefix){return `<div class="history-filters"><label>Period <select id="${prefix}-range">${ranges}</select></label><label class="history-custom-field" hidden>From (IST)<input id="${prefix}-from" type="date" aria-label="From date in IST"></label><label class="history-custom-field" hidden>Through (IST)<input id="${prefix}-to" type="date" aria-label="Through date in IST"></label><button id="${prefix}-apply" class="row-retry">Apply</button></div>`;}
  function query(prefix){
    const rangeEl=document.getElementById(prefix+'-range');
    const range=rangeEl ? rangeEl.value : 'WEEK';
    let q='range='+encodeURIComponent(range);
    if(range==='CUSTOM'){
      const fromVal=document.getElementById(prefix+'-from')?.value;
      const toVal=document.getElementById(prefix+'-to')?.value;
      const from=Date.parse(fromVal+'T00:00:00+05:30');
      const to=Date.parse(toVal+'T00:00:00+05:30')+86400000;
      if(!Number.isFinite(from)||!Number.isFinite(to)||to<=from)throw Error('Choose a valid IST date range within the last 30 days.');
      const minCutoff=Date.now()-(30*86400000);
      const clampedFrom=Math.max(from,minCutoff);
      q+='&from='+clampedFrom+'&to='+to;
    }
    return q;
  }
  function initialize(){
    const box=document.getElementById('tab-history');
    if(!box||box.dataset.ready)return;
    box.dataset.ready='true';
    box.innerHTML=`
      <div class="history-heading">
        <h2>Trade history</h2>
        <p>Realized exits, separate from open positions and order status.</p>
      </div>
      ${filters('history')}
      <label class="history-session">Practice session <select id="history-session"><option value="">All sessions</option></select></label>
      <div id="history-summary" role="status"></div>
      <div id="history-trades"></div>
      <button id="history-more" class="row-retry" hidden>More closed trades</button>
      <div id="history-legacy"></div>
      <button id="history-legacy-more" class="row-retry" hidden>More older settlements</button>
    `;
    document.getElementById('history-apply').onclick=()=>show(fetcher);
    document.getElementById('history-session').onchange=()=>show(fetcher);
    document.getElementById('history-more').onclick=()=>load(lastData?.nextOffset||0,true);
    document.getElementById('history-legacy-more').onclick=()=>load(0,false,true);
  }
  function card(t){
    const inst=t.instrument||{};
    const sym=inst.symbol||t.globalInstrumentId.split(':')[1]||t.globalInstrumentId;
    const exch=inst.exchange||t.globalInstrumentId.split(':')[0]||'NSE';
    const subParts=[
      exch,
      inst.expiry ? 'Exp ' + inst.expiry : '',
      inst.strikePrice ? 'Strike ₹' + inst.strikePrice + (inst.optionType ? ' ' + inst.optionType : '') : (inst.instrumentType?.startsWith('FUT') ? 'FUT' : ''),
      inst.lotSize ? 'Lot ' + inst.lotSize : ''
    ].filter(Boolean).join(' · ');
    const isNetPos=Number(t.netPaise)>=0;
    const relatedIds=[...(t.entryOrderIds||[]),t.exitOrderId].filter(Boolean);

    return `<article class="history-card">
      <div class="history-card-top">
        <div class="history-card-heading">
          <strong class="history-card-sym" style="word-break:break-word;white-space:normal;">${esc(sym)}</strong>
          <span class="history-card-exch">${esc(exch)}</span>
        </div>
        <span class="history-net ${isNetPos?'is-pos':'is-neg'}">${money(t.netPaise)}</span>
      </div>
      ${subParts ? `<div class="history-card-sub">${esc(subParts)}</div>` : ''}
      <div class="history-card-summary-line">
        <span class="history-side-tag is-${esc(t.side).toLowerCase()}">${esc(t.side)}</span>
        <span>${esc(t.quantity)} units</span>
        <span>Entry ${price(t.entryPrice)} → Exit ${price(t.exitPrice)}</span>
        <span class="history-time">${date(t.exitTimestamp)}</span>
      </div>
      <details class="history-card-details">
        <summary class="btn-card-details">Details</summary>
        <div class="history-details-content">
          <dl>
            <dt>Entry</dt><dd>${price(t.entryPrice)} · ${date(t.entryTimestamp)}</dd>
            <dt>Exit</dt><dd>${price(t.exitPrice)} · ${date(t.exitTimestamp)}</dd>
            <dt>Gross P&L</dt><dd>${money(t.grossPaise)}</dd>
            <dt>Allocated charges</dt><dd>${money(t.chargesPaise)}</dd>
            <dt>Net P&L</dt><dd class="${isNetPos?'is-pos':'is-neg'}">${money(t.netPaise)}</dd>
          </dl>
          <p class="history-coverage-note">${esc(t.coverage==='COMPLETE'?'Actual fills · weighted average cost':'Historical entry cost unavailable; net result is not inferred.')}</p>
          ${relatedIds.length ? `<div class="history-order-links">${relatedIds.map(id=>`<button type="button" class="history-order-link" data-history-order="${esc(id)}">Order ${esc(id.slice(0,8))}…</button>`).join('')}</div>` : ''}
        </div>
      </details>
    </article>`;
  }
  async function load(offset=0,append=false,moreLegacy=false){
    const current=++seq;
    try{
      if(!append&&!moreLegacy)document.getElementById('history-summary').textContent='Loading trade history…';
      const session=document.getElementById('history-session').value;
      const data=await fetcher('/api/v1/history?'+query('history')+'&offset='+offset+'&legacyOffset='+(moreLegacy?legacyOffset:0)+(session?'&sessionId='+encodeURIComponent(session):''));
      if(current!==seq)return;
      lastData=data;
      const s=data.summary;
      const ls=data.lifetimeSummary;
      const notice=data.retentionNotice || 'Trade history is retained for 30 days.';

      document.getElementById('history-summary').innerHTML=`
        <div class="history-retention-notice history-retention-banner"><span class="history-retention-icon">ℹ️</span> ${esc(notice)}</div>
        <div class="history-summary-grid">
          <div><b>${s.closedTrades}</b> closed exits${data.legacyTotal?' + '+data.legacyTotal+' older settlements':''}</div>
          <div><b>${s.wins} / ${s.losses} / ${s.breakeven}</b> win / loss / flat</div>
          <div><b>${s.winRatePct===null?'—':s.winRatePct.toFixed(1)+'%'}</b> win rate</div>
          <div><b>${money(s.grossPaise)}</b> gross P&L</div>
          <div><b>${money(s.chargesPaise)}</b> charges</div>
          <div><b>${money(s.netPaise)}</b> net P&L</div>
        </div>
        ${ls ? `<div class="history-lifetime-stat"><span>Lifetime (retained + archived):</span> <b>${ls.closedTrades} exits</b> · <b>${money(ls.netPaise)}</b></div>` : ''}
        <details class="history-method"><summary>How results are calculated</summary><p class="history-note">${esc(data.methodology)}${s.unknownCostTrades?' '+s.unknownCostTrades+' exit(s) have unavailable entry costs.':''}</p></details>
        <p class="history-order-counts">Cancelled orders: ${s.orderCounts?.CANCELLED||0} · Rejected: ${s.orderCounts?.REJECTED||0}</p>
      `;

      if(!moreLegacy){
        const html=data.trades.map(card).join('')||'<div class="list-state">No closed trades in this period.</div>';
        const tradesBox=document.getElementById('history-trades');
        if(tradesBox){
          if(append)tradesBox.insertAdjacentHTML('beforeend',html);
          else tradesBox.innerHTML=html;
        }
      }
      const legacy=data.legacyRealizations.map(t=>`<article class="history-card"><strong>Older recorded settlement</strong><p>${date(t.exitTimestamp)} · Gross ${money(t.grossPaise)}</p><p>${esc(t.note)}. Entry details, allocated charges and net P&L are unavailable.</p>${t.exitOrderId?`<button data-history-order="${esc(t.exitOrderId)}">View recorded exit order</button>`:''}</article>`).join('');
      const legacyBox=document.getElementById('history-legacy');
      if(legacyBox){
        if(moreLegacy)legacyBox.insertAdjacentHTML('beforeend',legacy);
        else legacyBox.innerHTML=(legacy?'<h3>Older ledger settlements</h3><p>'+esc(data.legacyNote)+' '+data.legacyTotal+' recorded settlements · Gross '+money(data.legacyGrossPaise)+'</p>':'')+legacy;
      }
      legacyOffset=data.nextLegacyOffset||0;
      document.getElementById('history-legacy-more').hidden=!data.nextLegacyOffset;
      document.getElementById('history-more').hidden=data.nextOffset===null;
    }catch(e){
      if(current===seq)document.getElementById('history-summary').textContent=e.message||'History unavailable. Tap Apply to retry.';
    }
  }
  async function show(api){
    fetcher=api;
    initialize();
    await load();
    try{
      const sessionSeq=seq;
      const r=await api('/api/v1/history/sessions');
      if(sessionSeq!==seq)return;
      const select=document.getElementById('history-session');
      if(!select)return;
      const value=select.value;
      select.innerHTML='<option value="">All sessions</option>'+r.sessions.map(s=>`<option value="${esc(s.id)}">${date(s.startedAt)}${s.isActive?' · Active':''}</option>`).join('');
      select.value=value;
    }catch{}
  }
  async function showOrders(api,status='ALL',offset=0,append=false){
    fetcher=api;
    currentOrderStatus=status;
    const box=document.getElementById('orders-list-container');
    if(!box)return;
    if(!document.getElementById('order-range')){
      box.innerHTML=filters('order')+'<div id="order-page"></div><button id="order-more" class="row-retry" hidden>More orders</button>';
      document.getElementById('order-apply').onclick=()=>showOrders(api,currentOrderStatus);
    }
    if(status==='PENDING'){
      const rEl=document.getElementById('order-range');
      if(rEl)rEl.value='WEEK';
      document.querySelectorAll('#orders-list-container .history-custom-field').forEach(n=>n.hidden=true);
    }
    const n=++ordersSeq;
    try{
      const r=await api('/api/v1/orders/page?'+query('order')+'&status='+status+'&offset='+offset);
      if(n!==ordersSeq)return;
      const counts=r.counts||{};
      const summary='<p class="history-note">Executed '+(counts.EXECUTED||0)+' · Pending '+(counts.PENDING||0)+' · Cancelled '+(counts.CANCELLED||0)+' · Rejected '+(counts.REJECTED||0)+'. Partial fills: 0 (full-order fills supported).</p>';
      const html=r.orders.map(o=>{
        const sym = o.symbol || (o.instrument && o.instrument.symbol) || o.globalInstrumentId.split(':')[1] || o.globalInstrumentId;
        const exch = (o.instrument && o.instrument.exchange) || o.globalInstrumentId.split(':')[0] || 'NSE';
        const subParts = [
          exch,
          o.instrument?.expiry ? 'Exp ' + o.instrument.expiry : '',
          o.instrument?.strikePrice ? 'Strike ₹' + o.instrument.strikePrice + (o.instrument.optionType ? ' ' + o.instrument.optionType : '') : (o.instrument?.instrumentType?.startsWith('FUT') ? 'FUT' : ''),
          o.productType || ''
        ].filter(Boolean).join(' · ');

        const orderTypeStr = (o.orderType || o.order_type || 'MARKET').toUpperCase();
        const isLinkedTp = orderTypeStr === 'TARGET' || o.source === 'CHART_DRAG_TP';
        const isLinkedSl = orderTypeStr === 'STOP_MARKET' || orderTypeStr === 'STOP_LOSS' || o.source === 'CHART_DRAG_SL';
        const hasCompanion = Boolean(o.oco_companion_order_id);

        let cleanReason = '';
        if (o.rejectionReason) {
          if (o.rejectionReason.startsWith('PROTECTION_UPDATED:')) cleanReason = 'TP/SL updated.';
          else if (o.rejectionReason.startsWith('OCO_COMPANION_FILLED:')) cleanReason = 'Companion order filled.';
          else if (o.rejectionReason.startsWith('MANUAL_CANCEL:')) cleanReason = 'Cancelled by user.';
          else if (o.rejectionReason.startsWith('POSITION_CLOSED:')) cleanReason = 'Position closed.';
          else cleanReason = o.rejectionReason.replace(/^[A-Z_]+:\s*/, '');
        }

        const statusCls = 'status-' + (o.status || 'PENDING').toLowerCase();
        const priceDisplay = Number(o.price) > 0 ? price(o.price) : (Number(o.triggerPrice || o.trigger_price) > 0 ? 'Trig ' + price(o.triggerPrice || o.trigger_price) : 'MKT');

        return `<article class="history-card order-card">
          <div class="history-card-top">
            <div class="history-card-heading">
              <strong class="history-card-sym" style="word-break:break-word;white-space:normal;">${esc(sym)}</strong>
              <span class="history-card-exch">${esc(exch)}</span>
              ${isLinkedTp ? '<span class="order-chip is-tp">Linked TP</span>' : (isLinkedSl ? '<span class="order-chip is-sl">Linked SL</span>' : (hasCompanion ? '<span class="order-chip is-oco">OCO</span>' : ''))}
            </div>
            <span class="order-status-badge ${statusCls}">${esc(o.status)}</span>
          </div>
          ${subParts ? `<div class="history-card-sub">${esc(subParts)}</div>` : ''}
          <div class="order-core-row">
            <span class="order-side ${o.side === 'BUY' ? 'is-buy' : 'is-sell'}">${esc(o.side)}</span>
            <span class="order-qty">${o.quantity} units</span>
            <span class="order-type-chip">${esc(orderTypeStr)}</span>
            <span class="order-price-val">${priceDisplay}</span>
            <span class="order-time">${date(o.createdAt || o.created_at)}</span>
          </div>
          ${cleanReason ? `<p class="order-reason-note">${esc(cleanReason)}</p>` : ''}
          <details class="history-card-details">
            <summary class="btn-card-details">Details</summary>
            <div class="order-details-content">
              <dl>
                <dt>Filled / Pending</dt><dd>${o.filledQuantity ?? 0} / ${o.pendingQuantity ?? o.quantity}</dd>
                ${o.executedPrice ? `<dt>Executed Price</dt><dd>${price(o.executedPrice)}</dd>` : ''}
                <dt>Placed</dt><dd>${date(o.createdAt || o.created_at)}</dd>
                ${o.updatedAt ? `<dt>Updated</dt><dd>${date(o.updatedAt || o.updated_at)}</dd>` : ''}
                ${o.executedAt ? `<dt>Executed</dt><dd>${date(o.executedAt || o.executed_at)}</dd>` : ''}
                <dt>Order ID</dt><dd class="order-id-code">${esc(o.id)}</dd>
              </dl>
              <button type="button" class="history-order-link" data-history-order="${esc(o.id)}">View fills & audit</button>
            </div>
          </details>
          ${o.status === 'PENDING' ? `<button type="button" class="btn-card-cancel" onclick="window.TZApp.cancelPendingOrder('${esc(o.id)}')">Cancel</button>` : ''}
        </article>`;
      }).join('') || '<div class="list-state">No orders in this period.</div>';

      const page=document.getElementById('order-page');
      if(page){
        if(append)page.insertAdjacentHTML('beforeend',html);
        else page.innerHTML=summary+html;
      }
      const more=document.getElementById('order-more');
      if(more){
        more.hidden=r.nextOffset===null;
        more.onclick=()=>showOrders(api,status,r.nextOffset,true);
      }
    }catch(e){
      if(n===ordersSeq){
        const page=document.getElementById('order-page');
        if(page)page.textContent=e.message;
      }
    }
  }
  document.addEventListener('change',e=>{
    if(e.target.matches('#history-range,#order-range')){
      const isCustom=e.target.value==='CUSTOM';
      e.target.closest('.history-filters').querySelectorAll('.history-custom-field').forEach(n=>{
        n.hidden=!isCustom;
        if(isCustom){
          const dInput=n.querySelector('input[type="date"]');
          if(dInput){
            const now=new Date();
            const past=new Date(now.getTime()-(30*86400000));
            dInput.max=now.toISOString().split('T')[0];
            dInput.min=past.toISOString().split('T')[0];
          }
        }
      });
    }
  });
  document.addEventListener('click',async e=>{
    const id=e.target.closest('[data-history-order]')?.dataset.historyOrder;
    if(!id||!fetcher)return;
    try{
      const d=await fetcher('/api/v1/history/orders/'+encodeURIComponent(id));
      let modal=document.getElementById('modal-history-detail');
      if(!modal){
        modal=document.createElement('div');
        modal.id='modal-history-detail';
        modal.className='modal-backdrop';
        document.body.appendChild(modal);
      }
      const o=d.order;
      modal.innerHTML=`<div class="white-bottom-sheet history-detail"><button class="row-retry" onclick="document.getElementById('modal-history-detail').classList.remove('active')">Close</button><h3>Order details</h3><p>${esc(o.global_instrument_id)}<br>${esc(o.status)} · ${esc(o.side)} · ${esc(o.quantity)} units</p><p class="order-id-code">${esc(o.id)}</p><p>Created ${date(o.created_at)}<br>Updated ${date(o.updated_at)}<br>Fill ${o.executed_price??'Unavailable'} at ${date(o.executed_at)}</p><p>${esc(o.rejection_reason||'')}</p><h4>Recorded fills</h4>${d.fills.length?d.fills.map(f=>'<p>'+esc(f.side)+' '+esc(f.quantity)+' @ '+esc(f.price)+' · Charges '+money(f.chargesPaise)+'</p>').join(''):'<p>Separate fill metadata unavailable for this older order. Recorded order values above remain authoritative.</p>'}</div>`;
      modal.classList.add('active');
      window.TradingzoneNative?.updateScreenState('history',true,false,false);
    }catch(error){
      window.SikhoUX?.notify?.(error.message);
    }
  });
  function clear(){
    seq++;ordersSeq++;lastData=null;fetcher=null;
    const box=document.getElementById('tab-history');
    if(box){box.innerHTML='';delete box.dataset.ready;}
    const orders=document.getElementById('orders-list-container');
    if(orders)orders.innerHTML='';
    document.getElementById('modal-history-detail')?.remove();
  }
  window.SikhoHistory={show,showOrders,clear};
})();
