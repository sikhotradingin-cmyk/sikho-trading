# Owner controls: Free Launch and ads

The shipped Android runtime is the Kotlin/WebView application in `packages/mobile/android`. The backend is authoritative; launch access is independent of billing and ad-free membership.

## Render configuration

In Render, open the Web Service serving `https://sikho-trading-api.onrender.com`, then **Environment**:

1. Add/set `SIKHO_ACCESS_MODE=FREE_LAUNCH` and use **Save, rebuild, and deploy** (or Save and deploy).
2. Verify `GET /api/v1/access` reports `accessMode: FREE_LAUNCH`. For an authenticated ordinary account, `fullFeatureAccess` is true, `adsRequired` is true and its verified billing tier remains FREE.
3. To end the promotion later, explicitly set `SIKHO_ACCESS_MODE=STANDARD`, then save/deploy and verify the endpoint. **Do not do this as part of this launch.**

Production defaults to FREE_LAUNCH when the variable is absent; isolated tests default to STANDARD. An unknown value fails closed to STANDARD. Set the production variable explicitly to make the owner's choice visible in Render. No download threshold, registration counter or timer ends the promotion. The actual download measurement source is **not configured/verified**. Approximately 1,000 downloads is a business goal, not an invented automatic counter.

After the first installation of v1.0.11+, mode changes require no new APK or login: the client polls authoritative access every 30 seconds, account responses carry the same policy, and reconnect authenticates/reconciles WSS after a deployment. All REST order/capital checks and WSS subscriptions re-resolve access on the server. STANDARD restores the existing normal instrument matrix. Viewing existing exposure, cancellation and risk-reducing exits remain permitted; access-change wording explains the transition. Balances, historical records and paid/grant entitlements are not changed by this flag.

Launch capital uses the existing approved Premium presets, not arbitrary balance edits. Existing genuine ad-free subscribers and complimentary owner grants remain ad-free. Launch access never writes PRO, creates grants or invents purchases.

## Production AdMob setup

Existing application: `ca-app-pub-3649125435732222~6082535411`, Android package `com.indianpapertrading`.

1. In AdMob **Apps**, select the app matching that application ID. Under **Ad units**, verify banner `ca-app-pub-3649125435732222/1906506742` is a banner and `ca-app-pub-3649125435732222/6775690042` is an interstitial. The previously captured production SDK error was code 3, `com.google.android.gms.ads`, **Publisher data not found**. Check the account/unit setup against that actual response; do not assume a suspension or sideload-only cause.
2. Create a **new App open** ad unit for that same application, for example named “Sikho Trading App Open”. Copy its exact unit ID. Do not reuse either existing banner/interstitial ID. No production App Open unit was supplied in this workspace.
3. In Render Environment set **`SIKHO_APP_OPEN_AD_UNIT_ID=<the new App open unit ID>`**, then save/deploy. The authenticated access response supplies this public configuration to v1.0.11+; the native bridge validates the app publisher and rejects the known banner/interstitial IDs. It takes effect in existing sessions after the policy refresh, without an APK rebuild. When empty, production App Open safely skips and reports `PRODUCTION_APP_OPEN_UNIT_NOT_CONFIGURED`. Debug builds always use Google's official App Open test unit.
4. Inspect the actual app readiness/account status and Policy Center messages in AdMob. Complete only the actions the console identifies. If it asks for store linkage, link the actual published Android listing; don't invent a store listing or infer readiness from a successful debug test ad.
5. In AdMob's **app-ads.txt** section inspect the expected developer website URL and the account's supplied publisher line. Publish/verify that exact line at the required website root if the console reports it missing. No developer website ownership, app-ads.txt verification or store download measurement was established by this task.
6. Retest production load/impression callbacks after configuration propagates. No-fill, inventory and consent can still prevent an impression. Never click production ads for testing.

Official guidance: [App Open Android integration](https://developers.google.com/admob/android/app-open), [App Open placement guidance](https://support.google.com/admob/answer/9341964), [publisher-data/load troubleshooting](https://support.google.com/admob/answer/9905175).

Only one anchored adaptive footer banner is used on eligible browsing screens. Fullscreen formats share persistent impression timestamps, a 60-second cooldown and caps of 6 per browsing session / 12 per rolling day. Session counts survive short relaunches/account switches; a session expires after 30 minutes away. Interstitials additionally require three completed browsing actions and 60 seconds foreground use. App Open preloads after initial browsing and may show immediately on a genuine safe foreground return after at least 30 seconds away; absent/late/expired inventory is skipped. Cold starts do not wait for an ad. Interaction closes the foreground opportunity. Account picker returns, consent/system dialogs, ad dismissal, background/lock screen, trading workspaces and exposure/pending orders are excluded. SDK controls are retained.

## History and migration safety

Migration `007_execution_history.sql` is additive: actual fills, closing executions, residual entry-cost basis and pending execution context. No existing balances, watchlists, subscriptions, grants or historical orders are deleted/reclassified. Back up production before deployment; normal tests use isolated pg-mem, never the production connection.

History is account-scoped, indexed, paginated and read-only through the public API. One realized **closing execution** counts as one exit; scale-outs are separate completed reductions, while repeat order updates/idempotent requests never add another result. Weighted-average entry price matches execution accounting. Entry charges are allocated by closed quantity with paise remainders carried forward. Win rate = positive net exits / all known-cost exits, including breakeven. Opening orders, cancelled/rejected orders and capital resets are not losing trades or profit. The engine currently supports full-order fills, so partial-fill status/count is honestly shown as unsupported/zero.

Older ledger settlements remain visible, with actual gross P&L included. Missing historical entry matches, timestamps or allocated costs remain unavailable; aggregate net/charges are unavailable when old coverage is incomplete. No fictional backfill is performed. New records survive capital resets and engine restarts; authenticated realtime invalidations reconcile Orders/Portfolio/History and reconnect performs an authoritative refresh. The existing subscription, Play verification and audited complimentary-grant/revoke mechanisms are retained.

New watchlists are empty. Existing rows lack reliable provenance distinguishing the old automatic template from manual edits, so they are preserved. “Clear watchlist…” explicitly confirms removal of instruments and does not touch positions or trading history.
