# Sikho Trading developer website — 18 November 2026 IST

Public deployment: **https://sikho-trading.contentconch2.chatgpt.site/**. Hosting: Sites, backed by Cloudflare Workers. No hosting purchase, nameserver change, APK rebuild or database operation was performed. Source is in this existing GitHub repository under `website/`; Sites also retains the deployment's source mirror and saved versions for rollback.

Canonical custom homepage: **https://sikhotrading.in/**. Both apex and www are attached to the hosting project `appgprj_6afc9b94f4188191ac8cb98148dfbbef`. A real HTTP 301 handler redirects www to the apex, preserving path/query. Custom-domain TLS issuance/validation is **PENDING**, not verified. Public DNS queries currently report NXDOMAIN; registrar activation/delegation and DNS changes must be completed by the owner. There is no authenticated GoDaddy DNS connection in this task.

## Exact GoDaddy DNS records

GoDaddy → Domain Portfolio → `sikhotrading.in` → DNS → Records. The targets and verification values below are copied from the actual hosting dashboard, also retained in [hosting-domains.json](hosting-domains.json). **The host does not prescribe a TTL. Select GoDaddy's default 1 hour (3600 seconds)** for these records; this is a DNS setting choice, not a claimed host-issued TTL.

| Type | Name / Host | Value / Target | TTL |
|---|---|---|---|
| A | `@` | `162.159.143.30` | 1 hour / 3600 |
| A | `@` | `172.66.3.26` | 1 hour / 3600 |
| CNAME | `www` | `custom-domains.chatgpt.site.` | 1 hour / 3600 |
| TXT | `_openai-site-verification` | `openai-site-verification=EvsIAs1iFMeD_PezPBPUMvETHeSWt4xgcYHbjIkiNJg` | 1 hour / 3600 |
| TXT | `_cf-custom-hostname` | `e90a3b8c-b1b9-478c-952f-4af9b9c5358b` | 1 hour / 3600 |
| TXT | `_openai-site-verification.www` | `openai-site-verification=J44zgjCtCB5V-07EJwGDybjHw9NlWR9DIUkgq61R2iw` | 1 hour / 3600 |
| TXT | `_cf-custom-hostname.www` | `2ccf4ec0-1505-4df9-a1c5-cb22590205f8` | 1 hour / 3600 |

Use those short Host names; GoDaddy appends `sikhotrading.in`. Enter TXT values without adding literal quotes. The CNAME trailing dot denotes a fully qualified target; GoDaddy may normalize it away.

Preserve all existing MX, email-related TXT (SPF/DKIM/DMARC), mail/autodiscover CNAMEs and unrelated DNS. Append the verification TXT records; do not replace the whole TXT set. Only replace conflicting website-only apex A/AAAA/parking or www records after reviewing them. Do not add an invented IPv6 record, point anything at the Render API, or change nameservers. If an existing mail record depends on an apex address being changed, coordinate with the mail provider before replacement. If GoDaddy shows the domain purchase as pending or not yet active, resolve that first; do not buy a second domain/hosting plan to work around it.

After saving records, wait for public DNS propagation, then refresh custom-domain status in Sites until both hostname and SSL status are active. Verify HTTPS on both hosts and the www → apex 301. Do not disable certificate checking or claim HTTPS verified while certificates are initializing. Inspect any additional certificate-validation instructions if the hosting dashboard reports them; no speculative CAA changes were made.

## Public checks already completed

- PASS: `/`, `/privacy`, `/support`, `/delete-account`, `/app-ads.txt` return HTTP 200 on the deployment URL. The final hosting adapter serves exact clean paths and security headers; previous static-host cached slash redirects may expire separately.
- PASS: `/app-ads.txt` returns **text/plain**, with exactly `google.com, pub-3649125435732222, DIRECT, f08c47fec0942fa0` and a final newline. No HTML wrapper, sign-in gate or extra publisher line. Verified both the ordinary URL and fresh-cache request.
- PASS: 9 isolated website tests, including canonical redirect, exact publisher bytes, route/link resolution, configured mailto target, deletion ownership instructions, safe methods and refusal to publish an unconfirmed mailbox. No tests connect to the user database.
- PASS: browser QA at 320/390 mobile widths and 1440 desktop, 9 page/viewport combinations: no horizontal overflow, broken images or JS exceptions. Approved logo copied without alteration; no fabricated downloads/testimonials, public APK link or Play listing. Screenshots/check output are in local `evidence/website/` (not committed with personal captures).
- PASS: feature wording follows the backend's public access mode without app credentials. Existing API URL remains `https://sikho-trading-api.onrender.com`. No backend/Android source or database migration changed. A GitHub master push may cause the existing Render auto-deploy pipeline to rebuild unchanged backend code; no Render configuration change was requested or made.
- PENDING: `https://sikhotrading.in` and `https://www.sikhotrading.in` DNS/HTTPS and custom-domain app-ads.txt fetch. The deployment URL's valid certificate does not prove custom-domain TLS.
- NOT VERIFIED: actual inbound support email, challenge delivery/reply or destructive account-deletion fulfilment. The owner selected **support@sikhotrading.in**, but public MX DNS is not visible yet. A mailto link is a real email request path, not proof of mailbox delivery. No support test email or real deletion was sent/performed.

## Support and deletion operation

Ensure **support@sikhotrading.in** exists and is monitored with the chosen email provider. Preserve or add only that provider's actual MX/SPF/DKIM/DMARC records; the website host does not supply email service or mail targets. Test inbound mail, reply delivery and the verification workflow before marking it operational.

The public deletion page prominently provides a mailto request with manual-email fallback. The sender must actually send the draft. Support sends a fresh one-use challenge to the registered address from the existing account record; a reply from that mailbox with the matching challenge and explicit confirmation is required before an authorized account-scoped deletion. No automatic database deletion endpoint or decorative submission form was added. [README.md](README.md) contains the operator procedure, dependencies and security steps. Request handling is manual; support must perform it. No account deletion was tested against production.

## Remaining Play Console / AdMob actions

1. Finish DNS, custom-domain TLS and support mailbox verification above.
2. In Play Console → Grow users → Store presence → Store settings → Store listing contact details, set website to **https://sikhotrading.in/** and the confirmed support email. Privacy policy URL: **https://sikhotrading.in/privacy**. Enter **https://sikhotrading.in/delete-account** as the web deletion resource in Data safety. Review the actual SDK/data disclosures. Do not claim full Play compliance until the in-app deletion path and real request fulfilment are also available; this website-only task does not add an APK path or publish a release.
3. In AdMob choose the actual Android app **ca-app-pub-3649125435732222~6082535411**, package **com.indianpapertrading**. Confirm its real store linkage when a listing exists; no Play Store link/listing/download count was invented here. Google uses the developer website from the store listing to discover the publisher file.
4. AdMob → Apps → View all apps → app-ads.txt → expand the app → Check for updates. Confirm it crawls **https://sikhotrading.in/app-ads.txt** and reports the publisher verified. Google says detection/crawling can take up to 24 hours after listing/file changes. Inspect the actual console result rather than treating an HTTP 200 as account approval.
5. Resolve only actual account/readiness/Policy Center errors shown by AdMob. This file does not guarantee ad fill or fix unrelated SDK/account configuration errors. Do not click production ads for testing.

Official references: [GoDaddy A records and default TTL](https://www.godaddy.com/en-in/help/add-an-a-record-19238), [AdMob website/app-ads.txt setup](https://support.google.com/admob/answer/9363762), [Play deletion resource requirements](https://support.google.com/googleplay/android-developer/answer/13327111).
