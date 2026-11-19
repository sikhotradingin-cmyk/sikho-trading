# Ad SDK QA build (19 November 2026)

The shipped application is Kotlin hosting the bundled WebView SPA. This QA build
uses the same entitlement resolver and existing Render API. It neither grants
membership nor changes trading records. Do not publish it to Play.

## Build identity and ad units

Build `packages/mobile/android` with `gradlew :app:assembleDebug :app:testDebugUnitTest`.
The label is **Sikho Trading Ads QA**, package `com.indianpapertrading.debug`,
version `1.0.14-ads-qa` / code 24. It updates earlier signed debug installs and
coexists with the distributed release. Keep `SikhoTrading-v1.apk` untouched;
deliver this separately as `SikhoTrading-Ads-QA-v1.0.14.apk`.

Google's Android sample application ID is `ca-app-pub-3940256099942544~3347511713`.
Only debug uses the official demo units:

| Format | Demo unit |
|---|---|
| Anchored adaptive footer | ca-app-pub-3940256099942544/9214589741 |
| Interstitial | ca-app-pub-3940256099942544/1033173712 |
| App Open | ca-app-pub-3940256099942544/9257395921 |

Release retains app ID `ca-app-pub-3649125435732222~6082535411`, banner
`ca-app-pub-3649125435732222/1906506742`, and interstitial
`ca-app-pub-3649125435732222/6775690042`. Its separate App Open unit is optional
configuration, blank when absent; it is never substituted with an interstitial.
The Gradle guard rejects a Google demo App Open unit in release configuration.
Inspect generated release BuildConfig and merged manifest before release.

## Consent and diagnostics

UMP remains authoritative: requests require a resolved ordinary Free entitlement
and `ConsentInformation.canRequestAds()`. Debug tests EEA consent on recognized
test devices; it does not force consent or reset it. Emulators are recognized
automatically. A later physical-device EEA test must use its actual UMP test-device
hash, never a guessed identifier. Demo-unit ads are test traffic on physical
devices too, independently of UMP geography settings.

`TradingzoneNative.getAdDiagnostics()` reports consent errors/status, readiness,
SDK adapter initialization, per-format requests/load errors/response IDs,
banner size/attachment/visibility, fullscreen display/impression/dismissal,
foreground eligibility and persistent caps. Sanitize userId before exporting.
Diagnostic logs no longer include account IDs in entitlement updates.

The trusted-origin `reloadTestAds()` bridge is **debug only** (returns false in
release). It starts fresh test loads for network/retry QA only after Free and
consent resolution and outside fullscreen/consent flows. It does not display a
fullscreen ad, change entitlement/consent, or reset counters/cooldowns. Earlier
load generations are invalidated. It must never become a production retry bypass.

## Reproduction and safeguards

1. Sign into an existing authorized Free account; complete UMP as the tester.
   Observe an anchored test banner above navigation on eligible browsing screens.
2. Complete three actual browsing transitions and at least 60 seconds of
   foreground use since session start/last impression. Only the next safe natural
   transition can show a loaded interstitial; clocks alone never trigger it.
3. After onboarding, let App Open preload. Leave a safe browsing screen for at
   least 30 seconds, then return after the shared fullscreen cooldown. Show only
   immediately on resume, with valid consent/entitlement, available ad and no
   positions/pending orders/trading/authentication. Skip cold-start or late loads.
4. Use the SDK's close/Continue controls; verify dismissal, short resumes and
   Google picker return do not produce duplicate fullscreen ads. Never click a
   production ad or modify SDK dismissal behavior.
5. Disable emulator connectivity, request fresh QA loads, and observe genuine
   errors while navigation remains responsive. Restore the previous connectivity
   state and observe bounded retry/recovery. Do not fabricate no-fill responses.
6. Switch existing authorized Free/ad-free accounts without wiping app data.
   PRO/UNKNOWN clear ad instances and pending callbacks; ad-free accounts must
   add zero requests/preloads/displays. Rolling device caps must not decrease.
   An unavailable ad-free account is NOT VERIFIED, never replaced by a new grant.

Session cap 6, rolling device 24h cap 12, shared cooldown, trading/authentication
exclusions and impression-based counting are unchanged. Fullscreen preloading now
waits until the currently showing ad dismisses; this avoids redundant requests
and discarding a newly loaded ad in the old ad's dismissal callback.

The App Open foreground decision runs from the resumed Activity instead of
waiting for window focus. The observed focus delay previously exhausted the
display window. Authentication/lock-screen/exposure/consent/fullscreen guards
still apply, and a late load callback never shows an ad.

## Observed results and limits

Emulator: real existing Free account, UMP OBTAINED/canRequestAds true, Google adapter
READY, actual banner/interstitial/App Open test creatives and impressions,
dismissal, chart exclusion, short resume, network errors and automatic retry
recovery. Persistent fullscreen counts survived APK updates and process restarts.
Native tests: 7 passed. WebView tests: 33 passed, including Free Launch feature
access remaining separate from ad-free entitlement.

Physical phone and live ad-free account were unavailable. Physical rendering,
live Premium-to-Free switching, zero requests for a real ad-free account, and a
dedicated Google-picker-return scenario remain NOT VERIFIED. Pure policy tests
are not substitutes for those runtime checks. No membership was changed.

Production release logs separately showed UMP error 3, no forms configured for
the production app ID, and load error 3, "Account not approved yet." Initialization
did complete on the observed release launch. These are evidence of production
configuration/readiness issues, not a reason to bypass consent. In the existing
AdMob app, review Privacy & messaging and configure/publish the applicable privacy
message with the actual policy URL and settings; inspect the account approval /
app-readiness tasks shown in AdMob. This task does not approve an account, link a
store, verify the crawler or demonstrate production fill/earnings. A separate
production App Open unit is needed before enabling that format in release.

Local evidence is in `evidence/adqa/` (ignored). See its REPORT.md for APK hash,
commit and the exact screenshots/videos/diagnostic traces. No Play publication,
DNS/database changes, service purchase or production-ad clicks are part of QA.

References: [Google demo units](https://developers.google.com/admob/android/test-ads),
[UMP](https://developers.google.com/admob/android/privacy),
[App Open](https://developers.google.com/admob/android/app-open).
