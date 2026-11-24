(function () {
  if (window.top !== window.self) {
    console.error('Sikho Trading cannot run inside an embedded frame.');
    return;
  }
  const isNative = Boolean(window.TradingzoneNative);
  const nativeDefault = isNative && typeof window.TradingzoneNative.getDefaultServerUrl === 'function'
    ? window.TradingzoneNative.getDefaultServerUrl()
    : null;
  const isDevPickerEnabled = !isNative || (typeof window.TradingzoneNative.isDevServerPickerEnabled === 'function' && window.TradingzoneNative.isDevServerPickerEnabled());

  const DEFAULT_HOST = nativeDefault || (
    window.location.hostname && window.location.hostname !== '' && window.location.protocol.startsWith('http')
      ? `${window.location.protocol}//${window.location.host}`
      : 'https://sikho-trading-api.onrender.com'
  );

  // Invalidate any legacy or stale local LAN addresses stored in WebView localStorage
  try {
    const savedBase = localStorage.getItem('tz_api_base');
    if (savedBase && (
      savedBase.includes('192.168.') ||
      savedBase.includes('10.0.2.2') ||
      savedBase.includes('localhost') ||
      savedBase.includes('127.0.0.1') ||
      savedBase.includes('api.sikhotrading.com')
    )) {
      localStorage.removeItem('tz_api_base');
    }
  } catch {}

  let API_BASE = (isDevPickerEnabled ? localStorage.getItem('tz_api_base') : null) || DEFAULT_HOST;

  const state = {
    authMode: 'login', // 'login' | 'register' | 'recover'
    token: null,
    user: null,
    account: null,
    subscription: null,
    entitlementResolved: false,
    access: null,
    isGoogleSignInPending: false,
    googleTrace: [],
    mainTab: 'explore',
    exploreCategory: 'STOCKS', // 'STOCKS' | 'FNO'
    stocksSectorFilter: 'ALL',
    portfolioSubTab: 'POSITIONS', // 'POSITIONS' | 'HOLDINGS' | 'HISTORY'
    ordersFilter: 'ALL',
    indices: [],
    exploreStocks: [],
    exploreFnoIndices: [],
    exploreFnoStocks: [],
    commodities: { metals: [], energy: [], agriculture: [] },
    commoditiesFilter: 'ALL',
    commoditySpecs: {},
    watchlists: [],
    positionsData: { positions: [], holdings: [], activePositions: [], closedPositions: [] },
    orders: [],
    feedHealth: null,
    searchSegment: '',
    wsConnected: false,
    lastAnyTickReceiveMs: 0,
    lastTickTimestamps: {},
    lastTickClientReceiveMs: {},
    lastCumulativeVolume: {},
    wsNeedsGapRecovery: false,
    activeChartSubId: null,

    // Active Chart State
    chartOpen: false,
    activeInstrument: null,
    activeTimeframe: '5m',
    activeRange: null,
    candles: [],
    hasMoreHistory: true,
    isFetchingOlder: false,
    earliestTime: null,
    prevSessionClose: null,
    chartLoadSeq: 0,
    isUserScrolledBack: false,

    // Replay & Alerts State
    replayMode: false,
    replayIndex: 0,
    replayTimer: null,
    replayPlaying: false,
    allReplayCandles: [],
    priceAlerts: [],
    alertCondition: 'ABOVE',
    journalEntries: [],

    // Indicators & Drawings
    indicators: {
      sma20: false,
      ema50: false,
      bb20: false,
      vwap: false,
      rsi14: false,
    },
    activeDrawingTool: 'cursor',
    drawings: [],
    activeDraftDrawing: null,
    draggingDrawingState: null,

    // Order Ticket State
    orderTicket: {
      instrument: null,
      side: 'BUY',
      productType: 'INTRADAY',
      orderType: 'MARKET',
      quantity: 1,
      price: '',
    },
  };

  let chartLibraryPromise=null;
  function ensureChartLibrary(){
   if(window.LightweightCharts)return Promise.resolve();
   if(!chartLibraryPromise)chartLibraryPromise=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='lightweight-charts.standalone.production.js';script.onload=resolve;script.onerror=()=>{chartLibraryPromise=null;reject(Error('Chart engine unavailable. Reopen the chart to retry.'));};document.head.appendChild(script);});
   return chartLibraryPromise;
  }
  let tvChart = null;
  let candleSeries = null;
  let volumeSeries = null;
  let indicatorSeriesMap = {};
  let wsConn = null;

  // =========================================================================
  // NATIVE STORAGE BRIDGE (Android SharedPreferences with Web Fallback)
  // =========================================================================
  function saveSessionSecure(sessionObj) {
    const raw = JSON.stringify(sessionObj);
    if (window.TradingzoneNative && typeof window.TradingzoneNative.saveSession === 'function') {
      try {
        const ok = window.TradingzoneNative.saveSession(raw);
        if (!ok) {
          console.error('Native saveSession returned false');
          return false;
        }
        return true;
      } catch (e) {
        console.error('Native saveSession threw exception:', e);
        return false;
      }
    }
    // Web fallback mode (browser only)
    try {
      sessionStorage.setItem('tz_session_v2', raw);
      return true;
    } catch {
      return false;
    }
  }

  function readSessionSecure() {
    try {
      if (window.TradingzoneNative && typeof window.TradingzoneNative.readSession === 'function') {
        const nativeRaw = window.TradingzoneNative.readSession();
        if (nativeRaw) return JSON.parse(nativeRaw);
        return null;
      }
      const webRaw = sessionStorage.getItem('tz_session_v2');
      if (webRaw) return JSON.parse(webRaw);
    } catch (e) {
      console.warn('Native readSession failed:', e);
    }
    return null;
  }

  function clearSessionSecure() {
    if (window.TradingzoneNative && typeof window.TradingzoneNative.clearSession === 'function') {
      try {
        window.TradingzoneNative.clearSession();
      } catch (e) {
        console.warn('Native clearSession failed:', e);
      }
    }
    try {
      sessionStorage.removeItem('tz_session_v2');
    } catch { }
  }

  // =========================================================================
  // FORMATTING HELPERS
  // =========================================================================
  function fmtINR(num, decimals = 2) {
    const n = Number(num || 0);
    return '₹' + n.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }

  function fmtNum(num, decimals = 2) {
    if (num === null || num === undefined || isNaN(num)) return '—';
    return Number(num).toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }

  function calcChange(quote) {
    if (!quote || !quote.ltp) return {diff:null,pct:null,sign:'',available:false};
    const base = Number(quote.close);
    if(!(base>0))return {diff:null,pct:null,sign:'',available:false};
    const diff = quote.ltp - base;
    const pct = base > 0 ? (diff / base) * 100 : 0;
    const sign = diff > 0 ? '+' : '';
    return { diff, pct, sign, available:true };
  }

  function formatChangePct(pct){
    if(pct===null||!Number.isFinite(pct))return 'Unavailable';
    if(pct===0)return '0.00%';
    if(Math.abs(pct)<.01)return (pct>0?'+':'−')+'<0.01%';
    return (pct>0?'+':'')+pct.toFixed(2)+'%';
  }

  function formatPointsAndPct(quote) {
    const chg = calcChange(quote);
    if (!chg.available) return { text: 'Unavailable', cls: 'val-neutral', available: false, diff: null, pct: null };
    const absPts = Math.abs(chg.diff);
    const ptsStr = `${chg.diff > 0 ? '+' : chg.diff < 0 ? '-' : ''}${fmtNum(absPts)}`;
    const pctStr = formatChangePct(chg.pct);
    const cls = chg.diff > 0 ? 'val-pos' : chg.diff < 0 ? 'val-neg' : 'val-neutral';
    return { text: `${ptsStr} (${pctStr})`, cls, available: true, diff: chg.diff, pct: chg.pct };
  }

  // =========================================================================
  // COMPLETE DAY / NIGHT / SYSTEM THEME ENGINE (PRIORITY 5)
  // =========================================================================
  const THEME_STORAGE_KEY = 'sikho_theme_pref';
  let systemThemeMedia = null;

  function getThemePreference() {
    try {
      const v = localStorage.getItem(THEME_STORAGE_KEY);
      if (v === 'light' || v === 'dark' || v === 'system') return v;
    } catch {}
    return 'light';
  }

  function resolveEffectiveTheme(pref) {
    const p = pref || getThemePreference();
    if (p === 'dark') return 'dark';
    if (p === 'light') return 'light';
    try {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  }

  function syncNativeSystemBarTheme() {
    if (!window.TradingzoneNative || typeof window.TradingzoneNative.setSystemBarTheme !== 'function') return;
    const isAuthScreen = document.getElementById('screen-auth')?.classList.contains('active');
    if (isAuthScreen) {
      window.TradingzoneNative.setSystemBarTheme(false, '#080C12');
      return;
    }
    const isLight = resolveEffectiveTheme() === 'light';
    window.TradingzoneNative.setSystemBarTheme(isLight, isLight ? '#FFFFFF' : '#080C12');
  }

  function getChartThemeOptions(effectiveTheme) {
    const isDark = (effectiveTheme || resolveEffectiveTheme()) === 'dark';
    return isDark
      ? {
          layout: { background: { type: 'solid', color: '#080C12' }, textColor: '#CBD5E1', fontSize: 11 },
          grid: { vertLines: { color: 'rgba(148, 163, 184, 0.08)' }, horzLines: { color: 'rgba(148, 163, 184, 0.08)' } },
          rightPriceScale: { borderColor: '#1E293B' },
          timeScale: { borderColor: '#1E293B' },
          candle: { upColor: '#22C55E', downColor: '#EF4444', borderUpColor: '#22C55E', borderDownColor: '#EF4444', wickUpColor: '#22C55E', wickDownColor: '#EF4444', priceLineColor: '#94A3B8' },
        }
      : {
          layout: { background: { type: 'solid', color: '#FFFFFF' }, textColor: '#334155', fontSize: 11 },
          grid: { vertLines: { color: 'rgba(15, 23, 42, 0.06)' }, horzLines: { color: 'rgba(15, 23, 42, 0.06)' } },
          rightPriceScale: { borderColor: '#E2E8F0' },
          timeScale: { borderColor: '#E2E8F0' },
          candle: { upColor: '#0D9456', downColor: '#D92D45', borderUpColor: '#0D9456', borderDownColor: '#D92D45', wickUpColor: '#0D9456', wickDownColor: '#D92D45', priceLineColor: '#475569' },
        };
  }

  function applyChartTheme(effectiveTheme) {
    if (!tvChart) return;
    const opts = getChartThemeOptions(effectiveTheme);
    try {
      tvChart.applyOptions({
        layout: opts.layout,
        grid: opts.grid,
        rightPriceScale: opts.rightPriceScale,
        timeScale: opts.timeScale,
      });
      if (candleSeries) {
        candleSeries.applyOptions(opts.candle);
      }
    } catch {}
  }

  function applyTheme(pref, persist = false) {
    const validPref = pref === 'dark' || pref === 'system' ? pref : 'light';
    if (persist) {
      try { localStorage.setItem(THEME_STORAGE_KEY, validPref); } catch {}
    }
    const effective = resolveEffectiveTheme(validPref);
    document.documentElement.setAttribute('data-theme', effective);
    const icon = effective === 'dark' ? '☀' : '🌙';
    const headerBtn = document.getElementById('header-theme-btn');
    const chartBtn = document.getElementById('chart-theme-btn');
    if (headerBtn) headerBtn.textContent = icon;
    if (chartBtn) chartBtn.textContent = icon;
    document.getElementById('theme-opt-light')?.classList.toggle('active', validPref === 'light');
    document.getElementById('theme-opt-dark')?.classList.toggle('active', validPref === 'dark');
    document.getElementById('theme-opt-system')?.classList.toggle('active', validPref === 'system');
    const statusEl = document.getElementById('prof-theme-status');
    if (statusEl) {
      statusEl.textContent = validPref === 'system'
        ? `Following system (${effective === 'dark' ? 'Night' : 'Day'})`
        : effective === 'dark' ? 'Night mode active' : 'Day mode active';
    }
    applyChartTheme(effective);
    syncNativeSystemBarTheme();
  }

  function setThemePreference(pref) {
    applyTheme(pref, true);
  }

  function toggleThemeQuick() {
    const next = resolveEffectiveTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next, true);
  }

  function quoteTimestamp(q) {
    return Number(q?.providerTimestamp || q?.receiveTimestamp || 0);
  }

  /**
   * Returns the freshest known quote for an instrument. A REST refresh that comes back with a
   * null/partial quote must never blank a price that is already streaming.
   */
  function pickQuote(inst) {
    if (!inst) return null;
    const live = inst.globalId ? state.quotesMap?.get(inst.globalId) : null;
    const rest = inst.latestQuote || null;
    const liveOk = live && Number(live.ltp) > 0;
    const restOk = rest && Number(rest.ltp) > 0;
    if (liveOk && restOk) return quoteTimestamp(rest) > quoteTimestamp(live) ? rest : live;
    if (liveOk) return live;
    if (restOk) return rest;
    return live || rest || null;
  }

  /** Merges fresh REST quotes into the live cache without ever replacing a newer value. */
  function seedQuotesFromInstruments(list) {
    if (!Array.isArray(list)) return;
    state.quotesMap = state.quotesMap || new Map();
    for (const inst of list) {
      const q = inst?.latestQuote;
      if (!q || !(Number(q.ltp) > 0) || !inst.globalId) continue;
      const existing = state.quotesMap.get(inst.globalId);
      if (!existing || quoteTimestamp(q) >= quoteTimestamp(existing)) {
        state.quotesMap.set(inst.globalId, q);
      }
    }
  }

  async function apiFetch(path, opts = {}) {
    const requestToken=state.token;
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (state.token) {
      headers['Authorization'] = `Bearer ${state.token}`;
    }

    const timeoutMs = opts.timeoutMs || 10000;
    const controller = new AbortController();
    const onExternalAbort=()=>controller.abort();
    if(opts.signal?.aborted)controller.abort();
    opts.signal?.addEventListener('abort',onExternalAbort,{once:true});
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res;
    try {
      res = await fetch(`${API_BASE}${path}`, Object.assign({}, opts, {
        headers,
        signal: controller.signal,
      }));
    } catch (err) {
      clearTimeout(timer);
      if (opts.signal?.aborted) throw new DOMException('Request superseded','AbortError');
      if (err.name === 'AbortError') {
        const timeoutErr = new Error(`Connection timed out (${timeoutMs / 1000}s) connecting to ${API_BASE}. Ensure PC backend is running and phone is on the same Wi-Fi.`);
        timeoutErr.code = 'ERR_SERVER_TIMEOUT';
        throw timeoutErr;
      }
      const netErr = new Error(`Cannot reach backend at ${API_BASE}. Ensure PC server is running and phone is on the same Wi-Fi network (or configure server URL).`);
      netErr.code = 'ERR_SERVER_UNREACHABLE';
      throw netErr;
    } finally {
      opts.signal?.removeEventListener('abort',onExternalAbort);
      clearTimeout(timer);
    }

    const data = await res.json().catch(() => ({}));
    if(state.token!==requestToken)throw new DOMException('Response belongs to a previous session','AbortError');
    if (res.status === 401 && state.token && state.token===requestToken && !path.startsWith('/api/v1/auth/')) {
      const expiredEmail = state.user?.email || '';
      signOut('Your session expired for your security. Please sign in again to continue.', { preserveEmail: expiredEmail });
      throw new Error(data.error || 'Session expired');
    }
    if (!res.ok) {
      const err = new Error(data.error || data.message || `Request failed (${res.status})`);
      err.code = data.code;
      err.status = res.status;
      if (res.status === 429) {
        const retryHeader = res.headers?.get?.('Retry-After');
        const parsedSec = Number(retryHeader);
        err.retryAfterSec = Number.isFinite(parsedSec) && parsedSec > 0 ? parsedSec : 60;
      }
      throw err;
    }
    return data;
  }

  // =========================================================================
  // BRANDED MODAL DIALOGS (REPLACING BROWSER ALERT / CONFIRM)
  // =========================================================================
  function showBrandedAlert(titleOrMsg, msg) {
    const title = msg !== undefined ? titleOrMsg : 'Notification';
    const message = msg !== undefined ? msg : titleOrMsg;
    const titleEl = document.getElementById('branded-alert-title');
    const msgEl = document.getElementById('branded-alert-message');
    const modal = document.getElementById('modal-branded-alert');
    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.textContent = message;
    if (modal) modal.classList.add('active');
  }

  window.alert = function (msg) {
    showBrandedAlert('Notification', String(msg));
  };

  let confirmSheetCallback = null;
  function showConfirmSheet(title, message, callback) {
    const titleEl = document.getElementById('branded-confirm-title');
    const msgEl = document.getElementById('branded-confirm-message');
    const modal = document.getElementById('modal-branded-confirm');
    if (titleEl) titleEl.textContent = title || 'Confirm Action';
    if (msgEl) msgEl.textContent = message || 'Are you sure you want to proceed?';
    confirmSheetCallback = callback;
    if (modal) modal.classList.add('active');
  }

  function closeConfirmSheet(accepted) {
    const modal = document.getElementById('modal-branded-confirm');
    if (modal) modal.classList.remove('active');
    if (typeof confirmSheetCallback === 'function') {
      const cb = confirmSheetCallback;
      confirmSheetCallback = null;
      cb(Boolean(accepted));
    }
  }

  // =========================================================================
  // SCREEN NAVIGATION, ADMOB STATE COORDINATION & ANDROID BACK BUTTON
  // =========================================================================
  function notifyNativeScreenState() {
    let screen = 'screen-auth';
    if (document.getElementById('screen-auth')?.classList.contains('active')) {
      screen = 'screen-auth';
    } else if (document.getElementById('screen-main')?.classList.contains('active')) {
      screen = state.mainTab || 'explore';
    }

    const isTradingWorkspaceOpen = Boolean(
      state.chartOpen ||
      document.querySelector('.modal-backdrop.active, .chart-overlay-screen.active') ||
      document.getElementById('modal-order-ticket')?.classList.contains('active') ||
      document.getElementById('modal-option-chain')?.classList.contains('active') ||
      document.getElementById('modal-subscription')?.classList.contains('active') ||
      document.getElementById('modal-search')?.classList.contains('active')
    );

    const posList = state.positionsData?.positions || state.positions || [];
    const hasOpenPositions = Boolean(
      posList.some((p) => Math.abs(p.quantity || 0) > 0)
    );

    const ordList = state.orders || [];
    const hasPendingOrders = state.hasPendingOrders || Boolean(
      ordList.some((o) => o.status === 'PENDING' || o.status === 'TRIGGER_PENDING' || o.status === 'TRIGGERED')
    );

    if (window.TradingzoneNative && typeof window.TradingzoneNative.updateScreenState === 'function') {
      window.TradingzoneNative.updateScreenState(screen, isTradingWorkspaceOpen, hasOpenPositions, hasPendingOrders);
    }
  }

  function notifyNativeUserTier() {
    if (window.TradingzoneNative && typeof window.TradingzoneNative.updateUserTier === 'function') {
      if (!state.token || !state.user || !state.entitlementResolved) {
        window.TradingzoneNative.updateUserTier('UNKNOWN', '');
        return;
      }
      const tier = isProUser() ? 'PRO' : 'FREE';
      const userId = state.user?.userId || state.user?.id || '';
      window.TradingzoneNative.updateUserTier(tier, userId);
    }
  }

  function hasFullFeatureAccess() { return Boolean(state.access?.fullFeatureAccess || isProUser()); }

  function isProUser() {
    return Boolean(
      state.entitlementResolved &&
      state.subscription?.tier === 'PRO' &&
      state.user?.tier === 'PRO'
    );
  }

  function isGlobalIdRestrictedForFree(globalId) {
    if (!globalId || hasFullFeatureAccess()) return false;
    // Never falsely show Pro lock while server access policy is still loading or transiently retrying
    if (!state.accessResolved) return false;
    const access = window.TzFreeAccess;
    if (!access) return true; // fail closed if the access-matrix asset is missing
    return !access.isFreeTierAllowedGlobalId(globalId);
  }

  function isInstrumentRestrictedForFree(inst) {
    if (!inst) return false;
    if (hasFullFeatureAccess()) return false;
    // Never falsely show Pro lock while server access policy is still loading or transiently retrying
    if (!state.accessResolved) return false;
    const access = window.TzFreeAccess;
    if (!access) return true; // fail closed if the access-matrix asset is missing
    return !access.isFreeTierAllowedInstrument(inst);
  }

  function showSubscriptionUpgradePrompt(symbol) {
    if (state.access?.accessMode === 'FREE_LAUNCH') return;
    if (!state.accessResolved) {
      window.SikhoUX?.notify('Checking account access…');
      pollAccessPolicy();
      return;
    }
    showBrandedAlert(
      'Premium Pro Required',
      `${symbol || 'This instrument'} is exclusive to Sikho Trading Premium. Upgrade now to unlock BSE SENSEX, Equities, and MCX Commodities.`
    );
    openSubscriptionPlansModal();
  }

  function recordEligibleAction(actionName) {
    notifyNativeScreenState();
    if (window.TradingzoneNative && typeof window.TradingzoneNative.recordEligibleAction === 'function') {
      window.TradingzoneNative.recordEligibleAction(actionName);
    }
  }

  function openAdPrivacyOptions() {
    if (window.TradingzoneNative && typeof window.TradingzoneNative.showPrivacyOptions === 'function') {
      window.TradingzoneNative.showPrivacyOptions();
    } else {
      alert('Ad consent and privacy choices are managed on the native Android device via Google UMP.');
    }
  }

  /**
   * Support surface for ads: entitlement, consent, SDK init, load errors (code/domain/message/
   * response id), banner attachment/dimensions and the exact eligibility block reason.
   */
  function showAdDiagnostics() {
    let diag = {};
    try {
      if (window.TradingzoneNative && typeof window.TradingzoneNative.getAdDiagnostics === 'function') {
        const raw = window.TradingzoneNative.getAdDiagnostics();
        diag = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
      }
    } catch (e) {
      diag = { error: String(e && e.message || e) };
    }
    console.log('[AdDiagnostics]', diag);
    const lines = [
      `Tier: ${diag.tier || '?'} • User: ${diag.userId || '(none)'}`,
      `Screen: ${diag.currentScreen || '?'} • Trading workspace: ${diag.isTradingWorkspaceOpen} • Open positions: ${diag.hasOpenPositions} • Pending orders: ${diag.hasPendingOrders}`,
      `AdMob App ID: ${diag.admobAppId || '?'}`,
      `Banner unit: ${diag.bannerAdUnitId || '?'}`,
      `Interstitial unit: ${diag.interstitialAdUnitId || '?'}`,
      `Test ad units: ${diag.usingOfficialTestAdUnits} • Debug build: ${diag.isDebugBuild}`,
      '',
      `SDK initialized: ${diag.sdkInitialized} (${diag.sdkInitStatus})`,
      `SDK detail: ${diag.sdkInitDetail || '—'}`,
      `Consent status: ${diag.consentStatus} • canRequestAds: ${diag.canRequestAds}`,
      `Consent callback: ${diag.consentCallbackAgoSec >= 0 ? diag.consentCallbackAgoSec + 's ago' : 'not received'}`,
      `Consent form error: ${diag.consentFormError || 'none'}`,
      `Consent request error: ${diag.consentRequestError || 'none'}`,
      '',
      `Banner: requests=${diag.bannerRequestCount} loaded=${diag.bannerLoaded} visible=${diag.bannerVisible} attached=${diag.bannerAttached}`,
      `Banner size: ${diag.bannerMeasuredWidthPx}x${diag.bannerMeasuredHeightPx}px (container ${diag.bannerContainerWidthPx}x${diag.bannerContainerHeightPx}px)`,
      `Banner last error: ${diag.lastBannerLoadError || 'none'}`,
      `Interstitial: requests=${diag.interstitialRequestCount} loaded=${diag.interstitialLoaded} loading=${diag.isInterstitialLoading} shown=${diag.interstitialShownCount}`,
      `Interstitial last error: ${diag.lastInterstitialLoadError || 'none'}`,
      '',
      `Actions: ${diag.eligibleActionCounter}/${diag.actionsRequired} • Foreground: ${diag.foregroundSec}s of ${diag.minForegroundSec}s required`,
      `Caps: session ${diag.sessionInterstitialCount}/${diag.maxSessionInterstitials} • 24h ${diag.recent24hCount}/${diag.max24hInterstitials}`,
      `Blocked reason: ${diag.lastEligibilityCheckReason || '—'}`,
      `Preload/display reason: ${diag.lastPreloadBlockedReason || '—'}`,
      '',
      'Ads are test/dev units in debug builds. Production serving additionally requires the AdMob account/app to be approved and linked.',
    ].join('\n');
    showBrandedAlert('Ad diagnostics', lines);
  }

  window.onAdBannerStateChanged = function (isVisible, heightDp) {
    const spacer = document.getElementById('native-ad-banner-spacer');
    if (spacer) {
      if (isVisible) {
        spacer.style.display = 'block';
        spacer.style.height = `${heightDp || 50}px`;
      } else {
        spacer.style.display = 'none';
      }
    }
  };

  window.onAdPrivacyOptionsResult = function (success, errorMsg) {
    if (!success && errorMsg) {
      console.log('Ad privacy form returned: ' + errorMsg);
    }
  };

  function showTopScreen(screenId) {
    document.querySelectorAll('.screen-view').forEach((el) => el.classList.remove('active'));
    const target = document.getElementById(screenId);
    if (target) target.classList.add('active');
    notifyNativeScreenState();
  }

  window.handleAndroidBackButton = function () {
    if (document.getElementById('modal-server-config')?.classList.contains('active')) {
      closeServerConfigModal();
      return true;
    }
    if (document.getElementById('modal-order-ticket').classList.contains('active')) {
      closeOrderTicket();
      return true;
    }
    if (document.getElementById('modal-indicators').classList.contains('active')) {
      document.getElementById('modal-indicators').classList.remove('active');
      return true;
    }
    if (document.getElementById('modal-drawings').classList.contains('active')) {
      document.getElementById('modal-drawings').classList.remove('active');
      return true;
    }
    if (document.getElementById('modal-option-chain').classList.contains('active')) {
      closeOptionChainModal();
      return true;
    }
    if (document.getElementById('modal-all-indices').classList.contains('active')) {
      closeAllIndicesModal();
      return true;
    }
    if (document.getElementById('modal-search').classList.contains('active')) {
      closeSearchModal();
      return true;
    }
    if (state.chartOpen) {
      closeChartWorkspace();
      return true;
    }
    if (state.mainTab !== 'explore') {
      switchMainTab('explore');
      return true;
    }
    return false;
  };

  // =========================================================================
  // 1. AUTHENTICATION, PIN UNLOCK & BIOMETRIC FLOWS
  // =========================================================================
  function toggleAuthMode(mode) {
    state.authMode = mode;
    const errEl = document.getElementById('auth-error-msg');
    errEl.style.display = 'none';
    const heading = document.getElementById('auth-card-heading');
    const sub = document.getElementById('auth-card-subtitle');
    const nameGrp = document.getElementById('auth-name-group');
    const currentPassGrp = document.getElementById('auth-current-password-group');
    const passLbl = document.getElementById('auth-label-password');
    const btnTxt = document.getElementById('btn-auth-submit-text');
    const toggleBtn = document.getElementById('btn-auth-toggle-mode');
    if (currentPassGrp) currentPassGrp.style.display = 'none';

    if (mode === 'register') {
      heading.textContent = 'Create your account';
      sub.textContent = 'Start with ₹1,00,000 in virtual capital for NSE & BSE practice';
      nameGrp.style.display = 'block';
      passLbl.textContent = 'Create Password (min 6 chars)';
      btnTxt.textContent = 'Create Practice Account';
      toggleBtn.textContent = 'Already have an account? Sign In';
      toggleBtn.onclick = () => toggleAuthMode('login');
    } else if (mode === 'recover') {
      // Security: no email-verification provider is configured, so a password change requires
      // proof of ownership (the current password). A bare email is not proof of ownership.
      heading.textContent = 'Change Account Password';
      sub.textContent = 'Verify ownership with your current password. Your virtual portfolio and track record are preserved.';
      nameGrp.style.display = 'none';
      if (currentPassGrp) currentPassGrp.style.display = 'block';
      passLbl.textContent = 'New Password (min 6 chars)';
      btnTxt.textContent = 'Update Password';
      toggleBtn.textContent = 'Back to Sign In';
      toggleBtn.onclick = () => toggleAuthMode('login');
    } else {
      heading.textContent = 'Welcome back!';
      sub.textContent = 'Sign in to your isolated Indian market practice account';
      nameGrp.style.display = 'none';
      passLbl.textContent = 'Password';
      btnTxt.textContent = 'Sign In to Sikho Trading';
      toggleBtn.textContent = 'Create new account';
      toggleBtn.onclick = () => toggleAuthMode('register');
    }
  }

  function showAuthError(msg) {
    const errEl = document.getElementById('auth-error-msg');
    errEl.textContent = msg;
    errEl.style.display = 'block';
  }

  function togglePasswordVisibility() {
    const passInput = document.getElementById('auth-input-password');
    const eyeOpen = document.getElementById('eye-icon-open');
    const eyeClosed = document.getElementById('eye-icon-closed');
    if (!passInput) return;
    if (passInput.type === 'password') {
      passInput.type = 'text';
      if (eyeOpen) eyeOpen.style.display = 'none';
      if (eyeClosed) eyeClosed.style.display = 'block';
    } else {
      passInput.type = 'password';
      if (eyeOpen) eyeOpen.style.display = 'block';
      if (eyeClosed) eyeClosed.style.display = 'none';
    }
  }

  async function submitAuthForm() {
    const submitBtn = document.getElementById('btn-auth-submit');
    const submitText = document.getElementById('btn-auth-submit-text');
    const emailInput = document.getElementById('auth-input-email');
    const passwordInput = document.getElementById('auth-input-password');
    const nameInput = document.getElementById('auth-input-name');
    const currentPasswordInput = document.getElementById('auth-input-current-password');

    const email = (emailInput?.value || '').trim();
    // Maintain password integrity: do not trim or modify password
    const password = passwordInput?.value || '';
    const name = (nameInput?.value || '').trim();
    const currentPassword = currentPasswordInput?.value || '';

    if (!email || !email.includes('@')) {
      return showAuthError('Please enter a valid email address.');
    }
    if (!password || password.length < 6) {
      return showAuthError('Please enter a password of at least 6 characters.');
    }
    if (state.authMode === 'recover' && !currentPassword) {
      return showAuthError(
        'Enter your current password to prove account ownership. Email-based reset is unavailable because email ownership verification is not configured for this deployment.'
      );
    }

    if (submitBtn) submitBtn.disabled = true;
    const originalText = submitText ? submitText.textContent : 'Submit';
    if (submitText) {
      if (state.authMode === 'register') {
        submitText.textContent = 'Creating Practice Account...';
      } else if (state.authMode === 'recover') {
        submitText.textContent = 'Updating Password...';
      } else {
        submitText.textContent = 'Signing In...';
      }
    }

    try {
      document.getElementById('auth-error-msg').style.display = 'none';
      let res;
      if (state.authMode === 'register') {
        res = await apiFetch('/api/v1/auth/register', {
          method: 'POST',
          body: JSON.stringify({ email, password, name: name || email.split('@')[0] }),
        });
      } else if (state.authMode === 'recover') {
        res = await apiFetch('/api/v1/auth/recover', {
          method: 'POST',
          body: JSON.stringify({ email, newPassword: password, currentPassword }),
        });
      } else {
        res = await apiFetch('/api/v1/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        });
      }

      completeAuthenticatedSession(res.token, res.user, res.account, true, res.entitlement, res.access);
    } catch (err) {
      if (err && err.status === 429 && err.retryAfterSec && submitBtn && window.SikhoUX?.startRateLimitCountdown) {
        window.SikhoUX.startRateLimitCountdown(submitBtn, document.getElementById('auth-error-msg'), err.retryAfterSec, originalText);
        return;
      }
      showAuthError(err.message || 'Authentication failed.');
    } finally {
      if (submitBtn && !(submitBtn.textContent || '').startsWith('Retry in ')) {
        submitBtn.disabled = false;
        if (submitText) submitText.textContent = originalText;
      }
    }
  }

  // Official Web Client ID configured in Google Cloud Project "Sikho Trading"
  const GOOGLE_WEB_CLIENT_ID = '18709659572-6d1j4db60j60vo0a0ek5kumvv06vu4fi.apps.googleusercontent.com';

  let googleSignInTimeoutId = null;

  let activeGoogleSignInRequestId = null;
  // Request IDs that must never be able to authenticate: timed-out, cancelled or already handled.
  // This prevents a late native callback (e.g. arriving after the 45s client timeout) from
  // silently logging the user in through a stale response.
  const expiredGoogleRequestIds = new Set();
  const handledGoogleRequestIds = new Set();

  // Callback registered globally for native Android Credential Manager result
  window.onTradingzoneGoogleSignInResult = async function (success, dataJsonStr, errorMsg, requestId) {
    const reqId = typeof requestId === 'string' ? requestId : '';
    if (reqId && expiredGoogleRequestIds.has(reqId)) {
      recordGoogleStage('JS_CALLBACK_REJECTED_STALE', reqId, 'expired_request');
      return;
    }
    if (reqId && handledGoogleRequestIds.has(reqId)) {
      recordGoogleStage('JS_CALLBACK_REJECTED_DUPLICATE', reqId, '');
      return; // Duplicate native callback for the same request
    }
    if (reqId && activeGoogleSignInRequestId && reqId !== activeGoogleSignInRequestId) {
      recordGoogleStage('JS_CALLBACK_REJECTED_STALE', reqId, 'superseded');
      return; // Ignore callback from a superseded sign-in attempt
    }
    if (reqId) handledGoogleRequestIds.add(reqId);
    activeGoogleSignInRequestId = null;
    recordGoogleStage('JS_CALLBACK_RECEIVED', reqId, 'success=' + Boolean(success));

    if (googleSignInTimeoutId) {
      clearTimeout(googleSignInTimeoutId);
      googleSignInTimeoutId = null;
    }
    const googleBtn = document.getElementById('btn-google-signin');
    const googleBtnText = document.getElementById('btn-google-signin-text');

    const resetGoogleBtn = () => {
      state.isGoogleSignInPending = false;
      if (googleBtn) googleBtn.disabled = false;
      if (googleBtnText) googleBtnText.textContent = 'Continue with Google';
    };

    if (!success) {
      resetGoogleBtn();
      const err = String(errorMsg || '');
      recordGoogleStage('JS_ERROR', reqId, err.substring(0, 120));
      if (err.includes('GOOGLE_REAUTH_FAILED')) {
        showAuthError('Google could not verify this account (error 16). Try the compatibility sign-in below, or use email and password. Sign-in help has details for support.');
        const compatibilityButton = document.getElementById('btn-google-compat');
        if (compatibilityButton) compatibilityButton.style.display = 'block';
      } else if (err.includes('USER_CANCELLED')) {
        showAuthError('Google returned no credential (picker closed or provider cancelled the request). If you selected an account, open Sign-in help and share the request trace with the owner. You can retry manually or use email/password.');
      } else if (err.includes('PLAY_SERVICES_UNAVAILABLE')) {
        showAuthError('Google Play Services is unavailable on this device. Update Google Play Services from the Play Store, then retry — or use email/password sign-in.');
      } else if (err.includes('SIGN_IN_TIMEOUT')) {
        showAuthError('Google sign-in timed out waiting for the account picker. Check your connection and retry, or use email/password sign-in.');
      } else if (err.includes('SIGN_IN_INTERRUPTED')) {
        showAuthError('The Google sign-in flow was interrupted before it finished. Bring the app to the front and tap "Continue with Google" again.');
      } else if (err.includes('UNEXPECTED_CREDENTIAL_TYPE')) {
        showAuthError('Google returned a credential type this build does not support (' + err.replace('UNEXPECTED_CREDENTIAL_TYPE:', '').trim() + '). Update the app and retry.');
      } else if (err.includes('CREDENTIAL_PARSE_ERROR') || err.includes('CREDENTIAL_INCOMPLETE')) {
        showAuthError('Google returned a credential that could not be read on this device. Update Google Play Services and the app, then retry.');
      } else if (err.includes('NO_CREDENTIALS')) {
        showAuthError(
          'Google sign-in could not obtain a credential for this build. The app\'s package + signing certificate may not match the registered Android OAuth client. Tap "Sign-in help" to see the exact fingerprint and stage trace, or use email/password sign-in.'
        );
        logGoogleSignInDiagnostics();
      } else if (err.includes('CONFIGURATION_ERROR')) {
        showAuthError('Google sign-in configuration could not be accepted by the provider. Open Sign-in help for the package and signing fingerprint, and verify the Android and Web OAuth registrations in the same Google Cloud project.');
      } else if (err.includes('ACTIVITY_NOT_ACTIVE')) {
        showAuthError('Google sign-in was interrupted because the app was not in the foreground. Reopen the app and retry.');
      } else if (err.includes('SIGN_IN_IN_PROGRESS')) {
        showAuthError('A Google sign-in request is already open. Wait for it to finish before starting another.');
      } else if (err.includes('CREDENTIAL_ERROR') || err.includes('CREDENTIAL_PROVIDER_CONFIGURATION') || err.includes('DEVELOPER_ERROR')) {
        showAuthError('Google sign-in configuration error: ' + (err.replace('CREDENTIAL_ERROR:', '').trim() || 'unknown') + '. Tap "Sign-in help" for details, or use email/password sign-in.');
        logGoogleSignInDiagnostics();
      } else if (err.includes('UNTRUSTED_ORIGIN')) {
        showAuthError('Google sign-in was blocked for security reasons. Restart the app and retry.');
      } else {
        showAuthError('Google sign-in failed: ' + (err || 'unknown error') + '. You can sign in with email/password.');
      }
      return;
    }

    try {
      let parsed = null;
      if (typeof dataJsonStr === 'string' && dataJsonStr.trim().length > 0) {
        try {
          parsed = JSON.parse(dataJsonStr);
        } catch (parseErr) {
          recordGoogleStage('JS_PARSE_ERROR', reqId, 'invalid_json');
        }
      } else if (typeof dataJsonStr === 'object' && dataJsonStr !== null) {
        parsed = dataJsonStr;
      }

      if (!parsed || !parsed.idToken) {
        recordGoogleStage('JS_PARSE_MISSING_TOKEN', reqId, '');
        resetGoogleBtn();
        return showAuthError('Invalid Google credential response: missing ID token.');
      }
      // Never log the token itself; length + credential type are enough for support.
      recordGoogleStage('JS_PARSE_OK', reqId, 'idTokenLength=' + String(parsed.idToken).length + ' credentialType=' + String(parsed.credentialType || 'unknown').split('.').pop());
      if (parsed.requestId && reqId && parsed.requestId !== reqId) {
        recordGoogleStage('JS_CALLBACK_REJECTED_STALE', reqId, 'payload_request_id_mismatch');
        resetGoogleBtn();
        return showAuthError('Google sign-in response did not match the active request. Please retry.');
      }

      if (googleBtnText) googleBtnText.textContent = 'Verifying with Sikho Trading...';
      recordGoogleStage('JS_BACKEND_REQUEST', reqId, 'POST /api/v1/auth/google');
      let res;
      try {
        res = await apiFetch('/api/v1/auth/google', {
          method: 'POST',
          headers: { 'X-Auth-Request-Id': reqId },
          timeoutMs: 30000,
          body: JSON.stringify({ idToken: parsed.idToken }),
        });
      } catch (backendErr) {
        recordGoogleStage('JS_BACKEND_ERROR', reqId, 'status=' + (backendErr.status || 'n/a') + ' code=' + (backendErr.code || 'n/a'));
        const statusText = backendErr.status ? ` (HTTP ${backendErr.status}${backendErr.code ? ', ' + backendErr.code : ''})` : '';
        showAuthError('The app could not complete Google sign-in on the server' + statusText + ': ' + (backendErr.message || 'verification failed') + ' You can retry or use email/password sign-in.');
        if (backendErr.status === 401) logGoogleSignInDiagnostics();
        return;
      }

      recordGoogleStage('JS_BACKEND_RESPONSE', reqId, 'status=200 tier=' + String(res.user?.tier || 'unknown'));
      if (res && res.token) {
        document.getElementById('auth-error-msg').style.display = 'none';
        const saved = completeAuthenticatedSession(res.token, res.user, res.account, true, res.entitlement, res.access);
        recordGoogleStage(saved ? 'JS_SESSION_SAVED' : 'JS_SESSION_SAVE_FAILED', reqId, 'secureSessionWrite=' + Boolean(saved) + ' tier=' + String(res.user?.tier || 'unknown'));
      } else {
        recordGoogleStage('JS_SESSION_MISSING_TOKEN', reqId, '');
        showAuthError('Google authentication succeeded but the app did not receive a session. Please retry.');
      }
    } catch (err) {
      recordGoogleStage('JS_UNEXPECTED_ERROR', reqId, String(err && err.message || err).substring(0, 120));
      showAuthError(err.message || 'Google verification failed on backend.');
    } finally {
      resetGoogleBtn();
      recordGoogleStage('JS_DONE', reqId, '');
    }
  };

  /** Sanitised, token-free JS stage trace for Google sign-in (max 60 entries). */
  function recordGoogleStage(stage, reqId, detail) {
    try {
      state.googleTrace = state.googleTrace || [];
      state.googleTrace.push({
        t: Date.now(),
        stage: String(stage || ''),
        req: String(reqId || '').slice(0, 64),
        detail: String(detail || '').slice(0, 160),
      });
      if (state.googleTrace.length > 60) state.googleTrace.shift();
      console.log('[GoogleAuthTrace] req=' + String(reqId || '').slice(0, 64) + ' ' + stage + (detail ? ' ' + detail : ''));
    } catch { }
  }

  async function handleGoogleSignIn(compatibility = false) {
    if (state.isGoogleSignInPending) return;

    const googleBtn = document.getElementById('btn-google-signin');
    const googleBtnText = document.getElementById('btn-google-signin-text');

    try {
      // 1. If running inside Android Native wrapper with Credential Manager bridge
      if (window.TradingzoneNative && typeof window.TradingzoneNative.startNativeGoogleSignIn === 'function') {
        state.isGoogleSignInPending = true;
        const reqId = `g_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        activeGoogleSignInRequestId = reqId;
        recordGoogleStage('JS_TAP', reqId, compatibility ? 'manual_compatibility_button' : 'button_pressed');
        if (googleBtn) googleBtn.disabled = true;
        if (googleBtnText) googleBtnText.textContent = 'Opening Google Sign-In...';

        // Native owns the 120s deadline; JS allows callback dispatch before its 125s guard.
        if (googleSignInTimeoutId) clearTimeout(googleSignInTimeoutId);
        googleSignInTimeoutId = setTimeout(() => {
          if (state.isGoogleSignInPending && activeGoogleSignInRequestId === reqId) {
            // Mark the request dead on BOTH sides so a late native callback can never authenticate.
            expiredGoogleRequestIds.add(reqId);
            recordGoogleStage('JS_TIMEOUT', reqId, 'afterMs=125000');
            if (window.TradingzoneNative && typeof window.TradingzoneNative.cancelNativeGoogleSignIn === 'function') {
              try { window.TradingzoneNative.cancelNativeGoogleSignIn(reqId); } catch { }
            }
            activeGoogleSignInRequestId = null;
            state.isGoogleSignInPending = false;
            if (googleBtn) googleBtn.disabled = false;
            if (googleBtnText) googleBtnText.textContent = 'Continue with Google';
            showAuthError('Google sign-in timed out waiting for the account picker. Check your connection and retry, or use email/password sign-in.');
          }
        }, 125000);

        // Immediately invoke native Credential Manager prompt with request ID
        recordGoogleStage('JS_NATIVE_CALL', reqId, 'startNativeGoogleSignIn');
        if (compatibility && typeof window.TradingzoneNative.startNativeGoogleSignInCompatible === 'function') {
          window.TradingzoneNative.startNativeGoogleSignInCompatible(GOOGLE_WEB_CLIENT_ID, reqId);
        } else {
          window.TradingzoneNative.startNativeGoogleSignIn(GOOGLE_WEB_CLIENT_ID, reqId);
        }
        return;
      }

      // 2. In browser fallback/testing environment: show clear instruction
      showAuthError('Native Google Sign-In requires an Android device. In browser mode, sign in with email and password.');
    } catch (err) {
      state.isGoogleSignInPending = false;
      if (activeGoogleSignInRequestId) expiredGoogleRequestIds.add(activeGoogleSignInRequestId);
      activeGoogleSignInRequestId = null;
      showAuthError(err.message || 'Failed to start Google sign-in.');
      if (googleBtn) googleBtn.disabled = false;
      if (googleBtnText) googleBtnText.textContent = 'Continue with Google';
    }
  }

  /**
   * Pulls the native Google Sign-In diagnostics (package, versionCode, signing SHA-1, Play
   * Services state, last exception) so the exact owner-side Cloud Console fix is visible.
   * SHA-1 fingerprints are public information, never credentials.
   */
  function logGoogleSignInDiagnostics() {
    try {
      if (window.TradingzoneNative && typeof window.TradingzoneNative.getGoogleSignInDiagnostics === 'function') {
        const raw = window.TradingzoneNative.getGoogleSignInDiagnostics();
        const diag = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
        console.warn('[GoogleSignInDiagnostics]', diag);
        const fingerprint = diag && diag.signingSha1 ? ` SHA-1: ${diag.signingSha1}` : '';
        const pkg = diag && diag.packageName ? ` Package: ${diag.packageName}` : '';
        const last = diag && diag.lastErrorCode ? ` Last error: ${diag.lastErrorCode}` : '';
        if (document.getElementById('auth-error-msg')) {
          showAuthError(
            'Google Sign-In diagnostics —' + pkg + fingerprint + last +
            '. Tap "Sign-in help" for the full stage trace. Email/password sign-in works meanwhile.'
          );
        }
      }
    } catch (e) {
      console.warn('Could not read Google sign-in diagnostics:', e);
    }
  }

  /** Owner-facing support surface: compact text report of the last Google sign-in attempt. */
  function showGoogleDiagnostics() {
    let native = {};
    try {
      if (window.TradingzoneNative && typeof window.TradingzoneNative.getGoogleSignInDiagnostics === 'function') {
        const raw = window.TradingzoneNative.getGoogleSignInDiagnostics();
        native = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw;
      }
    } catch (e) {
      native = { error: String(e && e.message || e) };
    }
    const jsTrace = (state.googleTrace || []).slice(-14).map((e) => `${new Date(e.t).toISOString().slice(11, 23)} ${e.stage}${e.detail ? ' — ' + e.detail : ''}`);
    const nativeTrace = Array.isArray(native.lastTrace)
      ? native.lastTrace.slice(-14).map((e) => `${new Date(Number(e.t) || Date.now()).toISOString().slice(11, 23)} ${e.stage}${e.detail ? ' — ' + e.detail : ''}`)
      : [];
    const lines = [
      `App: ${native.versionName || '?'} (${native.versionCode || '?'})`,
      `Package: ${native.packageName || '?'}`,
      `Signing SHA-1: ${native.signingSha1 || '?'}`,
      `Play Services: ${native.playServicesVersion || '?'} (status ${native.playServicesStatus})`,
      `Android SDK: ${native.androidSdkInt || '?'} • Activity: ${native.activityLifecycleState || '?'}`,
      `Web client: …${native.webClientIdSuffix || '?'}`,
      `Last credential type: ${native.lastCredentialType || 'none'}`,
      `Last error: ${native.lastErrorCode || 'none'}`,
      '',
      'JS stages:',
      ...(jsTrace.length ? jsTrace : ['(none)']),
      '',
      'Native stages:',
      ...(nativeTrace.length ? nativeTrace : ['(none)']),
    ].join('\n');
    console.log('[GoogleSignInDiagnosticsReport]\n' + lines);
    showBrandedAlert('Google Sign-In help', lines);
  }

  // =========================================================================
  // SERVER CONFIGURATION & MULTI-CANDIDATE DISCOVERY
  // =========================================================================
  function updateServerDisplay() {
    const lbl = document.getElementById('auth-server-label');
    if (lbl) {
      const displayUrl = API_BASE.replace(/^https?:\/\//, '');
      lbl.textContent = `Server: ${displayUrl}`;
    }
  }

  function openServerConfigModal() {
    const input = document.getElementById('input-server-url');
    if (input) input.value = API_BASE;
    const resEl = document.getElementById('server-test-result');
    if (resEl) {
      resEl.textContent = '';
      resEl.style.color = 'inherit';
    }
    const modal = document.getElementById('modal-server-config');
    if (modal) modal.classList.add('active');
  }

  function closeServerConfigModal() {
    const modal = document.getElementById('modal-server-config');
    if (modal) modal.classList.remove('active');
  }

  function applyServerPreset(url) {
    const input = document.getElementById('input-server-url');
    if (input) input.value = url;
  }

  async function testServerConnection() {
    const input = document.getElementById('input-server-url');
    const resEl = document.getElementById('server-test-result');
    const targetUrl = (input?.value || API_BASE).trim().replace(/\/+$/, '');
    if (!resEl) return;
    resEl.style.color = '#3B82F6';
    resEl.textContent = `Testing connection to ${targetUrl}...`;
    try {
      const ctrl = new AbortController();
      const tm = setTimeout(() => ctrl.abort(), 4000);
      const resp = await fetch(`${targetUrl}/health`, { signal: ctrl.signal });
      clearTimeout(tm);
      if (resp.ok) {
        const h = await resp.json().catch(() => ({}));
        resEl.style.color = '#10B981';
        resEl.textContent = `✓ Connected! (${h.status || 'OK'}, mode: ${h.mode || 'Active'})`;
      } else {
        resEl.style.color = '#EF4444';
        resEl.textContent = `✗ Server responded with HTTP ${resp.status}`;
      }
    } catch (e) {
      resEl.style.color = '#EF4444';
      resEl.textContent = `✗ Cannot reach server (${e.message || 'timed out'}). Check Wi-Fi or adb reverse.`;
    }
  }

  function saveServerConfig() {
    const input = document.getElementById('input-server-url');
    const resEl = document.getElementById('server-test-result');
    const newUrl = (input?.value || '').trim().replace(/\/+$/, '');
    if (!newUrl || !newUrl.startsWith('http')) {
      if (resEl) {
        resEl.style.color = '#EF4444';
        resEl.textContent = 'Please enter a valid URL starting with http:// or https://';
      }
      return;
    }
    API_BASE = newUrl;
    localStorage.setItem('tz_api_base', newUrl);
    updateServerDisplay();
    closeServerConfigModal();
    if (wsConn) {
      const oldSock = wsConn;
      wsConn = null;
      oldSock.onclose = null;
      oldSock.onerror = null;
      oldSock.onmessage = null;
      try { oldSock.close(); } catch {}
    }
    apiFetch('/api/v1/feed-health')
      .then((fh) => {
        if (fh) state.feedHealth = fh;
        connectRealtimeWebSocket();
        if (state.chartOpen) updateChartCountdownUI();
      })
      .catch(() => {
        connectRealtimeWebSocket();
      });
  }

  async function probeAndSelectServer() {
    const isNative = Boolean(window.TradingzoneNative);
    const isDevPicker = !isNative || (typeof window.TradingzoneNative.isDevServerPickerEnabled === 'function' && window.TradingzoneNative.isDevServerPickerEnabled());

    // In production release builds, hide developer server picker and NEVER probe private LAN addresses
    if (!isDevPicker) {
      const serverStatusEl = document.querySelector('.auth-server-status');
      if (serverStatusEl) serverStatusEl.style.display = 'none';
      if (isNative && typeof window.TradingzoneNative.getDefaultServerUrl === 'function') {
        API_BASE = window.TradingzoneNative.getDefaultServerUrl();
      } else {
        API_BASE = DEFAULT_HOST;
      }
      return;
    }

    if (localStorage.getItem('tz_api_base')) {
      API_BASE = localStorage.getItem('tz_api_base');
    } else {
      API_BASE = DEFAULT_HOST;
    }
    updateServerDisplay();
  }

  function completeAuthenticatedSession(token, user, account, isFreshLogin, entitlement, accessPolicy) {
    // Strip any legacy PIN/biometric flags and never trust cached client-side PRO tier until server verifies entitlement
    state.sessionGen = (state.sessionGen || 0) + 1;
    state.accessSeq = (state.accessSeq || 0) + 1;
    state.previousAccessMode = accessPolicy?.accessMode || account?.access?.accessMode || null;
    state.access = accessPolicy || null;
    state.accessResolved = Boolean(accessPolicy && typeof accessPolicy.fullFeatureAccess === 'boolean');
    state.indicators={sma20:false,ema50:false,bb20:false,vwap:false,rsi14:false};
    const resolvedTier = (isFreshLogin && entitlement && entitlement.tier === 'PRO') ? 'PRO' : 'FREE';
    const cleanUser = Object.assign({}, user || {}, {
      tier: resolvedTier,
      hasPin: false,
      biometricEnabled: false,
    });
    const cleanAccount = account ? Object.assign({}, account, { tier: resolvedTier }) : null;
    const saved = saveSessionSecure({ token, user: cleanUser, account: cleanAccount });
    if (!saved) {
      showAuthError('Secure session storage failed on this device. Please sign in again.');
      clearSessionSecure();
      if (window.TradingzoneNative && typeof window.TradingzoneNative.clearNativeGoogleCredentialState === 'function') {
        try { window.TradingzoneNative.clearNativeGoogleCredentialState(); } catch { }
      }
      showTopScreen('screen-auth');
      return false;
    }
    state.token = token;
    state.user = cleanUser;
    state.account = cleanAccount;
    if (isFreshLogin && entitlement && (entitlement.tier === 'PRO' || entitlement.tier === 'FREE')) {
      state.subscription = entitlement;
      state.entitlementResolved = true;
    } else {
      state.subscription = null;
      window.SikhoHistory?.clear();
      state.entitlementResolved = false;
    }
    if (accessPolicy) applyAccessPolicy(accessPolicy, state.accessSeq);
    enterMainWorkspace();
    return true;
  }

  function signOut(optionalNotice, opts = {}) {
    state.sessionGen = (state.sessionGen || 0) + 1;
    state.accessSeq = (state.accessSeq || 0) + 1;
    state.token = null;
    state.user = null;
    state.account = null;
    state.subscription = null;
    state.entitlementResolved = false;
    state.access = null;
    state.accessResolved = false;
    state.quotesMap = new Map();
    state.orderTicket.open=false;clearInterval(ticketQuoteTimer);ticketQuoteTimer=null;
    state.protectionModal = null;
    state.protectionDrag = null;
    if (typeof chartCandleCache !== 'undefined' && chartCandleCache?.clear) chartCandleCache.clear();
    state.lastTickTimestamps={};state.lastTickClientReceiveMs={};state.lastSeenQuoteReceipt={};state.lastRenderByInstrument={};state.providerDiagnostics={};state.wsSubscribed=new Set();
    window.SikhoHistory?.clear();
    document.getElementById('modal-history-csv')?.remove();
    stopFeedHealthPolling();
    clearTimeout(accessRetryTimer); accessRetryTimer = null;
    serverClockOffsetMs = 0;
    state.positionsData = { positions: [], holdings: [], activePositions: [], closedPositions: [] };
    state.orders = [];
    state.hasPendingOrders=false;
    state.watchlists = [];
    state.performance = null;
    clearSessionSecure();
    if (window.TradingzoneNative && typeof window.TradingzoneNative.clearNativeGoogleCredentialState === 'function') {
      try { window.TradingzoneNative.clearNativeGoogleCredentialState(); } catch { }
    }
    if (wsConn) {
      try { wsConn.close(); } catch { }
      wsConn = null;
    }
    notifyNativeUserTier();
    notifyNativeScreenState();
    toggleAuthMode('login');
    const emailEl = document.getElementById('auth-email');
    const passEl = document.getElementById('auth-password');
    if (emailEl && opts.preserveEmail) emailEl.value = opts.preserveEmail;
    if (passEl) passEl.value = '';
    if (optionalNotice) showAuthError(optionalNotice);
    showTopScreen('screen-auth');
    syncNativeSystemBarTheme();
  }

  // =========================================================================
  // GLOBAL CONNECTIVITY / FRESHNESS / MAINTENANCE / UPDATE BANNER & ONBOARDING
  // =========================================================================
  let reconnectBannerTimer = null;
  function updateAppStatusBanner() {
    const el = document.getElementById('app-connectivity-banner');
    if (!el) return;
    const esc = window.SikhoUX?.escape || ((s) => String(s ?? ''));
    // Priority precedence: Maintenance > Device Offline > Reconnecting > Provider Stale > Optional/Mandatory Update
    if (state.maintenance?.active) {
      el.className = 'app-status-banner is-maintenance';
      const eta = state.maintenance.expectedReturnIso ? ` Expected return: ${new Date(state.maintenance.expectedReturnIso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST.` : '';
      el.innerHTML = `<span>Scheduled maintenance: ${esc(state.maintenance.message || 'Upgrading infrastructure.')}${esc(eta)}</span><button type="button" class="app-status-banner-btn" onclick="window.TZApp.checkServerHealthStatus()">Retry</button>`;
      el.hidden = false;
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      const lastTs = state.lastAnyTickReceiveMs ? ` (last updated ${new Date(state.lastAnyTickReceiveMs).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })} IST)` : '';
      el.className = 'app-status-banner is-offline';
      el.innerHTML = `<span>You are offline — showing cached data${esc(lastTs)}.</span><button type="button" class="app-status-banner-btn" onclick="window.TZApp.retryConnectivityNow()">Check</button>`;
      el.hidden = false;
      return;
    }
    if (state.token && !state.wsConnected && wsReconnectAttempts > 0) {
      el.className = 'app-status-banner is-reconnecting';
      el.innerHTML = `<span>Reconnecting to live feed (Attempt ${wsReconnectAttempts})…</span><button type="button" class="app-status-banner-btn" onclick="window.TZApp.retryConnectivityNow()">Retry now</button>`;
      el.hidden = false;
      return;
    }
    if (state.token && state.wsConnected && state.feedHealth?.marketSession?.isMarketOpen && state.lastAnyTickReceiveMs && (Date.now() - state.lastAnyTickReceiveMs > 15000)) {
      el.className = 'app-status-banner is-stale';
      el.innerHTML = `<span>Live prices delayed — showing last received quotes.</span><button type="button" class="app-status-banner-btn" onclick="window.TZApp.retryExploreData()">Refresh</button>`;
      el.hidden = false;
      return;
    }
    const cv = state.clientVersion;
    const currentCode = Number(window.TradingzoneNative?.getVersionCode?.() || 26);
    if (cv && !state.updateBannerDismissed && ((cv.minSupportedCode && cv.minSupportedCode > currentCode) || (cv.latestCode && cv.latestCode > currentCode))) {
      const isMandatory = Boolean(cv.minSupportedCode && cv.minSupportedCode > currentCode);
      el.className = 'app-status-banner is-update';
      const url = cv.updateUrl || 'https://sikhotrading.in/';
      el.innerHTML = `<span>${isMandatory ? 'Update required to continue.' : 'A newer version of Sikho Trading is available.'}</span><span style="display:flex;gap:6px;"><a class="app-status-banner-btn" href="${esc(url)}" target="_blank" rel="noopener">Update</a>${isMandatory ? '' : '<button type="button" class="app-status-banner-btn" onclick="window.TZApp.dismissUpdateBanner()">Later</button>'}</span>`;
      el.hidden = false;
      return;
    }
    el.hidden = true;
  }

  function retryConnectivityNow() {
    wsReconnectAttempts = 0;
    connectRealtimeWebSocket();
    checkServerHealthStatus();
    if (state.token) {
      pollAccessPolicy();
      refreshAccountAndPortfolio();
    }
    updateAppStatusBanner();
  }

  function dismissUpdateBanner() {
    state.updateBannerDismissed = true;
    updateAppStatusBanner();
  }

  async function checkServerHealthStatus() {
    try {
      const res = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(6000) });
      const data = await res.json().catch(() => null);
      if (data) {
        state.maintenance = data.maintenance || { active: false };
        state.clientVersion = data.clientVersion || null;
        updateAppStatusBanner();
      }
    } catch {}
  }

  function getOnboardingKey() {
    const uid = state.user?.userId || state.user?.id;
    return uid ? `sikho_onboarding_${uid}` : null;
  }

  function markOnboardingStep(stepKey) {
    const key = getOnboardingKey();
    if (!key) return;
    try {
      const cur = JSON.parse(localStorage.getItem(key) || '{}');
      if (cur.dismissed || cur[stepKey]) return;
      cur[stepKey] = true;
      localStorage.setItem(key, JSON.stringify(cur));
      renderOnboardingCard();
    } catch {}
  }

  function dismissOnboardingCard() {
    const key = getOnboardingKey();
    if (!key) return;
    try {
      const cur = JSON.parse(localStorage.getItem(key) || '{}');
      cur.dismissed = true;
      localStorage.setItem(key, JSON.stringify(cur));
    } catch {}
    const slot = document.getElementById('onboarding-card-slot');
    if (slot) slot.innerHTML = '';
  }

  function renderOnboardingCard() {
    const slot = document.getElementById('onboarding-card-slot');
    if (!slot || !state.user) return;
    const key = getOnboardingKey();
    if (!key) { slot.innerHTML = ''; return; }
    let prog = {};
    try { prog = JSON.parse(localStorage.getItem(key) || '{}'); } catch {}
    if (prog.dismissed) { slot.innerHTML = ''; return; }
    const hasTrades = (state.orders || []).length > 0;
    const hasWl = (state.watchlists?.[0]?.instruments || []).length > 0;
    const s1 = Boolean(prog.chart || hasTrades);
    const s2 = Boolean(prog.watchlist || hasWl);
    const s3 = Boolean(prog.trade || hasTrades);
    const allDone = s1 && s2 && s3;
    const esc = window.SikhoUX?.escape || ((s) => String(s ?? ''));
    const firstName = (state.user.name || 'Trader').split(' ')[0];
    if (allDone) {
      slot.innerHTML = `<div class="onboarding-card" role="status"><div class="onboarding-header"><strong>✓ All 3 setup steps complete!</strong><button type="button" class="link-btn" style="font-size:12px;" onclick="window.TZApp.dismissOnboardingCard()">Dismiss</button></div><div class="section-sub-dark">Your Sikho Trading workspace is ready for practice.</div></div>`;
      return;
    }
    const nextAction = !s1
      ? `<button type="button" class="ux-state-cta" style="margin-top:0;width:100%;" onclick="window.TZApp.openChartByGlobalId('NSE:NIFTY50')">Open NIFTY 50 Chart</button>`
      : !s2
        ? `<button type="button" class="ux-state-cta" style="margin-top:0;width:100%;" onclick="window.TZApp.openSearchModal()">Add a Symbol to Watchlist</button>`
        : `<button type="button" class="ux-state-cta" style="margin-top:0;width:100%;" onclick="window.TZApp.switchMainTab('explore')">Place Your First Paper Trade</button>`;
    slot.innerHTML = `<div class="onboarding-card"><div class="onboarding-header"><strong>Welcome, ${esc(firstName)}!</strong><button type="button" class="link-btn" style="font-size:12px;" onclick="window.TZApp.dismissOnboardingCard()">Skip for now</button></div><div class="onboarding-steps"><div class="onboarding-step ${s1 ? 'is-done' : ''}"><span>${s1 ? '✓' : '1.'}</span><span>Explore a live chart</span></div><div class="onboarding-step ${s2 ? 'is-done' : ''}"><span>${s2 ? '✓' : '2.'}</span><span>Add a symbol to Watchlist</span></div><div class="onboarding-step ${s3 ? 'is-done' : ''}"><span>${s3 ? '✓' : '3.'}</span><span>Place your first paper trade</span></div></div>${nextAction}</div>`;
  }

  // =========================================================================
  // 2. MAIN WORKSPACE INITIALIZATION & REAL-TIME WEBSOCKET
  // =========================================================================
  let tradingReconcileTimer, accessPollTimer, accessRetryTimer;
  function scheduleTradingReconcile(){
    clearTimeout(tradingReconcileTimer);tradingReconcileTimer=setTimeout(async()=>{if(!state.token)return;await refreshAccountAndPortfolio();if(state.mainTab==='history')window.SikhoHistory?.show(apiFetch);},180);
  }
  function applyAccessPolicy(policy, seq) {
    if (!policy) return;
    if (seq && seq < (state.accessSeq || 0)) return;
    // Never let an unauthenticated fallback overwrite an authenticated FREE_LAUNCH session
    if (state.token && policy.accessMode === 'FREE_LAUNCH' && !policy.fullFeatureAccess) return;
    if (seq) state.accessSeq = seq;
    if (typeof policy.appOpenAdUnitId === 'string') window.TradingzoneNative?.configureAppOpenUnit?.(policy.appOpenAdUnitId);
    const wasFullAccess = Boolean(state.access?.fullFeatureAccess);
    const wasResolved = Boolean(state.accessResolved);
    const previousMode = state.access?.accessMode || state.previousAccessMode;
    state.access = policy;
    state.accessResolved = true;
    state.previousAccessMode = policy.accessMode;
    const modeChanged = Boolean(previousMode && previousMode !== policy.accessMode);
    const accessChanged = !wasResolved || wasFullAccess !== Boolean(policy.fullFeatureAccess);
    if (modeChanged) {
      if (policy.accessMode === 'STANDARD') {
        const exposure = (state.positionsData?.positions || []).some(p => p.globalInstrumentId === state.activeInstrument?.globalId && p.quantity !== 0);
        if (state.chartOpen && isInstrumentRestrictedForFree(state.activeInstrument) && !exposure) closeChartWorkspace();
        if (state.optionChain && !optionChainFreeAllowed(state.optionChain.underlying)) closeOptionChainModal();
      }
      state.quotesMap = new Map();
      window.SikhoUX?.notify(policy.accessMode === 'FREE_LAUNCH' ? 'Free Launch — all features unlocked' : 'Introductory access has ended. Existing positions can still be viewed and reduced.');
    }
    if (modeChanged || accessChanged) {
      renderBenchmarkIndexStrip();
      renderExploreStocksList();
      renderExploreFnoLists();
      renderCommoditiesList();
      renderWatchlistsTab();
    }
    const label = document.getElementById('launch-access-label');
    if (label) {
      label.textContent = policy.label;
      label.hidden = policy.accessMode !== 'FREE_LAUNCH';
    }
  }
  async function pollAccessPolicy() {
    if (!state.token) return;
    const token = state.token;
    const gen = state.sessionGen;
    const reqSeq = (state.accessSeq || 0) + 1;
    try {
      const r = await apiFetch('/api/v1/access');
      if (token !== state.token || gen !== state.sessionGen) return;
      if (r && r.access) {
        applyAccessPolicy(r.access, reqSeq);
      }
      if (r && r.entitlement && (r.entitlement.tier === 'PRO' || r.entitlement.tier === 'FREE')) {
        state.subscription = r.entitlement;
        state.entitlementResolved = true;
        if (state.user) state.user.tier = r.entitlement.tier;
        notifyNativeUserTier();
      } else if (r && r.entitlementResolved === false) {
        state.entitlementResolved = false;
        notifyNativeUserTier();
      }
      renderProfileStatsUI();
    } catch {
      // Transient error: keep existing access policy, never falsely lock; retry shortly if still unresolved
      if (!state.accessResolved && token === state.token && gen === state.sessionGen) {
        clearTimeout(accessRetryTimer);
        accessRetryTimer = setTimeout(() => { pollAccessPolicy(); }, 5000);
      }
    }
  }
  async function clearCurrentWatchlist(){
    const list=state.watchlists[0];if(!list)return;
    if(!await new Promise(resolve=>showConfirmSheet('Clear watchlist','Remove all instruments from this watchlist? Positions and trading history are preserved.',resolve)))return;
    await apiFetch('/api/v1/watchlists',{method:'POST',body:JSON.stringify({id:list.id,name:list.name,instruments:[]})});await loadWatchlists();
  }
  async function enterMainWorkspace() {
    clearInterval(accessPollTimer);accessPollTimer=setInterval(pollAccessPolicy,30000);
    pollAccessPolicy();
    showTopScreen('screen-main');
    (window.requestIdleCallback||((fn)=>setTimeout(fn,150)))(()=>ensureChartLibrary().catch(()=>{}));
    notifyNativeUserTier();
    notifyNativeScreenState();
    updateProfileHeaderUI();
    connectRealtimeWebSocket();
    startFeedHealthPolling();
    checkServerHealthStatus();
    updateAppStatusBanner();
    await Promise.all([
      refreshFeedHealth(),
      refreshAccountAndPortfolio(),
      loadExploreData(),
      loadWatchlists(),
    ]);
    renderOnboardingCard();
    updateAppStatusBanner();
  }

  function updateProfileHeaderUI() {
    if (!state.user) return;
    const initial = (state.user.name || 'T').charAt(0).toUpperCase();
    document.getElementById('header-avatar-btn').textContent = initial;
    document.getElementById('prof-avatar-circle').textContent = initial;
    document.getElementById('prof-user-name').textContent = state.user.name || 'Trader';
    document.getElementById('prof-user-email').textContent = state.user.email || '';
  }

  async function refreshFeedHealth() {
    try {
      const h = await apiFetch('/api/v1/feed-health');
      state.feedHealth = h;
      // Measured clock correction: the backend timestamp lets the countdown follow the exchange
      // clock even when the phone's clock is skewed. Network latency shifts this by ~RTT/2.
      noteServerClock(h.serverTimestamp);
      const src = h.activeProvider?.source || 'UPSTOX';
      const mktOpen = h.marketSession?.isMarketOpen ? 'Market OPEN' : 'Market CLOSED';
      const provEl = document.getElementById('header-provider-label');
      if (provEl) provEl.textContent = `${src} V3 • ${mktOpen} • Virtual Funds`;
      document.getElementById('prof-provider-title').textContent = `Primary Provider: ${src} (${h.activeProvider?.status || 'ACTIVE'})`;
      document.getElementById('prof-provider-sub').textContent =
        h.activeProvider?.message || h.marketSession?.note || '';
    } catch { }
  }

  // =========================================================================
  // SERVER CLOCK CORRECTION & FEED-HEALTH POLLING
  // =========================================================================
  let feedHealthPollTimer = null;
  let serverClockOffsetMs = 0;

  function noteServerClock(serverTimestamp) {
    const ts = Number(serverTimestamp);
    if (!Number.isFinite(ts) || ts <= 0) return;
    // Smooth the measured offset to avoid jitter from individual requests.
    const sample = ts - Date.now();
    serverClockOffsetMs = serverClockOffsetMs === 0 ? sample : Math.round(serverClockOffsetMs * 0.7 + sample * 0.3);
  }

  function serverNowMs() {
    return Date.now() + serverClockOffsetMs;
  }

  function startFeedHealthPolling() {
    stopFeedHealthPolling();
    feedHealthPollTimer = setInterval(() => {
      if (state.token) refreshFeedHealth();
    }, 30000);
  }

  function stopFeedHealthPolling() {
    if (feedHealthPollTimer) {
      clearInterval(feedHealthPollTimer);
      feedHealthPollTimer = null;
    }
  }

  async function refreshAccountAndPortfolio() {
    try {
      const sessionToken=state.token;
      const [acc, posRes, ordRes, perfRes] = await Promise.all([
        apiFetch('/api/v1/account').catch(() => null),
        apiFetch('/api/v1/positions').catch(() => null),
        apiFetch('/api/v1/orders').catch(() => null),
        apiFetch('/api/v1/account/performance').catch(() => null),
      ]);
      if(state.token!==sessionToken)return;
      if (acc && !acc.error) {
        state.account = acc;
        applyAccessPolicy(acc.access);
      }
      if (posRes) {
        state.positionsData = posRes;
      }
      if (ordRes && Array.isArray(ordRes.orders)) {
        state.orders = ordRes.orders;
        state.hasPendingOrders=Boolean(ordRes.hasPendingOrders);
      }
      if (perfRes) {
        state.performance = perfRes;
      }

      const resolvedSub = acc?.entitlement || null;
      if (resolvedSub && (resolvedSub.tier === 'PRO' || resolvedSub.tier === 'FREE')) {
        state.subscription = resolvedSub;
        state.entitlementResolved = true;
        if (state.user) {
          state.user.tier = resolvedSub.tier;
        }
        if (state.account) {
          state.account.tier = resolvedSub.tier;
        }
        if (state.token && state.user) {
          saveSessionSecure({ token: state.token, user: state.user, account: state.account });
        }
      } else {
        // Fail closed on temporary billing/entitlement outage: never grant PRO or request ads while unresolved
        state.subscription = {
          tier: 'FREE',
          status: 'EXPIRED',
          entitlementSource: 'NONE',
          statusLabel: 'Membership status unavailable (Retrying...)',
          isComplimentary: false,
        };
        state.entitlementResolved = false;
        if (state.user) state.user.tier = 'FREE';
        if (state.account) state.account.tier = 'FREE';
      }

      renderAccountBalancesUI();
      renderPortfolioTab();
      renderOrdersTab();
      renderProfileStatsUI();
      renderExploreStocksList();
      renderExploreFnoLists();
      renderCommoditiesList();
      reconcileActiveProtectionState();
      if (state.chartOpen && state.activeInstrument) {
        renderChartBottomTradeBar(state.activeInstrument);
        renderChartProtectionOverlay();
      }
      notifyNativeScreenState();
      notifyNativeUserTier();
    } catch { }
  }

  function renderProfileStatsUI() {
    updateProfileHeaderUI();
    const isPro = isProUser();
    const isComplimentary = Boolean(
      isPro &&
      (state.subscription?.isComplimentary || state.subscription?.entitlementSource === 'COMPLIMENTARY_GRANT')
    );
    const badgeEl = document.getElementById('prof-tier-badge');
    if (badgeEl) {
      if (!state.entitlementResolved) {
        badgeEl.textContent = 'VERIFYING...';
        badgeEl.className = 'tier-pill-free';
      } else if (isComplimentary) {
        badgeEl.textContent = 'COMPLIMENTARY PRO';
        badgeEl.className = 'tier-pill-pro';
      } else if (isPro) {
        badgeEl.textContent = 'PREMIUM PRO';
        badgeEl.className = 'tier-pill-pro';
      } else {
        badgeEl.textContent = 'FREE PLAN';
        badgeEl.className = 'tier-pill-free';
      }
    }
    const subTitle = document.getElementById('prof-sub-title');
    const subDesc = document.getElementById('prof-sub-desc');
    const subBtn = document.getElementById('prof-btn-manage-sub');
    if (subTitle && subDesc && subBtn) {
      if (!state.entitlementResolved) {
        subTitle.textContent = state.subscription?.statusLabel || 'Verifying Membership...';
        subDesc.textContent = 'Free-tier rules enforced while verifying membership • Existing positions remain accessible for exit.';
        subBtn.textContent = 'Retry ➔';
      } else if (isComplimentary) {
        subTitle.textContent = state.subscription?.statusLabel || 'Premium — complimentary test access';
        subDesc.textContent = 'Owner-Approved Test Access • All Equities, F&O & MCX Commodities • Zero Ads';
        subBtn.textContent = 'Manage Plan ➔';
      } else if (isPro) {
        subTitle.textContent = 'Sikho Trading Premium Active';
        subDesc.textContent = 'Unlimited Access • All Equities, F&O & MCX Commodities • Zero Ads';
        subBtn.textContent = 'Manage Plan ➔';
      } else {
        subTitle.textContent = 'Sikho Trading Free Tier';
        subDesc.textContent = 'NIFTY & BANKNIFTY Futures & Options Practice';
        subBtn.textContent = 'Upgrade ➔';
      }
    }

    if(state.access?.accessMode==='FREE_LAUNCH'){
      if(!isPro && badgeEl)badgeEl.textContent='FREE LAUNCH';
      if(!isPro && subTitle)subTitle.textContent=state.access.label;
      if(!isPro && subDesc)subDesc.textContent='Introductory access supported by ads. Capital changes use the approved presets.';
      if(subBtn)subBtn.hidden=true;
    }else if(subBtn)subBtn.hidden=false;
    if (state.performance) {
      const session=state.performance.session || state.performance.currentSession || {};
      const lifetime=state.performance.lifetime || {};
      const cur={...session,realizedPnlINR:Number(session.realizedPnlPaise||0)/100,winRatePercent:session.tradesCount?100*Number(session.winTradesCount||0)/session.tradesCount:0};
      const life={...lifetime,netPnlINR:Number(lifetime.lifetimeNetTradingPnlPaise||0)/100,totalChargesINR:Number(lifetime.lifetimeChargesPaise||0)/100,totalClosedTrades:lifetime.lifetimeTradesCount||0,winRatePercent:lifetime.winRatePct||0};

      const sessPnlEl = document.getElementById('prof-session-pnl');
      if (sessPnlEl) {
        const pnl = Number(cur.realizedPnlINR || 0);
        sessPnlEl.textContent = (pnl >= 0 ? '+' : '') + fmtINR(pnl);
        sessPnlEl.style.color = pnl >= 0 ? '#C7F542' : '#EF4444';
      }

      const sessWrEl = document.getElementById('prof-session-winrate');
      if (sessWrEl) {
        sessWrEl.textContent = (Number(cur.winRatePercent || 0)).toFixed(1) + '%';
      }

      const lifePnlEl = document.getElementById('prof-lifetime-pnl');
      if (lifePnlEl) {
        const netPnl = Number(life.netPnlINR || 0);
        lifePnlEl.textContent = (netPnl >= 0 ? '+' : '') + fmtINR(netPnl);
        lifePnlEl.style.color = netPnl >= 0 ? '#0F172A' : '#EF4444';
      }

      const lifeChgEl = document.getElementById('prof-lifetime-charges');
      if (lifeChgEl) {
        lifeChgEl.textContent = fmtINR(Number(life.totalChargesINR || 0));
      }

      const lifeTrdEl = document.getElementById('prof-lifetime-trades');
      if (lifeTrdEl) {
        lifeTrdEl.textContent = String(life.totalClosedTrades || 0);
      }

      const lifeWrEl = document.getElementById('prof-lifetime-winrate');
      if (lifeWrEl) {
        lifeWrEl.textContent = (Number(life.winRatePercent || 0)).toFixed(1) + '%';
      }
    }
  }

  function renderAccountBalancesUI() {
    if (!state.account) return;
    const avail = fmtINR(state.account.availableBalanceINR);
    const cash = fmtINR(state.account.cashBalanceINR);
    const locked = fmtINR(state.account.lockedMarginINR);

    document.getElementById('explore-avail-balance').textContent = avail;
    document.getElementById('prof-cash-balance').textContent = cash;
    document.getElementById('prof-avail-balance').textContent = avail;
    document.getElementById('prof-locked-balance').textContent = locked;
    document.getElementById('ticket-avail-bal').textContent = avail;

    const allPos = state.positionsData.positions || [];
    const totalUnrealized = allPos.reduce((acc, p) => acc + (p.quantity !== 0 ? Number(p.unrealizedPnlINR || 0) : 0), 0);
    const totalRealized = allPos.reduce((acc, p) => acc + Number(p.realizedPnlINR || 0), 0);
    const totalEquity = Number(state.account.cashBalanceINR || 0) + totalUnrealized;

    document.getElementById('port-total-equity').textContent = fmtINR(totalEquity);
    document.getElementById('port-avail-margin').textContent = avail;
    document.getElementById('port-locked-margin').textContent = locked;

    const uEl = document.getElementById('port-unrealized-pnl');
    uEl.textContent = (totalUnrealized >= 0 ? '+' : '') + fmtINR(totalUnrealized);
    uEl.className = 'summary-sub-val ' + (totalUnrealized >= 0 ? 'val-pos-dark' : 'val-neg');

    const rEl = document.getElementById('port-realized-pnl');
    rEl.textContent = (totalRealized >= 0 ? '+' : '') + fmtINR(totalRealized);
    rEl.className = 'summary-sub-val ' + (totalRealized >= 0 ? 'val-pos-dark' : 'val-neg');
  }

  // =========================================================================
  // 3. MARKETS TAB: BENCHMARK STRIP, STOCKS, F&O & MCX COMMODITIES DISCOVERY
  // =========================================================================
  let searchDebounceTimer=null,searchRequestSeq=0,searchRequestController=null;
  let secondaryCataloguePromise=null, secondaryCatalogueLoadedFor=null;
  const prominentSymbols=['RELIANCE','TCS','TTML','HDFCBANK','INFY','ICICIBANK','SBIN','BHARTIARTL','ITC','KOTAKBANK','TATAMOTORS','WIPRO','MARUTI','SUNPHARMA','BAJFINANCE','HINDUNILVR'];
  const sortStocks=(a,b)=>{const rank=x=>{const p=prominentSymbols.indexOf(x.symbol);return p<0?999:p;};return rank(a)-rank(b)||a.symbol.localeCompare(b.symbol);};
  async function loadSecondaryCatalogue(){
   if(secondaryCatalogueLoadedFor===state.token)return;
   if(secondaryCataloguePromise){await secondaryCataloguePromise;return;}
   const sessionToken=state.token;
   secondaryCataloguePromise=Promise.allSettled([
    ['/api/v1/instruments?segment=FUTIDX&limit=12',r=>{state.exploreFnoIndices=r.instruments||[];seedQuotesFromInstruments(state.exploreFnoIndices);renderExploreFnoLists();}],
    ['/api/v1/instruments?segment=FUTSTK&limit=16',r=>{state.exploreFnoStocks=r.instruments||[];seedQuotesFromInstruments(state.exploreFnoStocks);renderExploreFnoLists();}],
    ['/api/v1/commodities',r=>{state.commodities=r;renderCommoditiesList();}],
    ['/api/v1/commodities/specs',r=>{state.commoditySpecs=r.specs||{};}]
   ].map(async([path,apply])=>{const r=await apiFetch(path);if(state.token===sessionToken)apply(r);}));
   try{const results=await secondaryCataloguePromise;if(results.every(r=>r.status==='fulfilled'))secondaryCatalogueLoadedFor=sessionToken;
    else if(state.token===sessionToken){window.SikhoUX.listState('explore-fno-indices-list','Some instruments are unavailable. Retry when connected.',true);}
   }finally{secondaryCataloguePromise=null;}
  }
  async function loadExploreData() {
 const sessionToken=state.token;
 for(const id of ['explore-stocks-list','explore-fno-indices-list','explore-fno-stocks-list'])window.SikhoUX.listState(id,'Loading instruments…');
 await Promise.allSettled([
  (async()=>{try{const r=await apiFetch('/api/v1/indices?limit=50');if(state.token!==sessionToken)return;state.indices=(r.indices||[]).sort((a,b)=>{const order=['NIFTY 50','BANKNIFTY','SENSEX','FINNIFTY','MIDCPNIFTY','NIFTY IT','NIFTY PHARMA','NIFTY METAL','BANKEX'];const rank=x=>{const i=order.indexOf(getIndexCanonicalKey(x));return i<0?999:i;};return rank(a)-rank(b)||a.symbol.localeCompare(b.symbol);});seedQuotesFromInstruments(state.indices);renderBenchmarkIndexStrip();loadUserIndexPreferences().catch(()=>{});}catch{}})(),
  (async()=>{try{const r=await apiFetch('/api/v1/instruments?segment=EQUITY_STOCK&limit=30');if(state.token!==sessionToken)return;state.exploreStocks=(r.instruments||[]).sort(sortStocks);seedQuotesFromInstruments(state.exploreStocks);renderExploreStocksList();}catch{window.SikhoUX.listState('explore-stocks-list','Instruments could not load. Check your connection.',true);}})()
 ]);
 setTimeout(()=>{if(state.token===sessionToken)loadSecondaryCatalogue();},350);
}

  function getIndexCanonicalKey(inst) {
    const sym = (inst.symbol || '').toUpperCase().replace(/\s+/g, '');
    const name = (inst.name || '').toUpperCase().replace(/\s+/g, '');
    const ts = (inst.tradingSymbol || '').toUpperCase().replace(/\s+/g, '');
    if (sym === 'NIFTY50' || sym === 'NIFTY' || name.includes('NIFTY50') || ts === 'NIFTY') return 'NIFTY 50';
    if (sym === 'BANKNIFTY' || name.includes('BANKNIFTY') || name.includes('NIFTYBANK') || ts === 'BANKNIFTY') return 'BANKNIFTY';
    if (sym === 'SENSEX' || name.includes('SENSEX') || ts === 'SENSEX') return 'SENSEX';
    if (sym === 'FINNIFTY' || name.includes('FINNIFTY') || ts === 'FINNIFTY') return 'FINNIFTY';
    if (sym === 'MIDCPNIFTY' || name.includes('MIDCPNIFTY') || ts === 'MIDCPNIFTY') return 'MIDCPNIFTY';
    if (sym === 'BANKEX' || name.includes('BANKEX') || ts === 'BANKEX') return 'BANKEX';
    if (sym.includes('IT') || name.includes('NIFTYIT') || ts.includes('NIFTYIT')) return 'NIFTY IT';
    if (sym.includes('PHARMA') || name.includes('PHARMA')) return 'NIFTY PHARMA';
    if (sym.includes('METAL') || name.includes('METAL')) return 'NIFTY METAL';
    return sym || name;
  }

  async function loadUserIndexPreferences() {
    const defaultIndices = ['NSE:NIFTY 50:99926000', 'NSE:BANKNIFTY:99926009', 'BSE:SENSEX:99919000'];
    const storageKey = 'tradingzone_indices_pref_' + (state.user?.id || 'guest');
    try {
      const cached = localStorage.getItem(storageKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed) && parsed.length === 3) {
          state.selectedIndices = parsed;
        }
      }
    } catch { }

    if (state.token) {
      try {
        const res = await apiFetch('/api/v1/user/preferences/indices');
        if (res && Array.isArray(res.selectedIndices) && res.selectedIndices.length === 3) {
          state.selectedIndices = res.selectedIndices;
          try {
            localStorage.setItem(storageKey, JSON.stringify(state.selectedIndices));
          } catch { }
        }
      } catch { }
    }

    if (!state.selectedIndices || state.selectedIndices.length !== 3) {
      state.selectedIndices = defaultIndices;
    }
  }

  function getActiveTop3Indices() {
    const pref = state.selectedIndices || ['NSE:NIFTY 50:99926000', 'NSE:BANKNIFTY:99926009', 'BSE:SENSEX:99919000'];
    const list = [];
    for (const gid of pref) {
      let inst = state.indices.find(i => i.globalId === gid);
      if (!inst) {
        inst = state.indices.find(i => {
          const k = getIndexCanonicalKey(i);
          return gid.toUpperCase().includes(k) || (i.symbol && gid.toUpperCase().includes(i.symbol.toUpperCase()));
        });
      }
      if (inst) {
        list.push(inst);
      }
    }
    // If fewer than 3 found, fill from state.indices
    for (const i of state.indices) {
      if (list.length >= 3) break;
      if (!list.some(existing => existing.globalId === i.globalId)) {
        list.push(i);
      }
    }
    return list.slice(0, 3);
  }

  function renderBenchmarkIndexStrip() {
    const strip = document.getElementById('benchmark-index-strip');
    if (!strip) return;
    const top3 = getActiveTop3Indices();
    const cardsHtml = top3
      .map((inst) => {
        const isRestricted = !isProUser() && isInstrumentRestrictedForFree(inst);
        const avatarHtml = window.InstrumentIdentity
          ? window.InstrumentIdentity.renderInstrumentAvatar(inst, 22, 'idx-mini-avatar')
          : '';

        if (isRestricted) {
          return `
            <div class="index-card-mini" onclick="window.TZApp.showSubscriptionUpgradePrompt('${inst.symbol}')" style="border:1px solid rgba(245,158,11,0.35);">
              <div class="idx-card-top">
                <div style="display:flex;align-items:center;gap:6px;">
                  ${avatarHtml}
                  <span class="idx-name">${inst.symbol}</span>
                </div>
                <span class="expiry-e-badge" style="background:#f59e0b;color:#000;font-weight:700;">PRO</span>
              </div>
              <div class="idx-card-bottom">
                <span class="idx-ltp" style="font-size:12.5px;color:#f59e0b;font-weight:700;">🔒 LOCKED</span>
                <span class="idx-chg" style="color:#0ea5e9;font-size:11px;font-weight:700;">Upgrade ➔</span>
              </div>
            </div>
          `;
        }
        const q = (inst.globalId && state.quotesMap?.get(inst.globalId)) || inst.latestQuote;
        const ptsPct = formatPointsAndPct(q);
        const isDerivative = inst.instrumentType === 'FUTIDX' || inst.instrumentType === 'OPTIDX';
        const eBadge = isDerivative && inst.expiry ? `<span class="expiry-e-badge">${inst.expiry}</span>` : '';
        const ltpDisplay = q && q.ltp !== undefined && q.ltp !== null && q.ltp > 0 ? fmtNum(q.ltp) : '—';
        const chgDisplay = q && q.ltp !== undefined && q.ltp !== null && q.ltp > 0 ? ptsPct.text : '';
        return `
          <div class="index-card-mini" onclick="window.TZApp.openChartByGlobalId('${inst.globalId}')">
            <div class="idx-card-top">
              <div style="display:flex;align-items:center;gap:6px;">
                ${avatarHtml}
                <span class="idx-name">${inst.symbol}</span>
              </div>
              ${eBadge}
            </div>
            <div class="idx-card-bottom">
              <span class="idx-ltp" data-ltp-id="${inst.globalId}">${ltpDisplay}</span>
              <span class="idx-chg ${ptsPct.cls}" data-chg-id="${inst.globalId}">${chgDisplay}</span>
            </div>
          </div>
        `;
      })
      .join('');

    strip.innerHTML =
      cardsHtml +
      `
      <div class="customize-indices-pill-card" onclick="window.TZApp.openCustomizeIndicesModal()" title="Customize Top 3 Indices">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
        </svg>
        <span>Customize</span>
      </div>
      <div class="all-indices-pill-card" onclick="window.TZApp.openAllIndicesModal()">
        <span>All Indices</span>
        <span style="font-size:10px;color:var(--text-on-black-secondary);">${state.indices.length}+ indices ➔</span>
      </div>
    `;
  }

  let tempSelectedIndices = [];

  function openCustomizeIndicesModal() {
    tempSelectedIndices = [...(state.selectedIndices || ['NSE:NIFTY 50:99926000', 'NSE:BANKNIFTY:99926009', 'BSE:SENSEX:99919000'])];
    renderCustomizeIndicesModal();
    const m = document.getElementById('modal-customize-indices');
    if (m) {
      m.style.display = 'flex';
      m.classList.add('active');
    }
  }

  function closeCustomizeIndicesModal() {
    const m = document.getElementById('modal-customize-indices');
    if (m) {
      m.classList.remove('active');
      m.style.display = 'none';
    }
  }

  function renderCustomizeIndicesModal() {
    const slotsCont = document.getElementById('customize-slots-container');
    const allListCont = document.getElementById('customize-all-indices-list');
    if (!slotsCont || !allListCont) return;

    slotsCont.innerHTML = tempSelectedIndices.map((gid, idx) => {
      let inst = state.indices.find(i => i.globalId === gid);
      if (!inst) {
        inst = state.indices.find(i => gid.includes(getIndexCanonicalKey(i)));
      }
      const sym = inst ? inst.symbol : gid.split(':')[1] || gid;
      const exch = inst ? inst.exchange : (gid.startsWith('BSE') ? 'BSE' : 'NSE');
      const avatarHtml = inst && window.InstrumentIdentity ? window.InstrumentIdentity.renderInstrumentAvatar(inst, 24, 'idx-mini-avatar') : '';
      return `
        <div class="customize-slot-card">
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="customize-slot-badge">#${idx + 1}</span>
            ${avatarHtml}
            <div>
              <div style="font-weight:700;font-size:13.5px;color:#0F172A;">${sym}</div>
              <div style="font-size:11px;color:#64748B;">${exch} Benchmark</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <button class="slot-arrow-btn" ${idx === 0 ? 'disabled' : ''} onclick="window.TZApp.moveIndexSlot(${idx}, -1)" title="Move Up">▲</button>
            <button class="slot-arrow-btn" ${idx === tempSelectedIndices.length - 1 ? 'disabled' : ''} onclick="window.TZApp.moveIndexSlot(${idx}, 1)" title="Move Down">▼</button>
            <button class="slot-remove-btn" onclick="window.TZApp.removeIndexSlot(${idx})" title="Remove">✕</button>
          </div>
        </div>
      `;
    }).join('');

    allListCont.innerHTML = state.indices.map((inst) => {
      const isSelected = tempSelectedIndices.includes(inst.globalId);
      const slotNum = isSelected ? tempSelectedIndices.indexOf(inst.globalId) + 1 : 0;
      const avatarHtml = window.InstrumentIdentity ? window.InstrumentIdentity.renderInstrumentAvatar(inst, 26, 'idx-mini-avatar') : '';
      const isRestricted = !isProUser() && isInstrumentRestrictedForFree(inst);
      return `
        <div class="customize-index-item ${isSelected ? 'selected' : ''}" onclick="window.TZApp.toggleIndexSelection('${inst.globalId}')">
          <div style="display:flex;align-items:center;gap:10px;">
            ${avatarHtml}
            <div>
              <div style="font-weight:700;font-size:13.5px;color:#0F172A;display:flex;align-items:center;gap:6px;">
                <span>${inst.symbol}</span>
                <span class="tag-exch">${inst.exchange}</span>
                ${isRestricted ? '<span class="tag-pro-lock">PRO</span>' : ''}
              </div>
              <div style="font-size:11px;color:#64748B;">${inst.name}</div>
            </div>
          </div>
          <div>
            ${isSelected 
              ? `<span style="font-size:11.5px;font-weight:700;color:#16A34A;background:#DCFCE7;padding:3px 8px;border-radius:6px;">Slot #${slotNum} ✓</span>`
              : `<span style="font-size:11.5px;font-weight:600;color:#64748B;background:#F1F5F9;padding:3px 8px;border-radius:6px;">+ Add</span>`
            }
          </div>
        </div>
      `;
    }).join('');
  }

  function moveIndexSlot(index, direction) {
    const target = index + direction;
    if (target < 0 || target >= tempSelectedIndices.length) return;
    const item = tempSelectedIndices[index];
    tempSelectedIndices.splice(index, 1);
    tempSelectedIndices.splice(target, 0, item);
    renderCustomizeIndicesModal();
  }

  function removeIndexSlot(index) {
    tempSelectedIndices.splice(index, 1);
    renderCustomizeIndicesModal();
  }

  function toggleIndexSelection(globalId) {
    const idx = tempSelectedIndices.indexOf(globalId);
    if (idx !== -1) {
      tempSelectedIndices.splice(idx, 1);
    } else {
      if (tempSelectedIndices.length >= 3) {
        showBrandedAlert('Top 3 Strip Full', 'Exactly 3 indices can be selected for the top benchmark strip. Please deselect or replace one of your active 3 slots first.');
        return;
      }
      tempSelectedIndices.push(globalId);
    }
    renderCustomizeIndicesModal();
  }

  function resetIndicesToDefault() {
    tempSelectedIndices = ['NSE:NIFTY 50:99926000', 'NSE:BANKNIFTY:99926009', 'BSE:SENSEX:99919000'];
    renderCustomizeIndicesModal();
  }

  async function saveIndexPreferences() {
    if (tempSelectedIndices.length !== 3) {
      showBrandedAlert('Select Exactly 3', 'Please select exactly 3 indices for your benchmark strip.');
      return;
    }
    state.selectedIndices = [...tempSelectedIndices];
    const storageKey = 'tradingzone_indices_pref_' + (state.user?.id || 'guest');
    try {
      localStorage.setItem(storageKey, JSON.stringify(state.selectedIndices));
    } catch { }

    renderBenchmarkIndexStrip();
    closeCustomizeIndicesModal();

    if (state.token) {
      try {
        await apiFetch('/api/v1/user/preferences/indices', {
          method: 'PUT',
          body: JSON.stringify({ selectedIndices: state.selectedIndices }),
        });
      } catch (err) {
        console.warn('Preferences saved locally; sync to backend pending:', err);
      }
    }
  }

  function setExploreCategory(cat) {
    if (state.exploreCategory === cat) return;
    state.exploreCategory = cat;
    if(cat!=='STOCKS')loadSecondaryCatalogue();
    const sBtn = document.getElementById('btn-explore-stocks') || document.getElementById('btn-market-stocks');
    const fBtn = document.getElementById('btn-explore-fno') || document.getElementById('btn-market-fno');
    const cBtn = document.getElementById('btn-explore-commodities') || document.getElementById('btn-market-commodities');
    if (sBtn) sBtn.classList.toggle('active', cat === 'STOCKS');
    if (fBtn) fBtn.classList.toggle('active', cat === 'FNO');
    if (cBtn) cBtn.classList.toggle('active', cat === 'COMMODITIES');

    const sView = document.getElementById('explore-stocks-view');
    const fView = document.getElementById('explore-fno-view');
    const cView = document.getElementById('explore-commodities-view') || document.getElementById('market-commodities-view');
    if (sView) sView.style.display = cat === 'STOCKS' ? 'block' : 'none';
    if (fView) fView.style.display = cat === 'FNO' ? 'block' : 'none';
    if (cView) cView.style.display = cat === 'COMMODITIES' ? 'block' : 'none';
    recordEligibleAction('switch_market_category_' + cat);
  }

  function filterCommodities(cat, btnEl) {
    if (state.commoditiesFilter === cat) return;
    state.commoditiesFilter = cat;
    document.querySelectorAll('#commodities-category-chips .filter-chip').forEach((b) => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');
    renderCommoditiesList();
    recordEligibleAction('filter_commodities_' + cat);
  }

  function renderCommoditiesList() {
    const container = document.getElementById('explore-commodities-list') || document.getElementById('market-commodities-list');
    if (!container) return;
    const { metals = [], energy = [], agriculture = [] } = state.commodities || {};
    let list = [];
    if (state.commoditiesFilter === 'METALS') list = metals;
    else if (state.commoditiesFilter === 'ENERGY') list = energy;
    else if (state.commoditiesFilter === 'AGRICULTURE') list = agriculture;
    else list = [...metals, ...energy, ...agriculture];

    if (list.length === 0) {
      container.innerHTML = `
        <div style="padding:28px;text-align:center;color:var(--text-on-white-secondary);">
          No active MCX contracts in this category.
        </div>
      `;
      return;
    }

    container.innerHTML = list
      .map((inst) => {
        const isRestricted = !isProUser() && isInstrumentRestrictedForFree(inst);
        const und = inst.underlying || inst.symbol.split(' ')[0];
        const tickValStr = inst.tickValue ? `₹${inst.tickValue}/tick` : '';

        const avatarHtml = window.InstrumentIdentity
          ? window.InstrumentIdentity.renderInstrumentAvatar(inst, 38)
          : `<div class="inst-badge-icon" style="background:#141B25;color:var(--accent-lime);">${und.slice(0, 3)}</div>`;

        if (isRestricted) {
          return `
            <div class="instrument-row-white" onclick="window.TZApp.showSubscriptionUpgradePrompt('${inst.symbol}')" style="opacity:0.92;">
              <div class="inst-left">
                ${avatarHtml}
                <div class="inst-meta">
                  <div class="inst-symbol-row">
                    <span class="inst-symbol">${inst.symbol}</span>
                    <span class="tag-exch">MCX</span>
                    <span class="expiry-e-badge" style="background:#f59e0b;color:#000;font-weight:700;">PRO</span>
                  </div>
                  <div class="inst-name-sub">
                    ${inst.quotationUnit || ''} ${tickValStr ? `• <span class="tag-tick-val">${tickValStr}</span>` : ''}
                  </div>
                </div>
              </div>
              <div class="inst-right">
                <div class="inst-price-col" style="text-align:right;">
                  <span class="inst-ltp-val" style="color:#f59e0b;font-weight:700;font-size:12.5px;">🔒 PRO ONLY</span>
                  <span class="inst-chg-val" style="color:#0ea5e9;font-size:11px;font-weight:600;">Upgrade to view</span>
                </div>
              </div>
            </div>
          `;
        }

        const q = pickQuote(inst);
        const { diff, pct, sign } = calcChange(q);
        const cls = diff >= 0 ? 'val-pos' : 'val-neg';
        const hasOptions = inst.hasDerivatives || ['CRUDEOIL', 'GOLD', 'SILVER', 'NATURALGAS', 'COPPER'].includes(und);
        const priceText = q && q.ltp !== undefined && q.ltp !== null ? fmtINR(q.ltp) : '—';
        const chgText = q && q.ltp !== undefined && q.ltp !== null ? `${sign}${(pct===null?'—':pct.toFixed(2))}%` : '';

        return `
          <div class="instrument-row-white" onclick="window.TZApp.openChartByGlobalId('${inst.globalId}')">
            <div class="inst-left">
              ${avatarHtml}
              <div class="inst-meta">
                <div class="inst-symbol-row">
                  <span class="inst-symbol">${inst.symbol}</span>
                  <span class="tag-exch">MCX</span>
                  <span class="tag-commodity-unit">${inst.tradingUnit || `Lot ${inst.lotSize}`}</span>
                </div>
                <div class="inst-name-sub">
                  ${inst.quotationUnit || ''} ${tickValStr ? `• <span class="tag-tick-val">${tickValStr}</span>` : ''}
                </div>
              </div>
            </div>
            <div class="inst-right">
              <div class="inst-price-col">
                <span class="inst-ltp-val" data-ltp-id="${inst.globalId}">${priceText}</span>
                <span class="inst-chg-val ${cls}" data-chg-id="${inst.globalId}">
                  ${chgText}
                </span>
              </div>
              ${hasOptions ? `
                <button class="chain-icon-btn" title="Commodity Option Chain" onclick="event.stopPropagation(); window.TZApp.openOptionChainModal('${und}')">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                  </svg>
                </button>
              ` : ''}
            </div>
          </div>
        `;
      })
      .join('');
  }

  function openCommoditySpecsModal() {
    const modal = document.getElementById('modal-commodity-specs');
    if (!modal) return;
    const container = document.getElementById('commodity-specs-table-container');
    const specs = state.commoditySpecs || {};
    const keys = Object.keys(specs);

    if (keys.length === 0) {
      container.innerHTML = `<div style="padding:20px;text-align:center;">Loading specifications...</div>`;
    } else {
      container.innerHTML = `
        <table class="oc-table" style="font-size:12px;">
          <thead>
            <tr>
              <th>COMMODITY</th>
              <th>TRADING UNIT</th>
              <th>QUOTE UNIT</th>
              <th>LOT</th>
              <th>TICK (₹)</th>
              <th>₹ / TICK</th>
              <th>MARGIN</th>
            </tr>
          </thead>
          <tbody>
            ${keys.map((k) => {
              const s = specs[k];
              return `
                <tr>
                  <td style="font-weight:700;text-align:left;padding-left:8px;">${s.name} (${s.symbol})</td>
                  <td>${s.tradingUnit}</td>
                  <td>${s.quotationUnit}</td>
                  <td>${s.lotSize}</td>
                  <td>₹${s.tickSize}</td>
                  <td style="font-weight:700;color:var(--positive-on-white);">₹${s.tickValuePerLot}</td>
                  <td>${(s.simulatedMarginRate * 100).toFixed(0)}%</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      `;
    }
    modal.classList.add('active');
  }

  function filterExploreStocks(sector, btnEl) {
    if (state.stocksSectorFilter === sector) return;
    state.stocksSectorFilter = sector;
    document.querySelectorAll('#stocks-sector-chips .filter-chip').forEach((b) => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');
    renderExploreStocksList();
    recordEligibleAction('filter_stocks_sector_' + sector);
  }

  function renderInstrumentRowHTML(inst, showChainBtn = false, options = {}) {
 const isRestricted = !isProUser() && isInstrumentRestrictedForFree(inst);
 const q = pickQuote(inst); const {diff,pct,sign}=calcChange(q);
 return window.SikhoUX.row(inst, {restricted:isRestricted,avatar:window.InstrumentIdentity.renderInstrumentAvatar(inst,40),price:q?.ltp>0?fmtINR(q.ltp):'—',change:q?.ltp>0?formatPointsAndPct(q).text:'',changeClass:formatPointsAndPct(q).cls,showChain:showChainBtn,search:options.search,removable:options.removable});
}

  function renderExploreStocksList() {
    const container = document.getElementById('explore-stocks-list');
    const sectorKeywords = {
      BANK: ['BANK', 'FIN', 'HDFC', 'ICICI', 'SBIN', 'AXIS', 'KOTAK', 'BAJFIN'],
      IT: ['TCS', 'INFY', 'WIPRO', 'HCL', 'TECHM', 'LTIM'],
      ENERGY: ['RELIANCE', 'ONGC', 'NTPC', 'POWER', 'TATASTEEL', 'JSW', 'HINDALCO', 'COAL'],
      AUTO: ['MARUTI', 'TATAMOTORS', 'M&M', 'ITC', 'HINDUNILVR', 'SUNPHARMA', 'TITAN'],
    };
    let list = state.exploreStocks;
    if (state.stocksSectorFilter !== 'ALL') {
      const keys = sectorKeywords[state.stocksSectorFilter] || [];
      const filtered = list.filter((i) =>
        keys.some((k) => i.symbol.toUpperCase().includes(k) || i.name.toUpperCase().includes(k))
      );
      if (filtered.length > 0) list = filtered;
    }
    container.innerHTML = list.map((inst) => renderInstrumentRowHTML(inst, false)).join('');
  }

  function renderExploreFnoLists() {
    const idxContainer = document.getElementById('explore-fno-indices-list');
    const stkContainer = document.getElementById('explore-fno-stocks-list');
    idxContainer.innerHTML = state.exploreFnoIndices.map((inst) => renderInstrumentRowHTML(inst, true)).join('');
    stkContainer.innerHTML = state.exploreFnoStocks.map((inst) => renderInstrumentRowHTML(inst, true)).join('');
  }

  // =========================================================================
  // 4. ALL INDICES SCREEN & OPTION CHAIN SCREEN
  // =========================================================================
  function openAllIndicesModal() {
    document.getElementById('modal-all-indices').classList.add('active');
    renderAllIndicesList();
  }

  function closeAllIndicesModal() {
    document.getElementById('modal-all-indices').classList.remove('active');
  }

  function renderAllIndicesList() {
    const q = (document.getElementById('all-indices-search').value || '').trim().toLowerCase();
    const filtered = state.indices.filter(
      (i) => !q || i.symbol.toLowerCase().includes(q) || i.name.toLowerCase().includes(q)
    );
    const container = document.getElementById('all-indices-list-container');
    container.innerHTML = filtered.map((inst) => renderInstrumentRowHTML(inst, Boolean(inst.hasDerivatives))).join('');
  }

  // =========================================================================
  // OPTION CHAIN: paginated strike window, ATM focus, genuine live CE/PE ticks
  // =========================================================================
  const OC_WINDOW_SIZE = 21;
  const OC_MAX_SUBSCRIPTIONS = 62;

  function optionChainCanonicalUnderlying(value) {
    const u = String(value || '').trim().toUpperCase().replace(/\s+/g, ' ');
    if (u === 'NIFTY' || u === 'NIFTY 50' || u === 'NIFTY50') return 'NIFTY';
    if (u === 'BANKNIFTY' || u === 'NIFTY BANK' || u === 'NIFTYBANK') return 'BANKNIFTY';
    return u;
  }

  function optionChainFreeAllowed(underlying) {
    const u = optionChainCanonicalUnderlying(underlying);
    return u === 'NIFTY' || u === 'BANKNIFTY';
  }

  function ensureOptionChainState() {
    state.optionChain = state.optionChain || {
      underlying: 'NIFTY',
      expiry: null,
      seq: 0,
      rows: [],
      contracts: new Map(),
      subscribed: new Set(),
      expiryInfo: [],
      window: null,
      loadedStart: null,
      loadedEnd: null,
      spotLtp: null,
      loading: false,
      error: null,
      lastFocusedKey: null,
      coverage: null,
      deliveryMode: null,
    };
    return state.optionChain;
  }

  function ocIsOpen() {
    return Boolean(document.getElementById('modal-option-chain')?.classList.contains('active'));
  }

  function ocKey() {
    const oc = state.optionChain;
    return oc ? `${oc.underlying}:${oc.expiry || ''}` : '';
  }

  function setOptionChainStatus(left, right) {
    const l = document.getElementById('oc-status-left');
    const r = document.getElementById('oc-status-right');
    if (l) l.textContent = left || '—';
    if (r) r.textContent = right || '';
  }

  function ocFmtCompact(num) {
    const n = Number(num);
    if (!Number.isFinite(n) || n <= 0) return '—';
    if (n >= 10000000) return (n / 10000000).toFixed(2) + 'Cr';
    if (n >= 100000) return (n / 100000).toFixed(2) + 'L';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(Math.round(n));
  }

  function ocLtpText(side, gid) {
    const cached = gid ? state.quotesMap?.get(gid) : null;
    const live = cached && Number(cached.ltp) > 0 ? Number(cached.ltp) : null;
    const base = side && Number(side.ltp) > 0 ? Number(side.ltp) : null;
    const value = live !== null ? live : base;
    return value !== null ? fmtNum(value) : '—';
  }

  function ocMetaText(side, gid) {
    const cached = gid ? state.quotesMap?.get(gid) : null;
    const oi = cached && cached.openInterest !== undefined ? cached.openInterest : side?.openInterest;
    const vol = cached && cached.volume !== undefined ? cached.volume : side?.volume;
    const parts = [];
    parts.push('OI ' + ocFmtCompact(oi));
    if (vol !== undefined && vol !== null) parts.push('Vol ' + ocFmtCompact(vol));
    return parts.join(' • ');
  }

  function ocQuoteAgeText(gid) {
    const cached = gid ? state.quotesMap?.get(gid) : null;
    const ts = Number(cached?.providerTimestamp || cached?.receiveTimestamp || 0);
    if (!ts) return '';
    const ageMs = Date.now() - ts;
    if (ageMs < 0) return '';
    if (ageMs < 5000) return 'live';
    if (ageMs < 60000) return Math.round(ageMs / 1000) + 's ago';
    return Math.round(ageMs / 60000) + 'm ago';
  }

  function renderOptionChainHeader(meta) {
    const oc = ensureOptionChainState();
    const title = document.getElementById('oc-title');
    if (title) title.textContent = `${oc.underlying === 'NIFTY' ? 'NIFTY 50' : oc.underlying} Option Chain`;
    const sub = document.getElementById('oc-spot-subtitle');
    if (sub) {
      const spotTxt = oc.spotLtp ? `Spot ${fmtINR(oc.spotLtp)}` : 'Spot unavailable';
      sub.textContent = `${spotTxt} • Exp ${oc.expiry || '—'}`;
      sub.title = `${spotTxt} • Expiry ${oc.expiry || '—'} • ${fmtIstClock(serverNowMs())} IST`;
    }

    const pillsEl = document.getElementById('oc-expiry-pills');
    if (pillsEl) {
      const infos = Array.isArray(oc.expiryInfo) && oc.expiryInfo.length
        ? oc.expiryInfo
        : (meta?.availableExpiries || []).map((e) => ({ expiry: e, contracts: 0, hasBothSides: true }));
      pillsEl.innerHTML = infos
        .map((info) => {
          const exp = typeof info === 'string' ? info : info.expiry;
          const active = exp === oc.expiry;
          const thin = typeof info === 'object' && info && info.contracts !== undefined && info.contracts < 2;
          return `<button class="filter-chip ${active ? 'active' : ''}" style="${thin ? 'opacity:0.55;' : ''}"
                  title="${thin ? 'Few contracts listed for this expiry' : 'Select expiry ' + exp}"
                  onclick="window.TZApp.loadOptionChain('${oc.underlying}', '${exp}')">${exp}</button>`;
        })
        .join('');
    }

    const total = oc.window?.total || oc.rows.length;
    // Rows ascend by strike. Provider "below" means lower strike, at the top of this table.
    const above = oc.loadedStart > 0;
    const below = oc.loadedEnd !== null && oc.loadedEnd < total;
    const coverage = oc.coverage
      ? `${oc.coverage.withQuotes}/${oc.coverage.total} contracts quoted`
      : '';
    setOptionChainStatus(
      `${oc.rows.length} of ${total} strikes${above || below ? ' (tap load buttons for more)' : ''}`,
      coverage + (oc.deliveryMode ? ` • ${oc.deliveryMode}` : '')
    );

    const aboveBtn = document.getElementById('oc-load-above');
    const belowBtn = document.getElementById('oc-load-below');
    if (aboveBtn) aboveBtn.style.display = above ? 'block' : 'none';
    if (belowBtn) belowBtn.style.display = below ? 'block' : 'none';
  }

  function renderOptionChainTable(opts = {}) {
    const oc = ensureOptionChainState();
    const tbody = document.getElementById('oc-table-body');
    if (!tbody) return;
    if (oc.error) {
      tbody.innerHTML = `<tr><td colspan="3" style="padding:22px;color:var(--negative-red);text-align:center;">${oc.error}</td></tr>`;
      return;
    }
    if (!oc.rows.length) {
      tbody.innerHTML = `<tr><td colspan="3" style="padding:22px;color:var(--text-on-white-secondary);text-align:center;">${oc.loading ? 'Loading live option chain…' : 'No strikes available for this expiry.'}</td></tr>`;
      return;
    }
    const atmStrike = oc.window?.atmStrike ?? null;
    const focusedKey = ocKey();
    const shouldFocus = opts.focusAtm && oc.lastFocusedKey !== focusedKey;

    tbody.innerHTML = oc.rows
      .map((row) => {
        const isAtm = atmStrike !== null && row.strikePrice === atmStrike;
        const ce = row.call;
        const pe = row.put;
        const ceGid = ce?.instrument?.globalId || '';
        const peGid = pe?.instrument?.globalId || '';
        const ceLtp = ce ? ocLtpText(ce, ceGid) : '—';
        const peLtp = pe ? ocLtpText(pe, peGid) : '—';
        const ceMeta = ce ? ocMetaText(ce, ceGid) : '—';
        const peMeta = pe ? ocMetaText(pe, peGid) : '—';
        const ceClick = ceGid ? `onclick="window.TZApp.openOrderTicketByGlobalId('${ceGid}','BUY')"` : '';
        const peClick = peGid ? `onclick="window.TZApp.openOrderTicketByGlobalId('${peGid}','BUY')"` : '';
        return `
          <tr data-oc-strike="${row.strikePrice}" class="${isAtm ? 'oc-atm-row' : ''}">
            <td class="oc-side-cell oc-ce-cell" data-oc-side="CE" ${ceClick}>
              <div class="oc-ltp-row"><span class="oc-ltp oc-ltp-ce" data-oc-ltp="${ceGid}">${ceLtp}</span></div>
              <div class="oc-meta" data-oc-meta="${ceGid}">${ceMeta}</div>
              ${ceGid ? `<div class="oc-actions"><button onclick="event.stopPropagation();window.TZApp.openOrderTicketByGlobalId('${ceGid}','BUY')">Buy</button><button onclick="event.stopPropagation();window.TZApp.openOrderTicketByGlobalId('${ceGid}','SELL')">Sell</button></div>` : ''}
            </td>
            <td class="oc-strike-cell" data-oc-strike-cell="${row.strikePrice}">
              <div class="oc-strike-value">${fmtNum(row.strikePrice, 0)}</div>
              <div class="oc-badge">${isAtm ? '<span class="oc-atm-tag">ATM</span>' : 'STRIKE'}</div>
            </td>
            <td class="oc-side-cell oc-pe-cell" data-oc-side="PE" ${peClick}>
              <div class="oc-ltp-row"><span class="oc-ltp oc-ltp-pe" data-oc-ltp="${peGid}">${peLtp}</span></div>
              <div class="oc-meta" data-oc-meta="${peGid}">${peMeta}</div>
              ${peGid ? `<div class="oc-actions"><button onclick="event.stopPropagation();window.TZApp.openOrderTicketByGlobalId('${peGid}','BUY')">Buy</button><button onclick="event.stopPropagation();window.TZApp.openOrderTicketByGlobalId('${peGid}','SELL')">Sell</button></div>` : ''}
            </td>
          </tr>`;
      })
      .join('');

    if (shouldFocus) {
      oc.lastFocusedKey = focusedKey;
      const scrollBox = document.getElementById('oc-scroll');
      const atmRow = tbody.querySelector('.oc-atm-row');
      if (scrollBox && atmRow) {
        requestAnimationFrame(() => {
          const target = atmRow.offsetTop - scrollBox.clientHeight / 2 + atmRow.clientHeight / 2;
          scrollBox.scrollTop = Math.max(0, target);
        });
      }
    }
  }

  function ocRegisterContracts(rows) {
    const oc = ensureOptionChainState();
    for (const row of rows) {
      for (const side of [row.call, row.put]) {
        const gid = side?.instrument?.globalId;
        if (gid) {
          oc.contracts.set(gid, { side: row.call === side ? 'CE' : 'PE', row });
          if (Number(side.ltp) > 0 && !(Number(state.quotesMap?.get(gid)?.ltp) > 0)) {
            state.quotesMap.set(gid, { globalId: gid, ltp: Number(side.ltp), providerTimestamp: side.quoteTimestamp || null });
          }
        }
      }
    }
  }

  function ocIsSymbolUsedElsewhere(gid) {
    if(state.orderTicket?.open&&state.orderTicket.instrument?.globalId===gid)return true;
    if (gid === state.activeChartSubId) return true;
    if ((state.selectedIndices || []).includes(gid)) return true;
    if ((state.watchlists?.[0]?.instruments || []).includes(gid)) return true;
    if ((state.positionsData?.positions || []).some((p) => p.globalInstrumentId === gid && Math.abs(p.quantity || 0) > 0)) return true;
    return false;
  }

  function syncOptionChainSubscriptions(subscribeGids) {
    const oc = ensureOptionChainState();
    const desired = new Set();
    const source = Array.isArray(subscribeGids) ? subscribeGids : Array.from(oc.contracts.keys());
    for (const gid of source) {
      if (!gid) continue;
      if (desired.size >= OC_MAX_SUBSCRIPTIONS) break;
      desired.add(gid);
    }
    const toAdd = Array.from(desired).filter((g) => !oc.subscribed.has(g));
    const toRemove = Array.from(oc.subscribed).filter((g) => !desired.has(g) && !ocIsSymbolUsedElsewhere(g));
    if (toAdd.length) sendWsSubscribe(toAdd);
    if (toRemove.length && wsConn && wsConn.readyState === WebSocket.OPEN) {
      try {
        wsConn.send(JSON.stringify({ action: 'UNSUBSCRIBE', type: 'UNSUBSCRIBE', symbols: toRemove }));
      } catch { }
    }
    oc.subscribed = desired;
  }

  // Follow rows actually visible after scrolling, rather than the most recently fetched page.
  // Store desired ids even while offline so reconnect can restore the correct contracts.
  function syncVisibleOptionChainSubscriptions() {
    if (!ocIsOpen()) return;
    const box = document.getElementById('oc-scroll');
    if (!box) return;
    const bounds = box.getBoundingClientRect();
    const ids = [];
    for (const row of box.querySelectorAll('[data-oc-strike]')) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom < bounds.top - 100 || rect.top > bounds.bottom + 100) continue;
      for (const cell of row.querySelectorAll('[data-oc-ltp]')) {
        if (cell.dataset.ocLtp) ids.push(cell.dataset.ocLtp);
      }
    }
    syncOptionChainSubscriptions(ids);
  }

  let ocScrollFrame = null;
  document.getElementById('oc-scroll')?.addEventListener('scroll', () => {
    if (ocScrollFrame !== null) return;
    ocScrollFrame = requestAnimationFrame(() => {
      ocScrollFrame = null;
      syncVisibleOptionChainSubscriptions();
    });
  }, { passive: true });

  function unsubscribableOptionChainContracts() {
    const oc = state.optionChain;
    if (!oc || !oc.subscribed.size) return;
    const toRemove = Array.from(oc.subscribed).filter((g) => !ocIsSymbolUsedElsewhere(g));
    if (toRemove.length && wsConn && wsConn.readyState === WebSocket.OPEN) {
      try {
        wsConn.send(JSON.stringify({ action: 'UNSUBSCRIBE', type: 'UNSUBSCRIBE', symbols: toRemove }));
      } catch { }
    }
    oc.subscribed = new Set();
    syncLiveSubscriptions();
  }

  async function openOptionChainModal(underlying = 'NIFTY', expiry) {
    const requested = optionChainCanonicalUnderlying(underlying || 'NIFTY');
    // FREE entitlement: NIFTY 50 and BANKNIFTY chains only. SENSEX/other chains stay Premium.
    if (!hasFullFeatureAccess() && !optionChainFreeAllowed(requested)) {
      showSubscriptionUpgradePrompt(requested);
      return;
    }
    const oc = ensureOptionChainState();
    document.getElementById('modal-option-chain').classList.add('active');
    notifyNativeScreenState();
    const sel = document.getElementById('oc-underlying-select');
    if (sel) sel.value = requested;
    oc.underlying = requested;
    oc.expiry = expiry || null;
    oc.window = null;
    oc.rows = [];
    oc.contracts.clear();
    oc.lastFocusedKey = null;
    unsubscribableOptionChainContracts();
    await loadOptionChain(oc.underlying, expiry, { reset: true });
  }

  function closeOptionChainModal() {
    const oc = state.optionChain;
    if (oc) {
      oc.seq += 1; // invalidate in-flight responses
      oc.loading = false;
      oc.error = null;
      unsubscribableOptionChainContracts();
    }
    document.getElementById('modal-option-chain').classList.remove('active');
    notifyNativeScreenState();
  }

  async function onOptionChainUnderlyingChange(value) {
    const requested = optionChainCanonicalUnderlying(value);
    if (!hasFullFeatureAccess() && !optionChainFreeAllowed(requested)) {
      showSubscriptionUpgradePrompt(requested);
      const sel = document.getElementById('oc-underlying-select');
      const oc = ensureOptionChainState();
      if (sel) sel.value = oc.underlying;
      return;
    }
    await openOptionChainModal(requested);
  }

  function mergeOptionChainRows(existing, incoming) {
    const byStrike = new Map();
    for (const row of existing || []) byStrike.set(row.strikePrice, row);
    for (const row of incoming || []) byStrike.set(row.strikePrice, row);
    return Array.from(byStrike.values()).sort((a, b) => a.strikePrice - b.strikePrice);
  }

  async function loadOptionChain(underlying, expiry, opts = {}) {
    const oc = ensureOptionChainState();
    const requested = optionChainCanonicalUnderlying(underlying || oc.underlying || 'NIFTY');
    if (!hasFullFeatureAccess() && !optionChainFreeAllowed(requested)) {
      showSubscriptionUpgradePrompt(requested);
      return;
    }
    const seq = ++oc.seq;
    const isReset = Boolean(opts.reset) || requested !== oc.underlying || (expiry && expiry !== oc.expiry);
    if (isReset) {
      oc.rows = [];
      oc.contracts.clear();
      oc.expiryInfo = [];
      oc.window = null;
      oc.loadedStart = null;
      oc.loadedEnd = null;
      oc.error = null;
      oc.lastFocusedKey = null;
      oc.coverage = null;
      setOptionChainStatus('Loading live option chain…', '');
      document.getElementById('oc-table-body').innerHTML =
        '<tr><td colspan="3" style="padding:22px;color:var(--text-on-white-secondary);text-align:center;">Loading live option chain…</td></tr>';
      unsubscribableOptionChainContracts();
    }
    oc.loading = true;
    oc.error = null;
    const offset = Number.isFinite(opts.offset) ? opts.offset : undefined;
    try {
      const url =
        `/api/v1/option-chain?underlying=${encodeURIComponent(requested)}` +
        (expiry ? `&expiry=${encodeURIComponent(expiry)}` : '') +
        (offset !== undefined ? `&offset=${offset}` : '') +
        `&limit=${OC_WINDOW_SIZE}`;
      const chain = await apiFetch(url, { timeoutMs: 25000 });
      if (seq !== oc.seq) return; // stale response for a previously selected underlying/expiry
      const rows = Array.isArray(chain.rows) ? chain.rows : [];
      const scrollBox = document.getElementById('oc-scroll');
      const prevScrollTop = scrollBox ? scrollBox.scrollTop : 0;
      const prevScrollHeight = scrollBox ? scrollBox.scrollHeight : 0;

      oc.underlying = requested;
      oc.expiry = chain.selectedExpiry || expiry || null;
      oc.spotLtp = chain.underlyingSpotLtp ?? null;
      oc.window = chain.strikeWindow || null;
      if (oc.window) {
        oc.loadedStart = oc.loadedStart === null ? oc.window.offset : Math.min(oc.loadedStart, oc.window.offset);
        oc.loadedEnd = Math.max(oc.loadedEnd || 0, oc.window.offset + oc.window.size);
      }
      oc.expiryInfo = Array.isArray(chain.expiryInfo) && chain.expiryInfo.length
        ? chain.expiryInfo
        : (chain.availableExpiries || []).map((e) => ({ expiry: e, contracts: 0, hasBothSides: true }));
      oc.coverage = chain.provenance
        ? { withQuotes: chain.provenance.contractsWithRealQuotes, total: chain.provenance.contractsTotal }
        : null;
      oc.deliveryMode = chain.deliveryMode || null;
      oc.rows = isReset || !oc.rows.length ? rows : mergeOptionChainRows(oc.rows, rows);
      ocRegisterContracts(oc.rows);
      renderOptionChainHeader(chain);
      renderOptionChainTable({ focusAtm: isReset });
      requestAnimationFrame(syncVisibleOptionChainSubscriptions);
      if (!isReset && rows.length && scrollBox && opts.appendAbove) {
        // Keep the user's visual position when prepending older strikes.
        requestAnimationFrame(() => {
          scrollBox.scrollTop = prevScrollTop + Math.max(0, scrollBox.scrollHeight - prevScrollHeight);
          syncVisibleOptionChainSubscriptions();
        });
      }
      if (!rows.length) {
        setOptionChainStatus(`No strikes returned for ${oc.expiry || requested}`, '');
      } else {
        const missing = rows.reduce((n, r) => n + (!r.call?.ltp ? 1 : 0) + (!r.put?.ltp ? 1 : 0), 0);
        const age = ocQuoteAgeText(rows[0]?.call?.instrument?.globalId || '');
        setOptionChainStatus(
          `${oc.rows.length} of ${oc.window?.total || oc.rows.length} strikes${age ? ' • ' + age : ''}`,
          oc.coverage ? `${oc.coverage.withQuotes}/${oc.coverage.total} quoted${missing ? ' • ' + missing + ' awaiting' : ''}` : ''
        );
      }
    } catch (err) {
      if (seq !== oc.seq) return;
      if (err && err.status === 403 && ['UPGRADE_REQUIRED', 'ERR_PRO_TIER_REQUIRED'].includes(err.code)) {
        showSubscriptionUpgradePrompt(requested);
        closeOptionChainModal();
        return;
      }
      oc.error = err && err.message ? err.message : 'Option chain unavailable';
      setOptionChainStatus('Option chain unavailable', '');
      renderOptionChainTable();
    } finally {
      if (seq === oc.seq) oc.loading = false;
    }
  }

  function nowarnRemoved() { }

  async function loadMoreOptionStrikes(direction) {
    const oc = ensureOptionChainState();
    if (!oc.window || oc.loading) return;
    const step = OC_WINDOW_SIZE;
    const nextOffset = direction === 'above'
      ? Math.max(0, oc.loadedStart - step)
      : oc.loadedEnd;
    if (direction === 'above' ? oc.loadedStart === 0 : nextOffset >= oc.window.total) return;
    await loadOptionChain(oc.underlying, oc.expiry, {
      offset: nextOffset,
      appendAbove: direction === 'above',
    });
  }

  /** Live CE/PE cell updates from genuine provider ticks (no full table re-render). */
  function updateOptionChainQuote(quote) {
    if (!quote || !quote.globalId) return;
    const oc = state.optionChain;
    if (!oc || !oc.contracts.has(quote.globalId) || !ocIsOpen()) return;
    if (!(Number(quote.ltp) > 0)) return; // never blank a valid price with a partial tick
    const gid = quote.globalId;
    const ltpEl = document.querySelector(`[data-oc-ltp="${CSS.escape(gid)}"]`);
    if (ltpEl) {
      const txt = fmtNum(quote.ltp);
      if (ltpEl.textContent !== txt) {
        ltpEl.textContent = txt;
        ltpEl.classList.remove('oc-updated');
        void ltpEl.offsetWidth;
        ltpEl.classList.add('oc-updated');
      }
    }
    const metaEl = document.querySelector(`[data-oc-meta="${CSS.escape(gid)}"]`);
    if (metaEl) {
      const cached = state.quotesMap?.get(gid) || quote;
      const parts = ['OI ' + ocFmtCompact(cached.openInterest)];
      if (cached.volume !== undefined && cached.volume !== null) parts.push('Vol ' + ocFmtCompact(cached.volume));
      const txt = parts.join(' • ');
      if (metaEl.textContent !== txt) metaEl.textContent = txt;
    }
  }

  // =========================================================================
  // 5. GLOBAL SEARCH DRAWER & WATCHLISTS
  // =========================================================================
  function openSearchModal(defaultSegment = '') {
    state.searchSegment = defaultSegment;
    document.getElementById('modal-search').classList.add('active');
    document.getElementById('global-search-input').focus();
    runGlobalSearch();
  }

  function closeSearchModal() {
    document.getElementById('modal-search').classList.remove('active');
  }

  function setSearchSegment(seg, btnEl) {
    state.searchSegment = seg;
    document.querySelectorAll('#modal-search .filter-chip').forEach((b) => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');
    runGlobalSearch();
  }

  function runGlobalSearch() {
 clearTimeout(searchDebounceTimer);
 searchRequestController?.abort();
 const seq=++searchRequestSeq;
 searchDebounceTimer=setTimeout(async()=>{
  searchRequestController=new AbortController();
  const q=(document.getElementById('global-search-input').value||'').trim();
  window.SikhoUX.listState('search-results-container','Searching instruments…');
  try {
   const res=await apiFetch('/api/v1/instruments?q='+encodeURIComponent(q)+'&segment='+encodeURIComponent(state.searchSegment)+'&limit=35',{signal:searchRequestController.signal});
   if(seq!==searchRequestSeq)return;
   const list=res.instruments||[];
   document.getElementById('search-results-container').innerHTML=list.length?list.map(i=>renderInstrumentRowHTML(i,false,{search:true})).join(''):'<div class="list-state" role="status">No matching instruments. Try a symbol or company name.</div>';
  } catch(err) {if(seq===searchRequestSeq&&err.name!=='AbortError')window.SikhoUX.listState('search-results-container','Search unavailable. Check your connection.');}
 },180);
}

  async function loadWatchlists() {
    try {
      const res = await apiFetch('/api/v1/watchlists');
      state.watchlists = res.watchlists || [];
      if (state.watchlists.length === 0) {
        await apiFetch('/api/v1/watchlists', {
          method: 'POST',
          body: JSON.stringify({
            name: 'My Watchlist',
            instruments: [],
          }),
        });
        const retry = await apiFetch('/api/v1/watchlists');
        state.watchlists = retry.watchlists || [];
      }
      renderWatchlistsTab();
    } catch { }
  }

  function renderWatchlistsTab() {
    const container = document.getElementById('watchlist-items-container');
    if (!container) return;
    const wl = state.watchlists[0];
    if (!wl || !wl.hydratedInstruments || wl.hydratedInstruments.length === 0) {
      container.innerHTML = window.SikhoUX?.emptyPanel
        ? window.SikhoUX.emptyPanel({
            title: 'No watchlist symbols yet',
            subtitle: 'Track NSE equities, F&O contracts, and MCX commodities in one place.',
            actionLabel: '+ Add Symbol',
            actionOnClick: 'window.TZApp.openSearchModal()',
          })
        : '<div style="padding:32px 16px;text-align:center;">Your watchlist is empty.</div>';
      return;
    }
    container.innerHTML = wl.hydratedInstruments
      .map((inst) => renderInstrumentRowHTML(inst, inst.instrumentType !== 'EQUITY_STOCK', { removable: true }))
      .join('');
  }

  async function addSymbolToWatchlist(globalId) {
    try {
      const wl = state.watchlists[0];
      if (!wl) return;
      const list = Array.from(new Set([...(wl.instruments || []), globalId]));
      await apiFetch('/api/v1/watchlists', {
        method: 'POST',
        body: JSON.stringify({ id: wl.id, name: wl.name, instruments: list }),
      });
      markOnboardingStep('watchlist');
      await loadWatchlists();
      closeSearchModal();
      switchMainTab('watchlists');
    } catch (err) {
      window.SikhoUX?.notify(err?.message || 'Could not add symbol to watchlist.');
    }
  }

  async function removeSymbolFromWatchlist(globalId, symbol) {
    const wl = state.watchlists[0];
    if (!wl) return;
    const prevIds = [...(wl.instruments || [])];
    const prevHydrated = [...(wl.hydratedInstruments || [])];
    const nextIds = prevIds.filter((id) => id !== globalId);
    const nextHydrated = prevHydrated.filter((i) => i.globalId !== globalId);
    // Optimistic update for reversible non-financial watchlist removal
    wl.instruments = nextIds;
    wl.hydratedInstruments = nextHydrated;
    renderWatchlistsTab();

    let undone = false;
    const persistList = async (ids, fallbackIds, fallbackHydrated) => {
      try {
        await apiFetch('/api/v1/watchlists', {
          method: 'POST',
          body: JSON.stringify({ id: wl.id, name: wl.name, instruments: ids }),
        });
      } catch {
        wl.instruments = fallbackIds;
        wl.hydratedInstruments = fallbackHydrated;
        renderWatchlistsTab();
        window.SikhoUX?.notify('Could not sync watchlist change — restored.');
      }
    };

    window.SikhoUX?.notifyWithUndo?.(
      `${symbol || globalId.split(':')[1] || 'Symbol'} removed from watchlist`,
      () => {
        undone = true;
        wl.instruments = prevIds;
        wl.hydratedInstruments = prevHydrated;
        renderWatchlistsTab();
        persistList(prevIds, nextIds, nextHydrated);
      },
      6000
    );

    await persistList(nextIds, prevIds, prevHydrated);
    if (undone) renderWatchlistsTab();
  }

  // =========================================================================
  // 6. FULL-SCREEN CHART WORKSPACE, WINDOWED HISTORY & TOUCH DRAWINGS
  // =========================================================================
  /**
   * Resolves the full instrument metadata for a global id BEFORE any entitlement decision, so the
   * canonical access matrix (underlying + instrument type) decides instead of string prefixes.
   * Option/futures contracts are not always in the cached lists, so the provider search is used.
   */
  async function resolveInstrumentForChart(globalId) {
    const chainContract = state.optionChain?.contracts.get(globalId);
    if (chainContract) {
      const side = chainContract.side === 'CE' ? chainContract.row.call : chainContract.row.put;
      if (side?.instrument?.globalId === globalId) return side.instrument;
    }
    const commList = [
      ...(state.commodities?.metals || []),
      ...(state.commodities?.energy || []),
      ...(state.commodities?.agriculture || []),
    ];
    let inst =
      state.indices.find((i) => i.globalId === globalId) ||
      state.exploreStocks.find((i) => i.globalId === globalId) ||
      state.exploreFnoIndices.find((i) => i.globalId === globalId) ||
      state.exploreFnoStocks.find((i) => i.globalId === globalId) ||
      commList.find((i) => i.globalId === globalId);

    if (!inst) {
      try {
        const symbolHint = (globalId.split(':')[1] || globalId).trim();
        const searchRes = await apiFetch(
          `/api/v1/instruments?q=${encodeURIComponent(symbolHint)}&limit=25`
        );
        inst = (searchRes.instruments || []).find((i) => i.globalId === globalId) || null;
      } catch { }
    }

    if (!inst) {
      // Last-resort descriptor: type is inferred from the segment/symbol so the access matrix can
      // still fail closed for restricted products.
      const exchange = (globalId.split(':')[0] || 'NSE').toUpperCase();
      const symbol = globalId.split(':')[1] || globalId;
      const isOption = /\b(CE|PE)\b/.test(symbol.toUpperCase());
      inst = {
        globalId,
        symbol,
        exchange,
        instrumentType:
          exchange === 'NFO' || exchange === 'BFO'
            ? isOption
              ? 'OPTIDX'
              : 'FUTIDX'
            : globalId.includes('999')
              ? 'INDEX_SPOT'
              : 'EQUITY_STOCK',
        isTradable: false,
        metadataUnavailable: true,
        lotSize: 1,
        tickSize: 0.05,
      };
    }
    return inst;
  }

  async function openChartByGlobalId(globalId) {
    if (!globalId) return;
    const navigationSeq=++chartNavigationSeq, sessionToken=state.token;
    const prevGid = state.activeInstrument?.globalId || null;
    if (prevGid && prevGid !== globalId) {
      if (typeof cancelChartProtectionDrag === 'function') cancelChartProtectionDrag();
      chartRequestController?.abort();
      state.chartLoadSeq = (state.chartLoadSeq || 0) + 1;
      state.chartLoading = true;
      state.candles = [];
      state.chartPendingTicks = [];
      state.chartBarUpdates = {};
      state.lastChartAppliedPriceMs = 0;
      state.drawings = [];
      state.activeDraftDrawing = null;
      state.historicalInspection = false;
      inspectedCandleTime = null;
      state.isUserScrolledBack = false;
      if (state.replayMode) {
        if (state.replayTimer) clearInterval(state.replayTimer);
        state.replayPlaying = false;
        state.replayMode = false;
        const rBar = document.getElementById('chart-replay-bar');
        if (rBar) rBar.style.display = 'none';
      }
      try { candleSeries?.setData?.([]); } catch {}
      try {
        Object.values(indicatorSeriesMap || {}).forEach((s) => {
          try { tvChart?.removeSeries?.(s); } catch { try { s?.setData?.([]); } catch {} }
        });
        indicatorSeriesMap = {};
      } catch {}
      const svgLayer = document.getElementById('drawing-svg-layer');
      if (svgLayer) svgLayer.innerHTML = '';
      try {
        tvChart?.priceScale?.('right')?.applyOptions?.({ autoScale: true, mode: 0, scaleMargins: { top: 0.1, bottom: 0.14 } });
        candleSeries?.priceScale?.()?.applyOptions?.({ autoScale: true, mode: 0, scaleMargins: { top: 0.1, bottom: 0.14 } });
        tvChart?.timeScale?.()?.resetTimeScale?.();
      } catch {}
    }
    const inst = await resolveInstrumentForChart(globalId);
    if(navigationSeq!==chartNavigationSeq||sessionToken!==state.token)return;
    const hasOpenPos = (state.positionsData?.positions || []).some(
      (p) => p.globalInstrumentId === globalId && Math.abs(p.quantity || 0) > 0
    );
    // NIFTY 50 / BANKNIFTY spot, futures and options are FREE. SENSEX, other NIFTY-family indices,
    // equities, stock F&O and MCX remain Premium-only.
    if (!isProUser() && isInstrumentRestrictedForFree(inst) && !hasOpenPos) {
      showSubscriptionUpgradePrompt(inst.symbol || globalId.split(':')[1] || globalId);
      return;
    }

    closeAllIndicesModal();
    closeOptionChainModal();
    state.chartOpen = true;
    markOnboardingStep('chart');
    document.getElementById('screen-chart').classList.add('active');
    syncNativeSystemBarTheme();
    notifyNativeScreenState();

    state.activeInstrument = inst;
    state.historicalInspection=false;inspectedCandleTime=null;
    state.isUserScrolledBack=false;
    if (prevGid !== inst.globalId) {
      state.candles=[];
      state.chartPendingTicks=[];
      state.chartBarUpdates={};
      state.lastChartAppliedPriceMs=0;
      state.drawings=[];
      state.activeDraftDrawing=null;
    }
    if (typeof chartViewportCache !== 'undefined' && chartViewportCache?.clear) {
      chartViewportCache.clear();
    }
    try{const saved=JSON.parse(localStorage.getItem('tz_indicators_'+(state.user?.userId||state.user?.id))||'null');if(saved)Object.assign(state.indicators,saved);}catch{}
    document.getElementById('chart-ltp-display').textContent='—';
    document.getElementById('chart-chg-display').textContent='';
    document.getElementById('chart-sym-title').textContent = inst.symbol;
    document.getElementById('chart-seg-badge').textContent = `${inst.exchange} • ${inst.instrumentType}`;

    // Manage active chart WebSocket subscription without duplicates
    if (state.activeChartSubId && state.activeChartSubId !== inst.globalId) {
      const keepPrev =
        (state.selectedIndices || []).includes(state.activeChartSubId) ||
        (state.watchlists?.[0]?.instruments || []).includes(state.activeChartSubId) ||
        (state.positionsData?.positions || []).some(
          (p) => p.globalInstrumentId === state.activeChartSubId && Math.abs(p.quantity || 0) > 0
        );
      if (!keepPrev && !ocIsSymbolUsedElsewhere(state.activeChartSubId) && wsConn && wsConn.readyState === WebSocket.OPEN) {
        try {
          wsConn.send(JSON.stringify({ action: 'UNSUBSCRIBE', type: 'UNSUBSCRIBE', symbols: [state.activeChartSubId] }));
        } catch {}
      }
    }
    state.activeChartSubId = inst.globalId;
    syncLiveSubscriptions();
    startChartCountdownTimer();

    renderChartBottomTradeBar(inst);
    try { await ensureChartLibrary(); } catch {
      document.getElementById('chart-ohlc-legend').textContent='Chart engine unavailable. Reopen to retry.';
      return;
    }
    if(navigationSeq!==chartNavigationSeq||sessionToken!==state.token)return;
    initLightweightChartInstance();
    await Promise.all([loadChartCandlesInitial(), loadUserDrawingsForActiveInstrument()]);
    if (typeof renderChartProtectionOverlay === 'function') renderChartProtectionOverlay();
  }

  function closeChartWorkspace() {
    if (typeof cancelChartProtectionDrag === 'function') cancelChartProtectionDrag();
    rememberChartViewport();
    chartNavigationSeq++;
    chartRequestController?.abort();
    state.chartLoadSeq++;
    state.chartOpen = false;
    state.activeChartSubId=null;
    syncLiveSubscriptions();
    stopChartCountdownTimer();
    document.getElementById('screen-chart').classList.remove('active');
    syncNativeSystemBarTheme();
    notifyNativeScreenState();
  }

  function renderChartBottomTradeBar(inst) {
    const bar = document.getElementById('chart-bottom-trade-bar');
    if (inst.metadataUnavailable) {
      bar.textContent = 'Contract details unavailable. Reload before trading.';
      return;
    }
    if (!inst.isTradable || inst.instrumentType === 'INDEX_SPOT') {
      const und = inst.underlying || (inst.symbol.includes('BANK') ? 'BANKNIFTY' : inst.symbol.includes('SENSEX') ? 'SENSEX' : 'NIFTY');
      bar.innerHTML = `
        <button class="btn-trade-sell" style="background:#1E293B;border:1px solid #334155;color:#F8FAFC;font-size:12px;font-weight:700;flex:1.2;" onclick="window.TZApp.openOptionChainModal('${und}')">
          Option Chain
        </button>
        <button class="btn-trade-sell" style="flex:1;" title="Trade the nearest ${und} index future" onclick="window.TZApp.tradeIndexFutureDirect('${und}', 'SELL')">
          Sell
        </button>
        <button class="btn-trade-buy" style="flex:1;" title="Trade the nearest ${und} index future" onclick="window.TZApp.tradeIndexFutureDirect('${und}', 'BUY')">
          Buy
        </button>
      `;
    } else {
      const openPos = getOpenPositionForInstrument(inst.globalId);
      const protBtnHtml = openPos
        ? `<button class="btn-trade-sell" style="background:#0F172A;border:1px solid #334155;color:#C7F542;font-size:12px;font-weight:700;flex:1.15;" onclick="window.TZApp.openProtectionModal('${openPos.id}')">
            TP / SL
           </button>`
        : '';
      bar.innerHTML = `
        ${protBtnHtml}
        <button class="btn-trade-sell" onclick="window.TZApp.openOrderTicket('SELL')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M4.5 9c0-1.9 1.6-3.5 3.5-3.5.7 0 1.4.2 2 .6C10.7 5.4 11.3 5 12 5s1.3.4 2 1.1c.6-.4 1.3-.6 2-.6 1.9 0 3.5 1.6 3.5 3.5 0 .8-.3 1.5-.8 2.1.2.6.3 1.3.3 1.9 0 3.3-3.1 6-7 6s-7-2.7-7-6c0-.6.1-1.3.3-1.9-.5-.6-.8-1.3-.8-2.1zm4.5 4c-.8 0-1.5.7-1.5 1.5s.7 1.5 1.5 1.5 1.5-.7 1.5-1.5-.7-1.5-1.5-1.5zm6 0c-.8 0-1.5.7-1.5 1.5s.7 1.5 1.5 1.5 1.5-.7 1.5-1.5-.7-1.5-1.5-1.5z"/></svg>
          <span>Sell</span>
        </button>
        <button class="btn-trade-buy" onclick="window.TZApp.openOrderTicket('BUY')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M21 7.5c-.8-.5-2.2-.5-3.3.3l-1.9 1.5C14.7 8.5 13.4 8 12 8s-2.7.5-3.8 1.3L6.3 7.8C5.2 7 3.8 7 3 7.5 1.9 8.2 2 9.5 2.5 11l1.5 4.5c.6 1.8 2.2 3 4.1 3.2L9 20h6l.9-1.3c1.9-.2 3.5-1.4 4.1-3.2L21.5 11c.5-1.5.6-2.8-.5-3.5zm-5.5 6.5c-.8 0-1.5-.7-1.5-1.5s.7-1.5 1.5-1.5 1.5.7 1.5 1.5-.7 1.5-1.5 1.5zm-7 0c-.8 0-1.5-.7-1.5-1.5s.7-1.5 1.5-1.5 1.5.7 1.5 1.5-.7 1.5-1.5 1.5z"/></svg>
          <span>Buy</span>
        </button>
      `;
    }
  }

  async function tradeIndexFutureDirect(underlying, side) {
    try {
      const res = await apiFetch(`/api/v1/instruments?segment=FUTIDX&underlying=${encodeURIComponent(underlying)}&limit=5`);
      const fut = selectFrontFuture(res.instruments,underlying);
      if (!fut) {
        showBrandedAlert('Futures Unavailable', `No active futures contracts currently available for ${underlying}.`);
        return;
      }
      if (!isProUser() && isInstrumentRestrictedForFree(fut)) {
        showSubscriptionUpgradePrompt(fut.symbol);
        return;
      }
      openOrderTicket(side, fut);
    } catch (err) {
      showBrandedAlert('Error', err.message);
    }
  }

  async function jumpToNearestIndexFuture(underlying) {
    try {
      const res = await apiFetch(`/api/v1/instruments?segment=FUTIDX&underlying=${encodeURIComponent(underlying)}&limit=5`);
      const first = selectFrontFuture(res.instruments,underlying);
      if (first) {
        await openChartByGlobalId(first.globalId);
      }
    } catch { }
  }

  function selectFrontFuture(instruments,underlying){
    const today=new Date(serverNowMs()+19800000).toISOString().slice(0,10);
    return (instruments||[]).filter(i=>i.instrumentType==='FUTIDX'&&i.isTradable!==false&&i.lotSize>0&&i.tickSize>0&&i.underlying===underlying&&i.expiry>=today).sort((a,b)=>a.expiry.localeCompare(b.expiry))[0];
  }

  function openOptionChainFromChart() {
    const inst = state.activeInstrument;
    let und = String(inst?.underlying || '').trim().toUpperCase();
    if (!und) {
      const resolved = window.TzFreeAccess?.resolveUnderlyingFromSymbol(inst?.symbol || '');
      und = resolved || (String(inst?.symbol || '').toUpperCase().includes('BANK') ? 'BANKNIFTY' : 'NIFTY');
    }
    openOptionChainModal(und);
  }

  let inspectedCandleTime=null;
  const historicalPageCache=new Map();
  function openChartDateNavigation(){
    let modal=document.getElementById('modal-chart-date');if(!modal){modal=document.createElement('div');modal.id='modal-chart-date';modal.className='modal-backdrop';document.body.appendChild(modal);}
    modal.innerHTML='<div class="white-bottom-sheet history-detail"><h3>Find a candle</h3><label>Date and time (IST)<input id="chart-date-target" type="datetime-local"></label><p>Actual provider history only. Holidays and unavailable times use the nearest recorded candle.</p><div id="chart-date-status" role="status"></div><button class="row-retry" id="chart-date-find">Find candle</button><button class="row-retry" id="chart-date-close">Close</button></div>';
    document.getElementById('chart-date-target').value=new Date(serverNowMs()+19800000).toISOString().slice(0,16);
    document.getElementById('chart-date-close').onclick=()=>{modal.classList.remove('active');notifyNativeScreenState();};
    document.getElementById('chart-date-find').onclick=async()=>{
      const input=document.getElementById('chart-date-target'),status=document.getElementById('chart-date-status'),button=document.getElementById('chart-date-find');
      const target=Date.parse(input.value+':00+05:30');if(!Number.isFinite(target)||target>serverNowMs()){status.textContent='Choose a valid past date/time in IST.';return;}
      const gid=state.activeInstrument?.globalId,tf=state.activeTimeframe,token=state.token;const seq=++state.chartLoadSeq;chartRequestController?.abort();button.disabled=true;status.textContent='Loading recorded history…';
      try{const day=Math.floor((target+19800000)/86400000)*86400000-19800000;const key=[state.user?.userId,gid,tf,day].join(':');let data=historicalPageCache.get(key);
        if(!data){data=await apiFetch('/api/v1/market-data/candles?globalId='+encodeURIComponent(gid)+'&timeframe='+tf+'&from='+Math.floor((day-7*86400000)/1000)+'&to='+Math.floor((day+86400000)/1000)+'&limit=1500');historicalPageCache.set(key,data);if(historicalPageCache.size>6)historicalPageCache.delete(historicalPageCache.keys().next().value);}
        if(seq!==state.chartLoadSeq||token!==state.token||gid!==state.activeInstrument?.globalId)return;
        const bars=sanitizeChartCandles(data.candles||[]);if(!bars.length){status.textContent=data.providerError||'No recorded candles available. Choose another date or instrument.';return;}
        state.candles=bars;state.earliestTime=bars[0].time;state.hasMoreHistory=Boolean(data.hasMore);state.historicalInspection=true;candleSeries.setData(bars);recalculateAndRenderIndicators();
        const targetSec=target/1000;let nearest=0;for(let i=1;i<bars.length;i++)if(Math.abs(bars[i].time-targetSec)<Math.abs(bars[nearest].time-targetSec))nearest=i;
        tvChart.timeScale().setVisibleLogicalRange({from:Math.max(-2,nearest-45),to:nearest+45});const bar=bars[nearest];inspectedCandleTime=bar.time;
        document.getElementById('chart-ohlc-legend').textContent=formatChartTime(bar.time,true)+' · O '+fmtNum(bar.open)+' H '+fmtNum(bar.high)+' L '+fmtNum(bar.low)+' C '+fmtNum(bar.close);
        document.getElementById('chart-candle-stats').textContent='Historical view · '+formatChartTime(bar.time,true);document.getElementById('btn-go-latest').style.display='inline-flex';
        const exact=bar.time<=targetSec&&targetSec<bar.time+getTimeframeIntervalSec(tf);status.textContent=(exact?'Recorded candle: ':'No candle at that time. Nearest recorded candle: ')+formatChartTime(bar.time,true)+'. Close this sheet to inspect it.';
      }catch(e){status.textContent=e.message||'History unavailable. Try another date.';}finally{button.disabled=false;}
    };modal.classList.add('active');notifyNativeScreenState();
  }
  function formatChartTime(t,full=false){
    const epoch=typeof t==='number'?t*1000:Date.parse(typeof t==='string'?t:t.year+'-'+String(t.month).padStart(2,'0')+'-'+String(t.day).padStart(2,'0'));
    return new Intl.DateTimeFormat('en-IN',{timeZone:'Asia/Kolkata',...(full?{day:'2-digit',month:'short',year:'numeric'}:{}),...(state.activeTimeframe==='1D'?{}:{hour:'2-digit',minute:'2-digit',hour12:false})}).format(epoch)+(full?' IST':'');
  }
  function formatChartAxisTick(t, tickMarkType) {
    const epochMs = typeof t === 'number'
      ? t * 1000
      : Date.parse(typeof t === 'string' ? t : `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`);
    if (!Number.isFinite(epochMs)) return '';
    if (state.activeTimeframe === '1D' || tickMarkType === 0 || tickMarkType === 1 || tickMarkType === 2) {
      return new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: 'short',
        ...(state.activeTimeframe === '1D' || tickMarkType === 0 ? { year: '2-digit' } : {}),
      }).format(epochMs);
    }
    const istSec = Math.floor(epochMs / 1000) + 19800;
    const secOfIstDay = ((istSec % 86400) + 86400) % 86400;
    let isDayBoundary = secOfIstDay === (9 * 3600 + 15 * 60) || secOfIstDay === (9 * 3600);
    if (!isDayBoundary && Array.isArray(state.candles) && state.candles.length > 1 && typeof t === 'number') {
      const idx = state.candles.findIndex((c) => c.time === t);
      if (idx > 0) {
        const prevDay = Math.floor((state.candles[idx - 1].time + 19800) / 86400);
        const curDay = Math.floor((t + 19800) / 86400);
        if (curDay !== prevDay) isDayBoundary = true;
      } else if (idx === 0) {
        isDayBoundary = true;
      }
    }
    if (isDayBoundary) {
      const datePart = new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: 'short',
      }).format(epochMs);
      const timePart = new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(epochMs);
      return `${datePart} ${timePart}`;
    }
    return formatChartTime(t, false);
  }
  function initLightweightChartInstance() {
    const container = document.getElementById('tv-main-chart');
    if (tvChart) {
      const targetKey = (state.activeInstrument?.globalId || '') + ':' + (state.activeTimeframe || '5m');
      if (state.chartDataKey !== targetKey) {
        state.candles=[]; candleSeries.setData([]);
        Object.values(indicatorSeriesMap).forEach((series) => {
          try { tvChart.removeSeries(series); } catch { try { series.setData([]); } catch {} }
        });
        indicatorSeriesMap = {};
        const svg = document.getElementById('drawing-svg-layer');
        if (svg) svg.innerHTML='';
      }
      tvChart.applyOptions({width:container.clientWidth||380,height:container.clientHeight||420});
      try {
        tvChart.priceScale('right')?.applyOptions?.({ autoScale: true, mode: 0, scaleMargins: { top: 0.1, bottom: 0.14 } });
        candleSeries?.priceScale?.()?.applyOptions?.({ autoScale: true, mode: 0, scaleMargins: { top: 0.1, bottom: 0.14 } });
        tvChart.timeScale()?.resetTimeScale?.();
      } catch {}
      return;
    }

    const chartTheme = getChartThemeOptions();
    tvChart = LightweightCharts.createChart(container, {
      width: container.clientWidth || 380,
      height: container.clientHeight || 420,
      localization:{locale:'en-IN',timeFormatter:t=>formatChartTime(t,true)},
      layout: chartTheme.layout,
      grid: chartTheme.grid,
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      rightPriceScale: { borderColor: chartTheme.rightPriceScale.borderColor, autoScale: true, scaleMargins:{top:.1,bottom:.14} },
      timeScale: {
        borderColor: chartTheme.timeScale.borderColor,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 5,
        visible:true, minimumHeight:32, barSpacing:7, minBarSpacing:3,
        tickMarkFormatter:(t, tickMarkType)=>formatChartAxisTick(t, tickMarkType),
      },
    });

    candleSeries = tvChart.addCandlestickSeries({
      ...chartTheme.candle,
      priceLineStyle: 2,
    });

    tvChart.subscribeCrosshairMove((param) => {
      if (!param || !param.time || !param.seriesData) {
        // Keep selected candle timestamp while browsing history; only clear when following latest bar
        if (!state.isUserScrolledBack && !state.historicalInspection) {
          inspectedCandleTime = null;
        }
        return;
      }
      inspectedCandleTime = param.time;
      const bar = param.seriesData.get(candleSeries);
      if (bar) {
        document.getElementById('chart-ohlc-legend').textContent =
          `${formatChartTime(param.time,true)} · O ${fmtNum(bar.open)}  H ${fmtNum(bar.high)}  L ${fmtNum(bar.low)}  C ${fmtNum(bar.close)}`;
      }
    });

    // Left-scroll pagination listener + refresh button scroll state indicator
    tvChart.timeScale().subscribeVisibleLogicalRangeChange((logicalRange) => {
      renderDrawingsSvgOverlay();
      if (typeof renderChartProtectionOverlay === 'function') renderChartProtectionOverlay();
      if (!logicalRange || state.candles.length === 0) return;

      const distanceFromRight = state.candles.length - 1 - logicalRange.to;
      state.isUserScrolledBack = distanceFromRight > 12;
      const btn = document.getElementById('btn-go-latest');
      if (btn) {
        btn.style.display = 'inline-flex';
        btn.classList?.toggle?.('is-scrolled', Boolean(state.isUserScrolledBack || state.historicalInspection));
      }

      if (logicalRange.from < 15 && state.hasMoreHistory && !state.isFetchingOlder) {
        fetchOlderCandlePage();
      }
    });

    setupTouchArbitratedDrawingEvents();
    new ResizeObserver(()=>{if(tvChart&&container.clientWidth>0){tvChart.applyOptions({width:container.clientWidth,height:container.clientHeight});if(typeof renderChartProtectionOverlay==='function')renderChartProtectionOverlay();}}).observe(container);
  }

  let chartRequestController=null;
  const chartViewportCache=new Map();
  const chartCandleCache=new Map();
  let chartNavigationSeq=0;
  function rememberChartViewport(){
    if(!tvChart||!state.activeInstrument||!state.candles.length)return;
    const range=tvChart.timeScale().getVisibleRange();
    if(range){const key=state.activeInstrument.globalId+':'+state.activeTimeframe;chartViewportCache.delete(key);chartViewportCache.set(key,range);if(chartViewportCache.size>12)chartViewportCache.delete(chartViewportCache.keys().next().value);}
  }
  function resetChartScaleAndFitRecent(fitTimeAxis = true) {
    if (!tvChart) return;
    try {
      tvChart.priceScale('right')?.applyOptions?.({
        autoScale: true,
        mode: 0,
        scaleMargins: { top: 0.1, bottom: 0.14 },
      });
    } catch {}
    try {
      candleSeries?.priceScale?.()?.applyOptions?.({
        autoScale: true,
        mode: 0,
        scaleMargins: { top: 0.1, bottom: 0.14 },
      });
    } catch {}
    if (fitTimeAxis) {
      try { tvChart.timeScale()?.resetTimeScale?.(); } catch {}
      const totalBars = (state.candles || []).length;
      if (totalBars > 0) {
        const barsToShow = Math.min(80, Math.max(50, totalBars));
        try {
          tvChart.timeScale().setVisibleLogicalRange({
            from: Math.max(0, totalBars - barsToShow),
            to: totalBars + 4,
          });
        } catch {}
      }
      try {
        tvChart.priceScale('right')?.applyOptions?.({
          autoScale: true,
          scaleMargins: { top: 0.1, bottom: 0.14 },
        });
        candleSeries?.priceScale?.()?.applyOptions?.({
          autoScale: true,
          scaleMargins: { top: 0.1, bottom: 0.14 },
        });
      } catch {}
    }
    state.isUserScrolledBack = false;
    const btn = document.getElementById('btn-go-latest');
    if (btn) {
      btn.style.display = 'inline-flex';
      btn.classList?.remove?.('is-scrolled');
    }
  }
  async function loadChartCandlesInitial(opts = {}) {
    if (!state.activeInstrument) return;
    chartRequestController?.abort();
    chartRequestController=new AbortController();
    const seq = ++state.chartLoadSeq;
    const gid = state.activeInstrument.globalId;
    const tf = state.activeTimeframe;
    const token = state.token;
    const isRefresh = Boolean(opts && opts.isRefresh);
    state.chartLoading=true;state.chartPendingTicks=[];state.chartBarUpdates={};state.lastChartAppliedPriceMs=0;
    state.isFetchingOlder = false;
    state.isUserScrolledBack = false;
    state.historicalInspection = false;
    inspectedCandleTime = null;
    if (typeof chartViewportCache !== 'undefined' && chartViewportCache?.delete) {
      chartViewportCache.delete(gid + ':' + tf);
    }
    const refreshBtn = document.getElementById('btn-go-latest');
    if (refreshBtn) {
      refreshBtn.style.display = 'inline-flex';
      refreshBtn.classList?.remove?.('is-scrolled');
      refreshBtn.classList?.add?.('is-loading');
      refreshBtn.setAttribute?.('aria-busy', 'true');
    }
    const legendEl = document.getElementById('chart-ohlc-legend');
    const statsEl = document.getElementById('chart-candle-stats');
    if (legendEl) legendEl.textContent = isRefresh ? 'Refreshing chart…' : 'Loading price history…';
    if (statsEl) statsEl.textContent = isRefresh ? 'Reloading latest candles…' : 'Loading current data…';

    const rangeParam = state.activeRange ? `&range=${encodeURIComponent(state.activeRange)}` : '';
    const cacheKey = `${state.user?.userId || state.user?.id || 'anon'}|${gid}|${tf}|${state.activeRange || ''}`;
    // When switching to a different instrument or timeframe, immediately clear the previous series so old candles never display as the new instrument
    if (state.chartDataKey && state.chartDataKey !== gid + ':' + tf) {
      state.candles = [];
      try { candleSeries?.setData?.([]); } catch {}
    }

    try {
      const data = await apiFetch(
        `/api/v1/market-data/candles?globalId=${encodeURIComponent(gid)}&timeframe=${encodeURIComponent(tf)}${rangeParam}&limit=200`, {signal:chartRequestController.signal}
      );
      if (seq !== state.chartLoadSeq || (token !== undefined && state.token !== token) || state.activeInstrument?.globalId !== gid || state.activeTimeframe !== tf) return; // Discard stale response from earlier switch

      const incomingHistory=sanitizeChartCandles(data.candles || []);
      if(!incomingHistory.length&&data.providerError){
        state.chartLoading=false;
        if (refreshBtn) {
          refreshBtn.classList?.remove?.('is-loading');
          refreshBtn.removeAttribute?.('aria-busy');
        }
        const cachedEntry = typeof chartCandleCache !== 'undefined' ? chartCandleCache.get(cacheKey) : null;
        if (state.chartDataKey === gid + ':' + tf && state.candles.length > 0) {
          for(const tick of state.chartPendingTicks||[])if(tick.globalId===gid)reconcileCandleWithTick(tick,false);
        } else if (cachedEntry && cachedEntry.candles?.length > 0) {
          state.candles = cachedEntry.candles.map((c) => ({ ...c }));
          state.chartDataKey = gid + ':' + tf;
          candleSeries?.setData?.(state.candles);
          for(const tick of state.chartPendingTicks||[])if(tick.globalId===gid)reconcileCandleWithTick(tick,false);
        } else {
          state.candles=[];
          candleSeries?.setData?.([]);
        }
        state.chartPendingTicks=[];
        const lastUpdateLabel = cachedEntry?.updatedAtMs && typeof fmtIstClock === 'function'
          ? ` • Last updated ${fmtIstClock(cachedEntry.updatedAtMs)} IST`
          : '';
        if (legendEl) legendEl.textContent='History unavailable: '+data.providerError;
        if (statsEl) statsEl.textContent=(state.candles.length > 0 ? `Stale / Reconnecting (${state.candles.length} cached bars${lastUpdateLabel}) • ` : '') + 'Tap ↻ or an interval to retry.';
        updateChartCountdownUI();
        if (typeof renderChartProtectionOverlay === 'function') renderChartProtectionOverlay();
        return;
      }
      state.candles = incomingHistory;state.chartDataKey=gid+':'+tf;
      state.lastChartDataUpdatedAt = Date.now();
      if (typeof chartCandleCache !== 'undefined' && incomingHistory.length > 0) {
        chartCandleCache.delete(cacheKey);
        chartCandleCache.set(cacheKey, {
          candles: incomingHistory.map((c) => ({ ...c })),
          hasMore: Boolean(data.hasMore),
          earliestTime: data.earliestTime,
          prevSessionClose: data.prevSessionClose,
          sessionDateIST: data.sessionDateIST,
          updatedAtMs: Date.now(),
        });
        if (chartCandleCache.size > 24) {
          chartCandleCache.delete(chartCandleCache.keys().next().value);
        }
      }
      state.chartLoading=false;
      if (refreshBtn) {
        refreshBtn.classList?.remove?.('is-loading');
        refreshBtn.removeAttribute?.('aria-busy');
      }
      state.hasMoreHistory = Boolean(data.hasMore);
      state.earliestTime = data.earliestTime;
      state.prevSessionClose = data.prevSessionClose;

      if (!state.candles.length) {
        candleSeries?.setData([]);
        if (legendEl) legendEl.textContent = 'No history available for this interval.';
        if (statsEl) statsEl.textContent = 'Tap ↻ or choose another interval to retry';
      }

      if (candleSeries && state.candles.length > 0) {
        candleSeries.setData(state.candles);
        try {
          if (typeof tvChart !== 'undefined' && tvChart) {
            tvChart.priceScale?.('right')?.applyOptions?.({
              autoScale: true,
              mode: 0,
              scaleMargins: { top: 0.1, bottom: 0.14 },
            });
            tvChart.timeScale?.()?.resetTimeScale?.();
          }
          candleSeries?.priceScale?.()?.applyOptions?.({
            autoScale: true,
            mode: 0,
            scaleMargins: { top: 0.1, bottom: 0.14 },
          });
        } catch {}
        const totalBars = state.candles.length;
        const barsToShow = Math.min(80, Math.max(50, totalBars));
        try {
          if (typeof tvChart !== 'undefined' && tvChart) {
            tvChart.timeScale?.()?.setVisibleLogicalRange?.({
              from: Math.max(0, totalBars - barsToShow),
              to: totalBars + 4,
            });
            tvChart.priceScale?.('right')?.applyOptions?.({
              autoScale: true,
              scaleMargins: { top: 0.1, bottom: 0.14 },
            });
          }
          candleSeries?.priceScale?.()?.applyOptions?.({
            autoScale: true,
            scaleMargins: { top: 0.1, bottom: 0.14 },
          });
        } catch {}
        const last = state.candles[state.candles.length - 1];
        if (legendEl) {
          const timePrefix = typeof formatChartTime === 'function' ? `${formatChartTime(last.time, true)} · ` : '';
          legendEl.textContent =
            `${timePrefix}O ${fmtNum(last.open)}  H ${fmtNum(last.high)}  L ${fmtNum(last.low)}  C ${fmtNum(last.close)}`;
        }
        if (statsEl) {
          const mktClosed = state.feedHealth && state.feedHealth.marketSession && state.feedHealth.marketSession.isMarketOpen === false;
          const sessionSuffix = data.sessionDateIST ? ` • ${data.sessionDateIST}` : '';
          const statusSuffix = data.staleFallback
            ? ` • Cached (${data.lastCachedAt && typeof fmtIstClock === 'function' ? fmtIstClock(data.lastCachedAt) + ' IST' : 'stale'})`
            : mktClosed
              ? ' • Market Closed'
              : '';
          statsEl.textContent = `${state.candles.length} bars${sessionSuffix}${statusSuffix}`;
        }
      }
      if (data.latestQuote && (!data.latestQuote.globalId || data.latestQuote.globalId === gid)) {
        const latest=state.quotesMap?.get(gid);
        updateChartHeaderQuote(latest&&latest.providerTimestamp>data.latestQuote.providerTimestamp?latest:data.latestQuote);
        // Reconcile initial snapshot against the latest loaded candle if snapshot is at or after the latest candle
        if (state.candles.length > 0 && Number(data.latestQuote.ltp) > 0) {
          if(!latest||latest.providerTimestamp<=data.latestQuote.providerTimestamp)reconcileCandleWithTick({ ...data.latestQuote, globalId: gid }, true);
        }
      } else if (state.quotesMap?.get(gid)) {
        updateChartHeaderQuote(state.quotesMap.get(gid));
      }
      for(const tick of state.chartPendingTicks||[])if(tick.globalId===gid)reconcileCandleWithTick(tick,false);
      state.chartPendingTicks=[];
      updateChartCountdownUI();
      recalculateAndRenderIndicators();
      renderDrawingsSvgOverlay();
      if (typeof renderChartProtectionOverlay === 'function') renderChartProtectionOverlay();
      if (!isRefresh || !state.wsSubscribed?.has?.(gid)) {
        if (typeof sendWsSubscribe === 'function') sendWsSubscribe([gid]);
      }
    } catch (err) {
      if(seq===state.chartLoadSeq&&err.name!=='AbortError'){
        state.chartLoading=false;
        if (refreshBtn) {
          refreshBtn.classList?.remove?.('is-loading');
          refreshBtn.removeAttribute?.('aria-busy');
        }
        const cachedEntry = typeof chartCandleCache !== 'undefined' ? chartCandleCache.get(cacheKey) : null;
        if (state.chartDataKey === gid + ':' + tf && state.candles.length > 0) {
          // Keep already-rendered valid candles for the same instrument visible
        } else if (cachedEntry && cachedEntry.candles?.length > 0) {
          state.candles = cachedEntry.candles.map((c) => ({ ...c }));
          state.chartDataKey = gid + ':' + tf;
          try { candleSeries?.setData?.(state.candles); } catch {}
        } else {
          state.candles = [];
          try { candleSeries?.setData?.([]); } catch {}
        }
        const lastTs = cachedEntry?.updatedAtMs || state.lastChartDataUpdatedAt;
        const lastUpdateText = lastTs && typeof fmtIstClock === 'function' ? ` (Last updated ${fmtIstClock(lastTs)} IST)` : '';
        if (legendEl) {
          legendEl.textContent = state.candles.length > 0
            ? `Chart refresh failed • Showing last verified candles${lastUpdateText}. Tap ↻ to retry.`
            : 'Chart refresh failed. Tap ↻ to retry.';
        }
        if (statsEl) {
          statsEl.textContent = state.candles.length > 0
            ? `Stale / Reconnecting${lastUpdateText} • Tap ↻ to retry`
            : 'Tap ↻ to retry';
        }
        if (typeof renderChartProtectionOverlay === 'function') renderChartProtectionOverlay();
      }
    }
  }

  async function fetchOlderCandlePage() {
    if (!state.activeInstrument || !state.earliestTime || state.isFetchingOlder || !state.hasMoreHistory) return;
    state.isFetchingOlder = true;
    const seq = state.chartLoadSeq;
    const gid = state.activeInstrument.globalId;
    const tf = state.activeTimeframe;

    try {
      const prevVisibleTimeRange = tvChart ? tvChart.timeScale().getVisibleRange() : null;
      const data = await apiFetch(
        `/api/v1/market-data/candles?globalId=${encodeURIComponent(gid)}&timeframe=${encodeURIComponent(tf)}&before=${state.earliestTime}&limit=500`
      );
      if (seq !== state.chartLoadSeq) return;

      const older = data.candles || [];
      if (older.length === 0) {
        state.hasMoreHistory = false;
        return;
      }

      // Deduplicate & merge older + existing without any cap on the right!
      const byTime = new Map();
      for (const c of older) byTime.set(c.time, c);
      for (const c of state.candles) byTime.set(c.time, c);
      state.candles = sanitizeChartCandles(Array.from(byTime.values()).sort((a, b) => a.time - b.time));
      if(state.candles.length>6000){state.candles=state.candles.slice(0,6000);state.historicalInspection=true;document.getElementById('btn-go-latest').style.display='inline-flex';}
      state.earliestTime = state.candles[0].time;
      state.hasMoreHistory = Boolean(data.hasMore);

      if (candleSeries) {
        candleSeries.setData(state.candles);
        if (prevVisibleTimeRange && prevVisibleTimeRange.from && prevVisibleTimeRange.to) {
          tvChart.timeScale().setVisibleRange(prevVisibleTimeRange);
        }
      }
      document.getElementById('chart-candle-stats').textContent = `${state.candles.length} bars loaded`;
      recalculateAndRenderIndicators();
      renderDrawingsSvgOverlay();
    } catch {
      state.hasMoreHistory = false;
    } finally {
      state.isFetchingOlder = false;
    }
  }

  /**
   * Deliberate reconciliation after a WebSocket reconnect / backend restart.
   * Reloads the history tail, merges it with any bars aggregated locally while the request was
   * in flight, then restores the user's viewport (unless they are following the latest bar).
   */
  async function recoverChartAfterReconnect() {
    if (!state.activeInstrument || !state.chartOpen || !candleSeries || state.replayMode || state.historicalInspection) return;
    const seq = state.chartLoadSeq;
    const gid = state.activeInstrument.globalId;
    const tf = state.activeTimeframe;
    const intervalSec = getTimeframeIntervalSec(tf);
    const requestStarted=Date.now();
    let previousVisibleRange = null;
    try {
      previousVisibleRange = tvChart ? tvChart.timeScale().getVisibleRange() : null;
    } catch { }

    try {
      const data = await apiFetch(
        `/api/v1/market-data/candles?globalId=${encodeURIComponent(gid)}&timeframe=${encodeURIComponent(tf)}&limit=500`
      );
      if (seq !== state.chartLoadSeq) return; // user switched symbol/timeframe meanwhile
      const history = Array.isArray(data.candles) ? data.candles : [];
      if (history.length === 0) return;

      const bounded = sanitizeChartCandles(mergeCandleHistory(history,state.candles,state.chartBarUpdates||{},requestStarted));
      state.candles = bounded;
      state.earliestTime = bounded[0]?.time || state.earliestTime;
      candleSeries.setData(state.candles);
      recalculateAndRenderIndicators();
      renderDrawingsSvgOverlay();
      if (previousVisibleRange && state.isUserScrolledBack) {
        try {
          tvChart.timeScale().setVisibleRange(previousVisibleRange);
        } catch { }
      }
      updateChartCountdownUI();
      if (data.latestQuote) updateChartHeaderQuote(state.quotesMap?.get(gid)||data.latestQuote);
    } catch {
      // Non-fatal: live ticks continue to update the existing series.
    }
  }

  function mergeCandleHistory(history,live,changedAt,since){
    const byTime=new Map(history.map(c=>[c.time,c])),tail=history.at(-1)?.time||0;
    for(const c of live){if((changedAt[c.time]||0)<since&&c.time<=tail)continue;const old=byTime.get(c.time);byTime.set(c.time,old?{...old,high:Math.max(old.high,c.high),low:Math.min(old.low,c.low),close:c.close,volume:Math.max(old.volume||0,c.volume||0)}:c);}
    return [...byTime.values()].sort((a,b)=>a.time-b.time).slice(-6000);
  }

  async function refreshActiveChart() {
    if (!state.activeInstrument || !state.chartOpen) return;
    const gid = state.activeInstrument.globalId;
    const tf = state.activeTimeframe || '5m';
    state.historicalInspection = false;
    inspectedCandleTime = null;
    state.isUserScrolledBack = false;
    if (typeof chartViewportCache !== 'undefined' && chartViewportCache?.delete) {
      chartViewportCache.delete(gid + ':' + tf);
    }
    if (state.replayMode) {
      if (state.replayTimer) clearInterval(state.replayTimer);
      state.replayPlaying = false;
      state.replayMode = false;
      const bar = document.getElementById('chart-replay-bar');
      if (bar) bar.style.display = 'none';
    }
    resetChartScaleAndFitRecent(true);
    await loadChartCandlesInitial({ isRefresh: true });
    if (state.activeInstrument?.globalId === gid) {
      recalculateAndRenderIndicators();
      renderDrawingsSvgOverlay();
      updateChartCountdownUI();
    }
  }

  function scrollToLatestBar() {
    return refreshActiveChart();
  }

  function selectTimeframe(tf) {
    state.historicalInspection=false;inspectedCandleTime=null;
    state.activeTimeframe = tf;
    document.querySelectorAll('.chart-controls-strip .tf-pill').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-tf') === tf);
    });
    updateChartCountdownUI();
    loadChartCandlesInitial();
  }

  function selectRangePreset(range) {
    state.activeRange = range;
    document.querySelectorAll('.range-footer-strip .tf-pill').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-range') === range);
    });
    if (range === '1Y' || range === 'ALL') {
      state.activeTimeframe = '1D';
      document.querySelectorAll('.chart-controls-strip .tf-pill').forEach((b) => {
        b.classList.toggle('active', b.getAttribute('data-tf') === '1D');
      });
    }
    loadChartCandlesInitial();
  }

  function updateChartHeaderQuote(quote) {
    const ltpEl = document.getElementById('chart-ltp-display');
    const chgEl = document.getElementById('chart-chg-display');
    if (!ltpEl || !quote) return;
    const base = Number(quote.close);
    if(!(base>0)){ltpEl.textContent=fmtINR(quote.ltp);chgEl.textContent='Change unavailable';return;}
    const diff = quote.ltp - base;
    const pct = base > 0 ? (diff / base) * 100 : 0;
    const sign = diff >= 0 ? '+' : '';
    ltpEl.textContent = fmtINR(quote.ltp);
    chgEl.textContent = `${sign}${diff.toFixed(2)} (${formatChangePct(pct)})`;
    chgEl.className = 'tabular-nums ' + (diff >= 0 ? 'val-pos-dark' : 'val-neg');
    checkPriceAlerts(quote);
  }

  // =========================================================================
  // INDICATORS & TOUCH-ARBITRATED VECTOR DRAWINGS
  // =========================================================================
  function recalculateAndRenderIndicators() {
    if (!tvChart || state.candles.length === 0) return;
    const label=document.getElementById('chart-indicator-label');if(label)label.textContent=Object.keys(state.indicators).filter(k=>state.indicators[k]).map(k=>k==='sma20'?'SMA 20':k==='ema50'?'EMA 50':k).join(' · ')||'Indicators off · dashed line: last price · drawings: user saved';
    Object.values(indicatorSeriesMap).forEach((s) => {
      try { tvChart.removeSeries(s); } catch { }
    });
    indicatorSeriesMap = {};

    const closes = state.candles.map((c) => c.close);

    if (state.indicators.sma20 && state.candles.length >= 20) {
      const smaSeries = tvChart.addLineSeries({ title:'SMA 20',color:'#a78bfa',lineWidth:1,priceLineVisible:false,lastValueVisible:false,autoscaleInfoProvider:()=>null });
      const data = [];
      for (let i = 19; i < state.candles.length; i++) {
        let sum = 0;
        for (let j = i - 19; j <= i; j++) sum += closes[j];
        data.push({ time: state.candles[i].time, value: Number((sum / 20).toFixed(2)) });
      }
      smaSeries.setData(data);
      indicatorSeriesMap.sma20 = smaSeries;
    }

    if (state.indicators.ema50 && state.candles.length >= 50) {
      const emaSeries = tvChart.addLineSeries({ title:'EMA 50',color:'#38BDF8',lineWidth:1,priceLineVisible:false,lastValueVisible:false,autoscaleInfoProvider:()=>null });
      const k = 2 / 51;
      let ema = closes.slice(0, 50).reduce((a, b) => a + b, 0) / 50;
      const data = [{ time: state.candles[49].time, value: Number(ema.toFixed(2)) }];
      for (let i = 50; i < state.candles.length; i++) {
        ema = closes[i] * k + ema * (1 - k);
        data.push({ time: state.candles[i].time, value: Number(ema.toFixed(2)) });
      }
      emaSeries.setData(data);
      indicatorSeriesMap.ema50 = emaSeries;
    }
  }

  /**
   * Lightweight indicator refresh for the forming bar: updates only the last SMA/EMA point so
   * indicators stay continuous with the candle series without a full rebuild on every tick.
   */
  function updateIndicatorsForLastBar() {
    if (!tvChart || state.candles.length === 0) return;
    const closes = state.candles.map((c) => c.close);
    const lastIdx = state.candles.length - 1;
    const lastTime = state.candles[lastIdx].time;
    try {
      if (indicatorSeriesMap.sma20 && lastIdx >= 19) {
        let sum = 0;
        for (let j = lastIdx - 19; j <= lastIdx; j++) sum += closes[j];
        indicatorSeriesMap.sma20.update({ time: lastTime, value: Number((sum / 20).toFixed(2)) });
      }
      if (indicatorSeriesMap.ema50 && lastIdx >= 49) {
        const k = 2 / 51;
        let ema = closes.slice(0, 50).reduce((a, b) => a + b, 0) / 50;
        for (let i = 50; i <= lastIdx; i++) ema = closes[i] * k + ema * (1 - k);
        indicatorSeriesMap.ema50.update({ time: lastTime, value: Number(ema.toFixed(2)) });
      }
    } catch {
      // Series may have been removed by the user toggling indicators.
    }
  }

  function openIndicatorsModal() {
    const box = document.getElementById('indicators-list-box');
    const items = [
      { key: 'sma20', label: 'SMA 20 (Simple Moving Average — Lime)' },
      { key: 'ema50', label: 'EMA 50 (Exponential Moving Average — Cyan)' },
    ];
    box.innerHTML = items
      .map(
        (it) => `
        <div class="instrument-row-white" onclick="window.TZApp.toggleIndicator('${it.key}')">
          <span class="inst-symbol">${it.label}</span>
          <span style="font-weight:700;color:${state.indicators[it.key] ? 'var(--positive-on-white)' : '#9CA3AF'};">
            ${state.indicators[it.key] ? 'ACTIVE ✓' : 'OFF'}
          </span>
        </div>
      `
      )
      .join('');
    document.getElementById('modal-indicators').classList.add('active');
  }

  function toggleIndicator(key) {
    state.indicators[key] = !state.indicators[key];
    localStorage.setItem('tz_indicators_'+(state.user?.userId||state.user?.id),JSON.stringify(state.indicators));
    recalculateAndRenderIndicators();
    openIndicatorsModal();
  }

  function openDrawingsModal() {
    const tools = [
      { id: 'cursor', name: 'Cursor (Pan / Zoom)' },
      { id: 'trendline', name: 'Trendline (2-Point)' },
      { id: 'hline', name: 'Horizontal Level' },
      { id: 'rect', name: 'Supply/Demand Zone' },
      { id: 'fib', name: 'Fib Retracement' },
      { id: 'rr_long', name: 'Long Risk/Reward' },
    ];
    const box = document.getElementById('drawings-tools-box');
    box.innerHTML = tools
      .map(
        (t) => `
        <button class="filter-chip ${state.activeDrawingTool === t.id ? 'active' : ''}"
                style="padding:10px;text-align:left;"
                onclick="window.TZApp.selectDrawingTool('${t.id}')">
          ${t.name}
        </button>
      `
      )
      .join('');
    document.getElementById('modal-drawings').classList.add('active');
  }

  function setChartTouchLock(locked) {
    if (!tvChart) return;
    tvChart.applyOptions({
      handleScroll: !locked,
      handleScale: !locked,
    });
    const svg = document.getElementById('drawing-svg-layer');
    if (svg) svg.classList.toggle('interactive-mode', locked);
  }

  function selectDrawingTool(toolId) {
    state.activeDrawingTool = toolId;
    document.getElementById('active-drawing-label').textContent =
      toolId === 'cursor' ? '✎ Draw' : `✎ ${toolId.toUpperCase()}`;
    document.getElementById('btn-chart-drawings').classList.toggle('active', toolId !== 'cursor');
    setChartTouchLock(toolId !== 'cursor');
    document.getElementById('modal-drawings').classList.remove('active');
  }

  function setupTouchArbitratedDrawingEvents() {
    const svg = document.getElementById('drawing-svg-layer');
    if (!svg) return;

    const getPointFromEvent = (ev) => {
      const rect = svg.getBoundingClientRect();
      const touch = ev.touches?.[0] || ev.changedTouches?.[0] || ev;
      const x = touch.clientX - rect.left;
      const y = touch.clientY - rect.top;
      const time = tvChart?.timeScale().coordinateToTime(x) || state.candles[state.candles.length - 1]?.time || Math.floor(Date.now() / 1000);
      const price = candleSeries?.coordinateToPrice(y) || 0;
      return { x, y, time, price };
    };

    const onStart = (ev) => {
      if (state.activeDrawingTool === 'cursor') return;
      ev.preventDefault();
      setChartTouchLock(true);
      const pt = getPointFromEvent(ev);
      if (state.activeDrawingTool === 'hline') {
        state.drawings.push({ id: `d_${Date.now()}`, type: 'hline', p1: pt, p2: pt });
        selectDrawingTool('cursor');
        renderDrawingsSvgOverlay();
        persistDrawingsToServer();
        return;
      }
      state.activeDraftDrawing = {
        id: `d_${Date.now()}`,
        type: state.activeDrawingTool,
        p1: pt,
        p2: pt,
      };
      renderDrawingsSvgOverlay();
    };

    const onMove = (ev) => {
      if (!state.activeDraftDrawing) return;
      ev.preventDefault();
      state.activeDraftDrawing.p2 = getPointFromEvent(ev);
      renderDrawingsSvgOverlay();
    };

    const onEnd = (ev) => {
      if (!state.activeDraftDrawing) return;
      ev.preventDefault();
      state.activeDraftDrawing.p2 = getPointFromEvent(ev);
      state.drawings.push(state.activeDraftDrawing);
      state.activeDraftDrawing = null;
      selectDrawingTool('cursor');
      renderDrawingsSvgOverlay();
      persistDrawingsToServer();
    };

    svg.onmousedown = onStart;
    svg.onmousemove = onMove;
    svg.onmouseup = onEnd;
    svg.ontouchstart = onStart;
    svg.ontouchmove = onMove;
    svg.ontouchend = onEnd;
  }

  function renderDrawingsSvgOverlay() {
    const svg = document.getElementById('drawing-svg-layer');
    if (!svg || !tvChart || !candleSeries) return;
    const all = [...state.drawings, ...(state.activeDraftDrawing ? [state.activeDraftDrawing] : [])];

    const toCoords = (pt) => {
      const x = tvChart.timeScale().timeToCoordinate(pt.time);
      const y = candleSeries.priceToCoordinate(pt.price);
      return {x,y,valid:x!==null&&y!==null};
    };

    svg.innerHTML = all
      .map((d) => {
        const c1 = toCoords(d.p1);
        const c2 = toCoords(d.p2);
        if(d.type!=='hline'&&(!c1.valid||!c2.valid))return '';
        if(d.type==='hline'&&c1.y===null)return '';
        if (d.type === 'hline') {
          return `<line x1="0" y1="${c1.y}" x2="100%" y2="${c1.y}" stroke="#C7F542" stroke-width="2" stroke-dasharray="5,4"/>`;
        }
        if (d.type === 'rect' || d.type === 'rr_long') {
          const rx = Math.min(c1.x, c2.x);
          const ry = Math.min(c1.y, c2.y);
          const rw = Math.max(4, Math.abs(c2.x - c1.x));
          const rh = Math.max(4, Math.abs(c2.y - c1.y));
          return `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="rgba(199,245,66,0.16)" stroke="#C7F542" stroke-width="1.8"/>`;
        }
        return `
          <line x1="${c1.x}" y1="${c1.y}" x2="${c2.x}" y2="${c2.y}" stroke="#C7F542" stroke-width="2.2"/>
          <circle cx="${c1.x}" cy="${c1.y}" r="4.5" fill="#080C12" stroke="#C7F542" stroke-width="2"/>
          <circle cx="${c2.x}" cy="${c2.y}" r="4.5" fill="#080C12" stroke="#C7F542" stroke-width="2"/>
        `;
      })
      .join('');
  }

  async function loadUserDrawingsForActiveInstrument() {
    if (!state.activeInstrument || !state.token) return;
    const gid=state.activeInstrument.globalId, sessionToken=state.token;
    try {
      const res = await apiFetch(`/api/v1/drawings?instrumentId=${encodeURIComponent(gid)}`);
      if(state.activeInstrument?.globalId!==gid||state.token!==sessionToken)return;
      state.drawings = res.drawings || [];
      renderDrawingsSvgOverlay();
    } catch { }
  }

  async function persistDrawingsToServer() {
    if (!state.activeInstrument || !state.token) return;
    try {
      await apiFetch('/api/v1/drawings', {
        method: 'POST',
        body: JSON.stringify({
          instrumentId: state.activeInstrument.globalId,
          drawings: state.drawings,
        }),
      });
    } catch { }
  }

  function clearAllDrawings() {
    state.drawings = [];
    renderDrawingsSvgOverlay();
    persistDrawingsToServer();
    document.getElementById('modal-drawings').classList.remove('active');
  }

  // =========================================================================
  // 7. WHITE ORDER ENTRY BOTTOM SHEET & PAPER ORDER SUBMISSION
  // =========================================================================
  async function openOrderTicketByGlobalId(globalId, side = 'BUY') {
    await openChartByGlobalId(globalId);
    if (state.activeInstrument?.globalId !== globalId || !state.chartOpen) return;
    openOrderTicket(side);
  }

  function openOrderTicket(side = 'BUY', explicitInst = null) {
    const inst = explicitInst || state.activeInstrument;
    if (!inst) return;
    if (inst.instrumentType === 'INDEX_SPOT' || inst.isTradable === false || inst.metadataUnavailable || !(inst.lotSize > 0)) {
      showBrandedAlert('Contract unavailable', 'Select an actual supported futures or options contract with verified lot details.');
      return;
    }
    state.orderTicket.instrument = inst;
    state.orderTicket.open=true;
    state.orderTicket.recoveryAttempts=0;
    state.orderTicket.nextRecoveryAt=0;
    syncLiveSubscriptions();
    state.orderTicket.side = side;
    state.orderTicket.productType = inst.instrumentType === 'EQUITY_STOCK' ? 'INTRADAY' : 'MARGIN';
    state.orderTicket.orderType = 'MARKET';
    state.orderTicket.quantity = inst.lotSize || 1;

    document.getElementById('ticket-symbol').textContent = inst.symbol;
    const badgeLabel = inst.instrumentType === 'FUTIDX'
      ? `${inst.exchange} • INDEX FUTURE`
      : inst.instrumentType === 'FUTSTK'
      ? `${inst.exchange} • STOCK FUTURE`
      : `${inst.exchange} • ${inst.instrumentType}`;
    document.getElementById('ticket-exchange-badge').textContent = `${badgeLabel} • ${inst.underlying || ''} ${inst.expiry || ''} ${inst.optionType || ''} ${inst.strikePrice || ''} • Lot: ${inst.lotSize}`;
    document.getElementById('ticket-qty-label').textContent = `Quantity (Lot Size: ${inst.lotSize || 1})`;
    document.getElementById('ticket-input-qty').value = String(inst.lotSize || 1);
    document.getElementById('ticket-input-sl').value = '';
    document.getElementById('ticket-input-target').value = '';
    document.getElementById('ticket-error-box').style.display = 'none';

    const prodGroup = document.getElementById('ticket-product-group');
    if (inst.instrumentType === 'EQUITY_STOCK') {
      prodGroup.innerHTML = `
        <button id="ticket-prod-intraday" class="seg-pill-btn active" onclick="window.TZApp.setOrderProduct('INTRADAY')">Intraday (MIS 20%)</button>
        <button id="ticket-prod-delivery" class="seg-pill-btn" onclick="window.TZApp.setOrderProduct('DELIVERY')">Delivery (CNC 100%)</button>
      `;
    } else if (inst.exchange === 'MCX') {
      prodGroup.innerHTML = `
        <button class="seg-pill-btn active" style="grid-column:span 2;">Commodity Practice Margin (MCX 5%)</button>
      `;
    } else {
      prodGroup.innerHTML = `
        <button class="seg-pill-btn active" style="grid-column:span 2;">F&amp;O Margin (${inst.instrumentType})</button>
      `;
    }

    setOrderSide(side);
    setOrderType('MARKET');
    recalcOrderMarginPreview();
    document.getElementById('modal-order-ticket').classList.add('active');
    startTicketQuoteRecovery();
    notifyNativeScreenState();
    apiFetch(`/api/v1/market-data/quote?globalId=${encodeURIComponent(inst.globalId)}`).then((data) => {
      noteServerClock(data.serverTimestamp);
      if (data.quote) handleIncomingQuoteTick(data.quote,true);
      if (state.orderTicket.instrument?.globalId === inst.globalId) recalcOrderMarginPreview();
    }).catch(() => {});
  }

  function closeOrderTicket() {
    state.orderTicket.open=false;
    clearInterval(ticketQuoteTimer);ticketQuoteTimer=null;
    document.getElementById('modal-order-ticket').classList.remove('active');
    syncLiveSubscriptions();
    notifyNativeScreenState();
  }

  function setOrderSide(side) {
    state.orderTicket.side = side;
    document.getElementById('ticket-side-buy').classList.toggle('active', side === 'BUY');
    document.getElementById('ticket-side-sell').classList.toggle('active', side === 'SELL');
    const btn = document.getElementById('ticket-submit-btn');
    btn.textContent = `Place Paper ${side} Order`;
    btn.style.background = side === 'BUY' ? 'var(--accent-lime)' : 'var(--negative-red)';
    btn.style.color = side === 'BUY' ? 'var(--bg-midnight)' : 'var(--bg-white)';
    recalcOrderMarginPreview();
  }

  function setOrderProduct(prod) {
    state.orderTicket.productType = prod;
    const iBtn = document.getElementById('ticket-prod-intraday');
    const dBtn = document.getElementById('ticket-prod-delivery');
    if (iBtn) iBtn.classList.toggle('active', prod === 'INTRADAY');
    if (dBtn) dBtn.classList.toggle('active', prod === 'DELIVERY');
    recalcOrderMarginPreview();
  }

  function setOrderType(type) {
    state.orderTicket.orderType = type;
    document.getElementById('ticket-type-market')?.classList.toggle('active', type === 'MARKET');
    document.getElementById('ticket-type-limit')?.classList.toggle('active', type === 'LIMIT');
    document.getElementById('ticket-type-sl')?.classList.toggle('active', type === 'STOP_MARKET');
    document.getElementById('ticket-type-sll')?.classList.toggle('active', type === 'STOP_LIMIT');

    const priceIn = document.getElementById('ticket-input-price');
    const triggerRow = document.getElementById('ticket-trigger-row');
    const triggerIn = document.getElementById('ticket-input-trigger');
    const inst = state.orderTicket.instrument;
    const lastClose = Number(state.quotesMap?.get(inst?.globalId)?.ltp || inst?.latestQuote?.ltp) ||
      (state.activeInstrument?.globalId === inst?.globalId ? state.candles[state.candles.length - 1]?.close : null);
    if (triggerRow) triggerRow.style.display = type === 'STOP_LIMIT' ? 'block' : 'none';
    if (type === 'MARKET') {
      priceIn.disabled = true;
      priceIn.value = '';
      priceIn.placeholder = 'Market Price';
      document.getElementById('ticket-price-label').textContent = 'Execution Price';
    } else if (type === 'STOP_LIMIT') {
      priceIn.disabled = false;
      priceIn.value = lastClose > 0 ? String(lastClose) : '';
      if (triggerIn) triggerIn.value = lastClose > 0 ? String(lastClose) : '';
      document.getElementById('ticket-price-label').textContent = 'Limit Price (₹)';
    } else {
      priceIn.disabled = false;
      priceIn.value = lastClose > 0 ? String(lastClose) : '';
      document.getElementById('ticket-price-label').textContent =
        type === 'LIMIT' ? 'Limit Price (₹)' : 'Trigger Price (₹)';
    }
    recalcOrderMarginPreview();
  }

  function stepOrderQty(dir) {
    const inst = state.orderTicket.instrument;
    const lot = inst?.lotSize || 1;
    const cur = parseInt(document.getElementById('ticket-input-qty').value || String(lot), 10);
    const next = Math.max(lot, cur + dir * lot);
    document.getElementById('ticket-input-qty').value = String(next);
    recalcOrderMarginPreview();
  }

  function recalcOrderMarginPreview() {
    const inst = state.orderTicket.instrument;
    if (!inst) return;
    const currentQuote=state.quotesMap?.get(inst.globalId)||inst.latestQuote;
    const fresh=quoteFreshnessMs(currentQuote)<=5000;
    const isOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const isTimedOut = Boolean(state.orderTicket.timedOutKey);
    const submit=document.getElementById('ticket-submit-btn');
    const hintEl = document.getElementById('ticket-disabled-hint');
    if (submit) submit.disabled = Boolean(state.orderSubmitting) || !fresh || isOffline || isTimedOut;
    if (hintEl) {
      if (isTimedOut) {
        hintEl.textContent = 'Check the timed-out order status above before placing another order.';
        hintEl.style.display = 'block';
      } else if (isOffline) {
        hintEl.textContent = 'You are offline — reconnect to submit a paper order.';
        hintEl.style.display = 'block';
      } else if (!fresh) {
        hintEl.textContent = 'Waiting for a fresh live quote (≤ 5s) before submission.';
        hintEl.style.display = 'block';
      } else {
        hintEl.style.display = 'none';
      }
    }
    const qty = Math.max(1, parseInt(document.getElementById('ticket-input-qty').value || '1', 10));
    const quotePrice = Number(state.quotesMap?.get(inst.globalId)?.ltp || inst.latestQuote?.ltp);
    const sameChart = state.activeInstrument?.globalId === inst.globalId;
    const chartPrice = sameChart && state.candles.length > 0 ? Number(state.candles[state.candles.length - 1].close) : 0;
    const lastClose = quotePrice > 0 ? quotePrice : chartPrice > 0 ? chartPrice : null;
    const reqPrice = parseFloat(document.getElementById('ticket-input-price').value);
    const price = !isNaN(reqPrice) && reqPrice > 0 ? reqPrice : lastClose;

    if (!(price > 0)) {
      document.getElementById('ticket-ltp-sub').textContent = 'Live price unavailable — reconnecting';
      document.getElementById('ticket-margin-req').textContent = '—';
      document.getElementById('ticket-charges-est').textContent = '—';
      return;
    }

    document.getElementById('ticket-ltp-sub').textContent = fresh?`Ref LTP: ${fmtINR(lastClose)} • Tick: ${inst.tickSize || 0.05}`:`Live price unavailable — reconnecting${lastClose>0?' • Last known: '+fmtINR(lastClose):''}`;

    const quoteRatio =
      inst.exchange === 'MCX' && inst.priceQuoteMultiplier
        ? inst.priceQuoteMultiplier / (inst.lotSize || 1)
        : 1.0;
    const notionalTurnover = price * quoteRatio * qty;

    let margin = notionalTurnover * 0.2;
    if (inst.instrumentType === 'EQUITY_STOCK') {
      margin = state.orderTicket.productType === 'DELIVERY' ? notionalTurnover * 1.0 : notionalTurnover * 0.2;
    } else if (inst.instrumentType === 'OPTIDX' || inst.instrumentType === 'OPTSTK' || inst.instrumentType === 'OPTCOM') {
      margin =
        state.orderTicket.side === 'BUY'
          ? notionalTurnover
          : notionalTurnover + (inst.strikePrice || price * 50) * qty * quoteRatio * 0.15;
    } else if (inst.instrumentType === 'FUTCOM') {
      margin = notionalTurnover * (inst.marginMultiplier || 0.05);
    } else if (inst.instrumentType === 'FUTIDX' || inst.instrumentType === 'FUTSTK') {
      margin = notionalTurnover * (inst.marginMultiplier || 0.12);
    }

    const charges = Math.max(20, notionalTurnover * 0.0002);
    const tickValue = (inst.tickSize || 0.05) * quoteRatio * (inst.lotSize || 1);

    document.getElementById('ticket-margin-req').textContent = fmtINR(margin);
    document.getElementById('ticket-charges-est').textContent = fmtINR(charges);

    const expBadge = document.getElementById('ticket-exposure-badge');
    if (expBadge) expBadge.textContent = `Notional: ${fmtINR(notionalTurnover)}`;

    const tickValEl = document.getElementById('ticket-tick-val');
    if (tickValEl) tickValEl.textContent = `₹${tickValue.toFixed(2)}`;

    const unitSpecEl = document.getElementById('ticket-unit-spec');
    if (unitSpecEl) unitSpecEl.textContent = inst.instrumentType==='EQUITY_STOCK'?'Unit: shares':inst.exchange==='MCX'&&inst.tradingUnit?`Unit: ${inst.tradingUnit}`:`Lot: ${inst.lotSize || 1} units`;

    // Dynamic Stop Loss Risk & R:R Calculator
    const slVal = parseFloat(document.getElementById('ticket-input-sl').value);
    const tpVal = parseFloat(document.getElementById('ticket-input-target').value);
    const slRow = document.getElementById('ticket-sl-risk-row');
    const rrRow = document.getElementById('ticket-rr-ratio-row');

    if (slRow) {
      if (!isNaN(slVal) && slVal > 0) {
        const stopDistance = Math.abs(price - slVal);
        const slRiskRupees = stopDistance * quoteRatio * qty;
        slRow.style.display = 'block';
        document.getElementById('ticket-sl-distance-pts').textContent = `(${stopDistance.toFixed(2)} pts)`;
        document.getElementById('ticket-sl-risk-amt').textContent = `-₹${fmtINR(slRiskRupees)}`;

        if (rrRow && !isNaN(tpVal) && tpVal > 0 && stopDistance > 0) {
          const targetDistance = Math.abs(tpVal - price);
          const rr = (targetDistance / stopDistance).toFixed(1);
          rrRow.style.display = 'flex';
          document.getElementById('ticket-rr-val').textContent = `1 : ${rr}`;
        } else if (rrRow) {
          rrRow.style.display = 'none';
        }
      } else {
        slRow.style.display = 'none';
        if (rrRow) rrRow.style.display = 'none';
      }
    }

    const assumptionsNotice = document.getElementById('ticket-simulation-disclaimer');
    if (assumptionsNotice) {
      assumptionsNotice.textContent = 'Simulation Assumption: Margin and charges are computed using fixed educational models for paper trading practice.';
    }
  }

  async function submitPaperOrder() {
    if(state.orderSubmitting)return;
    const inst = state.orderTicket.instrument;
    if (!inst) return;
    if(quoteFreshnessMs(state.quotesMap?.get(inst.globalId)||inst.latestQuote)>5000){
      recalcOrderMarginPreview();recoverTicketQuote();return;
    }
    const errBox = document.getElementById('ticket-error-box');
    errBox.style.display = 'none';

    const qty = parseInt(document.getElementById('ticket-input-qty').value || '0', 10);
    const rawPrice = parseFloat(document.getElementById('ticket-input-price').value);
    const rawTrigger = parseFloat(document.getElementById('ticket-input-trigger')?.value || '');
    const slVal = parseFloat(document.getElementById('ticket-input-sl').value);
    const tpVal = parseFloat(document.getElementById('ticket-input-target').value);

    const payload = {
      globalInstrumentId: inst.globalId,
      side: state.orderTicket.side,
      orderType: state.orderTicket.orderType,
      productType: state.orderTicket.productType,
      quantity: qty,
      idempotencyKey: state.orderTicket.pendingIdempotencyKey || `ord_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    };
    state.orderTicket.pendingIdempotencyKey = payload.idempotencyKey;

    if (state.orderTicket.orderType === 'LIMIT') payload.requestedPrice = rawPrice;
    if (state.orderTicket.orderType === 'STOP_MARKET') payload.triggerPrice = rawPrice;
    if (state.orderTicket.orderType === 'STOP_LIMIT') {
      payload.requestedPrice = rawPrice;
      payload.triggerPrice = rawTrigger;
    }
    if (!isNaN(slVal) && slVal > 0) payload.stopLossPrice = slVal;
    if (!isNaN(tpVal) && tpVal > 0) payload.targetPrice = tpVal;

    const timeoutBox = document.getElementById('ticket-timeout-box');
    if (timeoutBox) timeoutBox.style.display = 'none';
    state.orderTicket.timedOutKey = null;

    state.orderSubmitting=true;
    const submittingButton=document.getElementById('ticket-submit-btn');
    submittingButton.disabled=true; submittingButton.setAttribute('aria-busy','true');
    const previousLabel=submittingButton.textContent; submittingButton.textContent='Placing simulated order…';
    try {
      const res = await apiFetch('/api/v1/orders/place', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      state.orderTicket.pendingIdempotencyKey = null;
      state.orderTicket.timedOutKey = null;
      markOnboardingStep('trade');
      const ordStatus = res?.order?.status || 'ACCEPTED';
      const extra = Array.isArray(res?.attachedOrders) && res.attachedOrders.length ? ` (+${res.attachedOrders.length} SL/TP)` : '';
      window.SikhoUX.notify(`Order ${ordStatus}: ${inst.symbol} × ${qty}${extra}`);
      closeOrderTicket();
      closeChartWorkspace();
      await refreshAccountAndPortfolio();
      switchMainTab(state.orderTicket.productType === 'DELIVERY' ? 'portfolio' : 'orders');
    } catch (err) {
      if (err && (err.code === 'ERR_SERVER_TIMEOUT' || err.code === 'ERR_SERVER_UNREACHABLE')) {
        // State 18 Trading Safety: never blindly resubmit as a new order or assume cancelled
        state.orderTicket.timedOutKey = payload.idempotencyKey;
        if (timeoutBox) {
          const detail = document.getElementById('ticket-timeout-detail');
          if (detail) detail.textContent = `Request timed out for ref ${payload.idempotencyKey.slice(-8)}. Do not re-submit until checking server status.`;
          timeoutBox.style.display = 'block';
        }
      } else if (err && err.status === 429 && err.retryAfterSec && window.SikhoUX?.startRateLimitCountdown) {
        window.SikhoUX.startRateLimitCountdown(submittingButton, errBox, err.retryAfterSec, previousLabel);
      } else {
        state.orderTicket.pendingIdempotencyKey = null;
        errBox.textContent = err.message;
        errBox.style.display = 'block';
      }
    } finally {
      state.orderSubmitting=false; submittingButton.removeAttribute('aria-busy');
      if (!(submittingButton.textContent || '').startsWith('Retry in ')) {
        submittingButton.textContent = previousLabel;
      }
      recalcOrderMarginPreview();
    }
  }

  async function checkTimedOutOrderStatus() {
    const key = state.orderTicket.timedOutKey;
    if (!key) return;
    const btn = document.getElementById('ticket-check-status-btn');
    const detail = document.getElementById('ticket-timeout-detail');
    if (btn) { btn.disabled = true; btn.textContent = 'Checking server status…'; }
    try {
      const res = await apiFetch(`/api/v1/orders/by-idempotency/${encodeURIComponent(key)}`);
      if (res && res.found && res.order) {
        state.orderTicket.timedOutKey = null;
        state.orderTicket.pendingIdempotencyKey = null;
        const timeoutBox = document.getElementById('ticket-timeout-box');
        if (timeoutBox) timeoutBox.style.display = 'none';
        window.SikhoUX?.notify(`Confirmed from server: Order ${res.order.status} (${res.order.symbol || ''} × ${res.order.quantity})`);
        closeOrderTicket();
        closeChartWorkspace();
        await refreshAccountAndPortfolio();
        switchMainTab('orders');
      } else {
        state.orderTicket.timedOutKey = null;
        const timeoutBox = document.getElementById('ticket-timeout-box');
        if (timeoutBox) timeoutBox.style.display = 'none';
        window.SikhoUX?.notify('Order was not received by server. You may safely retry with the same reference.');
        recalcOrderMarginPreview();
      }
    } catch (err) {
      if (detail) detail.textContent = `Still unable to verify status (${err.message}). Keep checking — do not place a duplicate order.`;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Check Order Status'; }
    }
  }

  // =========================================================================
  // 8. PORTFOLIO (Holdings | Positions | History) & ORDERS TABS
  // =========================================================================
  function setPortfolioSubTab(sub) {
    if(sub==='HISTORY'){switchMainTab('history');return;}
    if (state.portfolioSubTab === sub) return;
    state.portfolioSubTab = sub;
    document.getElementById('btn-port-positions').classList.toggle('active', sub === 'POSITIONS');
    document.getElementById('btn-port-holdings').classList.toggle('active', sub === 'HOLDINGS');
    document.getElementById('btn-port-history').classList.toggle('active', sub === 'HISTORY');
    renderPortfolioTab();
    notifyNativeScreenState();
    recordEligibleAction('view_portfolio_' + sub);
  }

  function renderPortfolioTab() {
    const container = document.getElementById('portfolio-list-container');
    let list = [];
    if (state.portfolioSubTab === 'HOLDINGS') {
      list = state.positionsData.holdings || [];
    } else if (state.portfolioSubTab === 'HISTORY') {
      list = state.positionsData.closedPositions || [];
    } else {
      list = state.positionsData.activePositions || [];
    }

    if (list.length === 0) {
      const emptyLabel =
        state.portfolioSubTab === 'HOLDINGS'
          ? 'No Equity Delivery (CNC) holdings yet. Place a Delivery BUY order on any NSE stock to build holdings.'
          : state.portfolioSubTab === 'HISTORY'
            ? 'No closed positions yet.'
            : 'No active Intraday or F&O positions. Explore stocks or option chains to place a paper trade.';
      container.innerHTML = `<div style="padding:32px 16px;text-align:center;color:var(--text-on-white-secondary);">${emptyLabel}</div>`;
      return;
    }

    container.innerHTML = list
      .map((p) => {
        const isOpen = p.quantity !== 0;
        const pnl = isOpen ? Number(p.unrealizedPnlINR || 0) : Number(p.realizedPnlINR || 0);
        const cls = pnl >= 0 ? 'val-pos' : 'val-neg';
        const avatarHtml = window.InstrumentIdentity
          ? window.InstrumentIdentity.renderInstrumentAvatar(p, 38)
          : `<div class="inst-badge-icon">${p.productType === 'DELIVERY' ? 'CNC' : 'POS'}</div>`;
        const sideLabel = p.quantity > 0 ? 'LONG' : p.quantity < 0 ? 'SHORT' : 'CLOSED';
        const tpText = Number(p.targetPrice) > 0 ? `TP: ${fmtINR(p.targetPrice)}` : 'TP: None';
        const slText = Number(p.stopLossPrice) > 0 ? `SL: ${fmtINR(p.stopLossPrice)}` : 'SL: None';
        const protLine = isOpen
          ? `<div class="inst-name-sub" style="margin-top:2px;font-weight:600;">${tpText} • ${slText}</div>`
          : '';

        return `
          <div class="instrument-row-white" onclick="window.TZApp.openChartByGlobalId('${p.globalInstrumentId}')">
            <div class="inst-left">
              ${avatarHtml}
              <div class="inst-meta">
                <div class="inst-symbol-row">
                  <span class="inst-symbol">${p.symbol}</span>
                  <span class="tag-exch">${p.productType || 'INTRADAY'}</span>
                  <span class="tag-exch">${sideLabel} ${Math.abs(p.quantity)}</span>
                </div>
                <div class="inst-name-sub">Avg: ${fmtINR(p.averageEntryPrice)} • LTP: ${fmtINR(p.currentPrice)}</div>
                ${protLine}
              </div>
            </div>
            <div class="inst-right" style="gap:6px;flex-wrap:wrap;justify-content:flex-end;">
              <div class="inst-price-col">
                <span class="inst-ltp-val ${cls}">${pnl >= 0 ? '+' : ''}${fmtINR(pnl)}</span>
                <span class="inst-chg-val" style="color:var(--text-on-white-secondary);">${isOpen ? 'Unrealized MTM' : 'Realized P&L'}</span>
              </div>
              ${isOpen
            ? `<div style="display:flex;gap:6px;align-items:center;">
                <button class="row-action" style="min-height:34px;padding:0 9px;font-size:11px;font-weight:700;"
                        onclick="event.stopPropagation(); window.TZApp.openProtectionModal('${p.id}')">
                  Add / Edit TP &amp; SL
                </button>
                <button class="btn-lime-primary" style="width:auto;min-height:34px;padding:0 10px;font-size:11.5px;background:var(--negative-red);color:#fff;"
                        onclick="event.stopPropagation(); window.TZApp.squareOffPosition('${p.globalInstrumentId}')">
                  Exit
                </button>
               </div>`
            : ''
          }
            </div>
          </div>
        `;
      })
      .join('');
  }

  async function squareOffPosition(globalId) {
    showConfirmSheet(
      'Exit Position',
      `Square off position for ${globalId.split(':')[1] || globalId}?`,
      async (ok) => {
        if (!ok) return;
        try {
          await apiFetch('/api/v1/positions/square-off', {
            method: 'POST',
            body: JSON.stringify({ globalInstrumentId: globalId }),
          });
          await refreshAccountAndPortfolio();
        } catch (err) {
          showBrandedAlert('Square Off Failed', err.message);
        }
      }
    );
  }

  function setOrdersFilter(filter, btnEl) {
    state.ordersFilter = filter;
    document.querySelectorAll('#tab-orders .filter-chip').forEach((b) => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');
    renderOrdersTab();
  }

  function renderOrdersTab(){if(state.mainTab==='orders')window.SikhoHistory?.showOrders(apiFetch,state.ordersFilter);}

  async function cancelPendingOrder(orderId) {
    showConfirmSheet(
      'Cancel Order',
      'Are you sure you want to cancel this pending order?',
      async (ok) => {
        if (!ok) return;
        try {
          await apiFetch(`/api/v1/orders/${encodeURIComponent(orderId)}/cancel`, { method: 'POST', body: '{}' });
          await refreshAccountAndPortfolio();
        } catch (err) {
          showBrandedAlert('Cancel Failed', err.message);
        }
      }
    );
  }

  // =========================================================================
  // 9. PROFILE ACTIONS: CAPITAL RESET PRESETS, SUBSCRIPTIONS, PIN & LEDGER
  // =========================================================================
  let selectedResetPresetINR = 100000;

  function openCapitalResetModal() {
    const modal = document.getElementById('modal-capital-reset');
    if (!modal) return;

    // Check positions and pending orders
    const allPos = state.positionsData?.positions || [];
    const hasOpenPos = allPos.some((p) => Math.abs(p.quantity || 0) > 0);
    const hasPendingOrd = state.hasPendingOrders || (state.orders || []).some((o) => o.status === 'PENDING' || o.status === 'TRIGGER_PENDING');

    const warningEl = document.getElementById('reset-positions-warning');
    const confirmBtn = document.getElementById('btn-confirm-capital-reset');
    if (warningEl) {
      warningEl.style.display = (hasOpenPos || hasPendingOrd) ? 'block' : 'none';
    }
    if (confirmBtn) {
      confirmBtn.disabled = (hasOpenPos || hasPendingOrd);
      confirmBtn.style.opacity = (hasOpenPos || hasPendingOrd) ? '0.5' : '1';
    }

    const isPro = hasFullFeatureAccess();
    // Free: ₹1L, ₹2L, ₹5L, ₹10L, ₹20L
    // Pro: ₹1L, ₹10L, ₹25L, ₹50L, ₹1Cr, ₹2Cr, ₹5Cr, ₹10Cr
    const freePresets = [100000, 200000, 500000, 1000000, 2000000];
    const proPresets = [100000, 1000000, 2500000, 5000000, 10000000, 20000000, 50000000, 100000000];
    const presets = isPro ? proPresets : freePresets;

    selectedResetPresetINR = 100000;

    const hintEl = document.getElementById('custom-capital-tier-hint');
    if (hintEl) {
      hintEl.textContent = isPro
        ? 'PRO TIER: Any custom amount up to ₹10 Crore'
        : 'FREE TIER: ₹1,00,000 to ₹20,00,000 • Upgrade to Pro for up to ₹10 Crore';
    }

    const inputCustom = document.getElementById('input-custom-reset-capital');
    if (inputCustom) inputCustom.value = '';

    const grid = document.getElementById('capital-preset-grid');
    if (grid) {
      grid.innerHTML = presets.map((amount) => {
        let label = '₹1 Lakh';
        if (amount >= 10000000) label = `₹${amount / 10000000} Crore`;
        else if (amount >= 100000) label = `₹${amount / 100000} Lakh`;

        const isActive = amount === selectedResetPresetINR;
        return `
          <button type="button" class="preset-chip ${isActive ? 'active' : ''}" data-amount="${amount}" onclick="window.TZApp.selectCapitalPreset(${amount}, this)">
            <span class="preset-chip-amount">${label}</span>
            <span class="preset-chip-sub">${fmtINR(amount)}</span>
          </button>
        `;
      }).join('');
    }

    if (confirmBtn) {
      confirmBtn.textContent = `Confirm Reset to ${fmtINR(selectedResetPresetINR)}`;
    }

    const custom=document.getElementById('input-custom-reset-capital')?.closest('div[style*="margin-top"]');
    if(custom)custom.hidden=state.access?.accessMode==='FREE_LAUNCH';
    modal.classList.add('active');
    notifyNativeScreenState();
  }

  function selectCapitalPreset(amount, btn) {
    selectedResetPresetINR = amount;
    const inputCustom = document.getElementById('input-custom-reset-capital');
    if (inputCustom) inputCustom.value = '';
    document.querySelectorAll('#capital-preset-grid .preset-chip').forEach((c) => c.classList.remove('active'));
    if (btn) btn.classList.add('active');
    const confirmBtn = document.getElementById('btn-confirm-capital-reset');
    if (confirmBtn) {
      confirmBtn.textContent = `Confirm Reset to ${fmtINR(amount)}`;
    }
  }

  function onCustomCapitalInput(val) {
    const num = Math.round(Number(val) || 0);
    if (num > 0) {
      document.querySelectorAll('#capital-preset-grid .preset-chip').forEach((c) => c.classList.remove('active'));
      const confirmBtn = document.getElementById('btn-confirm-capital-reset');
      if (confirmBtn) confirmBtn.textContent = `Confirm Reset to ${fmtINR(num)}`;
    }
  }

  function applyCustomCapital() {
    const input = document.getElementById('input-custom-reset-capital');
    if(state.access?.accessMode==='FREE_LAUNCH'){showBrandedAlert('Choose a preset','Free Launch includes the approved Premium capital presets.');return;}
    const val = Math.round(Number(input?.value) || 0);
    const isPro = hasFullFeatureAccess();

    if (!val || val < 100000) {
      showBrandedAlert('Invalid Capital', 'Minimum starting practice capital is ₹1,00,000.');
      return;
    }

    if (!isPro && val > 2000000) {
      showBrandedAlert('Pro Tier Required', 'Free tier users can select up to ₹20,00,000 (₹20 Lakhs). Upgrade to Pro to trade with practice capital up to ₹10 Crore.');
      return;
    }

    if (isPro && val > 100000000) {
      showBrandedAlert('Maximum Limit', 'Maximum allowed practice capital is ₹10 Crore (₹10,00,00,000).');
      return;
    }

    selectedResetPresetINR = val;
    document.querySelectorAll('#capital-preset-grid .preset-chip').forEach((c) => c.classList.remove('active'));
    const confirmBtn = document.getElementById('btn-confirm-capital-reset');
    if (confirmBtn) confirmBtn.textContent = `Confirm Reset to ${fmtINR(val)}`;
  }

  async function executeCapitalReset() {
    const allPos = state.positionsData?.positions || [];
    const hasOpenPos = allPos.some((p) => Math.abs(p.quantity || 0) > 0);
    const hasPendingOrd = (state.orders || []).some((o) => o.status === 'PENDING' || o.status === 'TRIGGER_PENDING');

    if (hasOpenPos || hasPendingOrd) {
      showBrandedAlert('Cannot Reset Capital', 'Please square off all open positions and cancel pending orders before resetting your practice capital.');
      return;
    }

    showConfirmSheet(
      'Reset Practice Capital',
      `Are you sure you want to reset your starting practice balance to ${fmtINR(selectedResetPresetINR)}? This will archive your current session and start fresh. Your lifetime track record will be preserved.`,
      async (confirmed) => {
        if (!confirmed) return;
        try {
          const res = await apiFetch('/api/v1/account/reset', {
            method: 'POST',
            body: JSON.stringify({ startingCapitalINR: selectedResetPresetINR }),
          });
          document.getElementById('modal-capital-reset')?.classList.remove('active');
          await refreshAccountAndPortfolio();
          showBrandedAlert('Capital Reset Successful', `Your virtual practice account has been reset to ${fmtINR(selectedResetPresetINR)}.`);
        } catch (err) {
          showBrandedAlert('Reset Failed', err.message);
        }
      }
    );
  }

  async function resetVirtualWallet() {
    openCapitalResetModal();
  }

  let selectedPlanId = 'plan_month_100';

  function openSubscriptionPlansModal() {
    if(state.access?.accessMode==='FREE_LAUNCH'){showBrandedAlert('Free Launch','All supported paper-trading features are unlocked. Your account remains Free unless you hold verified ad-free access.');return;}
    const modal = document.getElementById('modal-subscription');
    if (!modal) return;
    selectPlanCard('plan_month_100');
    modal.classList.add('active');
    notifyNativeScreenState();
  }

  function selectPlanCard(planId) {
    selectedPlanId = planId;
    ['day', 'month', 'year'].forEach((p) => {
      const card = document.getElementById(`plan-card-${p}`);
      if (card) card.classList.remove('active');
    });

    const ctaBtn = document.getElementById('btn-subscribe-cta');
    if (planId === 'plan_day_10') {
      document.getElementById('plan-card-day')?.classList.add('active');
      if (ctaBtn) ctaBtn.textContent = 'Get Day Pass • ₹10';
    } else if (planId === 'plan_month_100') {
      document.getElementById('plan-card-month')?.classList.add('active');
      if (ctaBtn) ctaBtn.textContent = 'Upgrade to Monthly Pro • ₹100';
    } else if (planId === 'plan_year_800') {
      document.getElementById('plan-card-year')?.classList.add('active');
      if (ctaBtn) ctaBtn.textContent = 'Upgrade to Annual Pro • ₹800';
    }
  }

  async function initiateSubscriptionPurchase() {
    if (window.TradingzoneNative && typeof window.TradingzoneNative.launchBillingFlow === 'function') {
      window.TradingzoneNative.launchBillingFlow(selectedPlanId);
      return;
    }

    try {
      const res = await apiFetch('/api/v1/billing/verify-purchase', {
        method: 'POST',
        body: JSON.stringify({
          productId: selectedPlanId,
          planId: selectedPlanId,
          purchaseToken: 'token_' + Date.now(),
        }),
      });
      if (state.user) {
        state.user.tier = res.tier || 'PRO';
      }
      document.getElementById('modal-subscription')?.classList.remove('active');
      await refreshAccountAndPortfolio();
      showBrandedAlert('Subscription Activated', 'Welcome to Sikho Trading Premium! All equities, F&O derivatives, and MCX commodities are now unlocked.');
    } catch (err) {
      showBrandedAlert('Subscription Error', err.message);
    }
  }

  async function restorePurchases() {
    try {
      const res = await apiFetch('/api/v1/billing/restore-purchases', {
        method: 'POST',
        body: '{}',
      });
      const restoredTier = res.status?.tier || res.tier || 'FREE';
      const isProActive = Boolean(res.restored || restoredTier === 'PRO');
      if (res.status) {
        state.subscription = res.status;
        state.entitlementResolved = true;
      }
      if (state.user) {
        state.user.tier = restoredTier;
      }
      await refreshAccountAndPortfolio();
      showBrandedAlert(
        'Purchases Restored',
        isProActive
          ? (res.status?.statusLabel || 'Your Pro subscription is active!')
          : 'No active Pro subscription found.'
      );
    } catch (err) {
      showBrandedAlert('Restore Failed', err.message);
    }
  }

  async function loadAndShowLedger() {
    const box = document.getElementById('prof-ledger-box');
    if (box.style.display === 'block') {
      box.style.display = 'none';
      return;
    }
    try {
      const res = await apiFetch('/api/v1/account/ledger');
      const entries = (res.ledger || []).slice(0, 12);
      box.innerHTML = entries
        .map(
          (e) => `
          <div style="padding:8px 0;border-bottom:1px solid #E5E7EB;font-size:12px;display:flex;justify-content:space-between;">
            <div>
              <strong>${e.entryType}</strong>
              <div style="color:var(--text-on-white-secondary);">${e.note}</div>
            </div>
            <div class="tabular-nums" style="font-weight:700;text-align:right;">
              ${e.amountINR >= 0 ? '+' : ''}${fmtINR(e.amountINR)}
            </div>
          </div>
        `
        )
        .join('');
      box.style.display = 'block';
    } catch { }
  }

  function switchMainTab(tab) {
    const activeTab = tab === 'markets' ? 'explore' : tab;
    const changed = state.mainTab !== activeTab;
    state.mainTab = activeTab;
    const strip=document.getElementById('benchmark-index-strip');if(strip)strip.style.display=activeTab==='explore'?'flex':'none';
    const launch=document.getElementById('launch-access-label');if(launch)launch.style.display=activeTab==='explore'?'block':'none';
    const tabs = ['explore', 'watchlists', 'portfolio', 'orders', 'history', 'profile'];
    tabs.forEach((t) => {
      const el = document.getElementById(`tab-${t}`);
      const btn = document.getElementById(`nav-btn-${t}`);
      if (el) el.style.display = t === activeTab ? 'block' : 'none';
      if (btn) btn.classList.toggle('active', t === activeTab);
    });
    if(tab==='history')window.SikhoHistory?.show(apiFetch);
    if(tab==='orders')window.SikhoHistory?.showOrders(apiFetch,state.ordersFilter);
    if (tab === 'portfolio' || tab === 'orders' || tab === 'profile') {
      refreshAccountAndPortfolio();
    }
    syncNativeSystemBarTheme();
    notifyNativeScreenState();
    if (changed) recordEligibleAction('switch_tab_' + activeTab);
  }

  // =========================================================================
  // 10. REALTIME WEBSOCKET TICK CONSUMPTION, CANDLE AGGREGATION & COUNTDOWN
  // =========================================================================
  let wsReconnectTimer = null;
  let wsReconnectAttempts = 0;
  let chartCountdownTimer = null;

  function getTimeframeIntervalSec(tf) {
    switch (tf) {
      case '1m': return 60;
      case '3m': return 180;
      case '5m': return 300;
      case '15m': return 900;
      case '30m': return 1800;
      case '1h': return 3600;
      case '1D': return 86400;
      default: return 300;
    }
  }

  /**
   * Computes the candle bucket start timestamp (in UTC seconds) for a given epoch ms and timeframe,
   * aligned to the existing historical series anchor or IST market open (09:15 IST = UTC+03:45 = 13500s offset).
   */
  /**
   * Defensive candle sanitisation for the chart. Providers can return structurally invalid rows or
   * pre-listing placeholder bars (e.g. a NIFTY future priced 12.45 while trading near 25,000) which
   * would compress the entire price scale. Invalid rows and >90% outliers versus the newest close
   * are removed. Applied after merges so the newest bar is always the reference.
   */
  function sanitizeChartCandles(candles) {
    if (!Array.isArray(candles) || candles.length === 0) return [];
    const valid = candles.filter((c) => {
      if (!c || !Number.isFinite(Number(c.time))) return false;
      const o = Number(c.open);
      const h = Number(c.high);
      const l = Number(c.low);
      const cl = Number(c.close);
      return [o, h, l, cl].every((v) => Number.isFinite(v) && v > 0) && h >= l;
    });
    if (valid.length === 0) return [];
    const reference = Number(valid[valid.length - 1].close);
    if (!Number.isFinite(reference) || reference <= 0) return valid;
    const filtered = valid.filter((c) => {
      const cl = Number(c.close);
      return cl >= reference * 0.1 && cl <= reference * 10;
    });
    return filtered.length > 0 ? filtered : [valid[valid.length - 1]];
  }

  function computeCandleBucketSec(epochMs, tf, referenceBarTimeSec) {
    const intervalSec = getTimeframeIntervalSec(tf);
    const tickSec = Math.floor(Number(epochMs || Date.now()) / 1000);
    if (tf === '1D') {
      // Align daily bar to IST midnight (UTC + 19800s) or match referenceBarTimeSec if same IST date
      const istOffsetSec = 19800;
      const tickIstDay = Math.floor((tickSec + istOffsetSec) / 86400);
      if (referenceBarTimeSec) {
        const refIstDay = Math.floor((referenceBarTimeSec + istOffsetSec) / 86400);
        if (tickIstDay === refIstDay) {
          return referenceBarTimeSec;
        }
        const dayDiff = tickIstDay - refIstDay;
        return referenceBarTimeSec + dayDiff * 86400;
      }
      return tickIstDay * 86400 - istOffsetSec;
    }

    if (referenceBarTimeSec && referenceBarTimeSec > 0) {
      const anchorMod = ((referenceBarTimeSec % intervalSec) + intervalSec) % intervalSec;
      const shifted = tickSec - anchorMod;
      return Math.floor(shifted / intervalSec) * intervalSec + anchorMod;
    }

    // Standard NSE/BSE 09:15 IST alignment (09:15 IST is 03:45 UTC = 13500 seconds from UTC midnight)
    const istAnchorMod = 13500 % intervalSec;
    return Math.floor((tickSec - istAnchorMod) / intervalSec) * intervalSec + istAnchorMod;
  }

  function isExchangeOpenNowIST(exchange) {
    const now = new Date();
    // Convert to IST (UTC + 5:30)
    const istMs = now.getTime() + 19800 * 1000;
    const istDate = new Date(istMs);
    const day = istDate.getUTCDay(); // 0 = Sun, 6 = Sat
    if (day === 0 || day === 6) return false;
    const mins = istDate.getUTCHours() * 60 + istDate.getUTCMinutes();
    if (exchange === 'MCX') {
      // MCX 09:00 to 23:55 IST
      return mins >= 540 && mins <= 1435;
    }
    // NSE / BSE / NFO / BFO: 09:15 to 15:30 IST
    return mins >= 555 && mins <= 930;
  }

  function formatCountdownRemaining(remSec) {
    const s = Math.max(0, Math.floor(remSec));
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    const pad = (n) => (n < 10 ? '0' + n : String(n));
    if (hrs > 0) {
      return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
    }
    return `${pad(mins)}:${pad(secs)}`;
  }

  function fmtIstClock(epochMs) {
    try {
      return new Date(epochMs).toLocaleTimeString('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      return '--:--:--';
    }
  }

  function fmtIstHhMm(epochMs) {
    try {
      return new Date(epochMs).toLocaleTimeString('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return '--:--';
    }
  }

  /**
   * Computes the running candle's session-aligned window. Intraday windows honour the exchange
   * session open (NSE/BSE 09:15 IST, MCX 09:00 IST) via computeCandleBucketSec; the daily window
   * is the IST trading day 00:00 → 15:30 IST.
   */
  function computeRunningCandleWindow(tf, referenceBarTimeSec) {
    const intervalSec = getTimeframeIntervalSec(tf);
    const nowMs = serverNowMs();
    if (tf === '1D') {
      const istOffsetSec = 19800;
      const nowSec = Math.floor(nowMs / 1000);
      const dayStartSec = Math.floor((nowSec + istOffsetSec) / 86400) * 86400 - istOffsetSec;
      const closeOffsetSec = 15 * 3600 + 30 * 60;
      const sessionEndSec = dayStartSec + (state.activeInstrument?.exchange === 'MCX' ? 23 * 3600 + 55 * 60 : closeOffsetSec);
      return {
        startSec: dayStartSec,
        endSec: sessionEndSec,
        label: `${fmtIstHhMm(dayStartSec * 1000)}–${fmtIstHhMm(sessionEndSec * 1000)} IST`,
      };
    }
    const dayStartSec = Math.floor((Math.floor(nowMs / 1000) + 19800) / 86400) * 86400 - 19800;
    const sessionEndSec = dayStartSec + (state.activeInstrument?.exchange === 'MCX' ? 23 * 3600 + 55 * 60 : 15 * 3600 + 30 * 60);
    const sessionStartSec = dayStartSec + (state.activeInstrument?.exchange === 'MCX' ? 9 * 3600 : 9 * 3600 + 15 * 60);
    const windowTimeMs = Math.max(sessionStartSec * 1000, Math.min(nowMs, (sessionEndSec - 1) * 1000));
    const bucketStartSec = computeCandleBucketSec(windowTimeMs, tf, referenceBarTimeSec);
    const endSec = Math.min(bucketStartSec + intervalSec, sessionEndSec);
    return {
      startSec: bucketStartSec,
      endSec,
      label: `${fmtIstHhMm(bucketStartSec * 1000)}–${fmtIstHhMm(endSec * 1000)} IST`,
    };
  }

  /** Current IST clock and running-candle window: independent of feed state and countdown. */
  function updateChartTimeStrip() {
    const clockEl = document.getElementById('chart-ist-clock');
    if (clockEl) {
      clockEl.textContent = `${fmtIstClock(serverNowMs())} IST`;
    }
    const windowEl = document.getElementById('chart-candle-window');
    if (windowEl) {
      const tf = state.activeTimeframe || '5m';
      const refTime = state.candles.length > 0 ? state.candles[state.candles.length - 1].time : null;
      const win = computeRunningCandleWindow(tf, refTime);
      windowEl.textContent = `${tf} ${win.label}`;
      windowEl.title = `Running ${tf} candle: ${win.label}`;
    }
  }

  function updateChartCountdownUI() {
    refreshPrioritySubscriptions();
    const feed=document.getElementById('chart-feed-status');
    if(feed){const q=state.quotesMap?.get(state.activeInstrument?.globalId),age=quoteFreshnessMs(q);feed.textContent=!state.wsConnected?'Disconnected — reconnecting':age>5000?'Data stale — reconnecting':`${q?.timestampSource==='UPSTOX_REST_TIMESTAMP'?'REST recovery':'Feed current'} · ${Math.round(age)}ms`;}
    if (!state.chartOpen) return;
    // Current IST clock + running-candle window are always refreshed, independent of feed state.
    updateChartTimeStrip();
    const pill = document.getElementById('chart-candle-countdown');
    if (!pill) return;

    const inst = state.activeInstrument;
    const exch = inst?.exchange || 'NSE';
    const tf = state.activeTimeframe || '5m';
    // Countdown is derived from the corrected server clock against the session-aligned interval
    // boundary, never from candle movement. It ticks once per second independently of data.
    const nowSec = Math.floor(serverNowMs() / 1000);
    const refTime = state.candles.length > 0 ? state.candles[state.candles.length - 1].time : null;
    const win = computeRunningCandleWindow(tf, refTime);
    const remSec = Math.max(0, win.endSec - nowSec);
    const timeStr = formatCountdownRemaining(remSec);

    const isLiveOrDemo = Boolean(
      state.feedHealth?.activeProvider?.status === 'LIVE' ||
      state.feedHealth?.activeProvider?.isSimulated ||
      state.feedHealth?.activeProvider?.source === 'DEMO'
    );
    const sessionExchange = exch === 'MCX' ? 'MCX' : ['BSE', 'BFO'].includes(exch) ? 'BSE' : 'NSE';
    const exchangeSession = state.feedHealth?.exchangeSessions?.[sessionExchange];
    const mktOpen = typeof exchangeSession?.isOpen === 'boolean' ? exchangeSession.isOpen
      : sessionExchange !== 'MCX' && state.feedHealth?.marketSession?.isMarketOpen !== undefined
        ? Boolean(state.feedHealth.marketSession.isMarketOpen)
        : isExchangeOpenNowIST(exch);

    pill.classList.remove('state-closed', 'state-warn', 'state-err');

    if (!wsConn || wsConn.readyState !== WebSocket.OPEN) {
      pill.classList.add('state-err');
      pill.textContent = `⚡ Disconnected • ${timeStr}`;
      return;
    }

    if (!mktOpen || state.feedHealth?.activeProvider?.status === 'MARKET_CLOSED') {
      pill.classList.add('state-closed');
      pill.textContent = `⏸ Market Closed • ${tf} (${timeStr})`;
      return;
    }

    const lastInstTickMs = inst?.globalId
      ? (state.lastTickClientReceiveMs?.[inst.globalId] || 0)
      : 0;
    const tickAgeMs = quoteFreshnessMs(state.quotesMap?.get(inst?.globalId));
    if (tickAgeMs > 5000) {
      pill.classList.add('state-warn');
      if (!lastInstTickMs || lastInstTickMs === 0 || tickAgeMs > 300000) {
        pill.textContent = `⏳ Waiting for live prices • ${timeStr}`;
        if (feed) feed.textContent = 'Waiting for live prices';
      } else {
        pill.textContent = `⚠ Stale Feed • ${timeStr}`;
      }
      return;
    }

    pill.textContent = `⏱ ${timeStr}`;
  }

  function startChartCountdownTimer() {
    stopChartCountdownTimer();
    updateChartCountdownUI();
    chartCountdownTimer = setInterval(() => {
      updateChartCountdownUI();
    }, 1000);
  }

  function stopChartCountdownTimer() {
    if (chartCountdownTimer) {
      clearInterval(chartCountdownTimer);
      chartCountdownTimer = null;
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      // Recalculate on resume: the countdown, feed state and boundary may all have moved on.
      refreshFeedHealth();
      if (state.chartOpen) {
        updateChartCountdownUI();
      }
      if (!wsConn || wsConn.readyState !== WebSocket.OPEN) {
        state.wsNeedsGapRecovery = true;
        connectRealtimeWebSocket();
      } else {
        syncLiveSubscriptions();
        if(state.chartOpen)recoverChartAfterReconnect();
      }
      if(state.orderTicket?.open){state.orderTicket.nextRecoveryAt=0;recoverTicketQuote();}
    }
  });

  function collectDesiredSubscriptions() {
    const subs = new Set(
      (state.selectedIndices && state.selectedIndices.length)
        ? state.selectedIndices
        : ['NSE:NIFTY 50:99926000', 'NSE:BANKNIFTY:99926009', 'BSE:SENSEX:99919000']
    );
    if (state.chartOpen && state.activeInstrument?.globalId) {
      subs.add(state.activeInstrument.globalId);
    }
    if(state.orderTicket?.open&&state.orderTicket.instrument?.globalId)subs.add(state.orderTicket.instrument.globalId);
    if (state.positionsData?.positions) {
      for (const p of state.positionsData.positions) {
        if (p.globalInstrumentId && Math.abs(p.quantity || 0) > 0) {
          subs.add(p.globalInstrumentId);
        }
      }
    }
    if (state.watchlists?.[0]?.instruments) {
      for (const gid of state.watchlists[0].instruments) {
        if (gid) subs.add(gid);
      }
    }
    // Keep the visible option-chain contracts streaming across reconnects.
    if (state.optionChain?.subscribed) {
      for (const gid of state.optionChain.subscribed) {
        if (gid) subs.add(gid);
      }
    }
    return Array.from(subs);
  }

  function sendWsSubscribe(symbols) {
    if (!Array.isArray(symbols) || symbols.length === 0) return;
    if (!wsConn || wsConn.readyState !== WebSocket.OPEN) return;
    try {
      wsConn.send(JSON.stringify({
        action: 'SUBSCRIBE',
        type: 'SUBSCRIBE',
        symbols,
        prioritySymbols:getPrioritySymbols(),
      }));
      state.wsSubscribed=state.wsSubscribed||new Set();symbols.forEach(s=>state.wsSubscribed.add(s));
    } catch {}
  }

  function getPrioritySymbols(){return [...new Set([state.chartOpen?state.activeInstrument?.globalId:null,state.orderTicket?.open?state.orderTicket.instrument?.globalId:null].filter(Boolean))];}
  function refreshPrioritySubscriptions(){if(Date.now()-(state.lastPrioritySentAt||0)<30000)return;const ids=getPrioritySymbols();if(ids.length){sendWsSubscribe(ids);state.lastPrioritySentAt=Date.now();}}

  function syncLiveSubscriptions(){
    const desired=new Set(collectDesiredSubscriptions()),known=state.wsSubscribed||new Set();
    if(wsConn?.readyState!==WebSocket.OPEN)return;
    const remove=[...known].filter(g=>!desired.has(g));
    if(remove.length)wsConn.send(JSON.stringify({type:'UNSUBSCRIBE',symbols:remove}));
    remove.forEach(g=>known.delete(g));state.wsSubscribed=known;
    sendWsSubscribe([...desired].filter(g=>!known.has(g)));
  }

  function quoteFreshnessMs(q){
    const now=serverNowMs(),event=Number(q?.providerTimestamp),received=Number(q?.receiveTimestamp);
    if(!q||!(received>0)||received>now+1000||(!q.isSimulated&&(!(event>0)||event>now+1000)))return Infinity;
    return Math.max(0,now-received,q.isSimulated?0:now-event);
  }
  let ticketQuoteTimer=null;
  async function recoverTicketQuote(){
    const t=state.orderTicket;if(!t?.open||t.recovering||Date.now()<(t.nextRecoveryAt||0))return;
    const gid=t.instrument?.globalId;if(!gid)return;t.recovering=true;
    t.recoveryAttempts=(t.recoveryAttempts||0)+1;t.nextRecoveryAt=Date.now()+Math.min(30000,1000*2**Math.min(t.recoveryAttempts-1,5));
    try{const data=await apiFetch('/api/v1/market-data/quote?globalId='+encodeURIComponent(gid));if(t.open&&t.instrument?.globalId===gid){if(data.diagnostics){state.providerDiagnostics=state.providerDiagnostics||{};state.providerDiagnostics[gid]=data.diagnostics;}if(data.quote)handleIncomingQuoteTick(data.quote,true);}}catch{}finally{t.recovering=false;}
  }
  function startTicketQuoteRecovery(){
    clearInterval(ticketQuoteTimer);
    const pulse=()=>{if(!state.orderTicket?.open)return;refreshPrioritySubscriptions();recalcOrderMarginPreview();if(quoteFreshnessMs(state.quotesMap?.get(state.orderTicket.instrument?.globalId))>5000)recoverTicketQuote();};
    pulse();ticketQuoteTimer=setInterval(pulse,1000);
  }
  function getMarketDataDiagnostics(){
    const offset=serverNowMs()-Date.now();
    return [state.activeInstrument,state.orderTicket?.open?state.orderTicket.instrument:null].filter(Boolean).map(i=>{
      const q=state.quotesMap?.get(i.globalId),age=quoteFreshnessMs(q);
      return {globalId:i.globalId,providerKey:i.upstoxInstrumentKey,expiry:i.expiry,lotSize:i.lotSize,tickSize:i.tickSize,
        desiredSubscription:collectDesiredSubscriptions().includes(i.globalId),appSocketConnected:state.wsConnected,
        lastProviderEventTimestamp:q?.providerTimestamp,lastTradeTimestamp:q?.lastTradeTimestamp,backendReceiptTimestamp:q?.receiveTimestamp,
        frontendReceiptTimestamp:state.lastSeenQuoteReceipt?.[i.globalId]||state.lastTickClientReceiveMs?.[i.globalId],
        frontendRenderTimestamp:state.lastRenderByInstrument?.[i.globalId],frontendClockOffsetMs:offset,
        quoteSource:q?.source,timestampSource:q?.timestampSource,ageMs:Number.isFinite(age)?age:null,
        provider:state.providerDiagnostics?.[i.globalId],chart:state.chartOpen&&state.activeInstrument?.globalId===i.globalId?{
          timeframe:state.activeTimeframe,barCount:state.candles.length,lastBars:state.candles.slice(-3).map(c=>({...c}))}:null};
    });
  }

  function scheduleWsReconnect() {
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    // Exponential backoff with jitter: 2s, 4s, 8s, up to 15s max
    const delay = Math.min(15000, 2000 * Math.pow(1.5, Math.min(wsReconnectAttempts, 6))) + Math.random() * 500;
    wsReconnectAttempts++;
    wsReconnectTimer = setTimeout(() => {
      connectRealtimeWebSocket();
    }, delay);
  }

  function connectRealtimeWebSocket() {
    if (wsConn && (wsConn.readyState === WebSocket.OPEN || wsConn.readyState === WebSocket.CONNECTING)) {
      return;
    }
    try {
      const wsUrl = API_BASE.replace(/^http/, 'ws') + '/ws';
      const sock = new WebSocket(wsUrl);
      wsConn = sock;

      sock.onopen = () => {
        if (wsConn !== sock) return;
        wsReconnectAttempts = 0;
        state.wsConnected = true;
        clearTimeout(reconnectBannerTimer);
        updateAppStatusBanner();
        state.wsSubscribed=new Set();
        if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
        if (state.token) {
          try {
            sock.send(JSON.stringify({ action: 'AUTH', type: 'AUTH', token: state.token }));
          } catch { }
        }
        sendWsSubscribe(collectDesiredSubscriptions());
        if (state.chartOpen) {
          updateChartCountdownUI();
        }
      };

      sock.onmessage = (ev) => {
        if (wsConn !== sock) return;
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'QUOTE_SUBSCRIPTION_LIMIT') {
            if (ocIsOpen()) setOptionChainStatus('Live subscription capacity unavailable', 'Displayed prices may be stale; retry later.');
            return;
          }
          if(msg.type==='TRADING_CHANGED'){scheduleTradingReconcile();return;}
          if (msg.type === 'POSITION_PROTECTION_UPDATED' && msg.position) {
            applyRemotePositionProtectionUpdate(msg.position);
            scheduleTradingReconcile();
            return;
          }
          if (msg.type === 'AUTH_SUCCESS') {
            state.wsSubscribed=new Set();
            applyAccessPolicy(msg.access);
            scheduleTradingReconcile();
            noteServerClock(msg.serverTimestamp);
            // Re-send desired subscriptions once authenticated so Pro-tier instruments are authorized
            sendWsSubscribe(collectDesiredSubscriptions());
            // After a dropped connection, reload the tail of history so candles created while the
            // socket was down are not missing from the chart (deliberate reconciliation).
            if (state.wsNeedsGapRecovery) {
              state.wsNeedsGapRecovery = false;
              recoverChartAfterReconnect();
            }
          } else if (msg.type === 'ENTITLEMENT_UPDATED') {
            applyAccessPolicy(msg.access);
            const newTier = msg.tier || msg.entitlement?.tier || 'FREE';
            if (msg.entitlement) {
              state.subscription = msg.entitlement;
            } else {
              state.subscription = Object.assign({}, state.subscription || {}, { tier: newTier });
            }
            state.entitlementResolved = true;
            if (state.user) state.user.tier = newTier;
            if (state.account) state.account.tier = newTier;
            if (state.token && state.user) {
              saveSessionSecure({ token: state.token, user: state.user, account: state.account });
            }
            renderProfileStatsUI();
            renderExploreStocksList();
            renderExploreFnoLists();
            renderCommoditiesList();
            notifyNativeUserTier();
          } else if (msg.type === 'FORMING_CANDLE_SNAPSHOT' && msg.globalId && msg.candles) {
            applyFormingCandleSnapshot(msg);
          } else if (msg.type === 'QUOTE_TICK' && msg.data) {
            handleIncomingQuoteTick(msg.data,Boolean(msg.isSnapshot));
          }
        } catch { }
      };

      sock.onclose = () => {
        if (wsConn !== sock) return;
        wsConn = null;
        state.wsConnected = false;
        // Anything that happened while the socket was down must be reconciled from history when
        // the next authenticated connection is established.
        state.wsNeedsGapRecovery = true;
        if (state.chartOpen) {
          updateChartCountdownUI();
        }
        scheduleWsReconnect();
        clearTimeout(reconnectBannerTimer);
        reconnectBannerTimer = setTimeout(() => updateAppStatusBanner(), 1500);
      };

      sock.onerror = () => {
        if (wsConn !== sock) return;
        try { sock.close(); } catch { }
      };
    } catch {
      scheduleWsReconnect();
    }
  }

  /**
   * Reconciles a live tick or initial quote snapshot with the active chart's candle series:
   * - Updates close, high, low while preserving open when in the same interval bucket
   * - Starts a new candle at the exact interval boundary when a valid tick for a newer interval arrives
   * - Preserves user zoom, scroll position, and drawings
   */
  function applyFormingCandleSnapshot(msg){
    if(!state.chartOpen||state.chartLoading||state.replayMode||state.historicalInspection||!candleSeries||!state.candles.length||state.activeInstrument?.globalId!==msg.globalId)return;
    const event=Number(msg.priceEventTimestamp),tf=state.activeTimeframe||'5m',last=state.candles.at(-1),bar=msg.candles?.[tf];
    if(!(event>0)||event>serverNowMs()+1000||event<(state.lastChartAppliedPriceMs||0)||!bar||!(bar.close>0))return;
    const expected=computeCandleBucketSec(event,tf,last.time),interval=getTimeframeIntervalSec(tf);
    if(bar.time!==expected||bar.time<last.time||bar.time>last.time+interval*2)return;
    if(bar.time===last.time){last.high=Math.max(last.high,bar.high);last.low=Math.min(last.low,bar.low);last.close=bar.close;last.volume=Math.max(last.volume||0,bar.volume||0);candleSeries.update({...last});updateIndicatorsForLastBar();}
    else{const next={time:bar.time,open:bar.open,high:bar.high,low:bar.low,close:bar.close,volume:bar.volume};state.candles.push(next);candleSeries.update(next);recalculateAndRenderIndicators();}
    state.lastChartAppliedPriceMs=event;state.chartBarUpdates=state.chartBarUpdates||{};state.chartBarUpdates[bar.time]=Date.now();updateChartCountdownUI();
  }
  function reconcileCandleWithTick(quote, isInitialSnapshot = false) {
    if (!quote || (quote.globalId && state.activeInstrument?.globalId && quote.globalId !== state.activeInstrument.globalId)) return;
    if(quote.isTradeEvent===false&&!isInitialSnapshot)return;
    if(state.chartLoading){state.chartPendingTicks=state.chartPendingTicks||[];if(!isInitialSnapshot){state.chartPendingTicks.push(quote);if(state.chartPendingTicks.length>3000)state.chartPendingTicks.shift();}return;}
    if (!candleSeries || state.candles.length === 0 || state.replayMode || state.historicalInspection) return;
    const ltp = Number(quote.ltp);
    if (!ltp || isNaN(ltp) || ltp <= 0) return;

    const tf = state.activeTimeframe || '5m';
    const lastBar = state.candles[state.candles.length - 1];
    const tickTimeMs = Number(quote.lastTradeTimestamp || quote.providerTimestamp || quote.timestamp);
    if(!(tickTimeMs>0))return;
    if(tickTimeMs<(state.lastChartAppliedPriceMs||0))return;
    const bucketSec = computeCandleBucketSec(tickTimeMs, tf, lastBar.time);

    // Compute volume delta from cumulative day volume if available
    let volDelta = 0;
    const cumVol = Number(quote.volume);
    const gid = quote.globalId;
    if (!isNaN(cumVol) && cumVol >= 0 && gid) {
      const prevCum = state.lastCumulativeVolume[gid];
      if (prevCum !== undefined && cumVol >= prevCum) {
        volDelta = cumVol - prevCum;
      }
      state.lastCumulativeVolume[gid] = cumVol;
    }

    // Do not allow an older historical snapshot to roll back or corrupt a newer candle
    if (bucketSec < lastBar.time) {
      return;
    }
    if(!isInitialSnapshot){state.chartBarUpdates=state.chartBarUpdates||{};state.chartBarUpdates[bucketSec]=Date.now();}

    if (bucketSec === lastBar.time) {
      const updatedBar = {
        time: lastBar.time,
        open: lastBar.open,
        high: Math.max(lastBar.high, ltp),
        low: Math.min(lastBar.low, ltp),
        close: ltp,
        volume: Number(lastBar.volume || 0) + volDelta,
      };
      state.candles[state.candles.length - 1] = updatedBar;
      candleSeries.update(updatedBar);
      updateIndicatorsForLastBar();
      const legendEl = document.getElementById('chart-ohlc-legend');
      if (legendEl && (!inspectedCandleTime || inspectedCandleTime===bucketSec)) {
        const timePrefix = typeof formatChartTime === 'function' ? `${formatChartTime(updatedBar.time, true)} · ` : '';
        legendEl.textContent =
          `${timePrefix}O ${fmtNum(updatedBar.open)}  H ${fmtNum(updatedBar.high)}  L ${fmtNum(updatedBar.low)}  C ${fmtNum(updatedBar.close)}`;
      }
      if (typeof renderChartProtectionOverlay === 'function') renderChartProtectionOverlay();
    } else if (bucketSec > lastBar.time) {
      if(isInitialSnapshot)return; // A cached snapshot does not prove a new interval traded.
      // Genuine tick in a new timeframe interval -> start a new candle at the exact boundary.
      // Note: an "initial snapshot" is NOT special-cased into the previous bar; doing so used to
      // merge the new interval's price into the old candle and corrupt its OHLC.
      const newBar = {
        time: bucketSec,
        open: ltp,
        high: ltp,
        low: ltp,
        close: ltp,
        volume: volDelta,
      };
      state.candles.push(newBar);
      candleSeries.update(newBar);
      recalculateAndRenderIndicators();
      const legendEl = document.getElementById('chart-ohlc-legend');
      if (legendEl && (!inspectedCandleTime || inspectedCandleTime===bucketSec)) {
        const timePrefix = typeof formatChartTime === 'function' ? `${formatChartTime(newBar.time, true)} · ` : '';
        legendEl.textContent =
          `${timePrefix}O ${fmtNum(newBar.open)}  H ${fmtNum(newBar.high)}  L ${fmtNum(newBar.low)}  C ${fmtNum(newBar.close)}`;
      }
      const statsEl = document.getElementById('chart-candle-stats');
      if (statsEl) {
        statsEl.textContent = `${state.candles.length} bars`;
      }
      renderDrawingsSvgOverlay();
      if (typeof renderChartProtectionOverlay === 'function') renderChartProtectionOverlay();
    }
    state.lastChartAppliedPriceMs=Math.max(state.lastChartAppliedPriceMs||0,tickTimeMs);
  }

  let portfolioUpdateScheduled = false;
  function schedulePortfolioPnlUpdate() {
    if (portfolioUpdateScheduled) return;
    portfolioUpdateScheduled = true;
    const scheduleFn = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
    scheduleFn(() => {
      portfolioUpdateScheduled = false;
      renderAccountBalancesUI();
      if (state.mainTab === 'portfolio') {
        renderPortfolioTab();
      }
    });
  }

  function handleIncomingQuoteTick(quote,isSnapshot=false) {
    if (!quote || !quote.globalId) return;
    state.lastSeenQuoteReceipt=state.lastSeenQuoteReceipt||{};state.lastSeenQuoteReceipt[quote.globalId]=Date.now();
    state.lastTickTimestamps = state.lastTickTimestamps || {};
    const quoteTime = Number(quote.providerTimestamp || quote.receiveTimestamp || quote.timestamp || Date.now());
    const lastTime = state.lastTickTimestamps[quote.globalId] || 0;
    if (quoteTime && lastTime && quoteTime < lastTime) {
      // Discard out-of-order tick for this specific instrument only
      return;
    }
    if (quoteTime) {
      state.lastTickTimestamps[quote.globalId] = quoteTime;
    }
    state.lastTickClientReceiveMs = state.lastTickClientReceiveMs || {};
    state.lastTickClientReceiveMs[quote.globalId] = Date.now();
    state.lastAnyTickReceiveMs = Date.now();
    state.clientTicksReceived = (state.clientTicksReceived || 0) + 1;
    state.lastClientRenderMs = state.lastAnyTickReceiveMs;

    const latencyMs = quoteTime ? Math.max(0, Date.now() - quoteTime) : null;
    const latencyPill = document.getElementById('header-latency-pill');
    if (latencyPill && latencyMs !== null) {
      latencyPill.textContent = `${ Math.min(latencyMs, 999) }ms`;
      latencyPill.style.display = 'inline-block';
    }

    // Robust quote cache: prevent null/undefined/partial ticks from clearing valid prices
    state.quotesMap = state.quotesMap || new Map();
    if (quote.ltp !== undefined && quote.ltp !== null && Number(quote.ltp) > 0) {
      const existing = state.quotesMap.get(quote.globalId) || {};
      const merged = { ...existing };
      for (const [k, v] of Object.entries(quote)) {
        if (v !== undefined && v !== null) merged[k] = v;
      }
      state.quotesMap.set(quote.globalId, merged);
      if (state.indices) {
        const found = state.indices.find(i => i.globalId === quote.globalId);
        if (found) found.latestQuote = merged;
      }
    }
    const currentQ = state.quotesMap.get(quote.globalId) || quote;

    // Update DOM price elements matching data-ltp-id
    document.querySelectorAll(`[data-ltp-id="${quote.globalId}"]`).forEach((el) => {
      if (currentQ.ltp !== undefined && currentQ.ltp !== null && currentQ.ltp > 0) {
        el.textContent = el.classList.contains('inst-ltp-val')?fmtINR(currentQ.ltp):fmtNum(currentQ.ltp);
      }
    });

    // Update DOM change elements matching data-chg-id (consistent points + percentage)
    const ptsPct = formatPointsAndPct(currentQ);
    document.querySelectorAll(`[data-chg-id="${quote.globalId}"]`).forEach((el) => {
      if (currentQ.ltp !== undefined && currentQ.ltp !== null && currentQ.ltp > 0) {
        el.textContent = ptsPct.text;
        const baseCls = el.classList.contains('inst-chg-val') ? 'inst-chg-val' : 'idx-chg';
        el.className = `${baseCls} ${ptsPct.cls}`;
      }
    });

    // Authoritative Live P&L streaming: update open positions live even when chart is closed
    if (state.positionsData) {
      const updatePosList = (arr) => {
        if (!Array.isArray(arr)) return false;
        let changed = false;
        arr.forEach((pos) => {
          if (pos.globalInstrumentId === quote.globalId && pos.quantity !== 0 && Number(quote.ltp) > 0) {
            const entryPrice = Number(pos.averageEntryPrice ?? pos.averageEntryPriceINR ?? 0);
            const currentPrice = Number(quote.ltp);
            const diffPerUnit = pos.quantity > 0 ? currentPrice - entryPrice : entryPrice - currentPrice;
            // Mirror the server's contract multiplier (commodities settle per contract unit) so
            // the streamed P&L never disagrees with the server-authoritative REST value.
            const multiplier = Number(pos.pnlMultiplier) > 0 ? Number(pos.pnlMultiplier) : 1;
            pos.currentPrice = currentPrice;
            pos.currentLtpINR = currentPrice;
            pos.unrealizedPnlINR =
              Math.round(diffPerUnit * multiplier * Math.abs(pos.quantity) * 100) / 100;
            pos.priceSource = 'WEBSOCKET';
            pos.priceTimestamp = Number(quote.providerTimestamp || quote.receiveTimestamp) || Date.now();
            pos.priceAgeMs = quoteFreshnessMs(quote);
            pos.priceStale = pos.priceAgeMs>5000;
            pos.pnlTimestamp = Date.now();
            changed = true;
          }
        });
        return changed;
      };

      const c1 = updatePosList(state.positionsData.positions);
      const c2 = updatePosList(state.positionsData.activePositions);
      const c3 = updatePosList(state.positionsData.holdings);
      if (c1 || c2 || c3) {
        schedulePortfolioPnlUpdate();
      }
    }

    if (state.chartOpen && state.activeInstrument && state.activeInstrument.globalId === quote.globalId) {
      updateChartHeaderQuote(currentQ);
      reconcileCandleWithTick(quote, isSnapshot||Boolean(quote.isSnapshot));
      if(!isSnapshot&&!quote.isSnapshot)state.lastChartTickAt=Date.now();
      state.lastRenderByInstrument=state.lastRenderByInstrument||{};state.lastRenderByInstrument[quote.globalId]=Date.now();
      updateChartCountdownUI();
    }

    // Update visible CE/PE cells from genuine ticks without re-rendering or jumping scroll.
    updateOptionChainQuote(quote);
    if(state.orderTicket?.open&&state.orderTicket.instrument?.globalId===quote.globalId){recalcOrderMarginPreview();state.lastRenderByInstrument=state.lastRenderByInstrument||{};state.lastRenderByInstrument[quote.globalId]=Date.now();}
    if (state.protectionModal?.open && state.protectionModal.globalInstrumentId === quote.globalId) {
      renderProtectionModalLiveQuote();
    }
  }

  // =========================================================================
  // TRADE JOURNAL & PERFORMANCE LOG (States 01, 03, 14, 32)
  // =========================================================================
  function getJournalDraftKey() {
    const uid = state.user?.userId || state.user?.id;
    return uid ? `sikho_journal_draft_${uid}` : null;
  }

  function setJournalSyncPill(text, cls = '') {
    const pill = document.getElementById('journal-sync-status');
    if (!pill) return;
    pill.textContent = text;
    pill.className = `sync-status-pill ${cls}`.trim();
  }

  function onJournalDraftInput() {
    const key = getJournalDraftKey();
    const tag = document.getElementById('journal-input-tag')?.value || '';
    const ref = document.getElementById('journal-input-ref')?.value || '';
    const notes = document.getElementById('journal-input-notes')?.value || '';
    if (key) {
      try {
        if (tag || ref || notes) {
          localStorage.setItem(key, JSON.stringify({ tag, ref, notes, savedAt: Date.now() }));
          setJournalSyncPill('Local draft (unsaved)');
        } else {
          localStorage.removeItem(key);
          setJournalSyncPill('✓ Synced to cloud', 'is-synced');
        }
      } catch {}
    }
  }

  function requestCloseJournalModal() {
    const modal = document.getElementById('modal-journal');
    if (!modal) return;
    const notes = (document.getElementById('journal-input-notes')?.value || '').trim();
    if (notes.length > 0) {
      showConfirmSheet(
        'Unsaved Journal Draft',
        'You have unsaved notes in your trade journal. Your local draft is kept safe, or you can discard it.',
        (discard) => {
          if (discard) {
            const key = getJournalDraftKey();
            if (key) try { localStorage.removeItem(key); } catch {}
            const n = document.getElementById('journal-input-notes');
            if (n) n.value = '';
            modal.classList.remove('active');
            notifyNativeScreenState();
          }
        }
      );
      return;
    }
    modal.classList.remove('active');
    notifyNativeScreenState();
  }

  async function openTradeJournalModal() {
    const modal = document.getElementById('modal-journal');
    if (!modal) return;
    const key = getJournalDraftKey();
    if (key) {
      try {
        const draft = JSON.parse(localStorage.getItem(key) || 'null');
        if (draft) {
          if (document.getElementById('journal-input-tag')) document.getElementById('journal-input-tag').value = draft.tag || '';
          if (document.getElementById('journal-input-ref')) document.getElementById('journal-input-ref').value = draft.ref || '';
          if (document.getElementById('journal-input-notes')) document.getElementById('journal-input-notes').value = draft.notes || '';
          setJournalSyncPill('Local draft restored');
        } else {
          setJournalSyncPill('✓ Synced to cloud', 'is-synced');
        }
      } catch {}
    }
    modal.classList.add('active');
    notifyNativeScreenState();
    await loadJournalEntries();
  }

  async function loadJournalEntries() {
    const container = document.getElementById('journal-entries-container');
    if (!container) return;
    if (window.SikhoUX?.skeleton) container.innerHTML = window.SikhoUX.skeleton(3);
    try {
      const res = await apiFetch('/api/v1/journal/entries');
      state.journalEntries = res.entries || [];
      if (state.journalEntries.length === 0) {
        container.innerHTML = window.SikhoUX?.emptyPanel
          ? window.SikhoUX.emptyPanel({
              title: 'No journal entries yet',
              subtitle: 'Log your trade rationale, strategy tags, or lessons above to build a disciplined review habit.',
            })
          : '<div style="padding:32px;text-align:center;">No journal entries yet.</div>';
        return;
      }
      const esc = window.SikhoUX?.escape || ((s) => String(s ?? ''));
      container.innerHTML = state.journalEntries.map((e) => `
        <div class="journal-card">
          <div class="journal-header">
            <span class="strategy-tag-pill">${esc(e.strategyTag || 'Untagged')}</span>
            <span style="font-size:11px;color:var(--text-secondary);">${new Date(Number(e.createdAt)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</span>
          </div>
          ${e.referenceId ? `<div style="font-size:11px;font-weight:600;color:var(--text-secondary);margin-top:2px;">Ref: ${esc(e.referenceId)}</div>` : ''}
          <div class="journal-notes-text">${esc(e.notes)}</div>
        </div>
      `).join('');
    } catch (err) {
      container.innerHTML = window.SikhoUX?.errorPanel
        ? window.SikhoUX.errorPanel({ title: 'Could not load journal', message: err.message, retryOnClick: 'window.TZApp.openTradeJournalModal()' })
        : `<div style="padding:20px;text-align:center;color:var(--negative-red);">Failed to load journal entries: ${err.message}</div>`;
    }
  }

  async function submitJournalEntry() {
    const tagEl = document.getElementById('journal-input-tag');
    const refEl = document.getElementById('journal-input-ref');
    const notesEl = document.getElementById('journal-input-notes');
    const saveBtn = document.getElementById('btn-journal-save');
    const tag = (tagEl?.value || '').trim();
    const ref = (refEl?.value || '').trim();
    const notes = (notesEl?.value || '').trim();
    if (!notes) {
      window.SikhoUX?.setFieldError?.(notesEl, 'Write a brief note before saving.');
      return;
    }
    window.SikhoUX?.clearFieldError?.(notesEl);
    if (saveBtn) { saveBtn.disabled = true; saveBtn.setAttribute('aria-busy', 'true'); saveBtn.textContent = 'Saving to cloud…'; }
    setJournalSyncPill('Syncing…');

    try {
      await apiFetch('/api/v1/journal/notes', {
        method: 'POST',
        body: JSON.stringify({ strategyTag: tag || 'General Note', referenceId: ref, notes }),
      });
      if (notesEl) notesEl.value = '';
      if (tagEl) tagEl.value = '';
      if (refEl) refEl.value = '';
      const key = getJournalDraftKey();
      if (key) try { localStorage.removeItem(key); } catch {}
      setJournalSyncPill('✓ Synced to cloud', 'is-synced');
      window.SikhoUX?.notify('Journal note saved to cloud.');
      await loadJournalEntries();
    } catch (err) {
      setJournalSyncPill('Sync failed — draft kept', 'is-error');
      window.SikhoUX?.notify('Could not sync note. Your local draft is safe.');
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.removeAttribute('aria-busy'); saveBtn.textContent = 'Save Journal Note'; }
    }
  }

  async function exportJournalCSV() {
    const token=state.token;
    try{const response=await fetch(API_BASE+'/api/v1/journal/export.csv',{headers:{Authorization:'Bearer '+token}});if(!response.ok)throw Error('History export unavailable. Retry after signing in.');const csv=await response.text();if(token!==state.token)return;
      let modal=document.getElementById('modal-history-csv');if(!modal){modal=document.createElement('div');modal.id='modal-history-csv';modal.className='modal-backdrop';document.body.appendChild(modal);}
      modal.innerHTML='<div class="white-bottom-sheet history-detail"><h3>Trade history CSV · Last 7 Days</h3><p>Actual fills and ledger settlements. Unknown historical fields stay blank.</p><textarea id="history-csv-text" readonly aria-label="Trade history CSV" style="width:100%;height:45vh;"></textarea><button class="row-retry" id="history-csv-copy">Copy CSV</button><button class="row-retry" id="history-csv-close">Close</button></div>';
      document.getElementById('history-csv-text').value=csv;document.getElementById('history-csv-copy').onclick=()=>{const area=document.getElementById('history-csv-text');area.select();window.SikhoUX.notify(document.execCommand('copy')?'CSV copied':'Select and copy the CSV text.');};document.getElementById('history-csv-close').onclick=()=>{modal.remove();notifyNativeScreenState();};modal.classList.add('active');notifyNativeScreenState();
    }catch(e){showBrandedAlert('Export unavailable',e.message);}
  }

  // =========================================================================
  // PRICE ALERTS & HISTORICAL REPLAY
  // =========================================================================
  function openPriceAlertModal() {
    const modal = document.getElementById('modal-alerts');
    if (!modal || !state.activeInstrument) return;
    const lastClose = state.candles.length > 0 ? state.candles[state.candles.length - 1].close : 100;
    document.getElementById('alert-target-subtitle').textContent = `Set alert for ${state.activeInstrument.symbol} (Ref LTP: ${fmtINR(lastClose)})`;
    document.getElementById('alert-input-price').value = String(lastClose);
    renderActiveAlertsList();
    modal.classList.add('active');
  }

  function setAlertCondition(cond) {
    state.alertCondition = cond;
    document.getElementById('alert-cond-above').classList.toggle('active', cond === 'ABOVE');
    document.getElementById('alert-cond-below').classList.toggle('active', cond === 'BELOW');
  }

  function saveActiveAlert() {
    const p = parseFloat(document.getElementById('alert-input-price').value);
    if (isNaN(p) || p <= 0) return;
    const inst = state.activeInstrument;
    if (!inst) return;
    state.priceAlerts.push({
      id: `al_${Date.now()}`,
      globalId: inst.globalId,
      symbol: inst.symbol,
      condition: state.alertCondition,
      price: p,
      createdAt: Date.now(),
      triggered: false,
    });
    renderActiveAlertsList();
    document.getElementById('modal-alerts').classList.remove('active');
  }

  function renderActiveAlertsList() {
    const container = document.getElementById('alerts-list-container');
    if (!container) return;
    if (state.priceAlerts.length === 0) {
      container.innerHTML = `<div style="font-size:12px;color:var(--text-on-white-secondary);padding:6px 0;">No active alerts set.</div>`;
      return;
    }
    container.innerHTML = state.priceAlerts.map((a, i) => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--surface-light-border);font-size:12px;">
        <span>${a.symbol} ${a.condition === 'ABOVE' ? '≥' : '≤'} ₹${fmtINR(a.price)}</span>
        <button class="link-btn" style="color:var(--negative-red);font-size:11px;" onclick="window.TZApp.removeAlert(${i})">Delete</button>
      </div>
    `).join('');
  }

  function removeAlert(idx) {
    state.priceAlerts.splice(idx, 1);
    renderActiveAlertsList();
  }

  function checkPriceAlerts(quote) {
    if (!quote || !quote.ltp) return;
    for (const a of state.priceAlerts) {
      if (a.triggered || a.globalId !== quote.globalId) continue;
      if (
        (a.condition === 'ABOVE' && quote.ltp >= a.price) ||
        (a.condition === 'BELOW' && quote.ltp <= a.price)
      ) {
        a.triggered = true;
        alert(`🔔 PRICE ALERT TRIGGERED: ${a.symbol} has reached ₹${quote.ltp} (${a.condition === 'ABOVE' ? '≥' : '≤'} ₹${a.price})`);
      }
    }
  }

  // Historical Replay Mode
  function toggleReplayMode() {
    if (state.candles.length < 15) return;
    state.replayMode = !state.replayMode;
    const bar = document.getElementById('chart-replay-bar');
    if (state.replayMode) {
      state.allReplayCandles = [...state.candles];
      state.replayIndex = Math.max(10, Math.floor(state.allReplayCandles.length * 0.7));
      candleSeries.setData(state.allReplayCandles.slice(0, state.replayIndex));
      if (bar) bar.style.display = 'flex';
    } else {
      exitReplayMode();
    }
  }

  function replayStepForward() {
    if (!state.replayMode || state.replayIndex >= state.allReplayCandles.length) return;
    state.replayIndex++;
    candleSeries.setData(state.allReplayCandles.slice(0, state.replayIndex));
    const last = state.allReplayCandles[state.replayIndex - 1];
    document.getElementById('chart-ohlc-legend').textContent =
      `O ${fmtNum(last.open)}  H ${fmtNum(last.high)}  L ${fmtNum(last.low)}  C ${fmtNum(last.close)}`;
  }

  function replayStepBackward() {
    if (!state.replayMode || state.replayIndex <= 5) return;
    state.replayIndex--;
    candleSeries.setData(state.allReplayCandles.slice(0, state.replayIndex));
    const last = state.allReplayCandles[state.replayIndex - 1];
    document.getElementById('chart-ohlc-legend').textContent =
      `O ${fmtNum(last.open)}  H ${fmtNum(last.high)}  L ${fmtNum(last.low)}  C ${fmtNum(last.close)}`;
  }

  function replayTogglePlay() {
    const btn = document.getElementById('btn-replay-playpause');
    if (state.replayPlaying) {
      clearInterval(state.replayTimer);
      state.replayPlaying = false;
      if (btn) btn.textContent = '▶ Play';
    } else {
      state.replayPlaying = true;
      if (btn) btn.textContent = '⏸ Pause';
      state.replayTimer = setInterval(() => {
        if (state.replayIndex >= state.allReplayCandles.length) {
          replayTogglePlay();
          return;
        }
        replayStepForward();
      }, 700);
    }
  }

  function exitReplayMode() {
    if (state.replayTimer) clearInterval(state.replayTimer);
    state.replayPlaying = false;
    state.replayMode = false;
    const bar = document.getElementById('chart-replay-bar');
    if (bar) bar.style.display = 'none';
    if (candleSeries && state.candles.length > 0) {
      candleSeries.setData(state.candles);
    }
  }

  // =========================================================================
  // 10. POST-EXECUTION TP/SL PROTECTION EDITOR & DRAGGABLE CHART LINES
  // =========================================================================
  function alignPriceToTick(price, tickSize = 0.05) {
    const tick = Number(tickSize) > 0 ? Number(tickSize) : 0.05;
    const num = Number(price);
    if (!Number.isFinite(num) || num <= 0) return 0;
    const steps = Math.round(num / tick);
    return Number((steps * tick).toFixed(2));
  }

  function getPositionById(positionId) {
    if (!positionId) return null;
    const all = state.positionsData?.positions || [];
    return all.find((p) => p.id === positionId) || null;
  }

  function getOpenPositionForInstrument(globalId, preferredPositionId = null) {
    if (!globalId) return null;
    const all = (state.positionsData?.positions || []).filter(
      (p) => p.globalInstrumentId === globalId && Number(p.quantity) !== 0
    );
    if (all.length === 0) return null;
    if (preferredPositionId) {
      const exact = all.find((p) => p.id === preferredPositionId);
      if (exact) return exact;
    }
    return all[0];
  }

  function applyRemotePositionProtectionUpdate(updatedPos) {
    if (!updatedPos || !updatedPos.id || !state.positionsData) return;
    const updateList = (arr) => {
      if (!Array.isArray(arr)) return;
      const idx = arr.findIndex((p) => p.id === updatedPos.id);
      if (idx !== -1) {
        arr[idx] = { ...arr[idx], ...updatedPos };
      }
    };
    updateList(state.positionsData.positions);
    updateList(state.positionsData.activePositions);
    updateList(state.positionsData.holdings);
    reconcileActiveProtectionState();
    renderPortfolioTab();
    if (state.chartOpen && state.activeInstrument) {
      renderChartBottomTradeBar(state.activeInstrument);
      renderChartProtectionOverlay();
    }
  }

  function reconcileActiveProtectionState() {
    // 1. If a chart drag confirmation or active drag is open and the target position closed, cancel & notify
    if (state.protectionDrag) {
      const pos = getPositionById(state.protectionDrag.positionId);
      if (!pos || Number(pos.quantity) === 0 || (state.chartOpen && state.activeInstrument?.globalId !== pos.globalInstrumentId)) {
        const closedWhileEditing = Boolean(!pos || Number(pos.quantity) === 0);
        cancelChartProtectionDrag();
        if (closedWhileEditing) {
          window.SikhoUX?.notify?.('Position closed while editing protection — reconciled with server.');
        }
      }
    }
    // 2. If the numeric TP/SL modal is open and the target position closed, disable confirmation and explain
    if (state.protectionModal?.open) {
      const pos = getPositionById(state.protectionModal.positionId);
      if (!pos || Number(pos.quantity) === 0) {
        const errBox = document.getElementById('prot-error-box');
        const submitBtn = document.getElementById('prot-submit-btn');
        if (errBox) {
          errBox.textContent = 'This position has already closed. TP/SL confirmation is disabled.';
          errBox.style.display = 'block';
        }
        if (submitBtn) submitBtn.disabled = true;
      } else {
        state.protectionModal.position = pos;
        renderProtectionModalLiveQuote();
      }
    }
  }

  function openProtectionModal(positionId, prefill = {}) {
    const pos = getPositionById(positionId) || (state.activeInstrument ? getOpenPositionForInstrument(state.activeInstrument.globalId, positionId) : null);
    if (!pos || Number(pos.quantity) === 0) {
      showBrandedAlert('Position Closed', 'Cannot edit TP/SL because this position is already closed.');
      return;
    }
    const tickSize = Number(pos.tickSize || state.activeInstrument?.tickSize || 0.05) || 0.05;
    state.protectionModal = {
      open: true,
      positionId: pos.id,
      globalInstrumentId: pos.globalInstrumentId,
      position: pos,
      tickSize,
      removeTp: false,
      removeSl: false,
      submitting: false,
      pendingIdempotencyKey: null,
      timedOutKey: null,
    };

    const tpIn = document.getElementById('prot-input-tp');
    const slIn = document.getElementById('prot-input-sl');
    if (tpIn) {
      tpIn.step = String(tickSize);
      tpIn.disabled = false;
      tpIn.value = prefill.targetPrice !== undefined
        ? String(prefill.targetPrice)
        : Number(pos.targetPrice) > 0
          ? String(pos.targetPrice)
          : '';
    }
    if (slIn) {
      slIn.step = String(tickSize);
      slIn.disabled = false;
      slIn.value = prefill.stopLossPrice !== undefined
        ? String(prefill.stopLossPrice)
        : Number(pos.stopLossPrice) > 0
          ? String(pos.stopLossPrice)
          : '';
    }

    const errBox = document.getElementById('prot-error-box');
    if (errBox) { errBox.style.display = 'none'; errBox.textContent = ''; }
    const timeoutBox = document.getElementById('prot-timeout-box');
    if (timeoutBox) timeoutBox.style.display = 'none';
    const submitBtn = document.getElementById('prot-submit-btn');
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Confirm TP / SL'; }

    renderProtectionModalState();
    const modal = document.getElementById('modal-position-protection');
    if (modal) modal.classList.add('active');
    notifyNativeScreenState();

    // Fetch a fresh quote for this position's exact contract so freshness is verified
    sendWsSubscribe([pos.globalInstrumentId]);
    apiFetch(`/api/v1/market-data/quote?globalId=${encodeURIComponent(pos.globalInstrumentId)}`)
      .then((data) => {
        if (data?.serverTimestamp) noteServerClock(data.serverTimestamp);
        if (data?.quote) handleIncomingQuoteTick(data.quote, true);
        if (state.protectionModal?.open && state.protectionModal.positionId === pos.id) {
          renderProtectionModalLiveQuote();
        }
      })
      .catch(() => {});
  }

  function closeProtectionModal() {
    if (state.protectionModal) state.protectionModal.open = false;
    const modal = document.getElementById('modal-position-protection');
    if (modal) modal.classList.remove('active');
    notifyNativeScreenState();
  }

  function renderProtectionModalLiveQuote() {
    const pm = state.protectionModal;
    if (!pm || !pm.open) return;
    const pos = getPositionById(pm.positionId) || pm.position;
    if (!pos) return;
    const quote = state.quotesMap?.get(pos.globalInstrumentId);
    const ltp = Number(quote?.ltp || pos.currentPrice || pos.averageEntryPrice);
    const ageMs = quote ? quoteFreshnessMs(quote) : Infinity;
    const isFresh = ageMs <= 5000;

    const ltpEl = document.getElementById('prot-current-ltp');
    const freshEl = document.getElementById('prot-ltp-freshness');
    if (ltpEl) ltpEl.textContent = ltp > 0 ? fmtINR(ltp) : '—';
    if (freshEl) {
      freshEl.textContent = isFresh
        ? `Live (${Math.round(ageMs)}ms)`
        : Number.isFinite(ageMs)
          ? `Stale (${Math.round(ageMs / 1000)}s old)`
          : 'Awaiting live tick';
      freshEl.style.color = isFresh ? 'var(--positive-text)' : 'var(--warning-amber)';
    }
  }

  function renderProtectionModalState() {
    const pm = state.protectionModal;
    if (!pm) return;
    const pos = getPositionById(pm.positionId) || pm.position;
    if (!pos) return;
    const isLong = Number(pos.quantity) > 0;
    const sideLabel = isLong ? 'LONG' : 'SHORT';
    const absQty = Math.abs(Number(pos.quantity));
    const tick = pm.tickSize || 0.05;
    const mult = Number(pos.pnlMultiplier) > 0 ? Number(pos.pnlMultiplier) : 1;

    const titleEl = document.getElementById('prot-modal-title');
    const subEl = document.getElementById('prot-modal-subtitle');
    if (titleEl) titleEl.textContent = `Add / Edit TP & SL — ${pos.symbol || pos.globalInstrumentId}`;
    if (subEl) subEl.textContent = `${sideLabel} ${absQty} • ${pos.exchange || 'NSE'} • Tick ₹${tick} • Contract price`;

    const entryEl = document.getElementById('prot-entry-price');
    if (entryEl) entryEl.textContent = fmtINR(pos.averageEntryPrice);
    renderProtectionModalLiveQuote();

    const savedTpEl = document.getElementById('prot-saved-tp');
    const savedSlEl = document.getElementById('prot-saved-sl');
    const hasSavedTp = Number(pos.targetPrice) > 0;
    const hasSavedSl = Number(pos.stopLossPrice) > 0;
    if (savedTpEl) savedTpEl.textContent = hasSavedTp ? fmtINR(pos.targetPrice) : 'Not set';
    if (savedSlEl) savedSlEl.textContent = hasSavedSl ? fmtINR(pos.stopLossPrice) : 'Not set';

    const rmTpBtn = document.getElementById('prot-btn-remove-tp');
    if (rmTpBtn) {
      rmTpBtn.style.display = hasSavedTp ? 'inline-flex' : 'none';
      rmTpBtn.classList.toggle('is-active', Boolean(pm.removeTp));
      rmTpBtn.textContent = pm.removeTp ? '✓ Removing Saved TP (Tap to Keep)' : 'Remove Saved TP';
    }
    const rmSlBtn = document.getElementById('prot-btn-remove-sl');
    if (rmSlBtn) {
      rmSlBtn.style.display = hasSavedSl ? 'inline-flex' : 'none';
      rmSlBtn.classList.toggle('is-active', Boolean(pm.removeSl));
      rmSlBtn.textContent = pm.removeSl ? '✓ Removing Saved SL (Tap to Keep)' : 'Remove Saved SL';
    }

    const tpIn = document.getElementById('prot-input-tp');
    const slIn = document.getElementById('prot-input-sl');
    const tpPrev = document.getElementById('prot-tp-preview');
    const slPrev = document.getElementById('prot-sl-preview');

    if (tpPrev) {
      if (pm.removeTp) {
        tpPrev.textContent = `Explicit removal: Saved TP (${fmtINR(pos.targetPrice)}) will be removed on confirmation.`;
        tpPrev.style.color = 'var(--negative-text)';
      } else {
        const rawTp = (tpIn?.value || '').trim();
        if (!rawTp) {
          tpPrev.textContent = hasSavedTp
            ? `Unchanged: Keeping saved TP at ${fmtINR(pos.targetPrice)}`
            : 'No Take Profit configured';
          tpPrev.style.color = 'var(--text-secondary)';
        } else {
          const val = Number(rawTp);
          if (!Number.isFinite(val) || val <= 0) {
            tpPrev.textContent = 'Enter a valid Take Profit price greater than 0.';
            tpPrev.style.color = 'var(--negative-text)';
          } else {
            const diff = isLong ? val - pos.averageEntryPrice : pos.averageEntryPrice - val;
            const estPnl = diff * mult * absQty;
            const prevStr = hasSavedTp ? fmtINR(pos.targetPrice) : 'None';
            tpPrev.textContent = `Proposed TP: ${prevStr} → ${fmtINR(val)} (Est. P&L vs Entry: ${estPnl >= 0 ? '+' : ''}${fmtINR(estPnl)})`;
            tpPrev.style.color = 'var(--positive-text)';
          }
        }
      }
    }

    if (slPrev) {
      if (pm.removeSl) {
        slPrev.textContent = `Explicit removal: Saved SL (${fmtINR(pos.stopLossPrice)}) will be removed on confirmation.`;
        slPrev.style.color = 'var(--negative-text)';
      } else {
        const rawSl = (slIn?.value || '').trim();
        if (!rawSl) {
          slPrev.textContent = hasSavedSl
            ? `Unchanged: Keeping saved SL at ${fmtINR(pos.stopLossPrice)}`
            : 'No Stop Loss configured';
          slPrev.style.color = 'var(--text-secondary)';
        } else {
          const val = Number(rawSl);
          if (!Number.isFinite(val) || val <= 0) {
            slPrev.textContent = 'Enter a valid Stop Loss price greater than 0.';
            slPrev.style.color = 'var(--negative-text)';
          } else {
            const diff = isLong ? val - pos.averageEntryPrice : pos.averageEntryPrice - val;
            const estPnl = diff * mult * absQty;
            const prevStr = hasSavedSl ? fmtINR(pos.stopLossPrice) : 'None';
            slPrev.textContent = `Proposed SL: ${prevStr} → ${fmtINR(val)} (Est. P&L vs Entry: ${estPnl >= 0 ? '+' : ''}${fmtINR(estPnl)})`;
            slPrev.style.color = estPnl >= 0 ? 'var(--positive-text)' : 'var(--negative-text)';
          }
        }
      }
    }
  }

  function toggleRemoveProtectionField(field) {
    const pm = state.protectionModal;
    if (!pm) return;
    if (field === 'TP') {
      pm.removeTp = !pm.removeTp;
      const tpIn = document.getElementById('prot-input-tp');
      if (tpIn) tpIn.disabled = pm.removeTp;
    } else if (field === 'SL') {
      pm.removeSl = !pm.removeSl;
      const slIn = document.getElementById('prot-input-sl');
      if (slIn) slIn.disabled = pm.removeSl;
    }
    renderProtectionModalState();
  }

  function applyProtectionPointsOffset(field, pts) {
    const pm = state.protectionModal;
    if (!pm) return;
    const pos = getPositionById(pm.positionId) || pm.position;
    if (!pos) return;
    const isLong = Number(pos.quantity) > 0;
    const entry = Number(pos.averageEntryPrice);
    const tick = pm.tickSize || 0.05;
    let targetPrice = entry;

    if (field === 'TP') {
      pm.removeTp = false;
      targetPrice = isLong ? entry + pts : Math.max(tick, entry - pts);
      const aligned = alignPriceToTick(targetPrice, tick);
      const tpIn = document.getElementById('prot-input-tp');
      if (tpIn) {
        tpIn.disabled = false;
        tpIn.value = String(aligned);
      }
    } else if (field === 'SL') {
      pm.removeSl = false;
      targetPrice = pts === 0 ? entry : isLong ? Math.max(tick, entry - pts) : entry + pts;
      const aligned = alignPriceToTick(targetPrice, tick);
      const slIn = document.getElementById('prot-input-sl');
      if (slIn) {
        slIn.disabled = false;
        slIn.value = String(aligned);
      }
    }
    renderProtectionModalState();
  }

  function onProtectionInputChanged(field) {
    const pm = state.protectionModal;
    if (!pm) return;
    if (field === 'TP') pm.removeTp = false;
    if (field === 'SL') pm.removeSl = false;
    pm.pendingIdempotencyKey = null;
    renderProtectionModalState();
  }

  async function submitPositionProtectionModal() {
    const pm = state.protectionModal;
    if (!pm || pm.submitting) return;
    const pos = getPositionById(pm.positionId) || pm.position;
    const errBox = document.getElementById('prot-error-box');
    if (errBox) { errBox.style.display = 'none'; errBox.textContent = ''; }

    if (!pos || Number(pos.quantity) === 0) {
      if (errBox) {
        errBox.textContent = 'This position has already closed. Reconciling portfolio state.';
        errBox.style.display = 'block';
      }
      await refreshAccountAndPortfolio();
      return;
    }

    const tpIn = document.getElementById('prot-input-tp');
    const slIn = document.getElementById('prot-input-sl');
    const rawTpStr = (tpIn?.value || '').trim();
    const rawSlStr = (slIn?.value || '').trim();

    const payload = {
      expectedVersion: pos.protectionVersion || 1,
      idempotencyKey: pm.pendingIdempotencyKey || `prot_${pos.id}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      source: 'MANUAL_EDIT',
    };
    pm.pendingIdempotencyKey = payload.idempotencyKey;

    if (pm.removeTp) {
      payload.removeTarget = true;
      payload.targetPrice = null;
    } else if (rawTpStr.length > 0) {
      const parsedTp = Number(rawTpStr);
      if (!Number.isFinite(parsedTp) || parsedTp <= 0) {
        if (errBox) {
          errBox.textContent = 'Enter a valid Take Profit price greater than zero (or use "Remove Saved TP").';
          errBox.style.display = 'block';
        }
        return;
      }
      payload.targetPrice = parsedTp;
    }

    if (pm.removeSl) {
      payload.removeStopLoss = true;
      payload.stopLossPrice = null;
    } else if (rawSlStr.length > 0) {
      const parsedSl = Number(rawSlStr);
      if (!Number.isFinite(parsedSl) || parsedSl <= 0) {
        if (errBox) {
          errBox.textContent = 'Enter a valid Stop Loss price greater than zero (or use "Remove Saved SL").';
          errBox.style.display = 'block';
        }
        return;
      }
      payload.stopLossPrice = parsedSl;
    }

    if (
      payload.targetPrice === undefined &&
      payload.stopLossPrice === undefined &&
      !payload.removeTarget &&
      !payload.removeStopLoss
    ) {
      if (errBox) {
        errBox.textContent = 'Enter a Take Profit or Stop Loss level to save, or choose an explicit remove button.';
        errBox.style.display = 'block';
      }
      return;
    }

    const submitBtn = document.getElementById('prot-submit-btn');
    const timeoutBox = document.getElementById('prot-timeout-box');
    if (timeoutBox) timeoutBox.style.display = 'none';
    pm.submitting = true;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.setAttribute('aria-busy', 'true');
      submitBtn.textContent = 'Saving protection…';
    }

    try {
      const res = await apiFetch(`/api/v1/positions/${encodeURIComponent(pos.id)}/protection`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      pm.pendingIdempotencyKey = null;
      pm.timedOutKey = null;
      if (res && res.position) {
        applyRemotePositionProtectionUpdate(res.position);
      }
      closeProtectionModal();
      await refreshAccountAndPortfolio();
      window.SikhoUX?.notify?.(`Saved TP/SL protection for ${pos.symbol || pos.globalInstrumentId}`);
    } catch (err) {
      if (err && (err.code === 'ERR_SERVER_TIMEOUT' || err.code === 'ERR_SERVER_UNREACHABLE')) {
        pm.timedOutKey = payload.idempotencyKey;
        if (timeoutBox) {
          const detail = document.getElementById('prot-timeout-detail');
          if (detail) {
            detail.textContent = `Request timed out for ref ${payload.idempotencyKey.slice(-8)}. Check saved server state before retrying.`;
          }
          timeoutBox.style.display = 'block';
        }
      } else {
        pm.pendingIdempotencyKey = null;
        if (errBox) {
          errBox.textContent = err?.message || 'Could not update TP/SL protection.';
          errBox.style.display = 'block';
        }
        await refreshAccountAndPortfolio();
      }
    } finally {
      pm.submitting = false;
      if (submitBtn) {
        submitBtn.removeAttribute('aria-busy');
        submitBtn.disabled = Boolean(pm.timedOutKey);
        submitBtn.textContent = 'Confirm TP / SL';
      }
    }
  }

  async function checkTimedOutProtectionStatus() {
    const pm = state.protectionModal;
    const key = pm?.timedOutKey;
    if (!key) return;
    const btn = document.getElementById('prot-check-status-btn');
    const detail = document.getElementById('prot-timeout-detail');
    if (btn) { btn.disabled = true; btn.textContent = 'Checking server state…'; }
    try {
      const res = await apiFetch(`/api/v1/positions/protection-by-idempotency/${encodeURIComponent(key)}`);
      await refreshAccountAndPortfolio();
      const timeoutBox = document.getElementById('prot-timeout-box');
      if (res && res.found) {
        pm.timedOutKey = null;
        pm.pendingIdempotencyKey = null;
        if (timeoutBox) timeoutBox.style.display = 'none';
        closeProtectionModal();
        window.SikhoUX?.notify?.('Confirmed from server: TP/SL update was saved.');
      } else {
        pm.timedOutKey = null;
        if (timeoutBox) timeoutBox.style.display = 'none';
        const submitBtn = document.getElementById('prot-submit-btn');
        if (submitBtn) submitBtn.disabled = false;
        window.SikhoUX?.notify?.('Server did not record the timed-out edit. Reconciled current saved levels — you may safely retry.');
        renderProtectionModalState();
      }
    } catch (err) {
      if (detail) {
        detail.textContent = `Still unable to reach server (${err.message}). Do not retry until server state is verified.`;
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Check Saved Server State'; }
    }
  }

  // =========================================================================
  // DRAGGABLE CHART TP/SL LINES & CONFIRMATION BAR
  // =========================================================================
  function renderChartProtectionOverlay() {
    const layer = document.getElementById('chart-protection-layer');
    const confirmBar = document.getElementById('chart-protection-confirm-bar');
    if (!layer) return;

    if (!state.chartOpen || !state.activeInstrument || !tvChart || !candleSeries || !state.candles.length) {
      layer.innerHTML = '';
      if (confirmBar) confirmBar.style.display = 'none';
      return;
    }

    const gid = state.activeInstrument.globalId;
    const drag = state.protectionDrag;
    const pos = getOpenPositionForInstrument(gid, drag?.positionId || null);
    if (!pos || Number(pos.quantity) === 0) {
      layer.innerHTML = '';
      if (confirmBar) confirmBar.style.display = 'none';
      state.protectionDrag = null;
      return;
    }

    const chartEl = document.getElementById('tv-main-chart');
    const totalHeight = chartEl?.clientHeight || 420;
    const plotMaxY = Math.max(80, totalHeight - 36); // stay above 32px bottom time axis
    const clampY = (y) => Math.max(12, Math.min(plotMaxY - 12, Math.round(y)));
    const priceToY = (price) => {
      if (!(Number(price) > 0)) return null;
      const coord = candleSeries.priceToCoordinate(Number(price));
      if (coord === null || coord === undefined || !Number.isFinite(coord)) return null;
      return clampY(coord);
    };

    const isLong = Number(pos.quantity) > 0;
    const sideLabel = isLong ? 'LONG' : 'SHORT';
    const absQty = Math.abs(Number(pos.quantity));
    const mult = Number(pos.pnlMultiplier) > 0 ? Number(pos.pnlMultiplier) : 1;
    const esc = window.SikhoUX?.escape || ((s) => String(s ?? ''));

    const linesHtml = [];

    // 1. Executed Entry Line + Quick TP/SL Trigger
    const entryY = priceToY(pos.averageEntryPrice);
    if (entryY !== null) {
      linesHtml.push(`
        <div class="prot-chart-line is-entry" style="top:${entryY}px;" data-prot-line="ENTRY">
          <button type="button" class="prot-line-badge is-entry"
                  onclick="window.TZApp.openProtectionModal('${esc(pos.id)}')"
                  title="Tap to add or edit TP &amp; SL for ${esc(pos.symbol)}">
            <span>ENTRY ${sideLabel} ${absQty} • ₹${fmtNum(pos.averageEntryPrice)}</span>
            <span style="text-decoration:underline;margin-left:4px;">TP/SL ✎</span>
          </button>
        </div>
      `);
    }

    // 2. Saved Take Profit (TP) Line (Draggable)
    if (Number(pos.targetPrice) > 0) {
      const tpY = priceToY(pos.targetPrice);
      if (tpY !== null) {
        const diff = isLong ? pos.targetPrice - pos.averageEntryPrice : pos.averageEntryPrice - pos.targetPrice;
        const estPnl = diff * mult * absQty;
        const isBeingDragged = drag && drag.positionId === pos.id && drag.field === 'TP';
        linesHtml.push(`
          <div class="prot-chart-line is-tp ${isBeingDragged ? 'is-dimmed' : ''}" style="top:${tpY}px;" data-prot-line="TP_SAVED">
            <div class="prot-drag-handle is-tp"
                 role="slider"
                 aria-label="Drag Take Profit line for ${esc(pos.symbol)}"
                 aria-valuenow="${Number(pos.targetPrice)}"
                 onmousedown="window.TZApp.startChartProtectionDrag(event, '${esc(pos.id)}', 'TP')"
                 ontouchstart="window.TZApp.startChartProtectionDrag(event, '${esc(pos.id)}', 'TP')">
              <span>⠿ TP (Saved) ₹${fmtNum(pos.targetPrice)} (${estPnl >= 0 ? '+' : ''}₹${fmtNum(estPnl)})</span>
            </div>
          </div>
        `);
      }
    }

    // 3. Saved Stop Loss (SL) Line (Draggable)
    if (Number(pos.stopLossPrice) > 0) {
      const slY = priceToY(pos.stopLossPrice);
      if (slY !== null) {
        const diff = isLong ? pos.stopLossPrice - pos.averageEntryPrice : pos.averageEntryPrice - pos.stopLossPrice;
        const estPnl = diff * mult * absQty;
        const isBeingDragged = drag && drag.positionId === pos.id && drag.field === 'SL';
        linesHtml.push(`
          <div class="prot-chart-line is-sl ${isBeingDragged ? 'is-dimmed' : ''}" style="top:${slY}px;" data-prot-line="SL_SAVED">
            <div class="prot-drag-handle is-sl"
                 role="slider"
                 aria-label="Drag Stop Loss line for ${esc(pos.symbol)}"
                 aria-valuenow="${Number(pos.stopLossPrice)}"
                 onmousedown="window.TZApp.startChartProtectionDrag(event, '${esc(pos.id)}', 'SL')"
                 ontouchstart="window.TZApp.startChartProtectionDrag(event, '${esc(pos.id)}', 'SL')">
              <span>⠿ SL (Saved) ₹${fmtNum(pos.stopLossPrice)} (${estPnl >= 0 ? '+' : ''}₹${fmtNum(estPnl)})</span>
            </div>
          </div>
        `);
      }
    }

    // 4. Temporary Unconfirmed Drag Preview Line
    if (drag && drag.positionId === pos.id && Number(drag.proposedPrice) > 0) {
      const prevY = drag.currentY !== undefined && drag.active ? clampY(drag.currentY) : priceToY(drag.proposedPrice);
      if (prevY !== null) {
        const diff = isLong ? drag.proposedPrice - pos.averageEntryPrice : pos.averageEntryPrice - drag.proposedPrice;
        const estPnl = diff * mult * absQty;
        linesHtml.push(`
          <div class="prot-chart-line is-preview" style="top:${prevY}px;" data-prot-line="PREVIEW">
            <div class="prot-line-badge is-preview">
              <span>⠿ ${esc(drag.field)} PREVIEW (Unconfirmed): ₹${fmtNum(drag.previousPrice)} → ₹${fmtNum(drag.proposedPrice)} (${estPnl >= 0 ? '+' : ''}₹${fmtNum(estPnl)})</span>
            </div>
          </div>
        `);
      }
    }

    layer.innerHTML = linesHtml.join('');

    // 5. Compact Confirmation Panel after Drag Release
    if (confirmBar) {
      if (drag && drag.pendingConfirm && drag.positionId === pos.id) {
        const fieldName = drag.field === 'TP' ? 'Take Profit (TP)' : 'Stop Loss (SL)';
        confirmBar.style.display = 'flex';
        confirmBar.innerHTML = `
          <div class="prot-confirm-header">
            <span>${esc(pos.symbol)} • ${sideLabel} ${absQty}</span>
            <span>Modify ${fieldName}</span>
          </div>
          <div class="prot-confirm-detail">
            Saved ₹${fmtNum(drag.previousPrice)} → Proposed ₹${fmtNum(drag.proposedPrice)} (Tick ₹${drag.tickSize})
          </div>
          <div class="prot-confirm-actions">
            <button type="button" class="prot-confirm-btn" ${drag.submitting ? 'disabled' : ''} onclick="window.TZApp.cancelChartProtectionDrag()">Cancel</button>
            <button type="button" class="prot-confirm-btn" ${drag.submitting ? 'disabled' : ''} onclick="window.TZApp.openProtectionModalFromDrag()">Numeric Edit</button>
            <button id="btn-chart-prot-confirm" type="button" class="prot-confirm-btn is-primary" ${drag.submitting ? 'disabled aria-busy="true"' : ''} onclick="window.TZApp.confirmChartProtectionDrag()">
              ${drag.submitting ? 'Confirming…' : 'Confirm ' + esc(drag.field)}
            </button>
          </div>
        `;
      } else {
        confirmBar.style.display = 'none';
        confirmBar.innerHTML = '';
      }
    }
  }

  function startChartProtectionDrag(ev, positionId, field) {
    if (!tvChart || !candleSeries) return;
    const pos = getPositionById(positionId);
    if (!pos || Number(pos.quantity) === 0) return;
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
    if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();

    const previousPrice = field === 'TP' ? Number(pos.targetPrice) : Number(pos.stopLossPrice);
    if (!(previousPrice > 0)) return;
    const tickSize = Number(pos.tickSize || state.activeInstrument?.tickSize || 0.05) || 0.05;

    // Lock chart pan/zoom during protection handle drag so dragging never scrolls the chart
    try {
      tvChart.applyOptions({ handleScroll: false, handleScale: false });
    } catch {}

    state.protectionDrag = {
      active: true,
      pendingConfirm: false,
      submitting: false,
      positionId: pos.id,
      globalInstrumentId: pos.globalInstrumentId,
      field,
      tickSize,
      previousPrice,
      proposedPrice: previousPrice,
      currentY: undefined,
      idempotencyKey: null,
    };

    const chartEl = document.getElementById('tv-main-chart');
    const updateFromClientY = (clientY) => {
      if (!state.protectionDrag || !state.protectionDrag.active || !chartEl) return;
      const rect = chartEl.getBoundingClientRect();
      const maxPlotY = Math.max(80, (rect.height || 420) - 36);
      const relY = Math.max(12, Math.min(maxPlotY - 12, clientY - rect.top));
      const rawPrice = candleSeries.coordinateToPrice(relY);
      if (rawPrice !== null && rawPrice !== undefined && Number.isFinite(rawPrice) && rawPrice > 0) {
        state.protectionDrag.proposedPrice = alignPriceToTick(rawPrice, tickSize);
        state.protectionDrag.currentY = relY;
        renderChartProtectionOverlay();
      }
    };

    const onMove = (moveEv) => {
      if (!state.protectionDrag || !state.protectionDrag.active) return;
      if (moveEv.cancelable) moveEv.preventDefault();
      const pt = moveEv.touches?.[0] || moveEv.changedTouches?.[0] || moveEv;
      if (pt && Number.isFinite(pt.clientY)) {
        updateFromClientY(pt.clientY);
      }
    };

    const onEnd = (endEv) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onEnd);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', onEnd);
      try {
        if (state.activeDrawingTool === 'cursor') {
          tvChart?.applyOptions?.({ handleScroll: true, handleScale: true });
        }
      } catch {}

      if (!state.protectionDrag) return;
      const pt = endEv?.changedTouches?.[0] || endEv;
      if (pt && Number.isFinite(pt.clientY)) {
        updateFromClientY(pt.clientY);
      }
      state.protectionDrag.active = false;
      state.protectionDrag.currentY = undefined;
      if (state.protectionDrag.proposedPrice === state.protectionDrag.previousPrice) {
        state.protectionDrag = null;
      } else {
        state.protectionDrag.pendingConfirm = true;
        state.protectionDrag.idempotencyKey = `drag_${pos.id}_${field}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      }
      renderChartProtectionOverlay();
    };

    window.addEventListener('mousemove', onMove, { passive: false });
    window.addEventListener('mouseup', onEnd);
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd);
    window.addEventListener('touchcancel', onEnd);
    renderChartProtectionOverlay();
  }

  /** Programmatic drag helper for deterministic tests and accessibility adjustments */
  function previewChartProtectionDrag(positionId, field, proposedRawPrice) {
    const pos = getPositionById(positionId);
    if (!pos || Number(pos.quantity) === 0) return null;
    const previousPrice = field === 'TP' ? Number(pos.targetPrice) : Number(pos.stopLossPrice);
    const tickSize = Number(pos.tickSize || state.activeInstrument?.tickSize || 0.05) || 0.05;
    const aligned = alignPriceToTick(proposedRawPrice, tickSize);
    if (!(aligned > 0) || aligned === previousPrice) {
      state.protectionDrag = null;
      renderChartProtectionOverlay();
      return null;
    }
    state.protectionDrag = {
      active: false,
      pendingConfirm: true,
      submitting: false,
      positionId: pos.id,
      globalInstrumentId: pos.globalInstrumentId,
      field,
      tickSize,
      previousPrice,
      proposedPrice: aligned,
      idempotencyKey: `drag_${pos.id}_${field}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    };
    renderChartProtectionOverlay();
    return state.protectionDrag;
  }

  function cancelChartProtectionDrag() {
    state.protectionDrag = null;
    try {
      if (tvChart && state.activeDrawingTool === 'cursor') {
        tvChart.applyOptions({ handleScroll: true, handleScale: true });
      }
    } catch {}
    renderChartProtectionOverlay();
  }

  function openProtectionModalFromDrag() {
    const drag = state.protectionDrag;
    if (!drag) return;
    const prefill = drag.field === 'TP'
      ? { targetPrice: drag.proposedPrice }
      : { stopLossPrice: drag.proposedPrice };
    const posId = drag.positionId;
    cancelChartProtectionDrag();
    openProtectionModal(posId, prefill);
  }

  async function confirmChartProtectionDrag() {
    const drag = state.protectionDrag;
    if (!drag || !drag.pendingConfirm || drag.submitting) return;
    const pos = getPositionById(drag.positionId);
    if (!pos || Number(pos.quantity) === 0) {
      cancelChartProtectionDrag();
      window.SikhoUX?.notify?.('Position has already closed — cannot apply TP/SL change.');
      await refreshAccountAndPortfolio();
      return;
    }

    drag.submitting = true;
    renderChartProtectionOverlay();

    const payload = {
      expectedVersion: pos.protectionVersion || 1,
      idempotencyKey: drag.idempotencyKey || `drag_${pos.id}_${drag.field}_${Date.now()}`,
      source: 'CHART_DRAG',
    };
    if (drag.field === 'TP') payload.targetPrice = drag.proposedPrice;
    else payload.stopLossPrice = drag.proposedPrice;

    try {
      const res = await apiFetch(`/api/v1/positions/${encodeURIComponent(pos.id)}/protection`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      state.protectionDrag = null;
      if (res && res.position) {
        applyRemotePositionProtectionUpdate(res.position);
      }
      await refreshAccountAndPortfolio();
      renderChartProtectionOverlay();
      window.SikhoUX?.notify?.(
        `${drag.field} updated: ₹${fmtNum(drag.previousPrice)} → ₹${fmtNum(drag.proposedPrice)}`
      );
    } catch (err) {
      if (err && (err.code === 'ERR_SERVER_TIMEOUT' || err.code === 'ERR_SERVER_UNREACHABLE')) {
        // Transfer timed-out drag request to the protection modal reconciliation flow rather than claiming success
        const prefill = drag.field === 'TP' ? { targetPrice: drag.proposedPrice } : { stopLossPrice: drag.proposedPrice };
        const timedOutKey = payload.idempotencyKey;
        state.protectionDrag = null;
        renderChartProtectionOverlay();
        openProtectionModal(pos.id, prefill);
        if (state.protectionModal) {
          state.protectionModal.timedOutKey = timedOutKey;
          state.protectionModal.pendingIdempotencyKey = timedOutKey;
          const timeoutBox = document.getElementById('prot-timeout-box');
          if (timeoutBox) timeoutBox.style.display = 'block';
          const submitBtn = document.getElementById('prot-submit-btn');
          if (submitBtn) submitBtn.disabled = true;
        }
        return;
      }
      state.protectionDrag = null;
      await refreshAccountAndPortfolio();
      renderChartProtectionOverlay();
      showBrandedAlert(
        `${drag.field} Change Rejected`,
        err?.message || 'Could not update protection level. Saved level has been restored.'
      );
    }
  }

  // =========================================================================
  // EXPORT PUBLIC API & BOOTSTRAP
  // =========================================================================
  window.TZApp = {
    toggleAuthMode,
    submitAuthForm,
    handleGoogleSignIn,
    showGoogleDiagnostics,
    retryExploreData:loadExploreData,
    signOut,
    switchMainTab,
    openChartDateNavigation,
    clearCurrentWatchlist,
    setExploreCategory,
    setMarketSegment: setExploreCategory,
    filterExploreStocks,
    filterCommodities,
    openCommoditySpecsModal,
    openTradeJournalModal,
    loadJournalEntries,
    submitJournalEntry,
    exportJournalCSV,
    openPriceAlertModal,
    setAlertCondition,
    saveActiveAlert,
    removeAlert,
    toggleReplayMode,
    replayStepForward,
    replayStepBackward,
    replayTogglePlay,
    exitReplayMode,
    openAllIndicesModal,
    closeAllIndicesModal,
    renderAllIndicesList,
    openCustomizeIndicesModal,
    closeCustomizeIndicesModal,
    renderCustomizeIndicesModal,
    moveIndexSlot,
    removeIndexSlot,
    toggleIndexSelection,
    resetIndicesToDefault,
    saveIndexPreferences,
    tradeIndexFutureDirect,
    openOptionChainModal,
    closeOptionChainModal,
    loadOptionChain,
    loadMoreOptionStrikes,
    onOptionChainUnderlyingChange,
    openSearchModal,
    closeSearchModal,
    setSearchSegment,
    runGlobalSearch,
    addSymbolToWatchlist,
    openChartByGlobalId,
    closeChartWorkspace,
    jumpToNearestIndexFuture,
    openOptionChainFromChart,
    selectTimeframe,
    selectRangePreset,
    scrollToLatestBar,
    refreshActiveChart,
    resetChartScaleAndFitRecent,
    openIndicatorsModal,
    toggleIndicator,
    openDrawingsModal,
    selectDrawingTool,
    clearAllDrawings,
    openOrderTicket,
    getMarketDataDiagnostics,
    openOrderTicketByGlobalId,
    closeOrderTicket,
    setOrderSide,
    setOrderProduct,
    setOrderType,
    stepOrderQty,
    recalcOrderMarginPreview,
    submitPaperOrder,
    setPortfolioSubTab,
    squareOffPosition,
    setOrdersFilter,
    cancelPendingOrder,
    resetVirtualWallet,
    openCapitalResetModal,
    selectCapitalPreset,
    onCustomCapitalInput,
    applyCustomCapital,
    executeCapitalReset,
    openSubscriptionPlansModal,
    selectPlanCard,
    initiateSubscriptionPurchase,
    restorePurchases,
    showSubscriptionUpgradePrompt,
    showBrandedAlert,
    showConfirmSheet,
    closeConfirmSheet,
    loadAndShowLedger,
    openAdPrivacyOptions,
    showAdDiagnostics,
    showGoogleDiagnostics,
    togglePasswordVisibility,
    openServerConfigModal,
    closeServerConfigModal,
    applyServerPreset,
    testServerConnection,
    saveServerConfig,
    setThemePreference,
    toggleThemeQuick,
    removeSymbolFromWatchlist,
    checkTimedOutOrderStatus,
    onJournalDraftInput,
    requestCloseJournalModal,
    retryConnectivityNow,
    dismissUpdateBanner,
    checkServerHealthStatus,
    dismissOnboardingCard,
    alignPriceToTick,
    formatChartAxisTick,
    openProtectionModal,
    closeProtectionModal,
    toggleRemoveProtectionField,
    applyProtectionPointsOffset,
    onProtectionInputChanged,
    submitPositionProtectionModal,
    checkTimedOutProtectionStatus,
    renderChartProtectionOverlay,
    startChartProtectionDrag,
    previewChartProtectionDrag,
    confirmChartProtectionDrag,
    cancelChartProtectionDrag,
    openProtectionModalFromDrag,
  };

  window.addEventListener('DOMContentLoaded', () => {
    applyTheme(getThemePreference(), false);
    window.addEventListener('online', () => { updateAppStatusBanner(); retryConnectivityNow(); });
    window.addEventListener('offline', () => { updateAppStatusBanner(); });
    try {
      systemThemeMedia = window.matchMedia('(prefers-color-scheme: dark)');
      systemThemeMedia.addEventListener('change', () => {
        if (getThemePreference() === 'system') applyTheme('system', false);
      });
    } catch {}
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.token) {
        pollAccessPolicy();
      }
    });
    probeAndSelectServer();
    const saved = readSessionSecure();
    if (saved && saved.token && saved.user) {
      completeAuthenticatedSession(saved.token, saved.user, saved.account);
    } else {
      showTopScreen('screen-auth');
      syncNativeSystemBarTheme();
    }
  });
})();

