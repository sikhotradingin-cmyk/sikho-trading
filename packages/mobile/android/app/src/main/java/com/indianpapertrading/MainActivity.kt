package com.indianpapertrading

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.credentials.ClearCredentialStateRequest
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.GetCredentialInterruptedException
import androidx.credentials.exceptions.GetCredentialProviderConfigurationException
import androidx.credentials.exceptions.GetCredentialUnsupportedException
import androidx.credentials.exceptions.NoCredentialException
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.roundToInt

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var bannerContainer: FrameLayout
    private lateinit var appRoot: FrameLayout
    private lateinit var adMobManager: AdMobManager
    private lateinit var credentialManager: CredentialManager
    private val googleSignInInFlight = AtomicBoolean(false)
    private val activeGoogleSignInRequestId = AtomicLong(0L)
    @Volatile private var activeGoogleRequestKey: String = ""
    private var googleSignInJob: Job? = null
    private var googleRequestDeadlineMs = 0L

    private fun credentialFailureDiagnostic(e: GetCredentialException): String {
        // Provider cancellation sometimes wraps reauthentication/configuration failure. Extract
        // only known categories and numeric status codes; never retain raw exception messages.
        val msg = e.message.orEmpty().lowercase()
        val category = listOf("reauth", "developer", "network", "sync", "cancel").firstOrNull { msg.contains(it) } ?: "unspecified"
        val status = Regex("\\[(\\d{1,6})\\]").find(msg)?.groupValues?.get(1) ?: "none"
        return "class=${e.javaClass.simpleName} type=${e.type} providerCategory=$category status=$status cause=${e.cause?.javaClass?.simpleName ?: "none"}"
    }

    // Request IDs that have already produced a terminal result (prevents duplicate callbacks).
    private val completedGoogleRequestIds: MutableSet<String> = ConcurrentHashMap.newKeySet()
    // Diagnostics surfaced to the WebView so the owner can see the real failure + signing identity.
    @Volatile
    private var lastGoogleSignInErrorCode: String? = null
    @Volatile
    private var lastGoogleSignInErrorDetail: String? = null
    @Volatile
    private var lastWebClientIdSuffix: String = ""
    @Volatile
    private var lastCredentialType: String? = null
    // Sanitised, token-free stage trace of the most recent Google sign-in attempt.
    private val googleAuthTrace: MutableList<String> = java.util.Collections.synchronizedList(mutableListOf())

    /**
     * Records one sanitised stage of the Google sign-in flow. Never accepts tokens, passwords or
     * raw credential bundles; only request ids, stage names, exception types and short details.
     */
    private fun recordGoogleStage(requestId: String, stage: String, detail: String = "") {
        val safeReq = requestId.take(64)
        val safeDetail = detail.take(160).replace("\n", " ")
        val entry = JSONObject().apply {
            put("t", System.currentTimeMillis())
            put("req", safeReq)
            put("stage", stage)
            if (safeDetail.isNotEmpty()) put("detail", safeDetail)
        }.toString()
        synchronized(googleAuthTrace) {
            if (googleAuthTrace.size >= 60) googleAuthTrace.removeAt(0)
            googleAuthTrace.add(entry)
        }
        Log.i("TradingzoneAuth", "STAGE $stage req=$safeReq ${safeDetail}")
    }

    private fun googleTraceJson(): org.json.JSONArray {
        val snapshot = synchronized(googleAuthTrace) { googleAuthTrace.toList() }
        return org.json.JSONArray().apply { snapshot.forEach { put(JSONObject(it)) } }
    }

    // Starts as completely untrusted until verified main-frame navigation completes
    @Volatile
    private var currentTrustedUrl: String = ""

    private fun isPermittedUri(uriString: String?): Boolean {
        if (uriString.isNullOrBlank()) return false
        return try {
            val uri = Uri.parse(uriString)
            val scheme = uri.scheme?.lowercase() ?: return false
            if (scheme == "file") {
                val path = uri.path ?: return false
                // Strict check: must reside inside /android_asset/www/ and have no host or query
                (path == "/android_asset/www/index.html" || path.startsWith("/android_asset/www/")) &&
                    uri.host.isNullOrEmpty() &&
                    uri.query.isNullOrEmpty()
            } else if (scheme == "https") {
                val host = uri.host?.lowercase() ?: return false
                host == "appassets.androidplatform.net"
            } else {
                false
            }
        } catch (e: Exception) {
            false
        }
    }

    inner class TradingzoneNativeBridge(private val context: Context) {
        @Synchronized
        private fun getSecurePrefs(): SharedPreferences? {
            return try {
                createEncryptedPrefs()
            } catch (t: Throwable) {
                Log.w("TradingzoneBridge", "Initial EncryptedSharedPreferences creation failed: ${t.message}. Attempting targeted recovery...", t)
                try {
                    // Targeted recovery: remove only this vault's shared prefs file and reset keystore alias
                    val sharedPrefsFile = File(context.filesDir.parent, "shared_prefs/tradingzone_keystore_vault.xml")
                    if (sharedPrefsFile.exists()) {
                        sharedPrefsFile.delete()
                    }
                    try {
                        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
                        if (keyStore.containsAlias(MasterKey.DEFAULT_MASTER_KEY_ALIAS)) {
                            keyStore.deleteEntry(MasterKey.DEFAULT_MASTER_KEY_ALIAS)
                        }
                    } catch (ke: Throwable) {
                        Log.w("TradingzoneBridge", "Could not remove MasterKey alias: ${ke.message}")
                    }
                    createEncryptedPrefs()
                } catch (recoveryErr: Throwable) {
                    Log.e("TradingzoneBridge", "Unrecoverable encryption failure: ${recoveryErr.message}", recoveryErr)
                    null
                }
            }
        }

        private fun createEncryptedPrefs(): SharedPreferences {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            return EncryptedSharedPreferences.create(
                context,
                "tradingzone_keystore_vault",
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            )
        }

        private fun verifyCallerIsTrusted(): Boolean {
            return currentTrustedUrl.isNotBlank() && isPermittedUri(currentTrustedUrl)
        }

        @JavascriptInterface
        fun saveSession(jsonPayload: String): Boolean {
            if (!verifyCallerIsTrusted()) {
                Log.e("TradingzoneBridge", "Rejected saveSession from untrusted origin: $currentTrustedUrl")
                return false
            }
            if (jsonPayload.isBlank() || jsonPayload.length > 32768) {
                Log.e("TradingzoneBridge", "Payload is empty or exceeds allowed size.")
                return false
            }
            return try {
                val prefs = getSecurePrefs()
                if (prefs == null) {
                    Log.e("TradingzoneBridge", "saveSession failed: securePrefs is null")
                    return false
                }
                prefs.edit().putString("auth_session_v2", jsonPayload).commit()
            } catch (t: Throwable) {
                Log.e("TradingzoneBridge", "Failed to saveSession: ${t.message}", t)
                false
            }
        }

        @JavascriptInterface
        fun readSession(): String {
            if (!verifyCallerIsTrusted()) {
                Log.e("TradingzoneBridge", "Rejected readSession from untrusted origin: $currentTrustedUrl")
                return ""
            }
            return try {
                getSecurePrefs()?.getString("auth_session_v2", "") ?: ""
            } catch (t: Throwable) {
                Log.e("TradingzoneBridge", "Failed to readSession: ${t.message}", t)
                ""
            }
        }

        @JavascriptInterface
        fun clearSession(): Boolean {
            if (!verifyCallerIsTrusted()) return false
            return try {
                val prefs = getSecurePrefs() ?: return false
                prefs.edit().remove("auth_session_v2").commit()
            } catch (t: Throwable) {
                Log.e("TradingzoneBridge", "Failed to clearSession: ${t.message}", t)
                false
            }
        }

        @JavascriptInterface
        fun saveKey(key: String, value: String): Boolean {
            if (!verifyCallerIsTrusted()) return false
            if (key.length > 128 || value.length > 32768) return false
            return try {
                val prefs = getSecurePrefs() ?: return false
                prefs.edit().putString(key, value).commit()
            } catch (t: Throwable) {
                Log.e("TradingzoneBridge", "Failed to saveKey: ${t.message}", t)
                false
            }
        }

        @JavascriptInterface
        fun readKey(key: String): String {
            if (!verifyCallerIsTrusted()) return ""
            return try {
                getSecurePrefs()?.getString(key, "") ?: ""
            } catch (t: Throwable) {
                Log.e("TradingzoneBridge", "Failed to readKey: ${t.message}", t)
                ""
            }
        }

        @JavascriptInterface
        fun isDebugBuild(): Boolean {
            return BuildConfig.DEBUG
        }

        @JavascriptInterface
        fun isDevServerPickerEnabled(): Boolean {
            return BuildConfig.ENABLE_DEV_SERVER_PICKER
        }

        @JavascriptInterface
        fun getDefaultServerUrl(): String {
            return BuildConfig.DEFAULT_SERVER_URL
        }

        /**
         * Native Android Credential Manager Sign in with Google
         * Prompts the native Android account selection bottom sheet (never opens in WebView)
         * and delivers the cryptographically signed Google ID token back to the app.
         */
        @JavascriptInterface
        fun startNativeGoogleSignIn(webServerClientId: String) {
            startNativeGoogleSignIn(webServerClientId, "")
        }

        @JavascriptInterface
        fun startNativeGoogleSignIn(webServerClientId: String, requestId: String) {
            startGoogleSignIn(webServerClientId, requestId, false)
        }

        @JavascriptInterface
        fun startNativeGoogleSignInCompatible(webServerClientId: String, requestId: String) {
            startGoogleSignIn(webServerClientId, requestId, true)
        }

        private fun startGoogleSignIn(webServerClientId: String, requestId: String, compatibility: Boolean) {
            try {
                val safeReqId = requestId.trim()
                lastWebClientIdSuffix = webServerClientId.trim().takeLast(30)
                Log.i("TradingzoneAuth", "startNativeGoogleSignIn called (req=$safeReqId, clientIdSuffix=${webServerClientId.takeLast(24)})")
                if (!verifyCallerIsTrusted()) {
                    Log.w("TradingzoneAuth", "Rejected startNativeGoogleSignIn from untrusted origin: $currentTrustedUrl")
                    sendGoogleSignInResult(false, null, "UNTRUSTED_ORIGIN: Origin is not trusted.", safeReqId)
                    return
                }
                val clientId = webServerClientId.trim()
                if (clientId.isBlank()) {
                    sendGoogleSignInResult(false, null, "CONFIGURATION_ERROR: Server Web Client ID is required for Google Sign-In.", safeReqId)
                    return
                }
                if (!googleSignInInFlight.compareAndSet(false, true)) {
                    Log.w("TradingzoneAuth", "Ignoring duplicate startNativeGoogleSignIn while request is in flight (req=$safeReqId)")
                    // Repeated delivery of the same bridge call must not consume its terminal slot.
                    if (safeReqId != activeGoogleRequestKey) sendGoogleSignInResult(false, null, "SIGN_IN_IN_PROGRESS: A Google Sign-In request is already active.", safeReqId)
                    return
                }
                activeGoogleRequestKey = safeReqId
                lastCredentialType = null
                lastGoogleSignInErrorCode = null
                lastGoogleSignInErrorDetail = null
                googleRequestDeadlineMs = android.os.SystemClock.elapsedRealtime() + 120000L
                val seq = activeGoogleSignInRequestId.incrementAndGet()

                runOnUiThread {
                    try {
                        if (isFinishing || isDestroyed) {
                            Log.w("TradingzoneAuth", "Activity is finishing or destroyed; aborting Google Sign-In.")
                            if (activeGoogleSignInRequestId.get() == seq) googleSignInInFlight.set(false)
                            sendGoogleSignInResult(false, null, "ACTIVITY_NOT_ACTIVE: Activity is finishing or destroyed.", safeReqId)
                            return@runOnUiThread
                        }
                        // Credential Manager must be invoked from a foreground (RESUMED) Activity.
                        if (!lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
                            Log.w("TradingzoneAuth", "Activity not resumed (state=${lifecycle.currentState}); aborting Google Sign-In.")
                            if (activeGoogleSignInRequestId.get() == seq) googleSignInInFlight.set(false)
                            sendGoogleSignInResult(false, null, "ACTIVITY_NOT_ACTIVE: Activity is not in the foreground. Bring the app to the front and retry.", safeReqId)
                            return@runOnUiThread
                        }

                        val gmsStatus = GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(this@MainActivity)
                        if (gmsStatus != ConnectionResult.SUCCESS) {
                            val errStr = GoogleApiAvailability.getInstance().getErrorString(gmsStatus)
                            Log.w("TradingzoneAuth", "Google Play Services unavailable (code=$gmsStatus, err=$errStr)")
                            if (activeGoogleSignInRequestId.get() == seq) googleSignInInFlight.set(false)
                            sendGoogleSignInResult(
                                false,
                                null,
                                "PLAY_SERVICES_UNAVAILABLE: Google Play Services unavailable ($errStr, code=$gmsStatus).",
                                safeReqId
                            )
                            return@runOnUiThread
                        }

                        googleSignInJob = lifecycleScope.launch(Dispatchers.Main) {
                            try {
                                recordGoogleStage(safeReqId, "NATIVE_REQUEST_START", if (compatibility) "flow=GetGoogleIdOption manual_compatibility" else "flow=GetSignInWithGoogleOption")
                                val result: GetCredentialResponse = withTimeout(120_000L) {
                                    // Primary explicit button flow: GetSignInWithGoogleOption opens the
                                    // full Google account picker for all accounts on the device.
                                    val primaryRequest = if (compatibility) {
                                        GetCredentialRequest.Builder().addCredentialOption(GetGoogleIdOption.Builder()
                                            .setServerClientId(clientId).setFilterByAuthorizedAccounts(false)
                                            .setAutoSelectEnabled(false).build()).build()
                                    } else {
                                        GetCredentialRequest.Builder().addCredentialOption(GetSignInWithGoogleOption.Builder(clientId).build()).build()
                                    }
                                    credentialManager.getCredential(
                                        request = primaryRequest,
                                        context = this@MainActivity
                                    )
                                }
                                recordGoogleStage(safeReqId, "PICKER_RESULT", "outcome=credential_returned")
                                if (activeGoogleSignInRequestId.get() != seq) {
                                    recordGoogleStage(safeReqId, "STALE_DISCARD", "sequence_mismatch")
                                    return@launch
                                }
                                handleGoogleCredentialResponse(result, safeReqId)
                            } catch (e: TimeoutCancellationException) {
                                recordGoogleStage(safeReqId, "TIMEOUT", "afterMs=120000")
                                if (activeGoogleSignInRequestId.get() == seq) {
                                    sendGoogleSignInResult(false, null, "SIGN_IN_TIMEOUT: Google Sign-In timed out. Please try again.", safeReqId)
                                }
                            } catch (e: GetCredentialCancellationException) {
                                val code = GoogleCredentialTypes.cancellationErrorCode(e.message)
                                recordGoogleStage(safeReqId, code, credentialFailureDiagnostic(e))
                                if (activeGoogleSignInRequestId.get() == seq) {
                                    sendGoogleSignInResult(
                                        false,
                                        null,
                                        "$code: Google returned no credential (${credentialFailureDiagnostic(e)}).",
                                        safeReqId
                                    )
                                }
                            } catch (e: NoCredentialException) {
                                recordGoogleStage(safeReqId, "NO_CREDENTIAL", "type=${e.type}")
                                if (activeGoogleSignInRequestId.get() == seq) {
                                    sendGoogleSignInResult(
                                        false,
                                        null,
                                        "NO_CREDENTIALS: Google Credential Manager returned no eligible Google ID credential (type=${e.type}). The app's signing certificate/package may not match the registered Android OAuth client. Signing SHA-1 is reported by getGoogleSignInDiagnostics().",
                                        safeReqId
                                    )
                                }
                            } catch (e: GetCredentialProviderConfigurationException) {
                                recordGoogleStage(safeReqId, "PROVIDER_CONFIG_FALLBACK", "type=${e.type}")
                                if (activeGoogleSignInRequestId.get() == seq) {
                                    if (compatibility) sendGoogleSignInResult(false, null, "CONFIGURATION_ERROR: Google credential provider unavailable.", safeReqId)
                                    else runLegacyGoogleIdFallback(clientId, seq, safeReqId)
                                }
                            } catch (e: GetCredentialUnsupportedException) {
                                recordGoogleStage(safeReqId, "PROVIDER_UNSUPPORTED_FALLBACK", "type=${e.type}")
                                if (activeGoogleSignInRequestId.get() == seq) {
                                    if (compatibility) sendGoogleSignInResult(false, null, "CONFIGURATION_ERROR: Google credential provider unsupported.", safeReqId)
                                    else runLegacyGoogleIdFallback(clientId, seq, safeReqId)
                                }
                            } catch (e: GetCredentialInterruptedException) {
                                recordGoogleStage(safeReqId, "INTERRUPTED", "class=${e.javaClass.simpleName} type=${e.type}")
                                if (activeGoogleSignInRequestId.get() == seq) {
                                    sendGoogleSignInResult(false, null, "SIGN_IN_INTERRUPTED: The Google sign-in flow was interrupted before a credential was returned. Tap Continue with Google to try again.", safeReqId)
                                }
                            } catch (e: GetCredentialException) {
                                recordGoogleStage(safeReqId, "CREDENTIAL_ERROR", "class=${e.javaClass.simpleName} type=${e.type}")
                                if (activeGoogleSignInRequestId.get() == seq) {
                                    val detail = credentialFailureDiagnostic(e)
                                    sendGoogleSignInResult(false, null, "CREDENTIAL_ERROR: $detail", safeReqId)
                                }
                            } catch (t: Throwable) {
                                recordGoogleStage(safeReqId, "EXCEPTION", "class=${t.javaClass.simpleName}")
                                if (activeGoogleSignInRequestId.get() == seq) {
                                    sendGoogleSignInResult(false, null, "AUTH_EXCEPTION: ${t.javaClass.simpleName}: ${t.message}", safeReqId)
                                }
                            } finally {
                                if (activeGoogleSignInRequestId.get() == seq) {
                                    googleSignInInFlight.set(false)
                                }
                            }
                        }
                    } catch (t: Throwable) {
                        Log.e("TradingzoneAuth", "Error scheduling Google sign-in coroutine: ${t.message}", t)
                        if (activeGoogleSignInRequestId.get() == seq) {
                            googleSignInInFlight.set(false)
                        }
                        sendGoogleSignInResult(false, null, "LAUNCH_EXCEPTION: ${t.message}", safeReqId)
                    }
                }
            } catch (t: Throwable) {
                Log.e("TradingzoneAuth", "Top-level startNativeGoogleSignIn exception: ${t.message}", t)
                googleSignInInFlight.set(false)
                sendGoogleSignInResult(false, null, "NATIVE_EXCEPTION: ${t.message}", requestId.trim())
            }
        }

        @JavascriptInterface
        fun clearNativeGoogleCredentialState() {
            if (!verifyCallerIsTrusted()) return
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                lifecycleScope.launch(Dispatchers.Main) {
                    try {
                        credentialManager.clearCredentialState(ClearCredentialStateRequest())
                        Log.i("TradingzoneAuth", "Cleared CredentialManager state on logout.")
                    } catch (t: Throwable) {
                        Log.w("TradingzoneAuth", "Failed to clear CredentialManager state: ${t.message}")
                    }
                }
            }
        }

        /**
         * Invalidate an in-flight Google Sign-In request (called by the WebView when it times out).
         * Any late result from Credential Manager is then discarded instead of authenticating.
         */
        @JavascriptInterface
        fun cancelNativeGoogleSignIn(requestId: String) {
            if (!verifyCallerIsTrusted()) return
            val safeReqId = requestId.trim()
            if (safeReqId != activeGoogleRequestKey) return
            if (safeReqId.isNotEmpty()) completedGoogleRequestIds.add(safeReqId)
            activeGoogleSignInRequestId.incrementAndGet()
            googleSignInInFlight.set(false)
            runOnUiThread { if (activeGoogleRequestKey == safeReqId) googleSignInJob?.cancel() }
            recordGoogleStage(safeReqId, "CANCELLED_BY_CLIENT", "timeout_or_user_reset")
        }

        /**
         * Google Sign-In diagnostics for the support/owner flow. SHA-1 fingerprints are public
         * information; this never exposes tokens or client secrets.
         */
        @JavascriptInterface
        fun getGoogleSignInDiagnostics(): String {
            if (!verifyCallerIsTrusted()) return "{}"
            val gmsStatus = try {
                GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(this@MainActivity)
            } catch (t: Throwable) {
                -1
            }
            return JSONObject().apply {
                put("packageName", packageName)
                put("versionName", BuildConfig.VERSION_NAME)
                put("versionCode", BuildConfig.VERSION_CODE)
                put("signingSha1", computeSigningSha1())
                put("playServicesStatus", gmsStatus)
                put("playServicesOk", gmsStatus == ConnectionResult.SUCCESS)
                put("playServicesError", if (gmsStatus == ConnectionResult.SUCCESS) "" else GoogleApiAvailability.getInstance().getErrorString(gmsStatus))
                put("credentialManagerAvailable", try { CredentialManager.create(this@MainActivity); true } catch (t: Throwable) { false })
                put("webClientIdSuffix", lastWebClientIdSuffix)
                put("lastErrorCode", lastGoogleSignInErrorCode ?: "")
                put("lastErrorDetail", lastGoogleSignInErrorDetail ?: "")
                put("lastCredentialType", lastCredentialType ?: "")
                put("activityLifecycleState", lifecycle.currentState.name)
                put("androidSdkInt", Build.VERSION.SDK_INT)
                put("playServicesVersion", playServicesVersionName())
                put("lastTrace", googleTraceJson())
                put("requiredOAuthRegistration", "Android OAuth client: package=$packageName, SHA-1=${computeSigningSha1()}")
            }.toString()
        }

        private fun computeSigningSha1(): String {
            return try {
                val pm = packageManager
                val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    val info = pm.getPackageInfo(packageName, PackageManager.GET_SIGNING_CERTIFICATES)
                    val signingInfo = info.signingInfo
                    when {
                        signingInfo == null -> null
                        signingInfo.hasMultipleSigners() -> signingInfo.apkContentsSigners
                        else -> signingInfo.signingCertificateHistory
                    }
                } else {
                    @Suppress("DEPRECATION")
                    pm.getPackageInfo(packageName, PackageManager.GET_SIGNATURES).signatures
                }
                val first = signatures?.firstOrNull() ?: return "UNAVAILABLE"
                val digest = MessageDigest.getInstance("SHA-1").digest(first.toByteArray())
                digest.joinToString(":") { byte -> "%02X".format(byte) }
            } catch (t: Throwable) {
                Log.w("TradingzoneAuth", "Could not compute signing SHA-1: ${t.message}")
                "UNAVAILABLE"
            }
        }

        // =========================================================================
        // Native Google AdMob & UMP Bridge Interfaces
        // =========================================================================

        @JavascriptInterface
        fun updateScreenState(screen: String, tradingWorkspaceOpen: Boolean, openPositions: Boolean, pendingOrders: Boolean) {
            if (!verifyCallerIsTrusted()) return
            runOnUiThread {
                if (::adMobManager.isInitialized) {
                    adMobManager.updateScreenState(screen, tradingWorkspaceOpen, openPositions, pendingOrders)
                }
            }
        }

        @JavascriptInterface
        fun updateUserTier(tier: String, userId: String) {
            if (!verifyCallerIsTrusted()) return
            runOnUiThread {
                if (::adMobManager.isInitialized) {
                    adMobManager.updateUserTier(tier, userId)
                }
            }
        }

        @JavascriptInterface
        fun recordEligibleAction(actionName: String) {
            if (!verifyCallerIsTrusted()) return
            runOnUiThread {
                if (::adMobManager.isInitialized) {
                    adMobManager.recordEligibleAction(actionName)
                }
            }
        }

        @JavascriptInterface
        fun showPrivacyOptions() {
            if (!verifyCallerIsTrusted()) return
            runOnUiThread {
                if (::adMobManager.isInitialized) {
                    adMobManager.showPrivacyOptionsForm { success, errorMsg ->
                        if (::webView.isInitialized) {
                            webView.post {
                                val safeErr = JSONObject.quote(errorMsg ?: "")
                                webView.evaluateJavascript(
                                    "if (window.onAdPrivacyOptionsResult) window.onAdPrivacyOptionsResult($success, $safeErr);",
                                    null
                                )
                            }
                        }
                    }
                }
            }
        }

        @JavascriptInterface
        fun configureAppOpenUnit(unitId:String){
            if(!verifyCallerIsTrusted())return
            runOnUiThread{if(::adMobManager.isInitialized)adMobManager.configureAppOpenUnit(unitId)}
        }

        @JavascriptInterface
        fun reloadTestAds(): Boolean {
            if (!BuildConfig.DEBUG || !verifyCallerIsTrusted()) return false
            return if (::adMobManager.isInitialized) adMobManager.reloadTestAds() else false
        }

        @JavascriptInterface
        fun getAdDiagnostics(): String {
            if (!verifyCallerIsTrusted()) return "{}"
            return if (::adMobManager.isInitialized) {
                adMobManager.getAdDiagnostics().toString()
            } else {
                "{}"
            }
        }

        @JavascriptInterface
        fun setSystemBarTheme(isLight: Boolean, colorHex: String) {
            if (!verifyCallerIsTrusted()) return
            runOnUiThread {
                try {
                    val parsedColor = Color.parseColor(colorHex)
                    window.decorView.setBackgroundColor(parsedColor)
                    if(::appRoot.isInitialized)appRoot.setBackgroundColor(parsedColor)
                    val insetsController = WindowCompat.getInsetsController(window, window.decorView)
                    insetsController.isAppearanceLightStatusBars = isLight
                    insetsController.isAppearanceLightNavigationBars = isLight
                } catch (e: Exception) {
                    Log.w("TradingzoneBridge", "Failed to setSystemBarTheme: ${e.message}")
                }
            }
        }
    }

    // =========================================================================
    // Google Sign-In result handling (outer Activity scope so the suspend flow and the
    // WebView callback share one implementation)
    // =========================================================================

    private fun playServicesVersionName(): String = try {
        packageManager.getPackageInfo("com.google.android.gms", 0).versionName ?: "UNKNOWN"
    } catch (t: Throwable) {
        "NOT_INSTALLED"
    }

    private fun sendGoogleSignInResult(success: Boolean, dataJson: String?, errorMsg: String?, requestId: String = "") {
        if (!::webView.isInitialized) return
        // Exactly one terminal result per request id. A late callback after the WebView has
        // already timed out must never deliver a credential.
        if (requestId.isNotBlank() && !completedGoogleRequestIds.add(requestId)) {
            Log.w("TradingzoneAuth", "Dropping duplicate Google Sign-In result for req=$requestId")
            return
        }
        if (!success && !errorMsg.isNullOrBlank()) {
            lastGoogleSignInErrorCode = errorMsg.substringBefore(':')
            lastGoogleSignInErrorDetail = errorMsg.take(400)
            recordGoogleStage(requestId, "CALLBACK_SEND", "success=false code=$lastGoogleSignInErrorCode")
        } else if (success) {
            lastGoogleSignInErrorCode = null
            lastGoogleSignInErrorDetail = null
            recordGoogleStage(requestId, "CALLBACK_SEND", "success=true")
        }
        webView.post {
            val safeData = JSONObject.quote(dataJson ?: "")
            val safeErr = JSONObject.quote(errorMsg ?: "")
            val safeReq = JSONObject.quote(requestId)
            webView.evaluateJavascript(
                "if (window.onTradingzoneGoogleSignInResult) window.onTradingzoneGoogleSignInResult($success, $safeData, $safeErr, $safeReq);",
                null
            )
        }
    }

    /**
     * Shared parsing of a Credential Manager response. Accepts BOTH Google ID token credential
     * types: the legacy One Tap type and the Sign-In-With-Google (button picker) type. The v1.0.7
     * release only accepted the former, which discarded genuinely successful picker selections.
     */
    private fun handleGoogleCredentialResponse(result: GetCredentialResponse, requestId: String) {
        val credential = result.credential
        lastCredentialType = credential.type
        val receivedType = GoogleCredentialTypes.describe(credential.type)
        recordGoogleStage(requestId, "CREDENTIAL_TYPE", "type=$receivedType")
        if (credential !is CustomCredential || !GoogleCredentialTypes.isGoogleIdTokenCredentialType(credential.type)) {
            recordGoogleStage(requestId, "CREDENTIAL_TYPE_REJECTED", "type=$receivedType")
            sendGoogleSignInResult(
                false,
                null,
                "UNEXPECTED_CREDENTIAL_TYPE: received $receivedType; expected a Google ID token credential.",
                requestId
            )
            return
        }
        try {
            val parsed = GoogleIdTokenCredential.createFrom(credential.data)
            val idToken = parsed.idToken
            val email = parsed.id
            if (idToken.isBlank() || email.isBlank()) {
                recordGoogleStage(requestId, "CREDENTIAL_INCOMPLETE", "idTokenLength=${idToken.length}")
                sendGoogleSignInResult(
                    false,
                    null,
                    "CREDENTIAL_INCOMPLETE: the Google credential did not contain a usable ID token or email.",
                    requestId
                )
                return
            }
            // Never log the token or the full email address.
            recordGoogleStage(
                requestId,
                "CREDENTIAL_PARSED",
                "emailDomain=${email.substringAfter('@', "unknown")} idTokenLength=${idToken.length}"
            )
            val payload = JSONObject().apply {
                put("idToken", idToken)
                put("email", email)
                put("name", parsed.displayName ?: "")
                put("requestId", requestId)
                put("credentialType", credential.type)
            }
            sendGoogleSignInResult(true, payload.toString(), null, requestId)
        } catch (t: Throwable) {
            recordGoogleStage(requestId, "PARSE_ERROR", "class=${t.javaClass.simpleName}")
            sendGoogleSignInResult(
                false,
                null,
                "CREDENTIAL_PARSE_ERROR: ${t.javaClass.simpleName}: ${t.message}",
                requestId
            )
        }
    }

    /**
     * One-time legacy fallback used only when the installed Play Services cannot serve the
     * Sign-In-With-Google option (provider configuration/unsupported). It is never triggered by a
     * user cancellation or a generic failure, so the picker cannot be reopened accidentally.
     */
    private suspend fun runLegacyGoogleIdFallback(clientId: String, seq: Long, requestId: String) {
        try {
            recordGoogleStage(requestId, "LEGACY_FALLBACK_START", "flow=GetGoogleIdOption")
            val remainingMs = (googleRequestDeadlineMs - android.os.SystemClock.elapsedRealtime()).coerceIn(1L, 30000L)
            val result = withTimeout(remainingMs) {
                val fallbackOption = GetGoogleIdOption.Builder()
                    .setFilterByAuthorizedAccounts(false)
                    .setServerClientId(clientId)
                    .setAutoSelectEnabled(false)
                    .build()
                val fallbackRequest = GetCredentialRequest.Builder()
                    .addCredentialOption(fallbackOption)
                    .build()
                credentialManager.getCredential(request = fallbackRequest, context = this@MainActivity)
            }
            recordGoogleStage(requestId, "LEGACY_FALLBACK_RESULT", "outcome=credential_returned")
            if (activeGoogleSignInRequestId.get() != seq) {
                recordGoogleStage(requestId, "STALE_DISCARD", "sequence_mismatch_legacy")
                return
            }
            handleGoogleCredentialResponse(result, requestId)
        } catch (e: TimeoutCancellationException) {
            recordGoogleStage(requestId, "LEGACY_TIMEOUT", "afterMs=30000")
            sendGoogleSignInResult(false, null, "SIGN_IN_TIMEOUT: Google Sign-In timed out. Please try again.", requestId)
        } catch (e: GetCredentialCancellationException) {
            val code = GoogleCredentialTypes.cancellationErrorCode(e.message)
            recordGoogleStage(requestId, "LEGACY_$code", credentialFailureDiagnostic(e))
            sendGoogleSignInResult(false, null, "$code: Google returned no credential (${credentialFailureDiagnostic(e)}).", requestId)
        } catch (e: GetCredentialException) {
            recordGoogleStage(requestId, "LEGACY_ERROR", "class=${e.javaClass.simpleName} type=${e.type}")
            sendGoogleSignInResult(
                false,
                null,
                "CREDENTIAL_ERROR: legacy flow ${credentialFailureDiagnostic(e)}",
                requestId
            )
        } catch (t: Throwable) {
            recordGoogleStage(requestId, "LEGACY_EXCEPTION", "class=${t.javaClass.simpleName}")
            sendGoogleSignInResult(false, null, "AUTH_EXCEPTION: ${t.javaClass.simpleName}: ${t.message}", requestId)
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        credentialManager = CredentialManager.create(this)
        // Inspect only isolated/debug builds through Chrome DevTools; release stays disabled.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        WindowCompat.setDecorFitsSystemWindows(window, false)
        val insetsController = WindowCompat.getInsetsController(window, window.decorView)
        insetsController.isAppearanceLightStatusBars = true
        insetsController.isAppearanceLightNavigationBars = true

        val rootLayout = FrameLayout(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(Color.parseColor("#F8FAFC"))
        }

        webView = WebView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(Color.parseColor("#F8FAFC"))

            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                allowFileAccess = true
                allowContentAccess = true
                @Suppress("DEPRECATION")
                databaseEnabled = true
                mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                cacheMode = WebSettings.LOAD_DEFAULT
                useWideViewPort = true
                loadWithOverviewMode = true
            }

            addJavascriptInterface(TradingzoneNativeBridge(this@MainActivity), "TradingzoneNative")

            webViewClient = object : WebViewClient() {
                override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                    super.onPageStarted(view, url, favicon)
                    // Invalidate trusted state first
                    currentTrustedUrl = ""
                    // If verified main-frame navigation to permitted local asset, establish trust
                    if (url != null && isPermittedUri(url)) {
                        currentTrustedUrl = url
                    }
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    // Confirm verified main-frame navigation with exact permitted URI
                    if (view != null && url != null && view.url == url && isPermittedUri(url)) {
                        currentTrustedUrl = url
                    } else {
                        currentTrustedUrl = ""
                    }
                }

                override fun onReceivedError(view: WebView?, errorCode: Int, description: String?, failingUrl: String?) {
                    super.onReceivedError(view, errorCode, description, failingUrl)
                    currentTrustedUrl = ""
                }

                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                    val reqUrl = request?.url ?: return true
                    // Only allow main-frame navigation to permitted local assets
                    if (request.isForMainFrame && isPermittedUri(reqUrl.toString())) {
                        return false
                    }
                    // Remote frames or external navigation -> open in browser, never inside WebView
                    if (request.isForMainFrame) {
                        try {
                            val intent = Intent(Intent.ACTION_VIEW, reqUrl)
                            startActivity(intent)
                        } catch (e: Exception) {
                            Log.e("TradingzoneWebView", "Failed to launch external browser for $reqUrl: ${e.message}")
                        }
                    } else {
                        Log.w("TradingzoneWebView", "Blocked subframe navigation to $reqUrl")
                    }
                    return true
                }

                override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? {
                    // Block remote frames or iframes requesting untrusted endpoints
                    if (request != null && !request.isForMainFrame) {
                        val dest = request.requestHeaders?.get("Sec-Fetch-Dest") ?: ""
                        if (dest.equals("iframe", ignoreCase = true) || dest.equals("frame", ignoreCase = true)) {
                            val reqUrl = request.url?.toString()
                            if (!isPermittedUri(reqUrl)) {
                                Log.w("TradingzoneWebView", "Blocked untrusted iframe request: $reqUrl")
                                return WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", null, null)
                            }
                        }
                    }
                    return super.shouldInterceptRequest(view, request)
                }
            }
            webChromeClient = WebChromeClient()

            setLayerType(WebView.LAYER_TYPE_HARDWARE, null)
        }
        rootLayout.addView(webView)

        // Native Banner Container: Anchored directly above the 60dp bottom navigation
        bannerContainer = FrameLayout(this).apply {
            val bottomNavPx = (60 * resources.displayMetrics.density).roundToInt()
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
                bottomMargin = bottomNavPx
            }
            visibility = View.GONE
        }
        appRoot=rootLayout
        rootLayout.addView(bannerContainer)

        adMobManager = AdMobManager(this, bannerContainer) { isVisible, heightDp ->
            if (::webView.isInitialized) {
                webView.post {
                    webView.evaluateJavascript(
                        "if (window.onAdBannerStateChanged) window.onAdBannerStateChanged($isVisible, $heightDp);",
                        null
                    )
                }
            }
        }

        ViewCompat.setOnApplyWindowInsetsListener(rootLayout) { _, windowInsets ->
            val insets = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            // Apply margins directly to WebView layout params so that HTML headers (including fixed/absolute)
            // never render under the status bar, notch or camera cutout.
            (webView.layoutParams as? FrameLayout.LayoutParams)?.apply {
                topMargin = insets.top
                bottomMargin = insets.bottom
                leftMargin = insets.left
                rightMargin = insets.right
                webView.layoutParams = this
            }

            val bottomNavPx = (60 * resources.displayMetrics.density).roundToInt()
            (bannerContainer.layoutParams as? FrameLayout.LayoutParams)?.apply {
                bottomMargin = bottomNavPx + insets.bottom
                leftMargin = insets.left
                rightMargin = insets.right
                bannerContainer.layoutParams = this
            }
            WindowInsetsCompat.CONSUMED
        }

        setContentView(rootLayout)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (::webView.isInitialized) {
                    webView.evaluateJavascript(
                        "(function(){ if(window.handleAndroidBackButton) return window.handleAndroidBackButton(); return false; })()"
                    ) { res ->
                        if (res == "true") {
                            // Handled inside SPA
                        } else if (webView.canGoBack()) {
                            webView.goBack()
                        } else {
                            finish()
                        }
                    }
                } else {
                    finish()
                }
            }
        })

        webView.loadUrl("file:///android_asset/www/index.html")
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if(::adMobManager.isInitialized && !googleSignInInFlight.get())adMobManager.noteUserLeaving()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean){
        super.onWindowFocusChanged(hasFocus)
        if(hasFocus && ::adMobManager.isInitialized)adMobManager.onForegroundWindowReady()
    }
    override fun onUserInteraction(){
        super.onUserInteraction()
        if(::adMobManager.isInitialized)adMobManager.cancelForegroundOpportunity()
    }

    override fun onResume() {
        super.onResume()
        if (googleSignInInFlight.get()) recordGoogleStage(activeGoogleRequestKey, "ACTIVITY_RESUME", "request_preserved")
        if (::adMobManager.isInitialized) {
            adMobManager.onResume(googleSignInInFlight.get())
        }
    }

    override fun onPause() {
        if (googleSignInInFlight.get()) recordGoogleStage(activeGoogleRequestKey, "ACTIVITY_PAUSE", "request_preserved")
        if (::adMobManager.isInitialized) {
            adMobManager.onPause()
        }
        super.onPause()
    }

    override fun onDestroy() {
        if (::adMobManager.isInitialized) {
            adMobManager.onDestroy()
        }
        if (::webView.isInitialized) {
            webView.destroy()
        }
        super.onDestroy()
    }
}
