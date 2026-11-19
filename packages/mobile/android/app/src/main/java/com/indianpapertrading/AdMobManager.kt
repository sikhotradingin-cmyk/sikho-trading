package com.indianpapertrading

import android.app.Activity
import android.content.Context
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import com.google.android.gms.ads.appopen.AppOpenAd
import com.google.android.gms.ads.AdListener
import com.google.android.gms.ads.AdRequest
import com.google.android.gms.ads.AdSize
import com.google.android.gms.ads.AdView
import com.google.android.gms.ads.FullScreenContentCallback
import com.google.android.gms.ads.LoadAdError
import com.google.android.gms.ads.MobileAds
import com.google.android.gms.ads.RequestConfiguration
import com.google.android.gms.ads.interstitial.InterstitialAd
import com.google.android.gms.ads.interstitial.InterstitialAdLoadCallback
import com.google.android.ump.ConsentDebugSettings
import com.google.android.ump.ConsentInformation
import com.google.android.ump.ConsentRequestParameters
import com.google.android.ump.UserMessagingPlatform
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.roundToInt

/**
 * AdMobManager
 * Coordinates the Google Mobile Ads SDK (v23+) and UMP consent for Free-tier users.
 *
 * Ordering (important):
 *  1. Wait for verified FREE entitlement, refresh UMP, and evaluate cached consent.
 *  2. Initialize once when canRequestAds() permits; initialization itself may preload ads.
 *  3. Diagnose missing callbacks without overriding consent or interrupting authentication.
 *
 * Rules preserved:
 *  - PRO and unresolved (UNKNOWN) users make zero ad requests/preloads/displays.
 *  - Banners never cover auth, full-screen chart, option chain, order ticket or trading flows.
 *  - Interstitials never interrupt authentication, charts, option chains, order entry, purchases or
 *    position management, and never show while positions/pending orders exist.
 *  - Session cap 6 and rolling device-wide 24h cap 12 are preserved.
 *  - Free-user eligibility: 3 completed browsing actions AND >= 60s of *foreground* use since the
 *    session start / last impression, at a natural transition.
 */
class AdMobManager(
    private val activity: Activity,
    private val bannerContainer: FrameLayout,
    private val onBannerHeightChange: (Boolean, Int) -> Unit
) {
    companion object {
        private const val TAG = "AdMobManager"
        private const val PREFS_NAME = "tradingzone_admob_stats"
        private const val KEY_24H_IMPRESSIONS = "interstitial_impressions_24h"

        // 3 completed browsing actions + 60s foreground use (owner-requested cadence).
        private const val ACTIONS_REQUIRED_FOR_INTERSTITIAL = 3
        private const val MIN_FOREGROUND_MS = 60 * 1000L
        private const val TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000L
        private const val MAX_INTERSTITIALS_PER_SESSION = 6
        private const val MAX_INTERSTITIALS_PER_24H = 12
        private val BANNER_RETRY_DELAYS_MS = longArrayOf(15000L, 30000L, 60000L)
        private val INTERSTITIAL_RETRY_DELAYS_MS = longArrayOf(15000L, 30000L, 60000L)

        private val ALLOWED_BANNER_SCREENS = setOf("explore", "watchlists", "portfolio", "orders", "history", "profile")
    }

    private val isMobileAdsInitialized = AtomicBoolean(false)
    private val consentInformation: ConsentInformation by lazy {
        UserMessagingPlatform.getConsentInformation(activity)
    }

    private val prefs: SharedPreferences by lazy {
        activity.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

    private val retryHandler = android.os.Handler(android.os.Looper.getMainLooper())

    // ---- Consent / SDK diagnostics -------------------------------------------------
    private var mobileAdsInitStatus: String = "NOT_STARTED"
    private var mobileAdsInitDetail: String = ""
    private var mobileAdsInitializedAt: Long = 0L
    private var consentRequestStartedAt: Long = 0L
    private var consentCallbackAt: Long = 0L
    private var consentFormError: String? = null
    private var consentRequestError: String? = null
    private var consentStatusSnapshot: String = "NOT_REQUESTED"
    private var canRequestAdsSnapshot: Boolean = false
    private var lastPreloadBlockedReason: String = "INITIALIZING"

    // ---- Session / eligibility -----------------------------------------------------
    private val sessionStartTime = System.currentTimeMillis()
    private var foregroundAccumulatedMs: Long = 0L
    private var foregroundStartedAt: Long = android.os.SystemClock.elapsedRealtime()
    private var foregroundAtLastImpressionMs: Long = 0L
    private var lastInterstitialTime = 0L
    private var sessionInterstitialCount = 0
    private var eligibleActionCounter = 0
    private var lastEligibilityCheckReason = "INITIALIZING"
    private val recentEligibleActions = mutableListOf<String>()

    // ---- Retry / backoff -----------------------------------------------------------
    private var bannerRetryAttempt = 0
    private var interstitialRetryAttempt = 0
    private var nextBannerRetryAt = 0L
    private var nextInterstitialRetryAt = 0L

    // ---- User & screen state -------------------------------------------------------
    var currentUserTier: String = "UNKNOWN"
        private set
    var currentUserId: String = ""
        private set
    private var currentScreen: String = "screen-auth"
    private var isTradingWorkspaceOpen: Boolean = false
    private var hasOpenPositions: Boolean = false
    private var hasPendingOrders: Boolean = false

    // ---- Ad instances & telemetry --------------------------------------------------
    private var bannerAdView: AdView? = null
    private var bannerLoaded: Boolean = false
    private var bannerRequestCount: Int = 0
    private var lastBannerLoadError: String? = null
    private var lastBannerResponseId: String? = null
    private var lastBannerMeasuredWidth: Int = 0
    private var lastBannerMeasuredHeight: Int = 0
    private var interstitialAd: InterstitialAd? = null
    private var isInterstitialLoading = false
    private var interstitialRequestCount: Int = 0
    private var lastInterstitialLoadError: String? = null
    private var lastInterstitialResponseId: String? = null
    private var lastInterstitialShownAt: Long = 0L
    private var interstitialShownCount = 0
    private var interstitialDisplayCount = 0
    private var interstitialDismissalCount = 0
    private var interstitialDisplayError: String? = null

    private var appOpenAd: AppOpenAd? = null
    private var appOpenUnitId = BuildConfig.APP_OPEN_AD_UNIT_ID
    private var appOpenUnitGeneration = 0L
    private var appOpenLoading = false
    private var appOpenLoadedAt = 0L
    private var appOpenRequests = 0
    private var appOpenImpressions = 0
    private var appOpenDisplays = 0
    private var appOpenDismissals = 0
    private var appOpenError: String? = null
    private var appOpenResponseId: String? = null
    private var appOpenBlock = "INITIAL_USE_OR_NOT_READY"
    private var appOpenRetry = 0
    private var appOpenNextRetry = 0L
    private var fullscreenShowing = false
    private var userLeftAt = 0L
    private var userLeftSafely = false
    private var foregroundOpportunityUntil = 0L
    private var foregroundAuthentication = false
    private var sessionStatsRestored = false
    private var consentUpdateInFlight = false
    private var consentAttempts = 0
    private var entitlementGeneration = 0L
    private var bannerImpressionCount = 0

    // =============================================================================
    // Consent
    // =============================================================================

    fun initializeUmpConsent() {
        if (currentUserTier != "FREE" || consentUpdateInFlight) return
        if(consentCallbackAt>0L && consentRequestError==null && consentFormError==null && consentInformation.canRequestAds())return
        if(consentAttempts>=4){lastPreloadBlockedReason="UMP_RETRY_EXHAUSTED";return}
        if (consentRequestStartedAt > 0L && System.currentTimeMillis() - consentRequestStartedAt < 60000L) return
        consentAttempts++
        consentUpdateInFlight = true
        val consentGeneration = entitlementGeneration
        consentRequestStartedAt = System.currentTimeMillis()
        val paramsBuilder = ConsentRequestParameters.Builder()
        if (BuildConfig.DEBUG) {
            val debugSettings = ConsentDebugSettings.Builder(activity)
                .setDebugGeography(ConsentDebugSettings.DebugGeography.DEBUG_GEOGRAPHY_EEA)
                .build()
            paramsBuilder.setConsentDebugSettings(debugSettings)
        }
        val params = paramsBuilder.build()
        try {
            consentInformation.requestConsentInfoUpdate(
                activity,
                params,
                {
                    if (consentGeneration != entitlementGeneration) return@requestConsentInfoUpdate
                    if (currentUserTier != "FREE") { consentUpdateInFlight = false; return@requestConsentInfoUpdate }
                    consentCallbackAt = System.currentTimeMillis()
                    consentRequestError = null
                    consentStatusSnapshot = consentStatusName()
                    Log.i(TAG, "Consent info updated. status=$consentStatusSnapshot canRequestAds=${consentInformation.canRequestAds()}")
                    UserMessagingPlatform.loadAndShowConsentFormIfRequired(activity) { formError ->
                        if (consentGeneration != entitlementGeneration) return@loadAndShowConsentFormIfRequired
                        consentUpdateInFlight = false
                        consentCallbackAt = System.currentTimeMillis()
                        if (formError != null) {
                            consentFormError = "${formError.errorCode}: ${formError.message}"
                            Log.w(TAG, "Consent form error: $consentFormError")
                        } else {
                            consentFormError = null
                        }
                        consentStatusSnapshot = consentStatusName()
                        onConsentOrSdkReady("consent_flow_complete")
                    }
                },
                { requestConsentError ->
                    if (consentGeneration != entitlementGeneration) return@requestConsentInfoUpdate
                    consentUpdateInFlight = false
                    consentCallbackAt = System.currentTimeMillis()
                    consentRequestError = "${requestConsentError.errorCode}: ${requestConsentError.message}"
                    consentStatusSnapshot = consentStatusName()
                    Log.w(TAG, "Consent request failed: $consentRequestError")
                    // Do NOT bypass consent: only proceed when the SDK itself reports ads are allowed.
                    onConsentOrSdkReady("consent_request_failed")
                }
            )
        } catch (t: Throwable) {
            consentUpdateInFlight = false
            consentRequestError = "exception: ${t.javaClass.simpleName}: ${t.message}"
            Log.e(TAG, "UMP request threw: ${t.message}", t)
            onConsentOrSdkReady("consent_exception")
        }
        // Observe stalled callbacks without bypassing UMP or blocking navigation. Cached consent
        // can still permit initialization; otherwise diagnostics identify the actual blocked stage.
        retryHandler.postDelayed({
            if (consentGeneration == entitlementGeneration && consentUpdateInFlight) {
                consentUpdateInFlight = false
                consentRequestError = "UMP_CALLBACK_TIMEOUT: no completion after 30 seconds"
                onConsentOrSdkReady("consent_callback_timeout")
            }
        }, 30000L)
    }

    private fun consentStatusName(): String {
        return try {
            when (consentInformation.consentStatus) {
                ConsentInformation.ConsentStatus.NOT_REQUIRED -> "NOT_REQUIRED"
                ConsentInformation.ConsentStatus.OBTAINED -> "OBTAINED"
                ConsentInformation.ConsentStatus.REQUIRED -> "REQUIRED"
                ConsentInformation.ConsentStatus.UNKNOWN -> "UNKNOWN"
                else -> "UNRECOGNISED"
            }
        } catch (t: Throwable) {
            "ERROR:${t.javaClass.simpleName}"
        }
    }

    /** Called when consent and/or SDK state changes; re-evaluates banner + preload eligibility. */
    private fun onConsentOrSdkReady(reason: String) {
        canRequestAdsSnapshot = try {
            consentInformation.canRequestAds()
        } catch (t: Throwable) {
            false
        }
        Log.i(TAG, "Ad readiness evaluated ($reason): sdkInit=${isMobileAdsInitialized.get()} canRequestAds=$canRequestAdsSnapshot consent=$consentStatusSnapshot")
        activity.runOnUiThread {
            if (currentUserTier == "FREE" && canRequestAdsSnapshot) initMobileAdsSdk()
            updateBannerVisibility()
            preloadInterstitialIfEligible()
            preloadAppOpen()
        }
    }

    fun showPrivacyOptionsForm(onResult: (Boolean, String?) -> Unit) {
        activity.runOnUiThread {
            UserMessagingPlatform.showPrivacyOptionsForm(activity) { formError ->
                if (formError != null) {
                    Log.e(TAG, "Error displaying privacy options: ${formError.message}")
                    onResult(false, formError.message)
                } else {
                    onResult(true, null)
                }
                // Consent may have been granted or withdrawn in the privacy form: re-evaluate
                // ad readiness immediately so banners/preloads follow the new state.
                consentStatusSnapshot = consentStatusName()
                onConsentOrSdkReady("privacy_options_result")
            }
        }
    }

    // =============================================================================
    // SDK init
    // =============================================================================

    private fun initMobileAdsSdk() {
        if (currentUserTier != "FREE" || !consentInformation.canRequestAds()) return
        if (isMobileAdsInitialized.get() || mobileAdsInitStatus == "INITIALIZING") return
        mobileAdsInitStatus = "INITIALIZING"
        activity.runOnUiThread {
            try {
                if (BuildConfig.DEBUG) {
                    val testConfig = RequestConfiguration.Builder()
                        .setTestDeviceIds(listOf(AdRequest.DEVICE_ID_EMULATOR))
                        .build()
                    MobileAds.setRequestConfiguration(testConfig)
                }
                MobileAds.initialize(activity) { status ->
                    isMobileAdsInitialized.set(true)
                    mobileAdsInitializedAt = System.currentTimeMillis()
                    val adapters = status.adapterStatusMap.entries.joinToString("; ") { (name, state) ->
                        "$name=${state.initializationState}/${state.description}"
                    }
                    mobileAdsInitStatus = "INITIALIZED"
                    mobileAdsInitDetail = "adapters=[$adapters]"
                    Log.i(TAG, "Google Mobile Ads SDK initialized: $mobileAdsInitDetail")
                    onConsentOrSdkReady("sdk_initialized")
                }
            } catch (t: Throwable) {
                mobileAdsInitStatus = "INIT_FAILED"
                mobileAdsInitDetail = "${t.javaClass.simpleName}: ${t.message}"
                Log.e(TAG, "MobileAds.initialize failed: ${t.message}", t)
            }
        }
    }

    // =============================================================================
    // Tier / screen state
    // =============================================================================

    fun updateUserTier(tier: String, userId: String) {
        restoreFullscreenSession()
        val cleanTier = tier.uppercase().trim().ifEmpty { "UNKNOWN" }
        val cleanUserId = userId.trim()
        val accountChanged = cleanUserId != currentUserId
        if (accountChanged || cleanTier != currentUserTier) entitlementGeneration++
        if (cleanUserId != currentUserId) {
            eligibleActionCounter = 0
            recentEligibleActions.clear()
            bannerRetryAttempt = 0
            interstitialRetryAttempt = 0
            nextBannerRetryAt = 0L
            nextInterstitialRetryAt = 0L
            lastEligibilityCheckReason = "USER_SWITCHED"
            foregroundAtLastImpressionMs = currentForegroundMs()
            lastInterstitialTime = 0L
        }
        currentUserTier = cleanTier
        currentUserId = cleanUserId
        Log.i(TAG, "Ad entitlement tier=$currentUserTier accountChanged=$accountChanged generation=$entitlementGeneration")

        activity.runOnUiThread {
            if (accountChanged) {
                consentAttempts=0
                consentUpdateInFlight = false
                consentRequestStartedAt = 0L
                retryHandler.removeCallbacksAndMessages(null)
                destroyBanner()
                interstitialAd = null
                isInterstitialLoading = false
                appOpenAd = null
                appOpenLoading = false
            }
            when (currentUserTier) {
                "PRO", "UNKNOWN" -> {
                    consentUpdateInFlight = false
                    // PRO → zero ads. UNKNOWN → unresolved entitlement: no false premium, no ads.
                    retryHandler.removeCallbacksAndMessages(null)
                    destroyBanner()
                    interstitialAd = null
                    isInterstitialLoading = false
                    appOpenAd = null
                    appOpenLoading = false
                    bannerContainer.visibility = View.GONE
                    onBannerHeightChange(false, 0)
                    lastEligibilityCheckReason =
                        if (currentUserTier == "PRO") "REASON_PRO_TIER" else "REASON_TIER_UNKNOWN"
                }
                else -> {
                    if (currentUserTier != "FREE") return@runOnUiThread
                    initializeUmpConsent()
                    onConsentOrSdkReady("free_entitlement_resolved")
                    updateBannerVisibility()
                    preloadInterstitialIfEligible()
                }
            }
        }
    }

    fun updateScreenState(
        screen: String,
        tradingWorkspaceOpen: Boolean,
        openPositions: Boolean,
        pendingOrders: Boolean
    ) {
        currentScreen = screen.lowercase().trim()
        isTradingWorkspaceOpen = tradingWorkspaceOpen
        hasOpenPositions = openPositions
        hasPendingOrders = pendingOrders
        activity.runOnUiThread { updateBannerVisibility() }
    }

    // =============================================================================
    // Banner
    // =============================================================================

    private fun canShowAdsNow(): Boolean {
        canRequestAdsSnapshot = try {
            consentInformation.canRequestAds()
        } catch (t: Throwable) {
            false
        }
        return isMobileAdsInitialized.get() && canRequestAdsSnapshot
    }

    private fun updateBannerVisibility() {
        if (currentUserTier != "FREE") {
            hideBanner()
            if (currentUserTier == "PRO") lastPreloadBlockedReason = "REASON_PRO_TIER"
            return
        }
        if (!canShowAdsNow()) {
            hideBanner()
            lastPreloadBlockedReason = "REASON_SDK_OR_CONSENT_NOT_READY"
            return
        }
        val isScreenEligible = ALLOWED_BANNER_SCREENS.contains(currentScreen)
        val shouldShowBanner = isScreenEligible && !isTradingWorkspaceOpen
        if (shouldShowBanner) {
            showOrLoadBanner()
        } else {
            hideBanner()
            lastPreloadBlockedReason = if (!isScreenEligible) "REASON_SCREEN_NOT_ELIGIBLE($currentScreen)" else "REASON_TRADING_WORKSPACE_OPEN"
        }
    }

    private fun showOrLoadBanner() {
        bannerContainer.visibility = View.VISIBLE
        if (bannerAdView == null) {
            loadAnchoredAdaptiveBanner()
        } else {
            val adSize = bannerAdView?.adSize
            val heightDp = adSize?.height ?: 50
            onBannerHeightChange(true, heightDp)
        }
    }

    private fun hideBanner() {
        bannerContainer.visibility = View.GONE
        onBannerHeightChange(false, 0)
    }

    private fun destroyBanner() {
        try {
            bannerAdView?.destroy()
        } catch (e: Exception) {
            Log.w(TAG, "Error destroying banner: ${e.message}")
        }
        bannerAdView = null
        bannerLoaded = false
        bannerContainer.removeAllViews()
    }

    private fun loadAnchoredAdaptiveBanner() {
        if (currentUserTier != "FREE") return
        if (System.currentTimeMillis() < nextBannerRetryAt || bannerRetryAttempt > BANNER_RETRY_DELAYS_MS.size) return
        if (!canShowAdsNow()) {
            lastPreloadBlockedReason = "REASON_BANNER_SDK_OR_CONSENT_NOT_READY"
            return
        }
        val displayMetrics = activity.resources.displayMetrics
        val density = displayMetrics.density
        val adWidthPixels = displayMetrics.widthPixels
        val adWidthDp = (adWidthPixels / density).toInt()
        val adSize = AdSize.getCurrentOrientationAnchoredAdaptiveBannerAdSize(activity, adWidthDp)
        val heightPixels = adSize.getHeightInPixels(activity)
        val heightDp = adSize.height

        val adView = AdView(activity).apply {
            setAdSize(adSize)
            adUnitId = BuildConfig.BANNER_AD_UNIT_ID
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                heightPixels
            ).apply { gravity = Gravity.CENTER }
        }

        adView.adListener = object : AdListener() {
            override fun onAdLoaded() {
                if (bannerAdView !== adView) return
                if (currentUserTier != "FREE") {
                    Log.i(TAG, "Discarding banner load because tier is now $currentUserTier")
                    destroyBanner()
                    return
                }
                bannerLoaded = true
                lastBannerLoadError = null
                lastBannerResponseId = adView.responseInfo?.responseId
                lastBannerMeasuredWidth = adView.width
                lastBannerMeasuredHeight = adView.height
                bannerRetryAttempt = 0
                Log.i(TAG, "Anchored adaptive banner loaded ($adSize, ${adView.width}x${adView.height}px)")
                updateBannerVisibility()
            }

            override fun onAdImpression() {
                bannerImpressionCount++
                Log.i(TAG, "Banner impression responseId=${adView.responseInfo?.responseId}")
            }

            override fun onAdFailedToLoad(loadAdError: LoadAdError) {
                if (bannerAdView !== adView) return
                bannerLoaded = false
                lastBannerResponseId = loadAdError.responseInfo?.responseId
                lastBannerLoadError =
                    "code=${loadAdError.code}; domain=${loadAdError.domain}; message=${loadAdError.message}; responseId=${lastBannerResponseId ?: "n/a"}"
                Log.w(TAG, "Banner failed to load: $lastBannerLoadError")
                onBannerHeightChange(false, 0)
                destroyBanner()
                hideBanner()
                scheduleBannerRetry()
            }
        }

        bannerContainer.removeAllViews()
        bannerContainer.addView(adView)
        bannerAdView = adView
        bannerRequestCount++
        adView.loadAd(AdRequest.Builder().build())
    }

    private fun scheduleBannerRetry() {
        if (currentUserTier != "FREE") return
        if (bannerRetryAttempt >= BANNER_RETRY_DELAYS_MS.size) { bannerRetryAttempt++; return }
        val delay = BANNER_RETRY_DELAYS_MS[bannerRetryAttempt]
        bannerRetryAttempt++
        nextBannerRetryAt = System.currentTimeMillis() + delay
        Log.i(TAG, "Scheduling banner retry #$bannerRetryAttempt in ${delay / 1000}s")
        retryHandler.postDelayed({
            if (bannerAdView == null && currentUserTier == "FREE") {
                updateBannerVisibility()
            }
        }, delay)
    }

    // =============================================================================
    // Interstitial eligibility
    // =============================================================================

    fun recordEligibleAction(actionName: String) {
        if (currentUserTier == "PRO") {
            lastEligibilityCheckReason = "REASON_PRO_TIER"
            return
        }
        if (currentUserTier != "FREE") {
            lastEligibilityCheckReason = "REASON_TIER_UNKNOWN"
            return
        }
        if (!Regex("^(switch_tab_|switch_market_category_|filter_commodities_|filter_stocks_sector_|view_portfolio_)[A-Za-z0-9_-]+$").matches(actionName)) {
            lastEligibilityCheckReason = "REASON_NOT_COMPLETED_BROWSING_ACTION"
            return
        }
        eligibleActionCounter++
        val onboarding=prefs.getInt("completed_browsing",0)+1
        prefs.edit().putInt("completed_browsing",onboarding.coerceAtMost(3)).apply()
        preloadAppOpen()
        recentEligibleActions.add(actionName)
        if (recentEligibleActions.size > 12) recentEligibleActions.removeAt(0)
        Log.i(TAG, "Recorded completed action: $actionName (${eligibleActionCounter}/$ACTIONS_REQUIRED_FOR_INTERSTITIAL)")

        preloadInterstitialIfEligible()

        if (eligibleActionCounter >= ACTIONS_REQUIRED_FOR_INTERSTITIAL) {
            checkAndTriggerInterstitial(actionName)
        } else {
            lastEligibilityCheckReason = "REASON_INSUFFICIENT_ACTIONS($eligibleActionCounter/$ACTIONS_REQUIRED_FOR_INTERSTITIAL)"
        }
    }

    private fun currentForegroundMs(): Long {
        val live = if (foregroundStartedAt > 0) android.os.SystemClock.elapsedRealtime() - foregroundStartedAt else 0L
        return foregroundAccumulatedMs + live
    }

    private fun preloadInterstitialIfEligible() {
        if (currentUserTier != "FREE") return
        if (fullscreenShowing) return
        if (System.currentTimeMillis() < nextInterstitialRetryAt || interstitialRetryAttempt > INTERSTITIAL_RETRY_DELAYS_MS.size) {
            lastPreloadBlockedReason = "REASON_RETRY_BACKOFF_OR_EXHAUSTED"; return
        }
        if (!canShowAdsNow()) {
            lastPreloadBlockedReason = "REASON_PRELOAD_SDK_OR_CONSENT_NOT_READY"
            return
        }
        if (interstitialAd != null || isInterstitialLoading) return
        if (sessionInterstitialCount >= MAX_INTERSTITIALS_PER_SESSION) return
        if (getRecent24hImpressionsCount() >= MAX_INTERSTITIALS_PER_24H) return

        isInterstitialLoading = true
        val loadGeneration = entitlementGeneration
        interstitialRequestCount++
        InterstitialAd.load(
            activity,
            BuildConfig.INTERSTITIAL_AD_UNIT_ID,
            AdRequest.Builder().build(),
            object : InterstitialAdLoadCallback() {
                override fun onAdLoaded(ad: InterstitialAd) {
                    if (loadGeneration != entitlementGeneration) return
                    isInterstitialLoading = false
                    if (currentUserTier != "FREE") {
                        Log.i(TAG, "Discarding preloaded interstitial because tier is now $currentUserTier")
                        interstitialAd = null
                        return
                    }
                    interstitialAd = ad
                    lastInterstitialLoadError = null
                    lastInterstitialResponseId = ad.responseInfo.responseId
                    interstitialRetryAttempt = 0
                    Log.i(TAG, "Interstitial preloaded successfully.")
                    ad.fullScreenContentCallback = object : FullScreenContentCallback() {
                        override fun onAdDismissedFullScreenContent() {
                            fullscreenShowing=false
                            interstitialDismissalCount++
                            Log.i(TAG, "Interstitial dismissed by user.")
                            interstitialAd = null
                            preloadInterstitialIfEligible()
                        }

                        override fun onAdFailedToShowFullScreenContent(adError: com.google.android.gms.ads.AdError) {
                            fullscreenShowing=false
                            interstitialDisplayError = "code=${adError.code}; domain=${adError.domain}; message=${adError.message}"
                            Log.w(TAG, "Interstitial failed to show: ${adError.message}")
                            interstitialAd = null
                            preloadInterstitialIfEligible()
                        }

                        override fun onAdShowedFullScreenContent() {
                            interstitialDisplayCount++
                            interstitialDisplayError = null
                            Log.i(TAG, "Interstitial displayed on screen.")
                        }

                        override fun onAdImpression() {
                            recordInterstitialImpression()
                        }
                    }
                }

                override fun onAdFailedToLoad(loadAdError: LoadAdError) {
                    if (loadGeneration != entitlementGeneration) return
                    isInterstitialLoading = false
                    interstitialAd = null
                    lastInterstitialResponseId = loadAdError.responseInfo?.responseId
                    lastInterstitialLoadError =
                        "code=${loadAdError.code}; domain=${loadAdError.domain}; message=${loadAdError.message}; responseId=${lastInterstitialResponseId ?: "n/a"}"
                    Log.w(TAG, "Interstitial failed to preload: $lastInterstitialLoadError")
                    if (currentUserTier == "FREE" && interstitialRetryAttempt < INTERSTITIAL_RETRY_DELAYS_MS.size) {
                        val delay = INTERSTITIAL_RETRY_DELAYS_MS[interstitialRetryAttempt]
                        interstitialRetryAttempt++
                        nextInterstitialRetryAt = System.currentTimeMillis() + delay
                        Log.i(TAG, "Scheduling interstitial preload retry #$interstitialRetryAttempt in ${delay / 1000}s")
                        retryHandler.postDelayed({ preloadInterstitialIfEligible() }, delay)
                    } else { interstitialRetryAttempt++ }
                }
            }
        )
    }

    private fun checkAndTriggerInterstitial(triggerReason: String) {
        val now = System.currentTimeMillis()
        if(fullscreenShowing || now-prefs.getLong("last_fullscreen_impression",0L)<MIN_FOREGROUND_MS){lastEligibilityCheckReason="REASON_SHARED_FULLSCREEN_COOLDOWN";return}
        if (currentUserTier == "PRO") {
            lastEligibilityCheckReason = "REASON_PRO_TIER"; return
        }
        if (currentUserTier != "FREE") {
            lastEligibilityCheckReason = "REASON_TIER_UNKNOWN"; return
        }
        // Trading safety exclusions (never interrupt trading workspaces or open exposure).
        if (isTradingWorkspaceOpen) {
            lastEligibilityCheckReason = "REASON_TRADING_WORKSPACE_OPEN"; return
        }
        if (currentScreen == "screen-auth") {
            lastEligibilityCheckReason = "REASON_AUTH_SCREEN"; return
        }
        if (foregroundStartedAt == 0L || activity.isFinishing || activity.isDestroyed) {
            lastEligibilityCheckReason = "REASON_ACTIVITY_NOT_FOREGROUND"; return
        }
        if (currentScreen !in setOf("explore", "watchlists", "profile")) {
            lastEligibilityCheckReason = "REASON_NO_SAFE_TRANSITION($currentScreen)"; return
        }
        if (!canShowAdsNow()) {
            lastEligibilityCheckReason = "REASON_SDK_OR_CONSENT_NOT_READY"; return
        }
        if (hasOpenPositions) {
            lastEligibilityCheckReason = "REASON_OPEN_POSITIONS"; return
        }
        if (hasPendingOrders) {
            lastEligibilityCheckReason = "REASON_PENDING_ORDERS"; return
        }
        // Foreground-time eligibility (not wall clock: backgrounded time does not count).
        val foregroundMs = currentForegroundMs()
        if (foregroundMs < MIN_FOREGROUND_MS) {
            lastEligibilityCheckReason = "REASON_FOREGROUND_COOLDOWN(${foregroundMs / 1000}s/${MIN_FOREGROUND_MS / 1000}s)"
            return
        }
        if (foregroundMs - foregroundAtLastImpressionMs < MIN_FOREGROUND_MS) {
            val remaining = MIN_FOREGROUND_MS - (foregroundMs - foregroundAtLastImpressionMs)
            lastEligibilityCheckReason = "REASON_INTERVAL_COOLDOWN(${remaining / 1000}s remaining)"
            return
        }
        if (sessionInterstitialCount >= MAX_INTERSTITIALS_PER_SESSION) {
            lastEligibilityCheckReason = "REASON_SESSION_CAP_REACHED($MAX_INTERSTITIALS_PER_SESSION)"; return
        }
        val recent24h = getRecent24hImpressionsCount()
        if (recent24h >= MAX_INTERSTITIALS_PER_24H) {
            lastEligibilityCheckReason = "REASON_24H_CAP_REACHED($recent24h/$MAX_INTERSTITIALS_PER_24H)"; return
        }
        val adToShow = interstitialAd
        if (adToShow == null) {
            lastEligibilityCheckReason = "REASON_AD_NOT_LOADED"
            preloadInterstitialIfEligible()
            return
        }
        interstitialAd = null
        fullscreenShowing = true
        eligibleActionCounter = 0
        recentEligibleActions.clear()
        lastEligibilityCheckReason = "REASON_ELIGIBLE"
        lastInterstitialShownAt = now
        val shownAt = foregroundMs
        activity.runOnUiThread {
            Log.i(TAG, "Showing interstitial (trigger=$triggerReason foreground=${shownAt / 1000}s)")
            adToShow.show(activity)
        }
    }

    private fun recordInterstitialImpression(isAppOpen: Boolean = false) {
        val now = System.currentTimeMillis()
        lastInterstitialTime = now
        foregroundAtLastImpressionMs = currentForegroundMs()
        sessionInterstitialCount++
        if(!isAppOpen)interstitialShownCount++
        val timestamps = getValid24hTimestamps()
        timestamps.add(now)
        save24hTimestamps(timestamps)
        Log.i(
            TAG,
            "Interstitial impression recorded. session=$sessionInterstitialCount/$MAX_INTERSTITIALS_PER_SESSION " +
                "24h=${timestamps.size}/$MAX_INTERSTITIALS_PER_24H foreground=${foregroundAtLastImpressionMs / 1000}s"
        )
    }

    // =============================================================================
    // 24h device-wide cap
    // =============================================================================

    private fun getRecent24hImpressionsCount(): Int = getValid24hTimestamps().size

    private fun getValid24hTimestamps(): MutableList<Long> {
        val raw = prefs.getString(KEY_24H_IMPRESSIONS, "[]") ?: "[]"
        val list = mutableListOf<Long>()
        val now = System.currentTimeMillis()
        try {
            val arr = JSONArray(raw)
            for (i in 0 until arr.length()) {
                val ts = arr.getLong(i)
                if (now - ts < TWENTY_FOUR_HOURS_MS) list.add(ts)
            }
        } catch (e: Exception) {
            Log.w(TAG, "Error parsing 24h ad impressions: ${e.message}")
        }
        return list
    }

    private fun save24hTimestamps(timestamps: List<Long>) {
        val arr = JSONArray()
        timestamps.forEach { arr.put(it) }
        prefs.edit().putString(KEY_24H_IMPRESSIONS, arr.toString()).putLong("last_fullscreen_impression",System.currentTimeMillis()).putInt("fullscreen_session_count",sessionInterstitialCount).putLong("fullscreen_session_touch",System.currentTimeMillis()).commit()
    }

    // =============================================================================
    // Diagnostics
    // =============================================================================

    /** QA-only load/retry probe. Never alters consent, entitlement, eligibility or caps. */
    fun reloadTestAds(): Boolean {
        if (!BuildConfig.DEBUG || currentUserTier != "FREE" || consentUpdateInFlight || fullscreenShowing || !canShowAdsNow()) return false
        activity.runOnUiThread {
            if (currentUserTier != "FREE" || consentUpdateInFlight || fullscreenShowing || !canShowAdsNow()) return@runOnUiThread
            // Invalidate earlier loads before issuing the explicitly requested test loads.
            entitlementGeneration++
            retryHandler.removeCallbacksAndMessages(null)
            destroyBanner()
            interstitialAd = null
            isInterstitialLoading = false
            appOpenAd = null
            appOpenLoading = false
            bannerRetryAttempt = 0
            interstitialRetryAttempt = 0
            appOpenRetry = 0
            nextBannerRetryAt = 0L
            nextInterstitialRetryAt = 0L
            appOpenNextRetry = 0L
            Log.i(TAG, "QA manual reload: test units only; consent/entitlement/caps unchanged")
            updateBannerVisibility()
            preloadInterstitialIfEligible()
            preloadAppOpen()
        }
        return true
    }

    private fun manifestAdMobAppId(): String = try {
        val info = activity.packageManager.getApplicationInfo(
            activity.packageName,
            PackageManager.GET_META_DATA
        )
        info.metaData?.getString("com.google.android.gms.ads.APPLICATION_ID") ?: "UNKNOWN"
    } catch (t: Throwable) {
        "UNAVAILABLE"
    }

    fun getAdDiagnostics(): JSONObject {
        val now = System.currentTimeMillis()
        return JSONObject().apply {
            put("appOpenUnit",appOpenUnitId)
            put("appOpenRequests",appOpenRequests)
            put("appOpenLoaded",appOpenAd!=null)
            put("appOpenDisplays",appOpenDisplays)
            put("appOpenImpressions",appOpenImpressions)
            put("appOpenDismissals",appOpenDismissals)
            put("appOpenError",appOpenError)
            put("appOpenResponseId",appOpenResponseId)
            put("appOpenBlockedReason",appOpenBlock)
            put("sharedLastImpression",prefs.getLong("last_fullscreen_impression",0L))
            put("tier", currentUserTier)
            put("userId", currentUserId)
            put("isDebugBuild", BuildConfig.DEBUG)
            put("admobAppId", manifestAdMobAppId())
            put("bannerAdUnitId", BuildConfig.BANNER_AD_UNIT_ID)
            put("interstitialAdUnitId", BuildConfig.INTERSTITIAL_AD_UNIT_ID)
            put("usingOfficialTestAdUnits", BuildConfig.DEBUG)
            // Consent / SDK
            put("sdkInitialized", isMobileAdsInitialized.get())
            put("sdkInitStatus", mobileAdsInitStatus)
            put("sdkInitDetail", mobileAdsInitDetail)
            put("sdkInitializedAgeSec", if (mobileAdsInitializedAt > 0) (now - mobileAdsInitializedAt) / 1000 else -1)
            put("consentStatus", consentStatusSnapshot)
            put("canRequestAds", canRequestAdsSnapshot)
            put("consentRequestStartedAgoSec", if (consentRequestStartedAt > 0) (now - consentRequestStartedAt) / 1000 else -1)
            put("consentCallbackAgoSec", if (consentCallbackAt > 0) (now - consentCallbackAt) / 1000 else -1)
            put("consentFormError", consentFormError ?: JSONObject.NULL)
            put("consentRequestError", consentRequestError ?: JSONObject.NULL)
            // Banner
            put("bannerRequestCount", bannerRequestCount)
            put("bannerImpressionCount", bannerImpressionCount)
            put("bannerLoaded", bannerLoaded)
            put("bannerAttached", bannerAdView != null)
            put("bannerVisible", bannerContainer.visibility == View.VISIBLE)
            put("bannerContainerWidthPx", bannerContainer.width)
            put("bannerContainerHeightPx", bannerContainer.height)
            put("bannerMeasuredWidthPx", lastBannerMeasuredWidth)
            put("bannerMeasuredHeightPx", lastBannerMeasuredHeight)
            put("lastBannerLoadError", lastBannerLoadError ?: JSONObject.NULL)
            put("lastBannerResponseId", lastBannerResponseId ?: JSONObject.NULL)
            put("bannerRetryAttempt", bannerRetryAttempt)
            // Interstitial
            put("interstitialRequestCount", interstitialRequestCount)
            put("interstitialLoaded", interstitialAd != null)
            put("isInterstitialLoading", isInterstitialLoading)
            put("lastInterstitialLoadError", lastInterstitialLoadError ?: JSONObject.NULL)
            put("lastInterstitialResponseId", lastInterstitialResponseId ?: JSONObject.NULL)
            put("interstitialShownCount", interstitialShownCount)
            put("interstitialDisplayCount", interstitialDisplayCount)
            put("interstitialDismissalCount", interstitialDismissalCount)
            put("interstitialDisplayError", interstitialDisplayError ?: JSONObject.NULL)
            put("fullscreenShowing", fullscreenShowing)
            put("sessionInterstitialCount", sessionInterstitialCount)
            put("maxSessionInterstitials", MAX_INTERSTITIALS_PER_SESSION)
            put("recent24hCount", getRecent24hImpressionsCount())
            put("max24hInterstitials", MAX_INTERSTITIALS_PER_24H)
            put("lastInterstitialShownAgoSec", if (lastInterstitialShownAt > 0) (now - lastInterstitialShownAt) / 1000 else -1)
            // Eligibility
            put("eligibleActionCounter", eligibleActionCounter)
            put("actionsRequired", ACTIONS_REQUIRED_FOR_INTERSTITIAL)
            put("recentActions", JSONArray(recentEligibleActions))
            put("foregroundSec", currentForegroundMs() / 1000)
            put("foregroundAtLastImpressionSec", foregroundAtLastImpressionMs / 1000)
            put("minForegroundSec", MIN_FOREGROUND_MS / 1000)
            put("sessionDurationSec", (now - sessionStartTime) / 1000)
            put("isTradingWorkspaceOpen", isTradingWorkspaceOpen)
            put("hasOpenPositions", hasOpenPositions)
            put("hasPendingOrders", hasPendingOrders)
            put("currentScreen", currentScreen)
            put("lastEligibilityCheckReason", lastEligibilityCheckReason)
            put("lastPreloadBlockedReason", lastPreloadBlockedReason)
        }
    }

    // =============================================================================
    // Lifecycle
    // =============================================================================

    private fun restoreFullscreenSession(){
        if(sessionStatsRestored)return
        sessionStatsRestored=true
        val now=System.currentTimeMillis()
        if(now-prefs.getLong("fullscreen_session_touch",0L)<30*60*1000L)sessionInterstitialCount=prefs.getInt("fullscreen_session_count",0)
        prefs.edit().putLong("fullscreen_session_touch",now).putInt("fullscreen_session_count",sessionInterstitialCount).apply()
    }
    fun noteUserLeaving(){
        userLeftAt=android.os.SystemClock.elapsedRealtime()
        userLeftSafely=!fullscreenShowing && currentUserTier=="FREE" && currentScreen in setOf("explore","watchlists","profile") && !isTradingWorkspaceOpen && !hasOpenPositions && !hasPendingOrders && !consentUpdateInFlight
    }
    fun configureAppOpenUnit(value:String){
        if(BuildConfig.DEBUG)return // Debug always uses Google's official App Open test format.
        val unit=value.trim()
        if(unit.isNotEmpty() && (!Regex("^ca-app-pub-[0-9]+/[0-9]+$").matches(unit) || unit.substringBefore('/')!=manifestAdMobAppId().substringBefore('~') || unit==BuildConfig.BANNER_AD_UNIT_ID || unit==BuildConfig.INTERSTITIAL_AD_UNIT_ID)){
            appOpenError="INVALID_APP_OPEN_CONFIGURATION";return
        }
        if(unit==appOpenUnitId)return
        appOpenUnitGeneration++;appOpenUnitId=unit;appOpenAd=null;appOpenLoading=false;appOpenRetry=0;appOpenNextRetry=0L
        preloadAppOpen()
    }
    private fun preloadAppOpen(){
        if(currentUserTier!="FREE" || fullscreenShowing || !canShowAdsNow() || appOpenLoading || appOpenAd!=null)return
        if(appOpenUnitId.isBlank()){appOpenBlock="PRODUCTION_APP_OPEN_UNIT_NOT_CONFIGURED";return}
        if(prefs.getInt("completed_browsing",0)<3){appOpenBlock="INITIAL_USE_ONBOARDING";return}
        if(System.currentTimeMillis()<appOpenNextRetry || appOpenRetry>3 || foregroundStartedAt==0L)return
        if(sessionInterstitialCount>=MAX_INTERSTITIALS_PER_SESSION || getRecent24hImpressionsCount()>=MAX_INTERSTITIALS_PER_24H)return
        appOpenLoading=true;appOpenRequests++
        val generation=entitlementGeneration
        val unitGeneration=appOpenUnitGeneration
        Log.i(TAG,"AppOpen load request unit="+appOpenUnitId)
        AppOpenAd.load(activity,appOpenUnitId,AdRequest.Builder().build(),object:AppOpenAd.AppOpenAdLoadCallback(){
            override fun onAdLoaded(ad:AppOpenAd){
                if(generation!=entitlementGeneration || unitGeneration!=appOpenUnitGeneration || currentUserTier!="FREE")return
                appOpenLoading=false;appOpenAd=ad;appOpenLoadedAt=System.currentTimeMillis();appOpenRetry=0;appOpenError=null;appOpenResponseId=ad.responseInfo?.responseId
                Log.i(TAG,"AppOpen loaded responseId="+appOpenResponseId)
                // Never show from a late load callback. Only a future eligible foreground may show.
            }
            override fun onAdFailedToLoad(error:LoadAdError){
                if(generation!=entitlementGeneration || unitGeneration!=appOpenUnitGeneration)return
                appOpenLoading=false;appOpenError="code="+error.code+" domain="+error.domain+" message="+error.message+" responseId="+error.responseInfo?.responseId
                Log.w(TAG,"AppOpen load failed "+appOpenError)
                if(appOpenRetry<3){val delay=longArrayOf(15000L,30000L,60000L)[appOpenRetry++];appOpenNextRetry=System.currentTimeMillis()+delay;retryHandler.postDelayed({preloadAppOpen()},delay)}else appOpenRetry++
            }
        })
    }
    private fun tryShowAppOpen(externalAuthentication:Boolean){
        val left=userLeftAt;val safe=userLeftSafely;userLeftAt=0L;userLeftSafely=false
        val now=System.currentTimeMillis()
        val blocked=when{
            externalAuthentication -> "AUTHENTICATION_RETURN"
            left==0L || android.os.SystemClock.elapsedRealtime()-left<30000L -> "NOT_A_NEW_FOREGROUND_VISIT"
            !safe || currentUserTier!="FREE" || consentUpdateInFlight || isTradingWorkspaceOpen || hasOpenPositions || hasPendingOrders -> "UNSAFE_OR_AD_FREE"
            activity.isFinishing || activity.isDestroyed || foregroundStartedAt==0L -> "ACTIVITY_NOT_READY"
            (activity.getSystemService(Context.KEYGUARD_SERVICE) as android.app.KeyguardManager).isKeyguardLocked -> "DEVICE_LOCKED"
            fullscreenShowing || now-prefs.getLong("last_fullscreen_impression",0L)<MIN_FOREGROUND_MS -> "SHARED_FULLSCREEN_COOLDOWN"
            sessionInterstitialCount>=MAX_INTERSTITIALS_PER_SESSION || getRecent24hImpressionsCount()>=MAX_INTERSTITIALS_PER_24H -> "SHARED_FULLSCREEN_CAP"
            !canShowAdsNow() -> "CONSENT_OR_SDK_NOT_READY"
            appOpenAd==null -> "NOT_LOADED_SKIP"
            now-appOpenLoadedAt>=4*60*60*1000L -> "EXPIRED_SKIP"
            else -> "ELIGIBLE"
        }
        appOpenBlock=blocked;Log.i(TAG,"AppOpen foreground "+blocked)
        if(blocked!="ELIGIBLE"){if(blocked=="EXPIRED_SKIP")appOpenAd=null;preloadAppOpen();return}
        val ad=appOpenAd ?: return;appOpenAd=null;fullscreenShowing=true
        ad.fullScreenContentCallback=object:FullScreenContentCallback(){
            override fun onAdShowedFullScreenContent(){appOpenDisplays++;Log.i(TAG,"AppOpen displayed")}
            override fun onAdImpression(){appOpenImpressions++;recordInterstitialImpression(true);Log.i(TAG,"AppOpen impression responseId="+appOpenResponseId)}
            override fun onAdDismissedFullScreenContent(){fullscreenShowing=false;appOpenDismissals++;Log.i(TAG,"AppOpen dismissed");preloadAppOpen()}
            override fun onAdFailedToShowFullScreenContent(error:com.google.android.gms.ads.AdError){fullscreenShowing=false;appOpenError="display code="+error.code+" domain="+error.domain+" message="+error.message;Log.w(TAG,"AppOpen "+appOpenError);preloadAppOpen()}
        }
        // The SDK shows immediately from the foreground transition; no artificial loading delay.
        ad.show(activity)
    }

    fun onResume(externalAuthentication: Boolean = false) {
        if (foregroundStartedAt == 0L) foregroundStartedAt = android.os.SystemClock.elapsedRealtime()
        foregroundAuthentication=externalAuthentication
        foregroundOpportunityUntil=if(userLeftAt>0L)android.os.SystemClock.elapsedRealtime()+2000L else 0L
        // A resumed Activity is the SDK's display host; window focus can arrive late on
        // slower phones. Decide here, before the user can navigate, rather than queueing
        // an ad behind a later focus callback (or an account-picker/dialog return).
        onForegroundWindowReady()
        bannerAdView?.resume()
        updateBannerVisibility()
    }

    fun onForegroundWindowReady(){
        if(foregroundOpportunityUntil==0L)return
        val timely=android.os.SystemClock.elapsedRealtime()<=foregroundOpportunityUntil
        foregroundOpportunityUntil=0L
        if(timely)tryShowAppOpen(foregroundAuthentication)else{userLeftAt=0L;userLeftSafely=false;appOpenBlock="FOREGROUND_WINDOW_PASSED_SKIP"}
    }
    fun cancelForegroundOpportunity(){foregroundOpportunityUntil=0L;userLeftAt=0L;userLeftSafely=false}

    fun onPause() {
        if(sessionStatsRestored)prefs.edit().putLong("fullscreen_session_touch",System.currentTimeMillis()).putInt("fullscreen_session_count",sessionInterstitialCount).apply()
        if (foregroundStartedAt > 0) {
            foregroundAccumulatedMs += android.os.SystemClock.elapsedRealtime() - foregroundStartedAt
            foregroundStartedAt = 0L
        }
        bannerAdView?.pause()
    }

    fun onDestroy() {
        retryHandler.removeCallbacksAndMessages(null)
        destroyBanner()
        interstitialAd = null
        appOpenAd=null
    }
}
