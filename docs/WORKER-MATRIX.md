# Worker-Matrix

Welcher Worker was tut — und woran die noch nicht gebauten hängen.

Die Reihenfolge ist die Abhängigkeitskette. Jeder Worker braucht, was der
vorherige produziert; deshalb ist die Frage „welchen bauen wir als nächstes"
nicht frei wählbar.

## Die Kette

```
DISCOVERY → ENRICHMENT → FEATURES → SCORING → DECISION → OPPORTUNITY
         → PAPER → POSITION MONITORING → RECONCILIATION → ALERTS
```

## Die Matrix

| Worker | Status | Input | Output | DB-Writes | Queue | Retry | Checkpoint | Idempotenz | Provider | Daten |
|---|---|---|---|---|---|---|---|---|---|---|
| **provider-health** | IMPLEMENTED | `PROVIDER_*`-Env | Statusbericht | `provider_status_samples` | — (eigener Takt) | keiner (nächster Takt) | nein | `UNIQUE (provider_id, observed_at)` | **keiner** | **keine** |
| **scheduler** | IMPLEMENTED | Takte, DB-Marktdatenlage | Aufträge | `job_queue` | Producer | — | nein | Fenster im `dedupe_key` | keiner | keine |
| **consumer** | IMPLEMENTED | `job_queue` | Handler-Ergebnis | `job_queue`, `job_queue_history` | Consumer | Backoff, Dead Letter | nein | `FOR UPDATE SKIP LOCKED` + Lease | keiner | keine |
| **market-refresh** *(Handler)* | IMPLEMENTED | Tokenliste | Snapshots | `token_snapshots`, `job_checkpoints` | `REFRESH_MARKET_DATA` | über Consumer | **ja** | `UNIQUE (ingest_key)` | **Marktdaten** | Tokens |
| **discovery** | READY — WAITING FOR DATA | Anbieter-Listen | neue Tokens | `tokens` | `DISCOVER_TOKENS` | über Consumer | ja (vorbereitet) | `UNIQUE (mint)` | **TOKEN_DISCOVERY** | — |
| **enrichment** | BLOCKED | Tokens | Sicherheit, Holder | `token_security`, `token_wallet_metrics` | — | — | — | — | **RugCheck, Helius** | Tokens |
| **scoring** | READY — WAITING FOR DATA | Feature-Vektor | `ScoringResult` | `scores` | `SCORE_TOKEN` | über Consumer | nein | Snapshot-Hash | keiner | **Snapshot-Historie** |
| **decision** | READY — WAITING FOR DATA | Score, Risiko, EV | `Decision` | `opportunities`, `feature_snapshots` | `EVALUATE_OPPORTUNITY` | über Consumer | nein | `UNIQUE (token, stream, decided_at)` | keiner | **Features** |
| **paper** | READY — WAITING FOR DATA | Gelegenheit | Position | `paper_positions`, `paper_position_events` | `MONITOR_PAPER_POSITION` | über Consumer | nein | `UNIQUE (opportunity_id)` | **Router-Quote** | Gelegenheiten |
| **positions** | BLOCKED | offene Positionen | Exits | `paper_position_events` | `MONITOR_PAPER_POSITION` | über Consumer | nein | optimistische Sperre (`version`) | **Marktdaten** | offene Positionen |
| **reconciler** | BLOCKED | Positionen, Chain | Abgleich | `reconciliation_events` | `RECONCILE` | über Consumer | nein | — | **RPC** | Live-Positionen |
| **alerts** | READY — WAITING FOR DATA | Manual-Gelegenheit | E-Mail | `alerts`, `email_alerts` | — | Resend-Idempotenzschlüssel | nein | `idempotency-key` je Gelegenheit | **Resend** | Gelegenheiten |
| **expire-opportunities** *(Handler)* | IMPLEMENTED | Zeit | Zustandswechsel | `opportunities` | `EXPIRE_OPPORTUNITIES` | über Consumer | nein | bedingtes `UPDATE` | keiner | Gelegenheiten |
| **execution** | **NICHT GEBAUT — bewusst** | — | — | — | — | — | — | — | — | — |

## Warum nicht mehr gebaut ist

Drei Gruppen, aus drei verschiedenen Gründen:

**BLOCKED durch fehlende Anbieter.** `enrichment` braucht RugCheck und Helius,
`positions` braucht laufende Preise, `reconciler` braucht einen RPC-Knoten. Für
keinen dieser Anbieter gibt es eine geprüfte Endpunkt-Spezifikation. Sie zu
bauen hieße, gegen eine erfundene Schnittstelle zu programmieren.

**READY, aber ohne Eingabe.** `scoring`, `decision`, `paper` und `alerts` sind
fachlich fertig — ihre Logik liegt in `@sae/scoring`, `@sae/decision`,
`@sae/trading` und `@sae/alerts` und ist getestet. Sie laufen im Ende-zu-Ende-Test
über `runOpportunityPipeline`. Was fehlt, ist die Snapshot-Historie, aus der der
Feature-Vektor entsteht — und die entsteht, sobald `market-refresh` eine Quelle
hat.

**`execution` ist bewusst nicht gebaut.** Live-Handel ist in dieser Phase
vollständig abgeschaltet. Kein Signieren, kein Senden, kein Wallet-Zugriff.

## Was als Nächstes freigeschaltet wird

Sobald **eine** Marktdatenquelle antwortet, in dieser Reihenfolge:

1. `market-refresh` schreibt Snapshots → die Historie wächst.
2. Bei genug Snapshots wird der Feature-Vektor baubar → `scoring` läuft.
3. Damit läuft `decision`, und `runOpportunityPipeline` bekommt seinen
   Live-Einstieg neben dem Fixture-Einstieg.
4. `paper` öffnet Positionen, `alerts` verschickt Manual-Gelegenheiten.

`discovery` kann parallel dazu laufen, sobald ein Anbieter mit
`TOKEN_DISCOVERY` erreichbar ist.
