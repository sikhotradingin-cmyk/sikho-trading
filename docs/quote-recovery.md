# Market-data freshness and contract ownership

The production runtime is Kotlin MainActivity hosting `packages/mobile/android/app/src/main/assets/www`. The backend remains Upstox, without a DEMO fallback. Version 1.0.12 / Android code 22 addresses the reported NIFTY spot / futures ticket regression.

## Findings and safeguards

- The spot chart and the order ticket can represent different instruments. The ticket previously made a one-off quote request but was absent from reconnect's desired subscriptions. It now owns its actual contract until closed, independently of chart, chain, watchlist and position ownership. Closing/switching a chart cannot release a contract still needed by an active ticket/position.
- Front futures are selected from tradable, unexpired master results with matching underlying, positive lot/tick size and sorted expiry. No replacement expiry is hardcoded. At investigation the active production master resolved **NFO:NIFTY23NOV26FUT:61471**, **NSE_FO|61471**, expiry **2026-11-23**, lot **65**, tick **₹0.10**. Spot is **NSE:NIFTY 50:99926000**, **NSE_INDEX|Nifty 50** and remains non-tradable.
- V3 `currentTs` is the provider event epoch, while `ltpc.ltt` is the last trade epoch. Both are parsed/normalized into distinct UTC millisecond fields. REST uses Upstox's actual `timestamp` and `last_trade_time`. Missing provider time is never replaced with local receipt time. Snapshot/heartbeat receipt does not rejuvenate a cached quote. Future/invalid source clocks are rejected by execution freshness checks.
- The existing **5000 ms** maximum is retained: execution checks the greater age of source event and backend receipt, with same-contract identity checks. Market-closed, margin, lot, tick, expiry and idempotency rules remain in force. Stale pending triggers and square-offs also fail safe. Client submission is disabled with “Live price unavailable — reconnecting”; recovery never submits an order automatically.
- Deduplication is per canonical instrument and source event. Old socket handlers are ignored; reconnect replays current subscriptions. Late REST snapshots cannot roll back a newer WS quote. History loads buffer genuine ticks; reconnect merges preserve bars updated while the request was in flight. A failed/429 history response is explicit and preserves valid same-timeframe bars, rather than silently replacing them with an empty successful result. Different-timeframe data is never silently relabelled.
- Historical bars are reference data and no longer populate the executable quote cache. Initial cached snapshots cannot manufacture a new bar. Genuine REST recovery can advance a candle only after the provider's actual last-trade timestamp advances; candle bucketing uses that trade time, not a heartbeat or request clock. Source UTC epochs, IST display and session boundaries are retained.

## Upstream connection and bounded recovery

During investigation NSE was open. The existing authorize-URL flow returned HTTP 200 at authorization but the WebSocket handshake returned **403**. The official Upstox Node SDK's direct authenticated V3 WSS flow was also tested and received 403. This is not reported as a verified V3 streaming recovery or assumed to be a password/token-expiry diagnosis. The backend retains TLS certificate validation and bounded reconnect backoff.

Real REST quotes initially recovered successfully. A longer run exposed HTTP **429** and the need to cover rolling limits, not only per-second bursts. The final recovery implementation:

- Coalesces concurrent requests and batches up to 100 provider keys into a single Full Market Quotes request; each response is matched by exact `instrument_token`.
- Retains the provider's original quote/trade epochs. It never timestamps a cache hit as fresh, borrows spot prices for a future, or creates executable data from candles.
- Limits this process to 4 requests/second, 240/minute and 1,500/30 minutes, below the published standard API limits. Provider limits apply across the relevant upstream account/API; external clients and rolling usage before a deployment are not reset by our process restarting.
- Honors `Retry-After` on 429, otherwise uses bounded 30/60/120/240/300-second backoff. During backoff the app continues normally with stale/unknown prices clearly unavailable for execution.
- Prioritizes active charts/tickets, refreshes priority every 30 seconds and rotates background recovery fairly. This does not create duplicate upstream subscriptions. Missing inventory/data or provider authorization cannot be bypassed by priority.

REST recovery is explicitly labelled separately from the app WebSocket connection and from Upstox V3 availability. It does not promise tick-for-tick completeness, a price change every second or continuous data during a provider outage/quota block.

## Token-free diagnostics

`GET /api/v1/market-data/quote?globalId=<canonical ID>` returns request ID, server UTC time and instrument diagnostics behind the existing access checks: provider key, subscription state/listener count, subscription send time, last provider event, last trade, backend receipt, source/timestamp source, ages, REST HTTP/error state and decoder/subscription error counts.

`GET /api/v1/feed-health` distinguishes provider WS connection/HTTP status, app WS emissions, actual forming trades and REST recovery request/backoff counters. A current app WS emission or clock/countdown is not proof of a fresh provider quote.

In an authorized debug WebView, `TZApp.getMarketDataDiagnostics()` returns chart and ticket identities separately, actual source/receipt/render epochs, client/server clock offset, desired ownership, current candle tail and quote age. It returns no auth token, password or account financial record. Instrument exchange tokens such as 61471 are public instrument identifiers, not credentials.

Never log bearer tokens, authorized signed WS URLs, Google credentials or passwords. Upstream error telemetry retains HTTP status and safe error/request codes only.

## Verification discipline

Focused automated coverage includes fresh spot/stale future, exact identity, timestamp units/invalid clocks, stale cached packets, provider reference ownership/reconnect, quote batching/429 backoff/rolling budgets, genuine REST trade progression, history-reference isolation, chart/history races and timeframe/socket switching. Backend tests use isolated databases.

Installed live verification uses an **isolated pg-mem account** with genuine production Upstox market data relayed read-only for the two NIFTY instruments. It does not trade a production account or change production balances/history. The isolated clock is synchronized to the measured server UTC offset; original provider/receipt epochs are never rewritten. Controlled relay interruption is identified separately from a real upstream outage. Any observed 403/429, missing history or failed rollover remains a FAIL/NOT VERIFIED result; passing build/countdown checks do not establish live success.

Official sources: [V3 schema and timestamp semantics](https://upstox.com/developer/api-documentation/v3/get-market-data-feed/), [Full Market Quotes](https://upstox.com/developer/api-documentation/get-full-market-quote/), [official Node V3 feeder](https://github.com/upstox/upstox-nodejs/blob/master/src/feeder/MarketDataFeederV3.js), [rate limits](https://upstox.com/developer/api-documentation/rate-limiting/).
