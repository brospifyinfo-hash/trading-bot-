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
| **discovery** *(Handler)* | IMPLEMENTED | DexScreener `token-profiles` + `tokens/v1` | neue Tokens mit Zustand | `tokens` | `DISCOVER_TOKENS` | über Consumer | nein | `UNIQUE (mint)` | **TOKEN_DISCOVERY** | — |
| **enrichment** | BLOCKED | Tokens | Sicherheit, Holder | `token_security`, `token_wallet_metrics` | — | — | — | — | **RugCheck, Helius** | Tokens |
| **scoring** | GEBAUT, NICHT VERDRAHTET | Feature-Vektor | `ScoringResult` | `scores` | `SCORE_TOKEN` | über Consumer | nein | Snapshot-Hash | keiner | **Snapshot-Historie** |
| **decision** | GEBAUT, NICHT VERDRAHTET | Score, Risiko, EV | `Decision` | `opportunities`, `feature_snapshots` | `EVALUATE_OPPORTUNITY` | über Consumer | nein | `UNIQUE (token, stream, decided_at)` | keiner | **Features** |
| **paper** | GEBAUT, NICHT VERDRAHTET | Gelegenheit | Position | `paper_positions`, `paper_position_events` | `MONITOR_PAPER_POSITION` | über Consumer | nein | `UNIQUE (opportunity_id)` | **Router-Quote** | Gelegenheiten |
| **positions** | BLOCKED | offene Positionen | Exits | `paper_position_events` | `MONITOR_PAPER_POSITION` | über Consumer | nein | optimistische Sperre (`version`) | **Marktdaten** | offene Positionen |
| **reconciler** | BLOCKED | Positionen, Chain | Abgleich | `reconciliation_events` | `RECONCILE` | über Consumer | nein | — | **RPC** | Live-Positionen |
| **alerts** | GEBAUT, NICHT VERDRAHTET | Manual-Gelegenheit | E-Mail | `alerts`, `email_alerts` | — | Resend-Idempotenzschlüssel | nein | `idempotency-key` je Gelegenheit | **Resend** | Gelegenheiten |
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

`discovery` läuft seither als Auftrag `DISCOVER_TOKENS` im `consumer` und ist
damit Schritt 0 dieser Kette: ohne Token in `tokens` meldete `market-refresh`
dauerhaft `NO_TOKENS`. Die gleichnamige **Rolle** `WORKER_ROLE=discovery` bleibt
absichtlich leer — zwei Takte für dieselbe Arbeit wären doppelte
Anbieteranfragen.

Eine Lücke bleibt offen und ist im Lauf gezählt: Mint- und Freeze-Authority
stehen im Mint-Account on-chain, und dafür gibt es kein geprüftes Lesemodul.
`cheapScreen` lehnt bei **unbekannten** Autoritäten nicht ab — ein Token mit
aktiver Mint-Authority kommt also durch das Vorsieb. Die Einstiegsentscheidung
fängt es ab (`securityScore` → `notComputable` → `dataCompleteness` unter
`minDataCompleteness` → `DATA_INCOMPLETE`), aber das Feld
`withoutAuthorityCheck` im Log sagt, wie oft das passiert.

## „READY — WAITING FOR DATA" war zu freundlich

Der Status stand bei `scoring`, `decision`, `paper` und `alerts` und las sich
wie „fertig, wartet nur auf Daten". Das stimmt nicht.

`runOpportunityPipeline` — die Kette aus Bewertung, Entscheidung, Gelegenheit
und Paper-Position — wird **ausschliesslich aus Tests aufgerufen**. Kein
Handler ruft sie. Die Auftragsarten `SCORE_TOKEN`, `EVALUATE_OPPORTUNITY`,
`MONITOR_PAPER_POSITION`, `RECONCILE`, `STRATEGY_HEALTH` und `RESEARCH_BATCH`
zeigen alle auf denselben generischen Marktdaten-Handler, der Daten holt und
das Ergebnis wegwirft.

Das ist **exakt dieselbe Luecke wie bei der Discovery** (DECISIONS §87): alles
gebaut, alles getestet, nur ruft es niemand zusammen auf. Dort war die
Diagnose „ein Sieb braucht jemanden, der Sand hineinschuettet". Hier wurde die
Diagnose beim Nachbarn gestellt und beim Rest nicht wiederholt.

Bekaeme das System morgen einen Preis mit bekanntem Alter, passierte trotzdem
nichts: es gibt keinen Weg von einem Snapshot zu einer Bewertung.

Der Status heisst deshalb jetzt **GEBAUT, NICHT VERDRAHTET** — nicht schoener,
aber richtig.
