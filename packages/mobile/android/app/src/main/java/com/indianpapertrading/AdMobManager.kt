package com.indianpapertrading

import android.app.Activity
import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
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
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.roundToInt

/**
 * AdMobManager
 * Coordinates Native Google Mobile Ads SDK (v23+) and UMP Consent handling.
 *
 * Rules:
 * 1. Native Kotlin integration, separate test IDs (debug) and production IDs (release).
 * 2. Anchored adaptive banner reserved above bottom nav for Free users on Explore, Watchlists,
 *    Portfolio, closed-order history, and Profile. Never overlays interactive content.
 * 3. Banners hidden on auth/PIN, full-screen chart, option-chain, and order sheet.
 *    Pro users get ZERO ads and ZERO ad requests.
 * 4. Interstitials: after 5 completed eligible browsing/review actions, >= 5 min from session start
 *    and last interstitial, max 3/session, max 6/24h. Never during trading, chart interaction,
 *    or when open positions/pending orders exist.
 * 5. Preloaded asynchronously; no waiting screen on failure; no catch-up ads.
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

        private const val ACTIONS_REQUIRED_FOR_INTERSTITIAL = 4
        private const val SIXTY_SECONDS_MS = 60 * 1000L
        private const val TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000L
        private const val MAX_INTERSTITIALS_PER_SESSION = 6
        private const val MAX_INTERSTITIALS_PER_24H = 12

        private val ALLOWED_BANNER_SCREENS = setOf("explore", "watchlists", "portfolio", "orders", "profile")
    }

    private val isMobileAdsInitialized = AtomicBoolean(false)
    private val consentInformation: ConsentInformation by lazy {
        UserMessagingPlatform.getConsentInformation(activity)
    }

    private val prefs: SharedPreferences by lazy {
        activity.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    }

    // Session State
    private val sessionStartTime = System.currentTimeMillis()
    private var lastInterstitialTime = 0L
    private var sessionInterstitialCount = 0
    private var eligibleActionCounter = 0
    private var lastEligibilityCheckReason = "INITIALIZING"

    // Retry and Backoff State
    private var retryAttempt = 0
    private val retryHandler = android.os.Handler(android.os.Looper.getMainLooper())

    // User & Screen State
    var currentUserTier: String = "UNKNOWN"
        private set
    var currentUserId: String = ""
        private set
    private var currentScreen: String = "screen-auth"
    private var isTradingWorkspaceOpen: Boolean = false
    private var hasOpenPositions: Boolean = false
    private var hasPendingOrders: Boolean = false

    // Ad Instances
    private var bannerAdView: AdView? = null
    private var interstitialAd: InterstitialAd? = null
    private var isInterstitialLoading = false

    init {
        initializeUmpConsent()
    }

    /**
     * Step 1: User Messaging Platform (UMP) Consent Flow
     */
    fun initializeUmpConsent() {
        val paramsBuilder = ConsentRequestParameters.Builder()

        if (BuildConfig.DEBUG) {
            val debugSettings = ConsentDebugSettings.Builder(activity)
                .setDebugGeography(ConsentDebugSettings.DebugGeography.DEBUG_GEOGRAPHY_EEA)
                .build()
            paramsBuilder.setConsentDebugSettings(debugSettings)
        }

        val params = paramsBuilder.build()

        consentInformation.requestConsentInfoUpdate(
            activity,
            params,
            {
                UserMessagingPlatform.loadAndShowConsentFormIfRequired(activity) { formError ->
                    if (formError != null) {
                        Log.w(TAG, "Consent form error: ${formError.errorCode}: ${formError.message}")
                    }
                    if (consentInformation.canRequestAds()) {
                        initMobileAdsSdk()
                    }
                }
            },
            { requestConsentError ->
                Log.w(TAG, "Consent request failed: ${requestConsentError.errorCode}: ${requestConsentError.message}")
                if (consentInformation.canRequestAds()) {
                    initMobileAdsSdk()
                }
            }
        )
    }

    /**
     * Privacy Options entry point for Google UMP compliance (e.g. from Profile tab)
     */
    fun showPrivacyOptionsForm(onResult: (Boolean, String?) -> Unit) {
        activity.runOnUiThread {
            UserMessagingPlatform.showPrivacyOptionsForm(activity) { formError ->
                if (formError != null) {
                    Log.e(TAG, "Error displaying privacy options: ${formError.message}")
                    onResult(false, formError.message)
                } else {
                    onResult(true, null)
                }
            }
        }
    }

    /**
     * Initialize Mobile Ads SDK once consent allows ad requests
     */
    private fun initMobileAdsSdk() {
        if (isMobileAdsInitialized.getAndSet(true)) return

        activity.runOnUiThread {
            MobileAds.initialize(activity) { status ->
                Log.i(TAG, "Google Mobile Ads SDK Initialized: $status")
                // Once initialized, evaluate if banner or interstitial preload is needed
                updateBannerVisibility()
                preloadInterstitialIfEligible()
            }
        }
    }

    /**
     * Update user tier. Pro users get ZERO ads and ZERO ad requests.
     */
    fun updateUserTier(tier: String, userId: String) {
        currentUserTier = tier.uppercase().trim()
        currentUserId = userId
        Log.i(TAG, "Updated user tier to $currentUserTier for user $currentUserId")

        activity.runOnUiThread {
            if (currentUserTier == "PRO") {
                destroyBanner()
                interstitialAd = null
                bannerContainer.visibility = View.GONE
                onBannerHeightChange(false, 0)
            } else {
                updateBannerVisibility()
                preloadInterstitialIfEligible()
            }
        }
    }

    /**
     * Update app screen and trading state
     */
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

        activity.runOnUiThread {
            updateBannerVisibility()
        }
    }

    /**
     * Evaluates whether the adaptive banner should be displayed.
     */
    private fun updateBannerVisibility() {
        if (currentUserTier != "FREE") {
            hideBanner()
            return
        }

        if (!consentInformation.canRequestAds() || !isMobileAdsInitialized.get()) {
            hideBanner()
            return
        }

        // Banners hidden on authentication/PIN screens, full-screen chart, option-chain, and order sheet
        val isScreenEligible = ALLOWED_BANNER_SCREENS.contains(currentScreen)
        val shouldShowBanner = isScreenEligible && !isTradingWorkspaceOpen

        if (shouldShowBanner) {
            showOrLoadBanner()
        } else {
            hideBanner()
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
        bannerContainer.removeAllViews()
    }

    /**
     * Loads an anchored adaptive banner matching screen width
     */
    private fun loadAnchoredAdaptiveBanner() {
        if (currentUserTier != "FREE") return
        if (!consentInformation.canRequestAds()) return

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
            ).apply {
                gravity = Gravity.CENTER
            }
        }

        adView.adListener = object : AdListener() {
            override fun onAdLoaded() {
                Log.i(TAG, "Anchored Adaptive Banner loaded successfully ($adSize)")
                onBannerHeightChange(true, heightDp)
            }

            override fun onAdFailedToLoad(loadAdError: LoadAdError) {
                Log.w(TAG, "Banner failed to load: ${loadAdError.code} - ${loadAdError.message}")
                onBannerHeightChange(false, 0)
            }
        }

        bannerContainer.removeAllViews()
        bannerContainer.addView(adView)
        bannerAdView = adView

        val adRequest = AdRequest.Builder().build()
        adView.loadAd(adRequest)
    }

    /**
     * Record an eligible browsing / review action from the web frontend
     */
    fun recordEligibleAction(actionName: String) {
        if (currentUserTier == "PRO") {
            lastEligibilityCheckReason = "REASON_PRO_TIER"
            return
        }
        if (currentUserTier != "FREE") {
            lastEligibilityCheckReason = "REASON_TIER_UNKNOWN"
            return
        }

        eligibleActionCounter++
        Log.i(TAG, "Recorded eligible action: $actionName (Total count: $eligibleActionCounter/$ACTIONS_REQUIRED_FOR_INTERSTITIAL)")

        preloadInterstitialIfEligible()

        if (eligibleActionCounter >= ACTIONS_REQUIRED_FOR_INTERSTITIAL) {
            checkAndTriggerInterstitial(actionName)
        } else {
            lastEligibilityCheckReason = "REASON_INSUFFICIENT_ACTIONS ($eligibleActionCounter/$ACTIONS_REQUIRED_FOR_INTERSTITIAL)"
        }
    }

    /**
     * Preload interstitial asynchronously in the background.
     * No waiting screen on failure, no catch-up ads.
     */
    private fun preloadInterstitialIfEligible() {
        if (currentUserTier != "FREE") return
        if (!consentInformation.canRequestAds() || !isMobileAdsInitialized.get()) return
        if (interstitialAd != null || isInterstitialLoading) return

        // Check if frequency limits have already been exhausted
        if (sessionInterstitialCount >= MAX_INTERSTITIALS_PER_SESSION) return
        if (getRecent24hImpressionsCount() >= MAX_INTERSTITIALS_PER_24H) return

        isInterstitialLoading = true
        val adRequest = AdRequest.Builder().build()

        InterstitialAd.load(
            activity,
            BuildConfig.INTERSTITIAL_AD_UNIT_ID,
            adRequest,
            object : InterstitialAdLoadCallback() {
                override fun onAdLoaded(ad: InterstitialAd) {
                    isInterstitialLoading = false
                    interstitialAd = ad
                    retryAttempt = 0
                    Log.i(TAG, "Interstitial ad preloaded successfully.")

                    ad.fullScreenContentCallback = object : FullScreenContentCallback() {
                        override fun onAdDismissedFullScreenContent() {
                            Log.i(TAG, "Interstitial dismissed by user.")
                            interstitialAd = null
                            // Preload next interstitial asynchronously
                            preloadInterstitialIfEligible()
                        }

                        override fun onAdFailedToShowFullScreenContent(adError: com.google.android.gms.ads.AdError) {
                            Log.w(TAG, "Interstitial failed to show: ${adError.message}")
                            interstitialAd = null
                            preloadInterstitialIfEligible()
                        }

                        override fun onAdShowedFullScreenContent() {
                            Log.i(TAG, "Interstitial displayed on screen.")
                            recordInterstitialImpression()
                        }
                    }
                }

                override fun onAdFailedToLoad(loadAdError: LoadAdError) {
                    isInterstitialLoading = false
                    interstitialAd = null
                    Log.w(TAG, "Interstitial failed to preload: ${loadAdError.code} - ${loadAdError.message}")
                    if (currentUserTier == "FREE" && retryAttempt < 3) {
                        val delays = listOf(15000L, 30000L, 60000L)
                        val delay = delays.getOrElse(retryAttempt) { 60000L }
                        retryAttempt++
                        Log.i(TAG, "Scheduling interstitial preload retry #$retryAttempt in ${delay / 1000}s")
                        retryHandler.postDelayed({
                            preloadInterstitialIfEligible()
                        }, delay)
                    }
                }
            }
        )
    }

    /**
     * Check timing, session, rolling 24h, and trading-safety constraints before presenting interstitial.
     */
    private fun checkAndTriggerInterstitial(triggerReason: String) {
        val now = System.currentTimeMillis()

        // 1. Pro users get ZERO ads
        if (currentUserTier == "PRO") {
            lastEligibilityCheckReason = "REASON_PRO_TIER"
            return
        }
        if (currentUserTier != "FREE") {
            lastEligibilityCheckReason = "REASON_TIER_UNKNOWN"
            return
        }

        // 2. Strict trading safety checks: Never during chart interaction, auth,
        // or while open positions / pending orders exist
        if (isTradingWorkspaceOpen) {
            lastEligibilityCheckReason = "REASON_TRADING_WORKSPACE_OPEN"
            Log.d(TAG, "Interstitial blocked: trading workspace is open.")
            return
        }
        if (currentScreen == "screen-auth" || currentScreen == "screen-pin") {
            lastEligibilityCheckReason = "REASON_AUTH_OR_PIN_SCREEN"
            Log.d(TAG, "Interstitial blocked: on auth/PIN screen.")
            return
        }
        if (hasOpenPositions) {
            lastEligibilityCheckReason = "REASON_OPEN_POSITIONS"
            Log.d(TAG, "Interstitial blocked: active open positions exist.")
            return
        }
        if (hasPendingOrders) {
            lastEligibilityCheckReason = "REASON_PENDING_ORDERS"
            Log.d(TAG, "Interstitial blocked: active pending orders exist.")
            return
        }

        // 3. Time elapsed >= 60s since session start
        val timeSinceSessionStart = now - sessionStartTime
        if (timeSinceSessionStart < SIXTY_SECONDS_MS) {
            val remSec = (SIXTY_SECONDS_MS - timeSinceSessionStart) / 1000
            lastEligibilityCheckReason = "REASON_SESSION_COOLDOWN ($remSec s remaining)"
            Log.d(TAG, "Interstitial blocked: session start cooldown active ($remSec s remaining).")
            return
        }

        // 4. Time elapsed >= 60s since last interstitial
        val timeSinceLastAd = now - lastInterstitialTime
        if (lastInterstitialTime > 0 && timeSinceLastAd < SIXTY_SECONDS_MS) {
            val remSec = (SIXTY_SECONDS_MS - timeSinceLastAd) / 1000
            lastEligibilityCheckReason = "REASON_INTERVAL_COOLDOWN ($remSec s remaining)"
            Log.d(TAG, "Interstitial blocked: interval cooldown active ($remSec s remaining).")
            return
        }

        // 5. Max 6 per session
        if (sessionInterstitialCount >= MAX_INTERSTITIALS_PER_SESSION) {
            lastEligibilityCheckReason = "REASON_SESSION_CAP_REACHED ($MAX_INTERSTITIALS_PER_SESSION)"
            Log.d(TAG, "Interstitial blocked: session cap of $MAX_INTERSTITIALS_PER_SESSION reached.")
            return
        }

        // 6. Max 12 per rolling 24 hours
        val recent24hCount = getRecent24hImpressionsCount()
        if (recent24hCount >= MAX_INTERSTITIALS_PER_24H) {
            lastEligibilityCheckReason = "REASON_24H_CAP_REACHED ($MAX_INTERSTITIALS_PER_24H)"
            Log.d(TAG, "Interstitial blocked: rolling 24h cap of $MAX_INTERSTITIALS_PER_24H reached ($recent24hCount shown).")
            return
        }

        // 7. Verify preloaded ad is ready
        val adToShow = interstitialAd
        if (adToShow == null) {
            lastEligibilityCheckReason = "REASON_AD_NOT_LOADED"
            Log.d(TAG, "Interstitial not ready yet. Preload in progress.")
            preloadInterstitialIfEligible()
            return
        }

        // All constraints passed! Reset action counter and display interstitial at genuine break
        eligibleActionCounter = 0
        lastEligibilityCheckReason = "REASON_ELIGIBLE"
        activity.runOnUiThread {
            Log.i(TAG, "Showing Interstitial Ad triggered by: $triggerReason")
            adToShow.show(activity)
        }
    }

    private fun recordInterstitialImpression() {
        val now = System.currentTimeMillis()
        lastInterstitialTime = now
        sessionInterstitialCount++

        val cleanTimestamps = getValid24hTimestamps()
        cleanTimestamps.add(now)
        save24hTimestamps(cleanTimestamps)

        Log.i(TAG, "Recorded interstitial impression. Session: $sessionInterstitialCount/$MAX_INTERSTITIALS_PER_SESSION, 24h: ${cleanTimestamps.size}/$MAX_INTERSTITIALS_PER_24H")
    }

    private fun getRecent24hImpressionsCount(): Int {
        return getValid24hTimestamps().size
    }

    private fun getValid24hTimestamps(): MutableList<Long> {
        val raw = prefs.getString(KEY_24H_IMPRESSIONS, "[]") ?: "[]"
        val list = mutableListOf<Long>()
        val now = System.currentTimeMillis()
        try {
            val arr = JSONArray(raw)
            for (i in 0 until arr.length()) {
                val ts = arr.getLong(i)
                if (now - ts < TWENTY_FOUR_HOURS_MS) {
                    list.add(ts)
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Error parsing 24h ad impressions: ${e.message}")
        }
        return list
    }

    private fun save24hTimestamps(timestamps: List<Long>) {
        val arr = JSONArray()
        timestamps.forEach { arr.put(it) }
        prefs.edit().putString(KEY_24H_IMPRESSIONS, arr.toString()).apply()
    }

    fun getAdDiagnostics(): org.json.JSONObject {
        val now = System.currentTimeMillis()
        val timeSinceSessionStart = (now - sessionStartTime) / 1000
        val timeSinceLastAd = if (lastInterstitialTime > 0) (now - lastInterstitialTime) / 1000 else -1
        val recent24hCount = getRecent24hImpressionsCount()
        return org.json.JSONObject().apply {
            put("tier", currentUserTier)
            put("sessionInterstitialCount", sessionInterstitialCount)
            put("maxSessionInterstitials", MAX_INTERSTITIALS_PER_SESSION)
            put("recent24hCount", recent24hCount)
            put("max24hInterstitials", MAX_INTERSTITIALS_PER_24H)
            put("eligibleActionCounter", eligibleActionCounter)
            put("actionsRequired", ACTIONS_REQUIRED_FOR_INTERSTITIAL)
            put("sessionDurationSec", timeSinceSessionStart)
            put("secondsSinceLastInterstitial", timeSinceLastAd)
            put("isTradingWorkspaceOpen", isTradingWorkspaceOpen)
            put("hasOpenPositions", hasOpenPositions)
            put("hasPendingOrders", hasPendingOrders)
            put("currentScreen", currentScreen)
            put("bannerVisible", bannerContainer.visibility == View.VISIBLE)
            put("interstitialLoaded", interstitialAd != null)
            put("isInterstitialLoading", isInterstitialLoading)
            put("lastEligibilityCheckReason", lastEligibilityCheckReason)
        }
    }

    fun onResume() {
        bannerAdView?.resume()
        updateBannerVisibility()
    }

    fun onPause() {
        bannerAdView?.pause()
    }

    fun onDestroy() {
        retryHandler.removeCallbacksAndMessages(null)
        destroyBanner()
        interstitialAd = null
    }
}

