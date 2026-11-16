package com.indianpapertrading

/**
 * Pure helpers for interpreting Google Credential Manager results.
 *
 * Kept free of Android imports so the rules can be unit-tested on the JVM.
 *
 * Background (googleid 1.1.1 bytecode): the library exposes TWO credential type strings:
 *  - TYPE_GOOGLE_ID_TOKEN_CREDENTIAL       -> returned by the legacy One Tap `GetGoogleIdOption`
 *  - TYPE_GOOGLE_ID_TOKEN_SIWG_CREDENTIAL  -> returned by the explicit button flow
 *                                             `GetSignInWithGoogleOption`
 *
 * The button flow is the one the app uses (it is what opens the full account picker). v1.0.7 only
 * accepted the first constant, so a genuinely successful account selection was discarded and the
 * user saw a failure after picking an account. Both types carry an identical credential bundle and
 * are parsed by the same `GoogleIdTokenCredential.createFrom`.
 */
object GoogleCredentialTypes {
    // GMS can wrap provider/account failures in GetCredentialCancellationException. Preserve
    // genuine dismissal, but never label the observed [16] reauth failure as user cancellation.
    fun cancellationErrorCode(message: String?): String {
        val text = message.orEmpty().lowercase()
        return when {
            text.contains("reauth") -> "GOOGLE_REAUTH_FAILED"
            text.contains("developer") || text.contains("oauth") -> "CONFIGURATION_ERROR"
            text.contains("network") -> "CREDENTIAL_ERROR"
            else -> "USER_CANCELLED"
        }
    }
    const val TYPE_ID_TOKEN = "com.google.android.libraries.identity.googleid.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL"
    const val TYPE_ID_TOKEN_SIWG =
        "com.google.android.libraries.identity.googleid.TYPE_GOOGLE_ID_TOKEN_SIWG_CREDENTIAL"

    fun isGoogleIdTokenCredentialType(type: String?): Boolean {
        val normalised = type?.trim()
        return normalised == TYPE_ID_TOKEN || normalised == TYPE_ID_TOKEN_SIWG
    }

    /** Redacted, log-safe description of a credential type the app could not consume. */
    fun describe(type: String?): String {
        val normalised = type?.trim()
        return when {
            normalised.isNullOrEmpty() -> "EMPTY"
            normalised.length > 120 -> normalised.take(120)
            else -> normalised
        }
    }
}
