(function () {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function row(inst, options) {
    const { restricted, avatar, price = '—', change = '', changeClass = '', showChain, search } = options;
    const symbol = inst.symbol || 'Instrument';
    const detail = [inst.expiry, inst.strikePrice, inst.optionType, inst.lotSize > 1 ? `Lot ${inst.lotSize}` : ''].filter(Boolean).join(' · ') || inst.name || symbol;
    return `<div class="instrument-row-white" role="button" tabindex="0" data-row-id="${escape(inst.globalId)}" data-row-symbol="${escape(symbol)}" data-row-underlying="${escape(inst.underlying || symbol)}" data-row-locked="${!!restricted}" data-row-search="${!!search}" aria-label="${escape(`${symbol}, ${inst.name || ''}, ${inst.exchange || ''}${restricted ? ', Premium, upgrade to access' : ''}`)}">
      <div class="inst-left">${avatar}<div class="inst-meta"><div class="inst-symbol-row"><span class="inst-symbol" title="${escape(symbol)}">${escape(symbol)}</span></div><div class="inst-details-row"><span class="tag-exch">${escape(inst.exchange || 'NSE')}</span><span class="inst-name-sub" title="${escape(detail)}">${escape(detail)}</span></div></div></div>
      <div class="inst-right">${restricted ? '<span class="row-access"><span aria-hidden="true">🔒</span> Premium<span class="row-access-sub">Upgrade →</span></span>' : `<div class="inst-price-col"><span class="inst-ltp-val" data-ltp-id="${escape(inst.globalId)}">${escape(price)}</span><span class="inst-chg-val ${escape(changeClass)}" data-chg-id="${escape(inst.globalId)}">${escape(change)}</span></div>`}${search && !restricted ? '<button class="row-action" data-row-action="add" aria-label="Add to watchlist">+</button>' : showChain && !restricted ? '<button class="row-action" data-row-action="chain" aria-label="Open option chain">⋯</button>' : ''}</div></div>`;
  }
  function activate(event) {
    const item = event.target.closest('[data-row-id]');
    if (!item || !window.TZApp) return;
    const action = event.target.closest('[data-row-action]')?.dataset.rowAction;
    if (action === 'add') return window.TZApp.addSymbolToWatchlist(item.dataset.rowId);
    if (action === 'chain') return window.TZApp.openOptionChainModal(item.dataset.rowUnderlying);
    if (item.dataset.rowLocked === 'true') return window.TZApp.showSubscriptionUpgradePrompt(item.dataset.rowSymbol);
    if (item.dataset.rowSearch === 'true') window.TZApp.closeSearchModal();
    window.TZApp.openChartByGlobalId(item.dataset.rowId);
  }
  document.addEventListener('click', activate);
  document.addEventListener('keydown', event => {
    if (!['Enter', ' '].includes(event.key) || !event.target.matches('[data-row-id]')) return;
    event.preventDefault(); activate(event);
  });
  function listState(id, text, error = false) {
    const node = document.getElementById(id);
    if (node) node.innerHTML = `<div class="list-state ${error ? 'is-error' : ''}" role="status">${escape(text)}${error ? '<button class="row-retry" onclick="window.TZApp.retryExploreData()">Retry</button>' : ''}</div>`;
  }
  const closingTimers = new WeakMap();
  const observer = new MutationObserver(changes => {
    for (const change of changes) {
      const node = change.target;
      const wasActive = (change.oldValue || '').split(/\s+/).includes('active');
      const active = node.classList.contains('active');
      if (wasActive === active) continue;
      clearTimeout(closingTimers.get(node));
      if (active) node.classList.remove('is-exiting');
      else if (node.matches('.modal-backdrop, .chart-overlay-screen')) {
        node.classList.add('is-exiting');
        closingTimers.set(node, setTimeout(() => node.classList.remove('is-exiting'), 160));
      }
    }
  });
  document.querySelectorAll('.modal-backdrop, .chart-overlay-screen, .screen-view').forEach(node => observer.observe(node, { attributes: true, attributeOldValue: true, attributeFilter: ['class'] }));
  let noticeTimer;
  function notify(text) {
    let node=document.getElementById('ux-notice');
    if(!node){node=document.createElement('div');node.id='ux-notice';node.className='ux-notice';node.setAttribute('role','status');document.body.appendChild(node);}
    clearTimeout(noticeTimer);node.textContent=text;
    node.style.bottom=(80+(document.getElementById('native-ad-banner-spacer')?.clientHeight||0))+'px';
    node.hidden=false;noticeTimer=setTimeout(()=>{node.hidden=true;},2200);
  }
  window.SikhoUX = { row, escape, listState, notify };
})();
