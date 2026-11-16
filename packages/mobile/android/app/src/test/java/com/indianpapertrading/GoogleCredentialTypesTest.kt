package com.indianpapertrading

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Regression coverage for the v1.0.7 Google sign-in failure: the account picker flow returns
 * `TYPE_GOOGLE_ID_TOKEN_SIWG_CREDENTIAL`, which was rejected by the old single-constant check.
 */
class GoogleCredentialTypesTest {
    @Test
    fun acceptsOneTapCredentialType() {
        assertTrue(
            GoogleCredentialTypes.isGoogleIdTokenCredentialType(GoogleCredentialTypes.TYPE_ID_TOKEN)
        )
    }

    @Test
    fun acceptsSignInWithGooglePickerCredentialType() {
        assertTrue(
            GoogleCredentialTypes.isGoogleIdTokenCredentialType(
                GoogleCredentialTypes.TYPE_ID_TOKEN_SIWG
            )
        )
    }

    @Test
    fun rejectsUnrelatedCredentialTypes() {
        assertFalse(GoogleCredentialTypes.isGoogleIdTokenCredentialType(null))
        assertFalse(GoogleCredentialTypes.isGoogleIdTokenCredentialType(""))
        assertFalse(
            GoogleCredentialTypes.isGoogleIdTokenCredentialType(
                "androidx.credentials.TYPE_PUBLIC_KEY_CREDENTIAL"
            )
        )
        assertFalse(
            GoogleCredentialTypes.isGoogleIdTokenCredentialType(
                "com.google.android.libraries.identity.googleid.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL_EXTRA"
            )
        )
    }

    @Test
    fun describesRejectedTypeWithoutLeakingTheWholeBundle() {
        val longType = "x".repeat(500)
        assertTrue(GoogleCredentialTypes.describe(longType).length <= 120)
        assertTrue(GoogleCredentialTypes.describe(null) == "EMPTY")
    }
}
