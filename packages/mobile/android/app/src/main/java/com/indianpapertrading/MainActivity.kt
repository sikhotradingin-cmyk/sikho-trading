package com.indianpapertrading

import android.annotation.SuppressLint
import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
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
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetCredentialResponse
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException
import androidx.lifecycle.lifecycleScope
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import kotlin.math.roundToInt

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var bannerContainer: FrameLayout
    private lateinit var adMobManager: AdMobManager
    private lateinit var credentialManager: CredentialManager

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

    private val credentialUnlockLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val success = result.resultCode == Activity.RESULT_OK
        if (::webView.isInitialized) {
            webView.post {
                webView.evaluateJavascript(
                    "if (window.onTradingzoneBiometricResult) window.onTradingzoneBiometricResult($success);",
                    null
                )
            }
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

        @JavascriptInterface
        fun isDeviceSecure(): Boolean {
            val km = context.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
            return km?.isDeviceSecure == true
        }

        @JavascriptInterface
        fun triggerDeviceBiometricPrompt(title: String, description: String) {
            if (!verifyCallerIsTrusted()) return
            runOnUiThread {
                val km = context.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
                if (km != null && km.isDeviceSecure) {
                    @Suppress("DEPRECATION")
                    val intent: Intent? = km.createConfirmDeviceCredentialIntent(title, description)
                    if (intent != null) {
                        credentialUnlockLauncher.launch(intent)
                        return@runOnUiThread
                    }
                }
                if (::webView.isInitialized) {
                    webView.post {
                        webView.evaluateJavascript(
                            "if (window.onTradingzoneBiometricResult) window.onTradingzoneBiometricResult(false);",
                            null
                        )
                    }
                }
            }
        }

        /**
         * Native Android Credential Manager Sign in with Google
         * Prompts the native Android account selection bottom sheet (never opens in WebView)
         * and delivers the cryptographically signed Google ID token back to the app.
         */
        @JavascriptInterface
        fun startNativeGoogleSignIn(webServerClientId: String) {
            Log.i("TradingzoneAuth", "startNativeGoogleSignIn called with clientId: $webServerClientId")
            if (!verifyCallerIsTrusted()) {
                Log.w("TradingzoneAuth", "Rejected startNativeGoogleSignIn from untrusted origin: $currentTrustedUrl")
                return
            }
            if (webServerClientId.isBlank()) {
                sendGoogleSignInResult(false, null, "Server Web Client ID is required for Google Sign-In.")
                return
            }

            runOnUiThread {
                if (isFinishing || isDestroyed) {
                    Log.w("TradingzoneAuth", "Activity is finishing or destroyed; aborting Google Sign-In.")
                    return@runOnUiThread
                }

                lifecycleScope.launch(Dispatchers.Main) {
                    try {
                        val googleIdOption = GetGoogleIdOption.Builder()
                            .setFilterByAuthorizedAccounts(false)
                            .setServerClientId(webServerClientId.trim())
                            .setAutoSelectEnabled(false)
                            .build()

                        val request = GetCredentialRequest.Builder()
                            .addCredentialOption(googleIdOption)
                            .build()

                        val result: GetCredentialResponse = credentialManager.getCredential(
                            request = request,
                            context = this@MainActivity
                        )

                        val credential = result.credential
                        if (credential is CustomCredential && credential.type == GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
                            val googleIdTokenCredential = GoogleIdTokenCredential.createFrom(credential.data)
                            val idToken = googleIdTokenCredential.idToken
                            val displayName = googleIdTokenCredential.displayName ?: ""
                            val email = googleIdTokenCredential.id

                            val payload = JSONObject().apply {
                                put("idToken", idToken)
                                put("email", email)
                                put("name", displayName)
                            }
                            sendGoogleSignInResult(true, payload.toString(), null)
                        } else {
                            sendGoogleSignInResult(false, null, "Unexpected credential type received.")
                        }
                    } catch (e: GetCredentialCancellationException) {
                        Log.i("TradingzoneAuth", "Google sign-in was cancelled by user.")
                        sendGoogleSignInResult(false, null, "USER_CANCELLED")
                    } catch (e: NoCredentialException) {
                        Log.w("TradingzoneAuth", "No Google credentials available on device: ${e.message}")
                        sendGoogleSignInResult(false, null, "NO_CREDENTIALS: No Google accounts found on this device.")
                    } catch (e: GetCredentialException) {
                        Log.e("TradingzoneAuth", "Credential Manager error: ${e.message}", e)
                        sendGoogleSignInResult(false, null, "CREDENTIAL_ERROR: ${e.message}")
                    } catch (t: Throwable) {
                        Log.e("TradingzoneAuth", "Google sign-in exception: ${t.message}", t)
                        sendGoogleSignInResult(false, null, "AUTH_EXCEPTION: ${t.message}")
                    }
                }
            }
        }

        private fun sendGoogleSignInResult(success: Boolean, dataJson: String?, errorMsg: String?) {
            if (!::webView.isInitialized) return
            webView.post {
                val safeData = JSONObject.quote(dataJson ?: "")
                val safeErr = JSONObject.quote(errorMsg ?: "")
                webView.evaluateJavascript(
                    "if (window.onTradingzoneGoogleSignInResult) window.onTradingzoneGoogleSignInResult($success, $safeData, $safeErr);",
                    null
                )
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
                    val insetsController = WindowCompat.getInsetsController(window, window.decorView)
                    insetsController.isAppearanceLightStatusBars = isLight
                    insetsController.isAppearanceLightNavigationBars = isLight
                } catch (e: Exception) {
                    Log.w("TradingzoneBridge", "Failed to setSystemBarTheme: ${e.message}")
                }
            }
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        credentialManager = CredentialManager.create(this)

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

    override fun onResume() {
        super.onResume()
        if (::adMobManager.isInitialized) {
            adMobManager.onResume()
        }
    }

    override fun onPause() {
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
