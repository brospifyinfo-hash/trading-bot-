# Offensive paper launch mode

The existing Standard account stays on the historical momentum strategy (score 75).
The Offensiv account keeps its strategy ID and ledger, now using version 1.2.0 and
paper-launch-1.0.0 scoring (entry score 50). It is driven only by fresh launch events.

The consumer opens one WebSocket to `wss://pumpportal.fun/api/data`, subscribing
only to `subscribeNewToken` and `subscribeMigration`. These feeds are documented
as free: https://pumpportal.fun/data-api/real-time/ and https://pumpportal.fun/fees/.
No paid trade subscriptions, wallet, transaction submission or signer is used.
A September 29 smoke check received both creation and migration events without a key.
This covers that provider's events, not every Solana pool. No replay guarantee is made
for disconnections; counters reset on worker restart. The feed reconnects with backoff.

An event queues PAPER_SNIPER, on a separate paper consumer, without waiting for the
ordinary 20-coin rotation. The bounded feed dispatches up to four new candidates/minute,
prioritizing migrations. Overload/stale drops are counted. Events expire after ten minutes.
Security/market availability can retry four times, at least 60 seconds apart. This is
not an assurance of buying every launch or filling in the first block. Jupiter and
DexScreener must already support the market; pre-migration bonding-curve execution
is not implemented. Newly unsupported markets are explicitly reported as waiting.

The handler checks the blacklist, avoids re-buying previously traded launch tokens,
loads a fresh RugCheck report, rejects reported rugs, ingests executable market data,
then uses the existing paper account, quote preflight and execution path. Existing
risk caps, exit rules, fees, position locks, daily loss and account reconciliation apply.

Launch scoring requires all 13 selected current security/market/execution inputs.
Weights: security 35%, liquidity 25%, execution 25%, buy transaction share 15%.
It requires at least three buys and more buys than sells. Counts are not unique buyers,
and the activity component is not a price-return measurement. Historical return fields
stay missing in stored features. These weights and rules are experimental, not validated
as profitable. Market features over 60 seconds old are rejected; preflight also rechecks age.
The launch model is rejected for live execution mode.

A `paper-sniper:feed` checkpoint supplies heartbeat/counters to the dashboard, and recent
PAPER_SNIPER job results supply per-token outcomes, score and receive-to-result latency.
No database migration is required. PAPER_STRATEGY=memecoin-risk-managed-v1 enables
this with the existing deployment. PAPER_SNIPER_ENABLED=false stops the feed and
sniper consumer (Standard continues). The dashboard reports stale heartbeat explicitly.

Both accounts also evaluate the ordinary discovered-market rotation. Launch events provide an additional offensive fast path. Market probes and paper execution share a per-origin request gate in the worker (2 seconds between starts, 8-second cooldown after HTTP 429). Provider-health in another process is outside this local budget. Sell failures retain their quote/valuation cause so transient quote failures can be retried.
