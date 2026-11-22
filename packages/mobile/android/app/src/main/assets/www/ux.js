(function () {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function row(inst, options) {
    const { restricted, avatar, price = '—', change = '', changeClass = '', showChain, search, removable } = options;
    const symbol = inst.symbol || 'Instrument';
    const detail = [inst.expiry, inst.strikePrice, inst.optionType, inst.lotSize > 1 ? `Lot ${inst.lotSize}` : ''].filter(Boolean).join(' · ') || inst.name || symbol;
    const actionBtn = search && !restricted
      ? '<button class="row-action" data-row-action="add" aria-label="Add to watchlist">+</button>'
      : removable && !restricted
        ? '<button class="row-action row-action-remove" data-row-action="remove" aria-label="Remove from watchlist">✕</button>'
        : showChain && !restricted
          ? '<button class="row-action" data-row-action="chain" aria-label="Open option chain">⋯</button>'
          : '';
    return `<div class="instrument-row-white" role="button" tabindex="0" data-row-id="${escape(inst.globalId)}" data-row-symbol="${escape(symbol)}" data-row-underlying="${escape(inst.underlying || symbol)}" data-row-locked="${!!restricted}" data-row-search="${!!search}" aria-label="${escape(`${symbol}, ${inst.name || ''}, ${inst.exchange || ''}${restricted ? ', Premium, upgrade to access' : ''}`)}">
      <div class="inst-left">${avatar}<div class="inst-meta"><div class="inst-symbol-row"><span class="inst-symbol" title="${escape(symbol)}">${escape(symbol)}</span></div><div class="inst-details-row"><span class="tag-exch">${escape(inst.exchange || 'NSE')}</span><span class="inst-name-sub" title="${escape(detail)}">${escape(detail)}</span></div></div></div>
      <div class="inst-right">${restricted ? '<span class="row-access"><span aria-hidden="true">🔒</span> Premium<span class="row-access-sub">Upgrade →</span></span>' : `<div class="inst-price-col"><span class="inst-ltp-val" data-ltp-id="${escape(inst.globalId)}">${escape(price)}</span><span class="inst-chg-val ${escape(changeClass)}" data-chg-id="${escape(inst.globalId)}">${escape(change)}</span></div>`}${actionBtn}</div></div>`;
  }

  function activate(event) {
    const item = event.target.closest('[data-row-id]');
    if (!item || !window.TZApp) return;
    const action = event.target.closest('[data-row-action]')?.dataset.rowAction;
    if (action === 'add') return window.TZApp.addSymbolToWatchlist(item.dataset.rowId);
    if (action === 'remove') return window.TZApp.removeSymbolFromWatchlist?.(item.dataset.rowId, item.dataset.rowSymbol);
    if (action === 'chain') return window.TZApp.openOptionChainModal(item.dataset.rowUnderlying);
    if (item.dataset.rowLocked === 'true') return window.TZApp.showSubscriptionUpgradePrompt(item.dataset.rowSymbol);
    if (item.dataset.rowSearch === 'true') window.TZApp.closeSearchModal();
    window.TZApp.openChartByGlobalId(item.dataset.rowId);
  }
  document.addEventListener('click', activate);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      const activeConfirm = document.getElementById('modal-branded-confirm');
      if (activeConfirm?.classList.contains('active')) {
        window.TZApp?.closeConfirmSheet?.(false);
        return;
      }
      const openBackdrop = Array.from(document.querySelectorAll('.modal-backdrop.active')).pop();
      if (openBackdrop) {
        if (openBackdrop.id === 'modal-journal' && window.TZApp?.requestCloseJournalModal) {
          window.TZApp.requestCloseJournalModal();
        } else {
          openBackdrop.classList.remove('active');
        }
        return;
      }
    }
    if (!['Enter', ' '].includes(event.key) || !event.target.matches('[data-row-id]')) return;
    event.preventDefault(); activate(event);
  });

  function listState(id, text, error = false) {
    const node = document.getElementById(id);
    if (node) node.innerHTML = `<div class="list-state ${error ? 'is-error' : ''}" role="status">${escape(text)}${error ? '<button class="row-retry" onclick="window.TZApp.retryExploreData()">Retry</button>' : ''}</div>`;
  }

  function skeleton(count = 5) {
    return Array.from({ length: count }, () =>
      `<div class="ux-skeleton-row" aria-hidden="true"><div class="ux-skel-avatar"></div><div class="ux-skel-lines"><div class="ux-skel-line w-45"></div><div class="ux-skel-line w-70"></div></div><div class="ux-skel-right"><div class="ux-skel-line w-60"></div><div class="ux-skel-line w-40"></div></div></div>`
    ).join('');
  }

  function emptyPanel({ title, subtitle, actionLabel, actionOnClick }) {
    return `<div class="ux-state-panel" role="status"><div class="ux-state-title">${escape(title)}</div><div class="ux-state-sub">${escape(subtitle)}</div>${actionLabel && actionOnClick ? `<button class="ux-state-cta" onclick="${escape(actionOnClick)}">${escape(actionLabel)}</button>` : ''}</div>`;
  }

  function noResultsPanel({ query, clearOnClick }) {
    return `<div class="ux-state-panel" role="status"><div class="ux-state-title">No matching results</div><div class="ux-state-sub">No instruments matched "${escape(query)}". Check spelling or clear active filters.</div>${clearOnClick ? `<button class="ux-state-cta" onclick="${escape(clearOnClick)}">Clear search filters</button>` : ''}</div>`;
  }

  function errorPanel({ title = 'Could not load data', message, retryOnClick }) {
    return `<div class="ux-state-panel is-error" role="alert"><div class="ux-state-title">${escape(title)}</div><div class="ux-state-sub">${escape(message || 'We had trouble reaching the server. Check your internet and try again.')}</div>${retryOnClick ? `<button class="ux-state-cta" onclick="${escape(retryOnClick)}">Try again</button>` : ''}</div>`;
  }

  function setFieldError(inputEl, message) {
    if (!inputEl) return;
    inputEl.classList.add('input-invalid');
    inputEl.setAttribute('aria-invalid', 'true');
    let hint = inputEl.parentElement?.querySelector('.field-error-text');
    if (!hint && inputEl.parentElement) {
      hint = document.createElement('div');
      hint.className = 'field-error-text';
      hint.setAttribute('role', 'alert');
      inputEl.parentElement.appendChild(hint);
    }
    if (hint) hint.textContent = message;
  }

  function clearFieldError(inputEl) {
    if (!inputEl) return;
    inputEl.classList.remove('input-invalid');
    inputEl.removeAttribute('aria-invalid');
    const hint = inputEl.parentElement?.querySelector('.field-error-text');
    if (hint) hint.textContent = '';
  }

  const countdownTimers = new WeakMap();
  function startRateLimitCountdown(btnEl, statusEl, retryAfterSec, defaultLabel) {
    if (!btnEl) return;
    const prev = countdownTimers.get(btnEl);
    if (prev) clearInterval(prev);
    let remaining = Math.max(1, Math.ceil(Number(retryAfterSec) || 10));
    const render = () => {
      if (remaining <= 0) {
        clearInterval(countdownTimers.get(btnEl));
        countdownTimers.delete(btnEl);
        btnEl.disabled = false;
        if (defaultLabel) btnEl.textContent = defaultLabel;
        if (statusEl) statusEl.textContent = '';
        return;
      }
      btnEl.disabled = true;
      btnEl.textContent = `Retry in ${remaining}s`;
      if (statusEl) {
        statusEl.textContent = `Too many requests. For security, please wait ${remaining}s before trying again.`;
        statusEl.style.display = 'block';
      }
      remaining--;
    };
    render();
    countdownTimers.set(btnEl, setInterval(render, 1000));
  }

  const closingTimers = new WeakMap();
  const focusReturnMap = new WeakMap();
  const observer = new MutationObserver(changes => {
    for (const change of changes) {
      const node = change.target;
      const wasActive = (change.oldValue || '').split(/\s+/).includes('active');
      const active = node.classList.contains('active');
      if (wasActive === active) continue;
      clearTimeout(closingTimers.get(node));
      if (active) {
        node.classList.remove('is-exiting');
        if (node.matches('.modal-backdrop') && document.activeElement && document.activeElement !== document.body) {
          focusReturnMap.set(node, document.activeElement);
        }
      } else if (node.matches('.modal-backdrop, .chart-overlay-screen')) {
        node.classList.add('is-exiting');
        closingTimers.set(node, setTimeout(() => node.classList.remove('is-exiting'), 160));
        const prevFocus = focusReturnMap.get(node);
        if (prevFocus && typeof prevFocus.focus === 'function' && document.contains(prevFocus)) {
          try { prevFocus.focus(); } catch {}
        }
      }
    }
  });
  document.querySelectorAll('.modal-backdrop, .chart-overlay-screen, .screen-view').forEach(node => observer.observe(node, { attributes: true, attributeOldValue: true, attributeFilter: ['class'] }));

  let noticeTimer;
  let undoInterval;
  function getNoticeNode() {
    let node = document.getElementById('ux-notice');
    if (!node) {
      node = document.createElement('div');
      node.id = 'ux-notice';
      node.className = 'ux-notice';
      node.setAttribute('role', 'status');
      node.setAttribute('aria-live', 'polite');
      document.body.appendChild(node);
    }
    return node;
  }

  function notify(text) {
    const node = getNoticeNode();
    clearTimeout(noticeTimer);
    clearInterval(undoInterval);
    node.classList.remove('has-undo');
    node.textContent = text;
    node.style.bottom = (80 + (document.getElementById('native-ad-banner-spacer')?.clientHeight || 0)) + 'px';
    node.hidden = false;
    noticeTimer = setTimeout(() => { node.hidden = true; }, 2600);
  }

  function notifyWithUndo(text, onUndo, durationMs = 6000) {
    const node = getNoticeNode();
    clearTimeout(noticeTimer);
    clearInterval(undoInterval);
    node.classList.add('has-undo');
    let secs = Math.max(1, Math.ceil(durationMs / 1000));
    const render = () => {
      node.innerHTML = `<span class="ux-notice-text">${escape(text)}</span><button type="button" class="ux-undo-btn" id="ux-undo-action">Undo (${secs}s)</button>`;
      const btn = node.querySelector('#ux-undo-action');
      if (btn) {
        btn.onclick = () => {
          clearTimeout(noticeTimer);
          clearInterval(undoInterval);
          node.hidden = true;
          try { onUndo?.(); } catch {}
        };
      }
    };
    render();
    node.style.bottom = (80 + (document.getElementById('native-ad-banner-spacer')?.clientHeight || 0)) + 'px';
    node.hidden = false;
    undoInterval = setInterval(() => {
      secs--;
      if (secs > 0) render();
    }, 1000);
    noticeTimer = setTimeout(() => {
      clearInterval(undoInterval);
      node.hidden = true;
    }, durationMs);
  }

  window.SikhoUX = {
    row,
    escape,
    listState,
    skeleton,
    emptyPanel,
    noResultsPanel,
    errorPanel,
    setFieldError,
    clearFieldError,
    startRateLimitCountdown,
    notify,
    notifyWithUndo,
  };
})();
