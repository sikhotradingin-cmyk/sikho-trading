package com.indianpapertrading

import android.annotation.SuppressLint
import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.graphics.Color
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
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
import kotlinx.coroutines.launch
import org.json.JSONObject
import kotlin.math.roundToInt

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var bannerContainer: FrameLayout
    private lateinit var adMobManager: AdMobManager
    private lateinit var credentialManager: CredentialManager

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
        private val securePrefs: SharedPreferences by lazy {
            try {
                val masterKey = MasterKey.Builder(context)
                    .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                    .build()
                EncryptedSharedPreferences.create(
                    context,
                    "tradingzone_keystore_vault",
                    masterKey,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
                )
            } catch (e: Exception) {
                Log.w("TradingzoneBridge", "Keystore-backed EncryptedSharedPreferences unavailable; falling back to private storage: ${e.message}")
                context.getSharedPreferences("tradingzone_secure_store", Context.MODE_PRIVATE)
            }
        }

        private fun verifyCallerIsTrusted(): Boolean {
            val url = webView.url ?: webView.originalUrl ?: ""
            return url.startsWith("file:///android_asset/www/") ||
                   url.startsWith("https://appassets.androidplatform.net/") ||
                   url.isBlank()
        }

        @JavascriptInterface
        fun saveSession(jsonPayload: String) {
            if (!verifyCallerIsTrusted()) {
                Log.e("TradingzoneBridge", "Rejected saveSession from untrusted origin: ${webView.url}")
                return
            }
            if (jsonPayload.length > 32768) {
                Log.e("TradingzoneBridge", "Payload exceeds allowed size.")
                return
            }
            securePrefs.edit().putString("auth_session_v2", jsonPayload).apply()
        }

        @JavascriptInterface
        fun readSession(): String {
            if (!verifyCallerIsTrusted()) {
                Log.e("TradingzoneBridge", "Rejected readSession from untrusted origin: ${webView.url}")
                return ""
            }
            return securePrefs.getString("auth_session_v2", "") ?: ""
        }

        @JavascriptInterface
        fun clearSession() {
            if (!verifyCallerIsTrusted()) return
            securePrefs.edit().remove("auth_session_v2").apply()
        }

        @JavascriptInterface
        fun saveKey(key: String, value: String) {
            if (!verifyCallerIsTrusted()) return
            if (key.length > 128 || value.length > 32768) return
            securePrefs.edit().putString(key, value).apply()
        }

        @JavascriptInterface
        fun readKey(key: String): String {
            if (!verifyCallerIsTrusted()) return ""
            return securePrefs.getString(key, "") ?: ""
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
            val km = context.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
            if (km != null && km.isDeviceSecure) {
                @Suppress("DEPRECATION")
                val intent: Intent? = km.createConfirmDeviceCredentialIntent(title, description)
                if (intent != null) {
                    credentialUnlockLauncher.launch(intent)
                    return
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

        /**
         * Native Android Credential Manager Sign in with Google
         * Prompts the native Android account selection bottom sheet (never opens in WebView)
         * and delivers the cryptographically signed Google ID token back to the app.
         */
        @JavascriptInterface
        fun startNativeGoogleSignIn(webServerClientId: String) {
            Log.i("TradingzoneAuth", "startNativeGoogleSignIn called with clientId: $webServerClientId, callerUrl: ${webView.url}")
            if (!verifyCallerIsTrusted()) {
                Log.w("TradingzoneAuth", "Rejected startNativeGoogleSignIn from untrusted origin: ${webView.url}")
                return
            }
            if (webServerClientId.isBlank()) {
                sendGoogleSignInResult(false, null, "Server Web Client ID is required for Google Sign-In.")
                return
            }

            lifecycleScope.launch {
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
                } catch (e: Exception) {
                    Log.e("TradingzoneAuth", "Google sign-in exception: ${e.message}", e)
                    sendGoogleSignInResult(false, null, "AUTH_EXCEPTION: ${e.message}")
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
            if (::adMobManager.isInitialized) {
                adMobManager.updateScreenState(screen, tradingWorkspaceOpen, openPositions, pendingOrders)
            }
        }

        @JavascriptInterface
        fun updateUserTier(tier: String, userId: String) {
            if (!verifyCallerIsTrusted()) return
            if (::adMobManager.isInitialized) {
                adMobManager.updateUserTier(tier, userId)
            }
        }

        @JavascriptInterface
        fun recordEligibleAction(actionName: String) {
            if (!verifyCallerIsTrusted()) return
            if (::adMobManager.isInitialized) {
                adMobManager.recordEligibleAction(actionName)
            }
        }

        @JavascriptInterface
        fun showPrivacyOptions() {
            if (!verifyCallerIsTrusted()) return
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

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        credentialManager = CredentialManager.create(this)

        WindowCompat.setDecorFitsSystemWindows(window, true)
        @Suppress("DEPRECATION")
        window.statusBarColor = Color.parseColor("#080C12")
        @Suppress("DEPRECATION")
        window.navigationBarColor = Color.parseColor("#080C12")

        val rootLayout = FrameLayout(this).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(Color.parseColor("#080C12"))
        }

        webView = WebView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(Color.parseColor("#080C12"))

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

            webViewClient = object : WebViewClient() {}
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
            webView.setPadding(insets.left, insets.top, insets.right, insets.bottom)

            val bottomNavPx = (60 * resources.displayMetrics.density).roundToInt()
            (bannerContainer.layoutParams as? FrameLayout.LayoutParams)?.apply {
                bottomMargin = bottomNavPx + insets.bottom
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
