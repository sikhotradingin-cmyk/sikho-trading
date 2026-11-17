# Sikho Trading developer website

Static HTML/CSS/JS output generated with Node and served by a tiny Cloudflare Worker hosting adapter for exact routes, MIME/security headers and the canonical www redirect. No app/backend/Android/database changes. The approved app icon is copied byte-for-byte from the shipped WebView assets. No stock imagery, third-party font requests, analytics or invented app-store link.

`node --test website.test.mjs` checks publisher bytes, paths, contact/ownership flow and security/redirect declarations with an isolated `.test` mailbox. It does not send email or connect to a database.

Before publishing, set the owner-confirmed monitored address in `site-config.json` and set `supportEmailConfirmed` to true. `node build.mjs` refuses an unconfirmed mailbox. Do not deploy QA addresses. Output is `dist/`; `.openai/hosting.json` pins the registered Sites project. Publishing source is mirrored through the Sites workflow into its own source repository; this directory remains tracked in the Sikho Trading GitHub repository.

The homepage checks only the public `/api/v1/access` endpoint with no credentials to keep Free Launch wording current. It never exposes API credentials or app sessions.

## Deletion-request operating procedure

This is a customer-service email pathway, not an automated account-deletion endpoint. The owner must monitor the configured mailbox and handle requests. The website opens a draft; the user explicitly sends it. No account is deleted while building/testing this website.

1. Acknowledge the request. Locate the exact existing normalized registered email and immutable user/account IDs using authorised management access. Do not create an account. Do not treat a capital reset as deletion.
2. Generate a cryptographically random, single-use challenge with at least 128 bits of entropy. Send it in a fresh email to the **registered address from the account record**, not a supplied Reply-To or alternative address. Record issue/expiry (24 hours), the scoped request and immutable IDs in the operator's restricted request record. Never log app tokens/passwords. Do not place challenges in source control.
3. Require a reply from the registered mailbox containing that challenge and explicit confirmation of account + associated-data deletion. Inspect mail authentication, not only a display name or claimed From header. Reject mismatched/expired/reused challenges; resolve suspicious requests before action. Mailbox access/recovery problems require a separately agreed safe verification method, never automatic acceptance.
4. Explain scope, irreversibility and any specific justified retention exception/period. Confirm whether Play billing requires separate cancellation. Do not invent retention obligations or retain entire profiles under a blanket exception.
5. After verified confirmation, use an authorised account-scoped deletion procedure with dependency review and transaction/rollback protections. This task does not add a public admin endpoint, delete any records or weaken authorization. Include user/profile, virtual accounts, orders/fills/positions, execution/closure/basis/context records, ledger, sessions, holdings where present, watchlists, journal, drawings/preferences and associated subscription/grant identifiers according to the agreed retention decision. Review FK dependencies rather than assuming cascading deletion covers all tables.
6. Revoke/reject previously issued sessions as part of actual fulfilment, validate account-scoped access is gone, mark the challenge consumed and send completion/retention information to the requester. Keep only a minimal restricted fulfilment record; handle backup/provider copies according to their retention process.

Do not claim a production deletion was verified by website tests. End-to-end mailbox receipt, challenge and destructive fulfilment require a separate authorised test request/account; no real user is deleted here.

## Store/ads preparation

After DNS/HTTPS are verified, set `https://sikhotrading.in/` as the developer website in Play Console → Grow users → Store presence → Store settings → Store listing contact details. Privacy URL: `/privacy`. Account deletion web URL: `/delete-account` in Data safety. An in-app path to the deletion resource is also required before claiming Play compliance; adding this website alone does not add that APK path. Do not publish a Play release as part of this task.

In AdMob select the actual app `ca-app-pub-3649125435732222~6082535411`; confirm linked store package `com.indianpapertrading` when a listing exists. Apps → View all apps → app-ads.txt → expand the app → Check for updates. Verification depends on the listing/domain and AdMob crawler, not just an HTTP 200. Check the console status; allow propagation per Google's current guidance. This website does not guarantee production ad fill or resolve unrelated account readiness/inventory errors.

Sources: [AdMob developer website/app-ads.txt](https://support.google.com/admob/answer/9363762), [Google Play deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111), [Google Mobile Ads data disclosure](https://developers.google.com/admob/android/privacy/play-data-disclosure). Privacy content was also checked against actual repository storage, manifest and SDK versions; the current Google SDK guidance describes newer SDK releases and does not replace reviewing the shipped version.
