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
    lastCumulativeVolume: {},
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
      sma20: true,
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
    if (!quote || !quote.ltp) return { diff: 0, pct: 0, sign: '' };
    const base = quote.close && quote.close > 0 ? quote.close : quote.open || quote.ltp;
    const diff = quote.ltp - base;
    const pct = base > 0 ? (diff / base) * 100 : 0;
    const sign = diff > 0 ? '+' : '';
    return { diff, pct, sign };
  }

  async function apiFetch(path, opts = {}) {
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (state.token) {
      headers['Authorization'] = `Bearer ${state.token}`;
    }

    const timeoutMs = opts.timeoutMs || 10000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res;
    try {
      res = await fetch(`${API_BASE}${path}`, Object.assign({}, opts, {
        headers,
        signal: controller.signal,
      }));
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        const timeoutErr = new Error(`Connection timed out (${timeoutMs / 1000}s) connecting to ${API_BASE}. Ensure PC backend is running and phone is on the same Wi-Fi.`);
        timeoutErr.code = 'ERR_SERVER_TIMEOUT';
        throw timeoutErr;
      }
      const netErr = new Error(`Cannot reach backend at ${API_BASE}. Ensure PC server is running and phone is on the same Wi-Fi network (or configure server URL).`);
      netErr.code = 'ERR_SERVER_UNREACHABLE';
      throw netErr;
    } finally {
      clearTimeout(timer);
    }

    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && state.token && !path.includes('/auth/login')) {
      signOut('Your session has expired. Please sign in again.');
      throw new Error(data.error || 'Session expired');
    }
    if (!res.ok) {
      const err = new Error(data.error || data.message || `Request failed (${res.status})`);
      err.code = data.code;
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
      document.getElementById('modal-order-ticket')?.classList.contains('active') ||
      document.getElementById('modal-option-chain')?.classList.contains('active')
    );

    const posList = state.positionsData?.positions || state.positions || [];
    const hasOpenPositions = Boolean(
      posList.some((p) => Math.abs(p.quantity || 0) > 0)
    );

    const ordList = state.orders || [];
    const hasPendingOrders = Boolean(
      ordList.some((o) => o.status === 'PENDING' || o.status === 'TRIGGER_PENDING')
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

  function isProUser() {
    return Boolean(
      state.entitlementResolved &&
      state.subscription?.tier === 'PRO' &&
      state.user?.tier === 'PRO'
    );
  }

  function isGlobalIdRestrictedForFree(globalId) {
    if (!globalId) return false;
    const gid = String(globalId).toUpperCase();
    if (gid === 'NSE:NIFTY:INDEX' || gid === 'NSE:BANKNIFTY:INDEX') return false;
    if (gid.startsWith('NSE:NIFTY') || gid.startsWith('NSE:BANKNIFTY')) return false;
    return true;
  }

  function isInstrumentRestrictedForFree(inst) {
    if (!inst) return false;
    if (isProUser()) return false;
    const gid = inst.globalId || inst.globalInstrumentId || '';
    if (gid) {
      return isGlobalIdRestrictedForFree(gid);
    }
    const sym = (inst.symbol || inst.tradingsymbol || '').toUpperCase();
    if (sym.includes('NIFTY 50') || sym === 'NIFTY' || sym.includes('BANK NIFTY') || sym.includes('NIFTY BANK') || sym === 'BANKNIFTY') {
      return false;
    }
    return true;
  }

  function showSubscriptionUpgradePrompt(symbol) {
    showBrandedAlert(
      'Premium Pro Required',
      `${symbol || 'This instrument'} is exclusive to Sikho Trading Premium. Upgrade now to unlock BSE SENSEX, Equities, and MCX Commodities.`
    );
    openSubscriptionPlansModal();
  }

  function recordEligibleAction(actionName) {
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
    const passLbl = document.getElementById('auth-label-password');
    const btnTxt = document.getElementById('btn-auth-submit-text');
    const toggleBtn = document.getElementById('btn-auth-toggle-mode');

    if (mode === 'register') {
      heading.textContent = 'Create your account';
      sub.textContent = 'Start with ₹1,00,000 in virtual capital for NSE & BSE practice';
      nameGrp.style.display = 'block';
      passLbl.textContent = 'Create Password (min 6 chars)';
      btnTxt.textContent = 'Create Practice Account';
      toggleBtn.textContent = 'Already have an account? Sign In';
      toggleBtn.onclick = () => toggleAuthMode('login');
    } else if (mode === 'recover') {
      heading.textContent = 'Account Password Recovery';
      sub.textContent = 'Reset your password while keeping your virtual portfolio and track record';
      nameGrp.style.display = 'none';
      passLbl.textContent = 'New Password (min 6 chars)';
      btnTxt.textContent = 'Reset Password';
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

    const email = (emailInput?.value || '').trim();
    // Maintain password integrity: do not trim or modify password
    const password = passwordInput?.value || '';
    const name = (nameInput?.value || '').trim();

    if (!email || !email.includes('@')) {
      return showAuthError('Please enter a valid email address.');
    }
    if (!password || password.length < 6) {
      return showAuthError('Please enter a password of at least 6 characters.');
    }

    if (submitBtn) submitBtn.disabled = true;
    const originalText = submitText ? submitText.textContent : 'Submit';
    if (submitText) {
      if (state.authMode === 'register') {
        submitText.textContent = 'Creating Practice Account...';
      } else if (state.authMode === 'recover') {
        submitText.textContent = 'Resetting Password...';
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
          body: JSON.stringify({ email, newPassword: password }),
        });
      } else {
        res = await apiFetch('/api/v1/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        });
      }

      completeAuthenticatedSession(res.token, res.user, res.account, true, res.entitlement);
    } catch (err) {
      showAuthError(err.message || 'Authentication failed.');
    } finally {
      if (submitBtn) submitBtn.disabled = false;
      if (submitText) submitText.textContent = originalText;
    }
  }

  // Official Web Client ID configured in Google Cloud Project "Sikho Trading"
  const GOOGLE_WEB_CLIENT_ID = '18709659572-6d1j4db60j60vo0a0ek5kumvv06vu4fi.apps.googleusercontent.com';

  let googleSignInTimeoutId = null;

  let activeGoogleSignInRequestId = null;

  // Callback registered globally for native Android Credential Manager result
  window.onTradingzoneGoogleSignInResult = async function (success, dataJsonStr, errorMsg, requestId) {
    if (requestId && activeGoogleSignInRequestId && requestId !== activeGoogleSignInRequestId) {
      return; // Ignore stale callback from timed-out or superseded sign-in attempt
    }
    activeGoogleSignInRequestId = null;

    if (googleSignInTimeoutId) {
      clearTimeout(googleSignInTimeoutId);
      googleSignInTimeoutId = null;
    }
    state.isGoogleSignInPending = false;

    const googleBtn = document.getElementById('btn-google-signin');
    const googleBtnText = document.getElementById('btn-google-signin-text');

    const resetGoogleBtn = () => {
      if (googleBtn) googleBtn.disabled = false;
      if (googleBtnText) googleBtnText.textContent = 'Continue with Google';
    };

    if (!success) {
      resetGoogleBtn();
      if (errorMsg === 'USER_CANCELLED') {
        showAuthError('Google sign-in was cancelled.');
      } else if (errorMsg && errorMsg.includes('PLAY_SERVICES_UNAVAILABLE')) {
        showAuthError('Google Play Services is unavailable or needs an update on this device. Please update Google Play Services or sign in with email/password.');
      } else if (errorMsg && errorMsg.includes('SIGN_IN_TIMEOUT')) {
        showAuthError('Google sign-in timed out. Please try again or use email login.');
      } else if (errorMsg && errorMsg.includes('NO_CREDENTIALS')) {
        showAuthError('Google Sign-In could not obtain an eligible Google ID credential from Play Services. Check that Google Play Services is updated and a Google account is active on this device, or sign in with email/password.');
      } else if (errorMsg && (errorMsg.includes('CREDENTIAL_ERROR') || errorMsg.includes('16:'))) {
        showAuthError('Google Sign-In configuration mismatch (SHA-1/Package). Ensure package com.indianpapertrading and signing fingerprint are registered in Google Cloud Console, or sign in with email/password.');
      } else {
        showAuthError(errorMsg || 'Google sign-in failed.');
      }
      return;
    }

    try {
      let parsed = null;
      if (typeof dataJsonStr === 'string' && dataJsonStr.trim().length > 0) {
        try {
          parsed = JSON.parse(dataJsonStr);
        } catch (parseErr) {
          console.error('Failed to parse Google credential JSON:', parseErr);
        }
      } else if (typeof dataJsonStr === 'object' && dataJsonStr !== null) {
        parsed = dataJsonStr;
      }

      if (!parsed || !parsed.idToken) {
        resetGoogleBtn();
        return showAuthError('Invalid Google credential response: missing ID token.');
      }

      if (googleBtnText) googleBtnText.textContent = 'Verifying with Sikho Trading...';
      const res = await apiFetch('/api/v1/auth/google', {
        method: 'POST',
        body: JSON.stringify({ idToken: parsed.idToken }),
      });

      if (res && res.token) {
        document.getElementById('auth-error-msg').style.display = 'none';
        completeAuthenticatedSession(res.token, res.user, res.account, true, res.entitlement);
      } else {
        showAuthError('Authentication succeeded but failed to issue session.');
      }
    } catch (err) {
      showAuthError(err.message || 'Google verification failed on backend.');
    } finally {
      resetGoogleBtn();
    }
  };

  async function handleGoogleSignIn() {
    if (state.isGoogleSignInPending) return;

    const googleBtn = document.getElementById('btn-google-signin');
    const googleBtnText = document.getElementById('btn-google-signin-text');

    try {
      // 1. If running inside Android Native wrapper with Credential Manager bridge
      if (window.TradingzoneNative && typeof window.TradingzoneNative.startNativeGoogleSignIn === 'function') {
        state.isGoogleSignInPending = true;
        const reqId = `g_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        activeGoogleSignInRequestId = reqId;
        if (googleBtn) googleBtn.disabled = true;
        if (googleBtnText) googleBtnText.textContent = 'Opening Google Sign-In...';

        // 45-second timeout safety guard
        if (googleSignInTimeoutId) clearTimeout(googleSignInTimeoutId);
        googleSignInTimeoutId = setTimeout(() => {
          if (state.isGoogleSignInPending && activeGoogleSignInRequestId === reqId) {
            activeGoogleSignInRequestId = null;
            state.isGoogleSignInPending = false;
            if (googleBtn) googleBtn.disabled = false;
            if (googleBtnText) googleBtnText.textContent = 'Continue with Google';
            showAuthError('Google sign-in timed out. Please try again or use email login.');
          }
        }, 45000);

        // Immediately invoke native Credential Manager prompt with request ID
        window.TradingzoneNative.startNativeGoogleSignIn(GOOGLE_WEB_CLIENT_ID, reqId);
        return;
      }

      // 2. In browser fallback/testing environment: show clear instruction
      showAuthError('Native Google Sign-In requires an Android device. In browser mode, sign in with email and password.');
    } catch (err) {
      state.isGoogleSignInPending = false;
      showAuthError(err.message || 'Failed to start Google sign-in.');
      if (googleBtn) googleBtn.disabled = false;
      if (googleBtnText) googleBtnText.textContent = 'Continue with Google';
    }
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

  function completeAuthenticatedSession(token, user, account, isFreshLogin, entitlement) {
    // Strip any legacy PIN/biometric flags and never trust cached client-side PRO tier until server verifies entitlement
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
      state.entitlementResolved = false;
    }
    enterMainWorkspace();
    return true;
  }

  function signOut(optionalNotice) {
    state.token = null;
    state.user = null;
    state.account = null;
    state.subscription = null;
    state.entitlementResolved = false;
    state.positionsData = { positions: [], holdings: [], activePositions: [], closedPositions: [] };
    state.orders = [];
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
    if (optionalNotice) showAuthError(optionalNotice);
    showTopScreen('screen-auth');
  }

  // =========================================================================
  // 2. MAIN WORKSPACE INITIALIZATION & REAL-TIME WEBSOCKET
  // =========================================================================
  async function enterMainWorkspace() {
    showTopScreen('screen-main');
    notifyNativeUserTier();
    notifyNativeScreenState();
    updateProfileHeaderUI();
    connectRealtimeWebSocket();
    await Promise.all([
      refreshFeedHealth(),
      refreshAccountAndPortfolio(),
      loadExploreData(),
      loadWatchlists(),
    ]);
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
      const src = h.activeProvider?.source || 'UPSTOX';
      const mktOpen = h.marketSession?.isMarketOpen ? 'Market OPEN' : 'Market CLOSED';
      const provEl = document.getElementById('header-provider-label');
      if (provEl) provEl.textContent = `${src} V3 • ${mktOpen} • Virtual Funds`;
      document.getElementById('prof-provider-title').textContent = `Primary Provider: ${src} (${h.activeProvider?.status || 'ACTIVE'})`;
      document.getElementById('prof-provider-sub').textContent =
        h.activeProvider?.message || h.marketSession?.note || '';
    } catch { }
  }

  async function refreshAccountAndPortfolio() {
    try {
      const [acc, posRes, ordRes, perfRes, subRes] = await Promise.all([
        apiFetch('/api/v1/account').catch(() => null),
        apiFetch('/api/v1/positions').catch(() => null),
        apiFetch('/api/v1/orders').catch(() => null),
        apiFetch('/api/v1/account/performance').catch(() => null),
        apiFetch('/api/v1/billing/status').catch(() => null),
      ]);
      if (acc && !acc.error) {
        state.account = acc;
      }
      if (posRes) {
        state.positionsData = posRes;
      }
      if (ordRes && Array.isArray(ordRes.orders)) {
        state.orders = ordRes.orders;
      }
      if (perfRes) {
        state.performance = perfRes;
      }

      const resolvedSub = subRes || acc?.entitlement || null;
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

    if (state.performance) {
      const cur = state.performance.currentSession || {};
      const life = state.performance.lifetime || {};

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
  async function loadExploreData() {
    try {
      const [idxRes, eqRes, futIdxRes, futStkRes, commRes, specsRes] = await Promise.all([
        apiFetch('/api/v1/indices?limit=50'),
        apiFetch('/api/v1/instruments?segment=EQUITY_STOCK&limit=30'),
        apiFetch('/api/v1/instruments?segment=FUTIDX&limit=12'),
        apiFetch('/api/v1/instruments?segment=FUTSTK&limit=16'),
        apiFetch('/api/v1/commodities'),
        apiFetch('/api/v1/commodities/specs'),
      ]);
      state.indices = idxRes.indices || [];
      state.quotesMap = state.quotesMap || new Map();
      (state.indices || []).forEach((inst) => {
        if (inst.latestQuote && inst.latestQuote.ltp > 0) {
          state.quotesMap.set(inst.globalId, inst.latestQuote);
        }
      });

      // Canonical index sorting: NIFTY 50 -> BANKNIFTY -> SENSEX -> FINNIFTY -> MIDCPNIFTY -> NIFTY IT...
      const INDEX_ORDER = ['NIFTY 50', 'BANKNIFTY', 'SENSEX', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTY IT', 'NIFTY PHARMA', 'NIFTY METAL', 'BANKEX'];
      state.indices.sort((a, b) => {
        const keyA = getIndexCanonicalKey(a);
        const keyB = getIndexCanonicalKey(b);
        const idxA = INDEX_ORDER.indexOf(keyA);
        const idxB = INDEX_ORDER.indexOf(keyB);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return keyA.localeCompare(keyB);
      });

      // Load user preferences for benchmark strip
      await loadUserIndexPreferences();

      state.exploreStocks = eqRes.instruments || [];
      const PROMINENT_ORDER = [
        'RELIANCE', 'TCS', 'TTML', 'HDFCBANK', 'INFY', 'ICICIBANK',
        'SBIN', 'BHARTIARTL', 'ITC', 'KOTAKBANK', 'TATAMOTORS', 'WIPRO',
        'MARUTI', 'SUNPHARMA', 'BAJFINANCE', 'HINDUNILVR'
      ];
      state.exploreStocks.sort((a, b) => {
        const symA = (a.tradingSymbol || a.symbol || '').toUpperCase().split('-')[0].trim();
        const symB = (b.tradingSymbol || b.symbol || '').toUpperCase().split('-')[0].trim();
        const idxA = PROMINENT_ORDER.indexOf(symA);
        const idxB = PROMINENT_ORDER.indexOf(symB);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return (a.tradingSymbol || a.symbol || '').localeCompare(b.tradingSymbol || b.symbol || '');
      });
      state.exploreFnoIndices = futIdxRes.instruments || [];
      state.exploreFnoStocks = futStkRes.instruments || [];
      state.commodities = commRes || { metals: [], energy: [], agriculture: [] };
      state.commoditySpecs = specsRes?.specs || {};

      renderBenchmarkIndexStrip();
      renderExploreStocksList();
      renderExploreFnoLists();
      renderCommoditiesList();
    } catch { }
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
        const { diff, pct, sign } = calcChange(q);
        const cls = diff >= 0 ? 'val-pos-dark' : 'val-neg';
        const isDerivative = inst.instrumentType === 'FUTIDX' || inst.instrumentType === 'OPTIDX';
        const eBadge = isDerivative && inst.expiry ? `<span class="expiry-e-badge">${inst.expiry}</span>` : '';
        const ltpDisplay = q && q.ltp !== undefined && q.ltp !== null && q.ltp > 0 ? fmtNum(q.ltp) : '—';
        const chgDisplay = q && q.ltp !== undefined && q.ltp !== null && q.ltp > 0 ? `${sign}${pct.toFixed(2)}%` : '';
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
              <span class="idx-chg ${cls}" data-chg-id="${inst.globalId}">${chgDisplay}</span>
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
    state.exploreCategory = cat;
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

        const q = inst.latestQuote;
        const { diff, pct, sign } = calcChange(q);
        const cls = diff >= 0 ? 'val-pos' : 'val-neg';
        const hasOptions = inst.hasDerivatives || ['CRUDEOIL', 'GOLD', 'SILVER', 'NATURALGAS', 'COPPER'].includes(und);
        const priceText = q && q.ltp !== undefined && q.ltp !== null ? fmtINR(q.ltp) : '—';
        const chgText = q && q.ltp !== undefined && q.ltp !== null ? `${sign}${pct.toFixed(2)}%` : '';

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
    state.stocksSectorFilter = sector;
    document.querySelectorAll('#stocks-sector-chips .filter-chip').forEach((b) => b.classList.remove('active'));
    if (btnEl) btnEl.classList.add('active');
    renderExploreStocksList();
    recordEligibleAction('filter_stocks_sector_' + sector);
  }

  function renderInstrumentRowHTML(inst, showChainBtn = false) {
    const isRestricted = !isProUser() && isInstrumentRestrictedForFree(inst);
    const avatarHtml = window.InstrumentIdentity
      ? window.InstrumentIdentity.renderInstrumentAvatar(inst, 38)
      : `<div class="inst-badge-icon">${(inst.symbol || 'EQ').slice(0, 3)}</div>`;

    if (isRestricted) {
      return `
        <div class="instrument-row-white" onclick="window.TZApp.showSubscriptionUpgradePrompt('${inst.symbol}')" style="opacity:0.92;">
          <div class="inst-left">
            ${avatarHtml}
            <div class="inst-meta">
              <div class="inst-symbol-row">
                <span class="inst-symbol">${inst.symbol}</span>
                <span class="tag-exch">${inst.exchange || 'NSE'}</span>
                <span class="expiry-e-badge" style="background:#f59e0b;color:#000;font-weight:700;">PRO</span>
              </div>
              <div class="inst-name-sub">${inst.name || 'Pro Tier Instrument'}</div>
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

    const q = inst.latestQuote;
    const { diff, pct, sign } = calcChange(q);
    const cls = diff >= 0 ? 'val-pos' : 'val-neg';
    const chainUnderlying = inst.underlying || inst.symbol;

    const isDerivative = inst.instrumentType === 'FUTIDX' || inst.instrumentType === 'FUTSTK' ||
                         inst.instrumentType === 'OPTIDX' || inst.instrumentType === 'OPTSTK' ||
                         inst.instrumentType === 'FUTCOM' || inst.instrumentType === 'OPTCOM';

    let metaSub = inst.name || inst.symbol;
    if (isDerivative && inst.expiry) {
      metaSub = `${inst.expiry}${inst.strikePrice ? ' • ' + inst.strikePrice : ''}${inst.optionType ? ' ' + inst.optionType : ''}`;
    }

    const priceText = q && q.ltp !== undefined && q.ltp !== null ? fmtINR(q.ltp) : '—';
    const chgText = q && q.ltp !== undefined && q.ltp !== null ? `${sign}${pct.toFixed(2)}%` : '';

    return `
      <div class="instrument-row-white" onclick="window.TZApp.openChartByGlobalId('${inst.globalId}')">
        <div class="inst-left">
          ${avatarHtml}
          <div class="inst-meta">
            <div class="inst-symbol-row">
              <span class="inst-symbol">${inst.symbol}</span>
              <span class="tag-exch">${inst.exchange}</span>
              ${inst.lotSize > 1 ? `<span class="tag-exch">Lot ${inst.lotSize}</span>` : ''}
            </div>
            <div class="inst-name-sub">${metaSub}</div>
          </div>
        </div>
        <div class="inst-right">
          <div class="inst-price-col">
            <span class="inst-ltp-val" data-ltp-id="${inst.globalId}">${priceText}</span>
            <span class="inst-chg-val ${cls}" data-chg-id="${inst.globalId}">
              ${chgText}
            </span>
          </div>
          ${showChainBtn
        ? `<button class="chain-icon-btn" title="Option Chain" onclick="event.stopPropagation(); window.TZApp.openOptionChainModal('${chainUnderlying}')">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                  </svg>
                </button>`
        : ''
      }
        </div>
      </div>
    `;
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

  async function openOptionChainModal(underlying = 'NIFTY', expiry) {
    document.getElementById('modal-option-chain').classList.add('active');
    notifyNativeScreenState();
    const sel = document.getElementById('oc-underlying-select');
    if (sel) sel.value = underlying;
    await loadOptionChain(underlying, expiry);
  }

  function closeOptionChainModal() {
    document.getElementById('modal-option-chain').classList.remove('active');
    notifyNativeScreenState();
  }

  async function loadOptionChain(underlying = 'NIFTY', expiry) {
    document.getElementById('oc-title').textContent = `${underlying} Option Chain`;
    document.getElementById('oc-table-body').innerHTML =
      '<tr><td colspan="5" style="padding:24px;color:var(--text-on-white-secondary);">Loading live option chain strikes from Upstox V3 master...</td></tr>';
    try {
      const url = `/api/v1/option-chain?underlying=${encodeURIComponent(underlying)}${expiry ? `&expiry=${encodeURIComponent(expiry)}` : ''
        }`;
      const chain = await apiFetch(url);
      document.getElementById('oc-spot-subtitle').textContent = chain.underlyingSpotLtp
        ? `Underlying Spot: ${fmtINR(chain.underlyingSpotLtp)} • Expiry: ${chain.selectedExpiry}`
        : `Expiry: ${chain.selectedExpiry}`;

      // Update provenance banner
      const provMode = document.getElementById('oc-provenance-mode');
      const provNote = document.getElementById('oc-provenance-note');
      if (provMode) provMode.textContent = `Delivery: ${chain.deliveryMode || 'POLLED'}`;
      if (provNote && chain.provenance?.note) provNote.textContent = chain.provenance.note;

      // Render expiry pills
      const pillsEl = document.getElementById('oc-expiry-pills');
      pillsEl.innerHTML = (chain.availableExpiries || [])
        .slice(0, 8)
        .map(
          (exp) => `
          <button class="filter-chip ${exp === chain.selectedExpiry ? 'active' : ''}"
                  onclick="window.TZApp.loadOptionChain('${chain.underlying}', '${exp}')">
            ${exp}
          </button>
        `
        )
        .join('');

      // Find ATM strike
      let atmStrike = null;
      if (chain.underlyingSpotLtp && chain.rows.length > 0) {
        let minD = Infinity;
        for (const r of chain.rows) {
          const d = Math.abs(r.strikePrice - chain.underlyingSpotLtp);
          if (d < minD) {
            minD = d;
            atmStrike = r.strikePrice;
          }
        }
      }

      const tbody = document.getElementById('oc-table-body');
      tbody.innerHTML = chain.rows
        .map((row) => {
          const isAtm = row.strikePrice === atmStrike;
          const ce = row.call;
          const pe = row.put;
          const ceLtp = ce && ce.ltp !== null ? fmtNum(ce.ltp) : '—';
          const peLtp = pe && pe.ltp !== null ? fmtNum(pe.ltp) : '—';
          const ceOi = ce && ce.openInterest ? (ce.openInterest / 1000).toFixed(1) + 'K' : '—';
          const peOi = pe && pe.openInterest ? (pe.openInterest / 1000).toFixed(1) + 'K' : '—';

          return `
            <tr class="${isAtm ? 'oc-atm-row' : ''}">
              <td class="oc-side-cell" onclick="${ce ? `window.TZApp.openChartByGlobalId('${ce.instrument.globalId}')` : ''}">${ceOi}</td>
              <td class="oc-side-cell" style="font-weight:700;color:var(--positive-on-white);" onclick="${ce ? `window.TZApp.openOrderTicketByGlobalId('${ce.instrument.globalId}', 'BUY')` : ''}">${ceLtp}</td>
              <td class="oc-strike-cell">${row.strikePrice}${isAtm ? ' <span style="font-size:9px;color:#566170;">ATM</span>' : ''}</td>
              <td class="oc-side-cell" style="font-weight:700;color:var(--negative-red);" onclick="${pe ? `window.TZApp.openOrderTicketByGlobalId('${pe.instrument.globalId}', 'BUY')` : ''}">${peLtp}</td>
              <td class="oc-side-cell" onclick="${pe ? `window.TZApp.openChartByGlobalId('${pe.instrument.globalId}')` : ''}">${peOi}</td>
            </tr>
          `;
        })
        .join('');
    } catch (err) {
      document.getElementById('oc-table-body').innerHTML = `<tr><td colspan="5" style="padding:20px;color:var(--negative-red);">${err.message}</td></tr>`;
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

  async function runGlobalSearch() {
    const q = document.getElementById('global-search-input').value.trim();
    try {
      const res = await apiFetch(
        `/api/v1/instruments?q=${encodeURIComponent(q)}&segment=${encodeURIComponent(state.searchSegment)}&limit=35`
      );
      const list = res.instruments || [];
      const container = document.getElementById('search-results-container');
      container.innerHTML = list
        .map(
          (inst) => {
            const avatarHtml = window.InstrumentIdentity
              ? window.InstrumentIdentity.renderInstrumentAvatar(inst, 38)
              : `<div class="inst-badge-icon">${inst.exchange}</div>`;
            return `
              <div class="instrument-row-white" onclick="window.TZApp.closeSearchModal(); window.TZApp.openChartByGlobalId('${inst.globalId}')">
                <div class="inst-left">
                  ${avatarHtml}
                  <div class="inst-meta">
                    <div class="inst-symbol-row">
                      <span class="inst-symbol">${inst.symbol}</span>
                      <span class="tag-exch">${inst.exchange || 'NSE'}</span>
                      ${inst.lotSize > 1 ? `<span class="tag-exch">Lot ${inst.lotSize}</span>` : ''}
                    </div>
                    <div class="inst-name-sub">${inst.name}</div>
                  </div>
                </div>
                <div class="inst-right">
                  <button class="chain-icon-btn" title="Add to Watchlist" onclick="event.stopPropagation(); window.TZApp.addSymbolToWatchlist('${inst.globalId}')">+</button>
                </div>
              </div>
            `;
          }
        )
        .join('');
    } catch { }
  }

  async function loadWatchlists() {
    try {
      const res = await apiFetch('/api/v1/watchlists');
      state.watchlists = res.watchlists || [];
      if (state.watchlists.length === 0) {
        await apiFetch('/api/v1/watchlists', {
          method: 'POST',
          body: JSON.stringify({
            name: 'Core Indian Markets',
            instruments: ['NSE:NIFTY 50:99926000', 'BSE:SENSEX:99919000', 'NFO:NIFTY23NOV26FUT:61471', 'NSE:RELIANCE:2885', 'NSE:HDFCBANK:1333'],
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
    const wl = state.watchlists[0];
    if (!wl || !wl.hydratedInstruments || wl.hydratedInstruments.length === 0) {
      container.innerHTML =
        '<div style="padding:32px 16px;text-align:center;color:var(--text-on-white-secondary);">Your watchlist is empty. Tap "+ Add Symbol" to add stocks or F&O contracts.</div>';
      return;
    }
    container.innerHTML = wl.hydratedInstruments
      .map((inst) => renderInstrumentRowHTML(inst, inst.instrumentType !== 'EQUITY_STOCK'))
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
      await loadWatchlists();
      closeSearchModal();
      switchMainTab('watchlists');
    } catch { }
  }

  // =========================================================================
  // 6. FULL-SCREEN CHART WORKSPACE, WINDOWED HISTORY & TOUCH DRAWINGS
  // =========================================================================
  async function openChartByGlobalId(globalId) {
    if (!globalId) return;
    const hasOpenPos = (state.positionsData?.positions || []).some(
      (p) => p.globalInstrumentId === globalId && Math.abs(p.quantity || 0) > 0
    );
    if (!isProUser() && isGlobalIdRestrictedForFree(globalId) && !hasOpenPos) {
      showSubscriptionUpgradePrompt(globalId.split(':')[1] || globalId);
      return;
    }
    closeAllIndicesModal();
    closeOptionChainModal();
    state.chartOpen = true;
    document.getElementById('screen-chart').classList.add('active');
    if (window.TradingzoneNative && typeof window.TradingzoneNative.setSystemBarTheme === 'function') {
      window.TradingzoneNative.setSystemBarTheme(false, '#0D1117');
    }
    notifyNativeScreenState();

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
        const searchRes = await apiFetch(`/api/v1/instruments?q=${encodeURIComponent(globalId.split(':')[1] || globalId)}&limit=10`);
        inst = (searchRes.instruments || []).find((i) => i.globalId === globalId) || searchRes.instruments?.[0];
      } catch { }
    }

    if (!inst) {
      inst = {
        globalId,
        symbol: globalId.split(':')[1] || globalId,
        exchange: globalId.split(':')[0] || 'NSE',
        instrumentType: globalId.startsWith('NFO') || globalId.startsWith('BFO') ? 'FUTIDX' : 'EQUITY_STOCK',
        isTradable: !globalId.includes('999'),
        lotSize: 1,
        tickSize: 0.05,
      };
    }

    state.activeInstrument = inst;
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
      if (!keepPrev && wsConn && wsConn.readyState === WebSocket.OPEN) {
        try {
          wsConn.send(JSON.stringify({ action: 'UNSUBSCRIBE', type: 'UNSUBSCRIBE', symbols: [state.activeChartSubId] }));
        } catch {}
      }
    }
    state.activeChartSubId = inst.globalId;
    sendWsSubscribe([inst.globalId]);
    startChartCountdownTimer();

    renderChartBottomTradeBar(inst);
    initLightweightChartInstance();
    await Promise.all([loadChartCandlesInitial(), loadUserDrawingsForActiveInstrument()]);
  }

  function closeChartWorkspace() {
    state.chartOpen = false;
    stopChartCountdownTimer();
    document.getElementById('screen-chart').classList.remove('active');
    if (window.TradingzoneNative && typeof window.TradingzoneNative.setSystemBarTheme === 'function') {
      window.TradingzoneNative.setSystemBarTheme(true, '#FFFFFF');
    }
    notifyNativeScreenState();
  }

  function renderChartBottomTradeBar(inst) {
    const bar = document.getElementById('chart-bottom-trade-bar');
    if (!inst.isTradable || inst.instrumentType === 'INDEX_SPOT') {
      const und = inst.underlying || (inst.symbol.includes('BANK') ? 'BANKNIFTY' : inst.symbol.includes('SENSEX') ? 'SENSEX' : 'NIFTY');
      bar.innerHTML = `
        <button class="btn-trade-sell" style="background:#1E293B;border:1px solid #334155;color:#F8FAFC;font-size:12px;font-weight:700;flex:1.2;" onclick="window.TZApp.openOptionChainModal('${und}')">
          Option Chain
        </button>
        <button class="btn-trade-sell" style="flex:1;" onclick="window.TZApp.tradeIndexFutureDirect('${und}', 'SELL')">
          SELL FUT
        </button>
        <button class="btn-trade-buy" style="flex:1;" onclick="window.TZApp.tradeIndexFutureDirect('${und}', 'BUY')">
          BUY FUT
        </button>
      `;
    } else {
      bar.innerHTML = `
        <button class="btn-trade-sell" onclick="window.TZApp.openOrderTicket('SELL')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M4.5 9c0-1.9 1.6-3.5 3.5-3.5.7 0 1.4.2 2 .6C10.7 5.4 11.3 5 12 5s1.3.4 2 1.1c.6-.4 1.3-.6 2-.6 1.9 0 3.5 1.6 3.5 3.5 0 .8-.3 1.5-.8 2.1.2.6.3 1.3.3 1.9 0 3.3-3.1 6-7 6s-7-2.7-7-6c0-.6.1-1.3.3-1.9-.5-.6-.8-1.3-.8-2.1zm4.5 4c-.8 0-1.5.7-1.5 1.5s.7 1.5 1.5 1.5 1.5-.7 1.5-1.5-.7-1.5-1.5-1.5zm6 0c-.8 0-1.5.7-1.5 1.5s.7 1.5 1.5 1.5 1.5-.7 1.5-1.5-.7-1.5-1.5-1.5z"/></svg>
          <span>SELL</span>
        </button>
        <button class="btn-trade-buy" onclick="window.TZApp.openOrderTicket('BUY')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M21 7.5c-.8-.5-2.2-.5-3.3.3l-1.9 1.5C14.7 8.5 13.4 8 12 8s-2.7.5-3.8 1.3L6.3 7.8C5.2 7 3.8 7 3 7.5 1.9 8.2 2 9.5 2.5 11l1.5 4.5c.6 1.8 2.2 3 4.1 3.2L9 20h6l.9-1.3c1.9-.2 3.5-1.4 4.1-3.2L21.5 11c.5-1.5.6-2.8-.5-3.5zm-5.5 6.5c-.8 0-1.5-.7-1.5-1.5s.7-1.5 1.5-1.5 1.5.7 1.5 1.5-.7 1.5-1.5 1.5zm-7 0c-.8 0-1.5-.7-1.5-1.5s.7-1.5 1.5-1.5 1.5.7 1.5 1.5-.7 1.5-1.5 1.5z"/></svg>
          <span>BUY</span>
        </button>
      `;
    }
  }

  async function tradeIndexFutureDirect(underlying, side) {
    try {
      const res = await apiFetch(`/api/v1/instruments?segment=FUTIDX&underlying=${encodeURIComponent(underlying)}&limit=5`);
      const fut = res.instruments?.[0];
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
      const first = res.instruments?.[0];
      if (first) {
        await openChartByGlobalId(first.globalId);
      }
    } catch { }
  }

  function openOptionChainFromChart() {
    const inst = state.activeInstrument;
    const und = inst?.underlying || (inst?.symbol?.includes('BANK') ? 'BANKNIFTY' : inst?.symbol?.includes('SENSEX') ? 'SENSEX' : 'NIFTY');
    openOptionChainModal(und);
  }

  function initLightweightChartInstance() {
    const container = document.getElementById('tv-main-chart');
    if (tvChart) {
      tvChart.remove();
      tvChart = null;
      indicatorSeriesMap = {};
    }

    tvChart = LightweightCharts.createChart(container, {
      width: container.clientWidth || 380,
      height: container.clientHeight || 420,
      layout: {
        background: { type: 'solid', color: '#080C12' },
        textColor: '#AAB4C2',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(255, 255, 255, 0.05)' },
        horzLines: { color: 'rgba(255, 255, 255, 0.05)' },
      },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#1E293B', autoScale: true },
      timeScale: {
        borderColor: '#1E293B',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 5,
      },
    });

    candleSeries = tvChart.addCandlestickSeries({
      upColor: '#22C55E',
      downColor: '#D92D45',
      borderUpColor: '#22C55E',
      borderDownColor: '#D92D45',
      wickUpColor: '#22C55E',
      wickDownColor: '#D92D45',
    });

    tvChart.subscribeCrosshairMove((param) => {
      if (!param || !param.time || !param.seriesData) return;
      const bar = param.seriesData.get(candleSeries);
      if (bar) {
        document.getElementById('chart-ohlc-legend').textContent =
          `O ${fmtNum(bar.open)}  H ${fmtNum(bar.high)}  L ${fmtNum(bar.low)}  C ${fmtNum(bar.close)}`;
      }
    });

    // Left-scroll pagination listener + "Go to latest" visibility detector
    tvChart.timeScale().subscribeVisibleLogicalRangeChange((logicalRange) => {
      renderDrawingsSvgOverlay();
      if (!logicalRange || state.candles.length === 0) return;

      const distanceFromRight = state.candles.length - 1 - logicalRange.to;
      state.isUserScrolledBack = distanceFromRight > 12;
      document.getElementById('btn-go-latest').style.display = state.isUserScrolledBack ? 'inline-flex' : 'none';

      if (logicalRange.from < 15 && state.hasMoreHistory && !state.isFetchingOlder) {
        fetchOlderCandlePage();
      }
    });

    setupTouchArbitratedDrawingEvents();
  }

  async function loadChartCandlesInitial() {
    if (!state.activeInstrument) return;
    const seq = ++state.chartLoadSeq;
    state.isFetchingOlder = false;
    state.isUserScrolledBack = false;
    document.getElementById('btn-go-latest').style.display = 'none';

    const gid = state.activeInstrument.globalId;
    const tf = state.activeTimeframe;
    const rangeParam = state.activeRange ? `&range=${encodeURIComponent(state.activeRange)}` : '';

    try {
      const data = await apiFetch(
        `/api/v1/market-data/candles?globalId=${encodeURIComponent(gid)}&timeframe=${encodeURIComponent(tf)}${rangeParam}`
      );
      if (seq !== state.chartLoadSeq) return; // Discard stale response from earlier switch

      state.candles = data.candles || [];
      state.hasMoreHistory = Boolean(data.hasMore);
      state.earliestTime = data.earliestTime;
      state.prevSessionClose = data.prevSessionClose;

      if (candleSeries && state.candles.length > 0) {
        candleSeries.setData(state.candles);
        const totalBars = state.candles.length;
        const barsToShow = Math.min(100, Math.max(60, totalBars));
        tvChart.timeScale().setVisibleLogicalRange({
          from: totalBars - barsToShow,
          to: totalBars + 4,
        });
        const last = state.candles[state.candles.length - 1];
        document.getElementById('chart-ohlc-legend').textContent =
          `O ${fmtNum(last.open)}  H ${fmtNum(last.high)}  L ${fmtNum(last.low)}  C ${fmtNum(last.close)}`;
        document.getElementById('chart-candle-stats').textContent =
          `${state.candles.length} bars • ${data.sessionDateIST || ''}`;
      }
      if (data.latestQuote) {
        updateChartHeaderQuote(data.latestQuote);
        // Reconcile initial snapshot against the latest loaded candle if snapshot is at or after the latest candle
        if (state.candles.length > 0 && Number(data.latestQuote.ltp) > 0) {
          reconcileCandleWithTick(data.latestQuote, true);
        }
      }
      updateChartCountdownUI();
      recalculateAndRenderIndicators();
      renderDrawingsSvgOverlay();
    } catch { }
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
      state.candles = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
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

  function scrollToLatestBar() {
    if (tvChart) {
      const totalBars = state.candles.length;
      const barsToShow = Math.min(100, Math.max(60, totalBars));
      tvChart.timeScale().setVisibleLogicalRange({
        from: totalBars - barsToShow,
        to: totalBars + 4,
      });
      state.isUserScrolledBack = false;
      document.getElementById('btn-go-latest').style.display = 'none';
    }
  }

  function selectTimeframe(tf) {
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
    const base = state.prevSessionClose || quote.close || quote.open || quote.ltp;
    const diff = quote.ltp - base;
    const pct = base > 0 ? (diff / base) * 100 : 0;
    const sign = diff >= 0 ? '+' : '';
    ltpEl.textContent = fmtINR(quote.ltp);
    chgEl.textContent = `${sign}${diff.toFixed(2)} (${sign}${pct.toFixed(2)}%)`;
    chgEl.className = 'tabular-nums ' + (diff >= 0 ? 'val-pos-dark' : 'val-neg');
    checkPriceAlerts(quote);
  }

  // =========================================================================
  // INDICATORS & TOUCH-ARBITRATED VECTOR DRAWINGS
  // =========================================================================
  function recalculateAndRenderIndicators() {
    if (!tvChart || state.candles.length === 0) return;
    Object.values(indicatorSeriesMap).forEach((s) => {
      try { tvChart.removeSeries(s); } catch { }
    });
    indicatorSeriesMap = {};

    const closes = state.candles.map((c) => c.close);

    if (state.indicators.sma20 && state.candles.length >= 20) {
      const smaSeries = tvChart.addLineSeries({ color: '#C7F542', lineWidth: 2, priceLineVisible: false });
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
      const emaSeries = tvChart.addLineSeries({ color: '#38BDF8', lineWidth: 2, priceLineVisible: false });
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
      return { x: x !== null ? x : pt.x || 100, y: y !== null ? y : pt.y || 100 };
    };

    svg.innerHTML = all
      .map((d) => {
        const c1 = toCoords(d.p1);
        const c2 = toCoords(d.p2);
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
    try {
      const res = await apiFetch(`/api/v1/drawings?instrumentId=${encodeURIComponent(state.activeInstrument.globalId)}`);
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
    openOrderTicket(side);
  }

  function openOrderTicket(side = 'BUY', explicitInst = null) {
    const inst = explicitInst || state.activeInstrument;
    if (!inst) return;
    state.activeInstrument = inst;
    state.orderTicket.instrument = inst;
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
    document.getElementById('ticket-exchange-badge').textContent = `${badgeLabel} • Lot: ${inst.lotSize || 1}`;
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
    notifyNativeScreenState();
  }

  function closeOrderTicket() {
    document.getElementById('modal-order-ticket').classList.remove('active');
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
    document.getElementById('ticket-type-market').classList.toggle('active', type === 'MARKET');
    document.getElementById('ticket-type-limit').classList.toggle('active', type === 'LIMIT');
    document.getElementById('ticket-type-sl').classList.toggle('active', type === 'STOP_MARKET');

    const priceIn = document.getElementById('ticket-input-price');
    const lastClose = state.candles.length > 0 ? state.candles[state.candles.length - 1].close : 100;
    if (type === 'MARKET') {
      priceIn.disabled = true;
      priceIn.value = '';
      priceIn.placeholder = 'Market Price';
    } else {
      priceIn.disabled = false;
      priceIn.value = String(lastClose);
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
    const qty = Math.max(1, parseInt(document.getElementById('ticket-input-qty').value || '1', 10));
    const lastClose = state.candles.length > 0 ? state.candles[state.candles.length - 1].close : 1000;
    const reqPrice = parseFloat(document.getElementById('ticket-input-price').value);
    const price = !isNaN(reqPrice) && reqPrice > 0 ? reqPrice : lastClose;

    document.getElementById('ticket-ltp-sub').textContent = `Ref LTP: ${fmtINR(lastClose)} • Tick: ${inst.tickSize || 0.05}`;

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
    if (unitSpecEl) unitSpecEl.textContent = inst.tradingUnit ? `Unit: ${inst.tradingUnit}` : `Lot: ${inst.lotSize || 1}`;

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
    const inst = state.orderTicket.instrument;
    if (!inst) return;
    const errBox = document.getElementById('ticket-error-box');
    errBox.style.display = 'none';

    const qty = parseInt(document.getElementById('ticket-input-qty').value || '0', 10);
    const rawPrice = parseFloat(document.getElementById('ticket-input-price').value);
    const slVal = parseFloat(document.getElementById('ticket-input-sl').value);
    const tpVal = parseFloat(document.getElementById('ticket-input-target').value);

    const payload = {
      globalInstrumentId: inst.globalId,
      side: state.orderTicket.side,
      orderType: state.orderTicket.orderType,
      productType: state.orderTicket.productType,
      quantity: qty,
      idempotencyKey: `ord_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    };

    if (state.orderTicket.orderType === 'LIMIT') payload.requestedPrice = rawPrice;
    if (state.orderTicket.orderType === 'STOP_MARKET') payload.triggerPrice = rawPrice;
    if (!isNaN(slVal) && slVal > 0) payload.stopLossPrice = slVal;
    if (!isNaN(tpVal) && tpVal > 0) payload.targetPrice = tpVal;

    try {
      await apiFetch('/api/v1/orders/place', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      closeOrderTicket();
      closeChartWorkspace();
      await refreshAccountAndPortfolio();
      switchMainTab(state.orderTicket.productType === 'DELIVERY' ? 'portfolio' : 'orders');
    } catch (err) {
      errBox.textContent = err.message;
      errBox.style.display = 'block';
    }
  }

  // =========================================================================
  // 8. PORTFOLIO (Holdings | Positions | History) & ORDERS TABS
  // =========================================================================
  function setPortfolioSubTab(sub) {
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

        return `
          <div class="instrument-row-white" onclick="window.TZApp.openChartByGlobalId('${p.globalInstrumentId}')">
            <div class="inst-left">
              ${avatarHtml}
              <div class="inst-meta">
                <div class="inst-symbol-row">
                  <span class="inst-symbol">${p.symbol}</span>
                  <span class="tag-exch">${p.productType || 'INTRADAY'}</span>
                  <span class="tag-exch">Qty: ${p.quantity}</span>
                </div>
                <div class="inst-name-sub">Avg: ${fmtINR(p.averageEntryPrice)} • LTP: ${fmtINR(p.currentPrice)}</div>
              </div>
            </div>
            <div class="inst-right">
              <div class="inst-price-col">
                <span class="inst-ltp-val ${cls}">${pnl >= 0 ? '+' : ''}${fmtINR(pnl)}</span>
                <span class="inst-chg-val" style="color:var(--text-on-white-secondary);">${isOpen ? 'Unrealized MTM' : 'Realized P&L'}</span>
              </div>
              ${isOpen
            ? `<button class="btn-lime-primary" style="width:auto;min-height:34px;padding:0 10px;font-size:11.5px;background:var(--negative-red);color:#fff;"
                             onclick="event.stopPropagation(); window.TZApp.squareOffPosition('${p.globalInstrumentId}')">
                      Exit
                    </button>`
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

  function renderOrdersTab() {
    const container = document.getElementById('orders-list-container');
    const list = state.orders.filter((o) => state.ordersFilter === 'ALL' || o.status === state.ordersFilter);

    if (list.length === 0) {
      container.innerHTML =
        '<div style="padding:32px 16px;text-align:center;color:var(--text-on-white-secondary);">No orders matching this filter.</div>';
      return;
    }

    container.innerHTML = list
      .map((o) => {
        const priceLabel = o.executedPrice
          ? `Fill: ${fmtINR(o.executedPrice)}`
          : o.requestedPrice
            ? `Limit: ${fmtINR(o.requestedPrice)}`
            : o.triggerPrice
              ? `SL Trigger: ${fmtINR(o.triggerPrice)}`
              : 'Market';
        const avatarHtml = window.InstrumentIdentity
          ? window.InstrumentIdentity.renderInstrumentAvatar(o, 38)
          : `<div class="inst-badge-icon" style="color:${o.side === 'BUY' ? 'var(--positive-on-white)' : 'var(--negative-red)'};">${o.side}</div>`;
        const sideTag = o.side === 'BUY'
          ? '<span class="tag-exch" style="background:#ECFDF5;color:#059669;font-weight:800;">BUY</span>'
          : '<span class="tag-exch" style="background:#FEF2F2;color:#DC2626;font-weight:800;">SELL</span>';
        return `
          <div class="instrument-row-white">
            <div class="inst-left">
              ${avatarHtml}
              <div class="inst-meta">
                <div class="inst-symbol-row">
                  <span class="inst-symbol">${o.symbol || o.globalInstrumentId}</span>
                  ${sideTag}
                  <span class="tag-exch">${o.productType || 'INTRADAY'}</span>
                  <span class="tag-exch">${o.orderType}</span>
                </div>
                <div class="inst-name-sub">Qty: ${o.quantity} • ${priceLabel}</div>
                ${o.rejectionReason ? `<div style="font-size:11px;color:var(--negative-red);margin-top:2px;">${o.rejectionReason}</div>` : ''}
              </div>
            </div>
            <div class="inst-right">
              <span class="tag-exch" style="font-weight:800;">${o.status}</span>
              ${o.status === 'PENDING'
            ? `<button class="btn-lime-primary" style="width:auto;min-height:32px;padding:0 10px;font-size:11.5px;background:var(--negative-red);color:#fff;"
                             onclick="window.TZApp.cancelPendingOrder('${o.id}')">
                      Cancel
                    </button>`
            : ''
          }
            </div>
          </div>
        `;
      })
      .join('');
  }

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
    const hasPendingOrd = (state.orders || []).some((o) => o.status === 'PENDING' || o.status === 'TRIGGER_PENDING');

    const warningEl = document.getElementById('reset-positions-warning');
    const confirmBtn = document.getElementById('btn-confirm-capital-reset');
    if (warningEl) {
      warningEl.style.display = (hasOpenPos || hasPendingOrd) ? 'block' : 'none';
    }
    if (confirmBtn) {
      confirmBtn.disabled = (hasOpenPos || hasPendingOrd);
      confirmBtn.style.opacity = (hasOpenPos || hasPendingOrd) ? '0.5' : '1';
    }

    const isPro = (state.user?.tier === 'PRO') || (state.subscription?.tier === 'PRO');
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

    modal.classList.add('active');
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
    const val = Math.round(Number(input?.value) || 0);
    const isPro = (state.user?.tier === 'PRO') || (state.subscription?.tier === 'PRO');

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
    const modal = document.getElementById('modal-subscription');
    if (!modal) return;
    selectPlanCard('plan_month_100');
    modal.classList.add('active');
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
    state.mainTab = activeTab;
    const tabs = ['explore', 'watchlists', 'portfolio', 'orders', 'profile'];
    tabs.forEach((t) => {
      const el = document.getElementById(`tab-${t}`);
      const btn = document.getElementById(`nav-btn-${t}`);
      if (el) el.style.display = t === activeTab ? 'block' : 'none';
      if (btn) btn.classList.toggle('active', t === activeTab);
    });
    if (tab === 'portfolio' || tab === 'orders' || tab === 'profile') {
      refreshAccountAndPortfolio();
    }
    if (window.TradingzoneNative && typeof window.TradingzoneNative.setSystemBarTheme === 'function') {
      window.TradingzoneNative.setSystemBarTheme(true, '#FFFFFF');
    }
    notifyNativeScreenState();
    recordEligibleAction('switch_tab_' + tab);
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

  function updateChartCountdownUI() {
    if (!state.chartOpen) return;
    const pill = document.getElementById('chart-candle-countdown');
    if (!pill) return;

    const inst = state.activeInstrument;
    const exch = inst?.exchange || 'NSE';
    const tf = state.activeTimeframe || '5m';
    const intervalSec = getTimeframeIntervalSec(tf);
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const refTime = state.candles.length > 0 ? state.candles[state.candles.length - 1].time : null;

    let nextBoundarySec;
    if (tf === '1D') {
      // Next market close (15:30 IST for NSE/BSE, 23:55 IST for MCX) or next day boundary
      const istOffsetSec = 19800;
      const istNowSec = nowSec + istOffsetSec;
      const startOfIstDaySec = Math.floor(istNowSec / 86400) * 86400 - istOffsetSec;
      const closeOffsetSec = exch === 'MCX' ? (23 * 3600 + 55 * 60) : (15 * 3600 + 30 * 60);
      const todayCloseSec = startOfIstDaySec + closeOffsetSec;
      nextBoundarySec = nowSec < todayCloseSec ? todayCloseSec : startOfIstDaySec + 86400;
    } else {
      const currentBucketSec = computeCandleBucketSec(nowMs, tf, refTime);
      nextBoundarySec = currentBucketSec + intervalSec;
    }

    const remSec = Math.max(0, nextBoundarySec - nowSec);
    const timeStr = formatCountdownRemaining(remSec);

    const isLiveOrDemo = Boolean(
      state.feedHealth?.activeProvider?.status === 'LIVE' ||
      state.feedHealth?.activeProvider?.isSimulated ||
      state.feedHealth?.activeProvider?.source === 'DEMO'
    );
    const mktOpen = isLiveOrDemo || (state.feedHealth?.marketSession?.isMarketOpen !== undefined
      ? Boolean(state.feedHealth.marketSession.isMarketOpen) || isExchangeOpenNowIST(exch)
      : isExchangeOpenNowIST(exch));

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

    const lastInstTickMs = inst?.globalId ? (state.lastTickTimestamps[inst.globalId] || 0) : 0;
    const tickAgeMs = lastInstTickMs > 0 ? (nowMs - lastInstTickMs) : (state.lastAnyTickReceiveMs > 0 ? nowMs - state.lastAnyTickReceiveMs : 0);
    if (tickAgeMs > 20000) {
      pill.classList.add('state-warn');
      pill.textContent = `⚠ Stale Feed • ${timeStr}`;
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
      if (state.chartOpen) {
        updateChartCountdownUI();
      }
      if (!wsConn || wsConn.readyState !== WebSocket.OPEN) {
        connectRealtimeWebSocket();
      }
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
      }));
    } catch {}
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
          if (msg.type === 'AUTH_SUCCESS') {
            // Re-send desired subscriptions once authenticated so Pro-tier instruments are authorized
            sendWsSubscribe(collectDesiredSubscriptions());
          } else if (msg.type === 'ENTITLEMENT_UPDATED') {
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
            if (
              state.chartOpen &&
              state.activeInstrument &&
              state.activeInstrument.globalId === msg.globalId &&
              candleSeries &&
              state.candles.length > 0 &&
              !state.replayMode
            ) {
              const tf = state.activeTimeframe || '5m';
              const serverBar = msg.candles[tf];
              const lastBar = state.candles[state.candles.length - 1];
              if (serverBar && serverBar.time >= lastBar.time && Number(serverBar.close) > 0) {
                if (serverBar.time === lastBar.time) {
                  lastBar.high = Math.max(lastBar.high, serverBar.high);
                  lastBar.low = Math.min(lastBar.low, serverBar.low);
                  lastBar.close = serverBar.close;
                  candleSeries.update({ ...lastBar });
                } else {
                  const nextBar = {
                    time: serverBar.time,
                    open: serverBar.open,
                    high: serverBar.high,
                    low: serverBar.low,
                    close: serverBar.close,
                  };
                  state.candles.push(nextBar);
                  candleSeries.update(nextBar);
                }
                updateChartCountdownUI();
              }
            }
          } else if (msg.type === 'QUOTE_TICK' && msg.data) {
            handleIncomingQuoteTick(msg.data);
          }
        } catch { }
      };

      sock.onclose = () => {
        if (wsConn !== sock) return;
        wsConn = null;
        state.wsConnected = false;
        if (state.chartOpen) {
          updateChartCountdownUI();
        }
        scheduleWsReconnect();
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
  function reconcileCandleWithTick(quote, isInitialSnapshot = false) {
    if (!candleSeries || state.candles.length === 0 || state.replayMode) return;
    const ltp = Number(quote.ltp);
    if (!ltp || isNaN(ltp) || ltp <= 0) return;

    const tf = state.activeTimeframe || '5m';
    const lastBar = state.candles[state.candles.length - 1];
    const tickTimeMs = Number(quote.providerTimestamp || quote.receiveTimestamp || quote.timestamp || Date.now());
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

    if (bucketSec === lastBar.time || isInitialSnapshot) {
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
      const legendEl = document.getElementById('chart-ohlc-legend');
      if (legendEl) {
        legendEl.textContent =
          `O ${fmtNum(updatedBar.open)}  H ${fmtNum(updatedBar.high)}  L ${fmtNum(updatedBar.low)}  C ${fmtNum(updatedBar.close)}`;
      }
    } else if (bucketSec > lastBar.time) {
      // Genuine tick in a new timeframe interval -> start a new candle at the exact boundary
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
      const legendEl = document.getElementById('chart-ohlc-legend');
      if (legendEl) {
        legendEl.textContent =
          `O ${fmtNum(newBar.open)}  H ${fmtNum(newBar.high)}  L ${fmtNum(newBar.low)}  C ${fmtNum(newBar.close)}`;
      }
      const statsEl = document.getElementById('chart-candle-stats');
      if (statsEl) {
        statsEl.textContent = `${state.candles.length} bars`;
      }
      renderDrawingsSvgOverlay();
    }
  }

  function handleIncomingQuoteTick(quote) {
    if (!quote || !quote.globalId) return;
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
        el.textContent = fmtNum(currentQ.ltp);
      }
    });

    // Update DOM change % elements matching data-chg-id
    const { diff, pct, sign } = calcChange(currentQ);
    const cls = diff >= 0 ? 'val-pos-dark' : 'val-neg';
    document.querySelectorAll(`[data-chg-id="${quote.globalId}"]`).forEach((el) => {
      if (currentQ.ltp !== undefined && currentQ.ltp !== null && currentQ.ltp > 0) {
        el.textContent = `${sign}${pct.toFixed(2)}%`;
        el.className = `idx-chg ${cls}`;
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
            pos.currentPrice = currentPrice;
            pos.currentLtpINR = currentPrice;
            pos.unrealizedPnlINR = Math.round(diffPerUnit * Math.abs(pos.quantity) * 100) / 100;
            changed = true;
          }
        });
        return changed;
      };

      const c1 = updatePosList(state.positionsData.positions);
      const c2 = updatePosList(state.positionsData.activePositions);
      const c3 = updatePosList(state.positionsData.holdings);
      if (c1 || c2 || c3) {
        renderAccountBalancesUI();
        if (state.mainTab === 'portfolio') {
          renderPortfolioTab();
        }
      }
    }

    if (state.chartOpen && state.activeInstrument && state.activeInstrument.globalId === quote.globalId) {
      updateChartHeaderQuote(quote);
      reconcileCandleWithTick(quote, false);
      updateChartCountdownUI();
    }
  }

  // =========================================================================
  // TRADE JOURNAL & PERFORMANCE LOG
  // =========================================================================
  async function openTradeJournalModal() {
    const modal = document.getElementById('modal-journal');
    if (!modal) return;
    modal.classList.add('active');
    await loadJournalEntries();
  }

  async function loadJournalEntries() {
    const container = document.getElementById('journal-entries-container');
    if (!container) return;
    try {
      const res = await apiFetch('/api/v1/journal/entries');
      state.journalEntries = res.entries || [];
      if (state.journalEntries.length === 0) {
        container.innerHTML = `
          <div style="padding:32px;text-align:center;color:var(--text-on-white-secondary);">
            No journal entries yet. Log your trade rationale, lessons, or psychology notes above!
          </div>
        `;
        return;
      }
      container.innerHTML = state.journalEntries.map((e) => `
        <div class="journal-card">
          <div class="journal-header">
            <span class="strategy-tag-pill">${e.strategyTag || 'Untagged'}</span>
            <span style="font-size:11px;color:var(--text-on-white-secondary);">${new Date(Number(e.createdAt)).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</span>
          </div>
          ${e.referenceId ? `<div style="font-size:11px;font-weight:600;color:var(--text-on-white-secondary);margin-top:2px;">Ref: ${e.referenceId}</div>` : ''}
          <div class="journal-notes-text">${e.notes}</div>
        </div>
      `).join('');
    } catch (err) {
      container.innerHTML = `<div style="padding:20px;text-align:center;color:var(--negative-red);">Failed to load journal entries: ${err.message}</div>`;
    }
  }

  async function submitJournalEntry() {
    const tag = (document.getElementById('journal-input-tag').value || '').trim();
    const ref = (document.getElementById('journal-input-ref').value || '').trim();
    const notes = (document.getElementById('journal-input-notes').value || '').trim();
    if (!notes) return;

    try {
      await apiFetch('/api/v1/journal/notes', {
        method: 'POST',
        body: JSON.stringify({ strategyTag: tag || 'General Note', referenceId: ref, notes }),
      });
      document.getElementById('journal-input-notes').value = '';
      await loadJournalEntries();
    } catch (err) {
      alert('Error saving note: ' + err.message);
    }
  }

  function exportJournalCSV() {
    window.open('/api/v1/journal/export.csv', '_blank');
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
  // EXPORT PUBLIC API & BOOTSTRAP
  // =========================================================================
  window.TZApp = {
    toggleAuthMode,
    submitAuthForm,
    handleGoogleSignIn,
    signOut,
    switchMainTab,
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
    openIndicatorsModal,
    toggleIndicator,
    openDrawingsModal,
    selectDrawingTool,
    clearAllDrawings,
    openOrderTicket,
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
    togglePasswordVisibility,
    openServerConfigModal,
    closeServerConfigModal,
    applyServerPreset,
    testServerConnection,
    saveServerConfig,
  };

  window.addEventListener('DOMContentLoaded', () => {
    probeAndSelectServer();
    const saved = readSessionSecure();
    if (saved && saved.token && saved.user) {
      completeAuthenticatedSession(saved.token, saved.user, saved.account);
    } else {
      showTopScreen('screen-auth');
    }
  });
})();

