package com.indianpapertrading

import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

class AdsQaConfigurationTest {
    @Test fun qaCannotRequestProductionAdUnits() {
        assumeTrue(BuildConfig.DEBUG)
        assertEquals("ca-app-pub-3940256099942544/9214589741", BuildConfig.BANNER_AD_UNIT_ID)
        assertEquals("ca-app-pub-3940256099942544/1033173712", BuildConfig.INTERSTITIAL_AD_UNIT_ID)
        assertEquals("ca-app-pub-3940256099942544/9257395921", BuildConfig.APP_OPEN_AD_UNIT_ID)
    }

    @Test fun qaIsDistinctFromDistributedRelease() {
        assumeTrue(BuildConfig.DEBUG)
        assertEquals("com.indianpapertrading.debug", BuildConfig.APPLICATION_ID)
        assertTrue(BuildConfig.VERSION_NAME.endsWith("-ads-qa"))
    }

}
