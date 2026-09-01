# Provider-Integrationsplan

**Stand:** 2026-09-01 · **Revision:** 2 (nach deinen Entscheidungen) · **Status:** Analyse, kein Code
**Nächster Schritt:** deine Freigabe für **einen** Provider und **eine** Capability

---

## 0. Vorbemerkung: was hier verifiziert ist

Gemessen in dieser Umgebung, nicht angenommen:

| Zugang | Ergebnis |
|---|---|
| `curl` auf alle sechs Doku-Hosts | `000` |
| `WebFetch` auf `docs.birdeye.so`, `developers.jup.ag` | `EGRESS_BLOCKED` |
| `WebSearch` | funktioniert |

Ich kann **keine Dokumentationsseite lesen**. Suchergebnisse liefern Titel, URLs
und die Zusammenfassung eines kleinen Modells — daraus entsteht kein
Response-Schema.

Zwei Korrekturen an Annahmen aus deiner Nachricht, beide klein:

1. **`SOCIAL_SIGNALS` existiert bereits** (`packages/providers/src/capability.ts:41`).
   Es muss nicht ergänzt werden. Die Capability-Landschaft hat heute acht Werte,
   nicht sieben.
2. **`decisionId` wird berechnet, aber nie gespeichert**
   (`apps/worker/src/pipeline/opportunity-pipeline.ts:167`). Ohne Persistenz kann
   `feature_observations.decision_id` nichts referenzieren. Siehe Abschnitt N.

---

## C. Evidenzstufen und die zwei neuen Reifegrade

Die vier Erkenntnisstufen bleiben. Sie beantworten: **woher weiß ich das?**

| Stufe | Bedeutung |
|---|---|
| **V** | Primärquelle in dieser Umgebung gelesen |
| **S** | Aus deiner Spezifikation, dir zugeschrieben |
| **C** | Suchtreffer belegt die Existenz einer Seite oder gibt eine Zahl wieder |
| **U** | Unverifiziert |

Neu daneben zwei **Reifegrade**, die eine andere Frage beantworten: **wie weit
darf der Code damit gehen?** Das ist bewusst getrennt — eine Erkenntnisstufe
sagt nichts über Produktionsreife.

### `IMPLEMENTATION_CONFIDENCE`

| Wert | Heißt |
|---|---|
| `NONE` | Kein Vertrag. Kein Code. |
| `SHAPE_ONLY` | Endpunktname bekannt, Schema nicht. Höchstens eine Capability-Hülle. |
| `SCHEMA_KNOWN` | Feldnamen und Typen bekannt. Parser und Contract-Tests möglich. |
| `SCHEMA_VERIFIED` | Aus Primärquelle (OpenAPI, `llms.txt`, aufgezeichnete Antwort). Adapter baubar. |

### `PRODUCTION_VERIFIED`

Ein Boolean, und nur der echte Smoke-Test setzt ihn: DNS → TLS → HTTP → Auth →
Endpunkt → Schema → Zeitstempel → Normalisierung, gegen die echte API mit
echtem Schlüssel.

**Die Regel, die daraus folgt:**
`PRODUCTION_VERIFIED = false` → der Provider erreicht nie `CAPABILITY_READY`,
egal wie gut das Schema dokumentiert ist. Und `SCHEMA_VERIFIED` allein
rechtfertigt keinen Eintrag in `MARKET_DATA_PRIORITY`.

Heute gilt für **jeden** der sechs Anbieter: `PRODUCTION_VERIFIED = false`.

---

## A. Finale Capability-Matrix

Deiner Vorgabe folgend habe ich meinen eigenen Vorschlag von acht neuen
Capabilities auf **fünf** gekürzt. Der Maßstab: eine Capability verdient einen
eigenen Wert nur, wenn (a) die Kette sie unabhängig auflösen kann, (b) sie eine
eigene Staleness-Policy hat und (c) ein Anbieter für sie **einzeln** `READY`
sein kann.

### Bestehend (8) — unverändert

`TOKEN_DISCOVERY` · `TOKEN_MARKET` · `PRICE_HISTORY` · `ROUTE_QUOTE` ·
`SWAP_TRANSACTION` · `SECURITY_REPORT` · `HOLDER_DISTRIBUTION` · `SOCIAL_SIGNALS`

### Neu (5) — mit Begründung

| Capability | Warum eigenständig | Erste Nutzung |
|---|---|---|
| `TOKEN_TRADES` | Ereignisliste, kein Aggregatzustand. Andere Form, andere Staleness (Sekunden statt Minuten) als `TOKEN_MARKET`. | Momentum-Stufe |
| `TOKEN_IDENTITY` | **Unveränderliche** Daten (Creator, Erstellungszeit, Decimals). Einmal holen, permanent cachen — ein Kostenprofil, das keine andere Capability hat. | Identitätsstufe |
| `SMART_MONEY` | Anbieterabgeleitet, eigene Tarifstufe (S: paketabhängig). Kann `NOT_READY` sein, während `TOKEN_MARKET` läuft. | Discovery |
| `ONCHAIN_HISTORY` | Rohe Transaktions- und Wallet-Historie. Grundlage aller eigenen Ableitungen. | Wallet-Forschung |
| `MARKET_STREAM` | **Eigene Gesundheit.** Ein WebSocket kann tot sein, während REST antwortet. Ohne eigene Capability meldet Provider-Health `CONNECTED` für einen Anbieter, der nichts mehr pusht. | Discovery, Monitoring |

**Zusammenlegungen gegenüber Revision 1**, im Sinne deiner Minimalvorgabe:

- `TOKEN_CREATION` + `TOKEN_METADATA` → **`TOKEN_IDENTITY`**. Beides sind Stammdaten
  eines Tokens; sie über verschiedene Endpunkte zu holen ist eine
  Adapter-Frage, keine Capability-Frage.
- `WALLET_ACTIVITY` + `TRANSACTION_HISTORY` → **`ONCHAIN_HISTORY`**. Beides ist
  „lies On-Chain-Historie, gefiltert nach Adresse oder Signatur". Eine Fähigkeit,
  zwei Filter.

### Zurückgestellt (1)

`EXECUTION_SIMULATION` — sinnvoll, aber erst relevant, wenn tatsächlich
Transaktionen gebaut werden. Paper Trading braucht sie nicht. **Wird ergänzt,
wenn Live-Ausführung ansteht, nicht vorher.**

### Nicht aufgenommen (10) — Begründung je Fall

| Abgelehnt | Grund |
|---|---|
| `DEV_ACTIVITY`, `INSIDER_ACTIVITY`, `SNIPER_ACTIVITY`, `BUNDLER_ACTIVITY` | **Features**, keine Capabilities. Sie kommen als Felder in `SECURITY_REPORT` (Solana Tracker Risk) oder werden von uns aus `ONCHAIN_HISTORY` abgeleitet. Eine eigene Capability hätte keinen eigenen Endpunkt und keine eigene Bereitschaft. |
| `RPC` | **Transport**, nicht Fähigkeit. Gehört als `rpcUrl` in die Provider-Konfiguration. |
| `TOKEN_RISK` | Duplikat von `SECURITY_REPORT` |
| `TOKEN_SOCIAL` | Duplikat von `SOCIAL_SIGNALS` |
| `LIQUIDITY_HISTORY` | Dieselbe Endpunktfamilie wie `PRICE_HISTORY` |
| `WALLET_HISTORY` | Zeitfenster von `ONCHAIN_HISTORY` |
| `EXECUTION_QUOTE` | Duplikat von `ROUTE_QUOTE` |
| `TRANSACTION_STREAM`, `REALTIME_MARKET_STREAM` | Von `MARKET_STREAM` abgedeckt |

**Ergebnis: 8 + 5 = 13 Capabilities.** Der Diff zu heute ist ein
Enum-Wert-Zuwachs von fünf; die Kette, `resolveFromChain` und
`ProviderStatusReport` ändern sich nicht.

---

## B. Provider-Matrix

| Provider | Auth | Doku lesbar | `IMPLEMENTATION_CONFIDENCE` | `PRODUCTION_VERIFIED` | Adapter |
|---|---|---|---|---|---|
| Birdeye | API-Key (S) | nein | `SHAPE_ONLY` | **false** | nein |
| Solana Tracker | `x-api-key` (S) | nein | `SHAPE_ONLY` | **false** | nein |
| DexScreener | keine (S) | nein | `SCHEMA_KNOWN` | **false** | nein |
| Helius | Key in URL (S) | nein | `SCHEMA_KNOWN` | **false** | nein |
| GoPlus | (U) | nein | `NONE` | **false** | nein |
| Jupiter Swap **v1** | keine für Quote (V) | **ja** | **`SCHEMA_VERIFIED`** | **false** | nein |
| Jupiter **Ziel** (v2 / Order-Execute) | (U) | nein | `SHAPE_ONLY` | **false** | nein |

DexScreener und Helius stehen auf `SCHEMA_KNOWN`, weil deine Spezifikation
konkrete Feldnamen nennt (Stufe S). Birdeye steht auf `SHAPE_ONLY`, weil dort
Endpunktnamen bekannt sind, aber **kein einziges Feld**.

---

## Jupiter: LEGACY / VERIFIED gegen TARGET / NOT YET VERIFIED

Deiner Entscheidung folgend.

| | **LEGACY / VERIFIED** | **TARGET / NOT YET VERIFIED** |
|---|---|---|
| Oberfläche | Swap **v1** | Swap v2 bzw. Order-&-Execute |
| Base-URL | `https://api.jup.ag/swap/v1` (V) | (U) — Spezifikation nennt `swap/v2`, Suchtreffer deuten auf Ultra |
| Endpunkte | `GET /quote`, `POST /swap`, `POST /swap-instructions`, `GET /program-id-to-label` (V) | `GET /order`, `POST /execute` (S) |
| Schema | vollständig aus Hersteller-OpenAPI (V) | (U) |
| Signaturmodell | **wir** signieren und senden | Anbieter sendet („managed landing", S) |
| Reifegrad | `SCHEMA_VERIFIED`, `PRODUCTION_VERIFIED = false` | `SHAPE_ONLY` |
| Status | **bleibt dokumentiert, wird nicht gelöscht** | Zielarchitektur, kein Code |

`docs/providers/jupiter.md` bleibt bestehen und ist entsprechend markiert.

**Warum das nicht kosmetisch ist:** Die verifizierte Spezifikation sagt zu
`otherAmountThreshold` wörtlich, der Wert werde *nicht* zum Bauen der
Transaktion verwendet. Die on-chain durchgesetzte Untergrenze steckt in der
Transaktion selbst. Ob das im Ziel-Modell genauso ist, weiß niemand hier — und
davon hängt ab, woher `SignerPolicy` ihren `minOut` liest.

**Signer-Grenze unverändert:** Web/API sehen nie einen privaten Schlüssel. Der
Signer bleibt ein eigener Prozess mit mTLS, Programm-Allowlist und
Abflussgrenzen. Ein Modell, in dem ein Anbieter für uns sendet, verschiebt diese
Grenze — und genau deshalb wird es nicht implementiert, bevor der Vertrag
verifiziert ist.

---

## D. Endpunkt-Status

Ausschließlich das, was du angegeben hast, plus was ich verifizieren konnte.
Keine Ergänzungen.

| Provider | Endpunkte | Stufe |
|---|---|---|
| **Birdeye** | `/defi/price` · `/defi/history_price` · `/defi/v3/ohlcv` · `/defi/token_overview` · `/defi/v3/token/txs` · `/defi/token_trending` · `/defi/v3/token/meme/list` · `/defi/v3/token/meme/detail/single` · `/defi/token_security` · `/smart-money/v1/token/list` · `/defi/v3/search` | S |
| Birdeye (zusätzlich) | `/defi/v3/token/holder`; WS `SUBSCRIBE_PRICE`, `SUBSCRIBE_TOKEN_NEW_LISTING`, `SUBSCRIBE_BASE_QUOTE_PRICE` | C |
| **Solana Tracker** | `/tokens/latest` · `/tokens/multi/all` · `/tokens/{tokenAddress}` · `/search` · `/price` · `/stats/{token}` · `/stats/{token}/{pool}` · `/tokens/{tokenAddress}/ath` · `/wallet/{owner}` · `/deployer/{wallet}` | S |
| **DexScreener** | `/token-profiles/latest/v1` · `/community-takeovers/latest/v1` · `/token-boosts/latest/v1` · `/token-boosts/top/v1` · `/latest/dex/pairs/{chainId}/{pairId}` · `/latest/dex/search` · `/token-pairs/v1/{chainId}/{tokenAddress}` · `/tokens/v1/{chainId}/{tokenAddresses}` | S |
| **Helius** | RPC + WSS-Endpunkt · `POST /v0/transactions` · `POST /v0/webhooks` · WS `transactionSubscribe`, `accountSubscribe`, `logsSubscribe` | S |
| **GoPlus** | Solana Token Security API, Solana Transaction Simulation API — **Pfade unbekannt** | C |
| **Jupiter v1** | `GET /quote` · `POST /swap` · `POST /swap-instructions` · `GET /program-id-to-label` | **V** |

---

## E. Response-Schema-Status

| Endpunkt | Bekannte Felder | Stufe | Confidence |
|---|---|---|---|
| Jupiter `GET /quote` | `inputMint`, `outputMint`, `inAmount`, `outAmount`, `otherAmountThreshold`, `swapMode`, `slippageBps`, `priceImpactPct`, `routePlan`; optional `platformFee`, `contextSlot`, `timeTaken` | **V** | `SCHEMA_VERIFIED` |
| DexScreener Pairs | `priceNative`, `priceUsd`, `txns`, `volume`, `priceChange`, `liquidity`, `fdv`, `marketCap`, `pairCreatedAt`, `websites`, `socials`, `boosts` | S | `SCHEMA_KNOWN` |
| Solana Tracker `/price` | `price`, `priceQuote`, `liquidity`, `marketCap`, `lastUpdated` | S | `SCHEMA_KNOWN` |
| Solana Tracker `/search` (Sortierfelder) | `liquidityUsd`, `marketCapUsd`, `volume`, `volume_5m…1h`, `holders`, `buys`, `sells`, `top10`, `dev`, `insiders`, `snipers`, `fees`, `createdAt`, `lpBurn`, `curvePercentage` | S | `SCHEMA_KNOWN` |
| Helius `POST /v0/transactions` | `signature`, `fee`, `feePayer`, `slot`, `timestamp`, `nativeTransfers`, `tokenTransfers`, `accountData` | S | `SCHEMA_KNOWN` |
| **Birdeye — alle** | — | **U** | `SHAPE_ONLY` |
| **GoPlus — alle** | — | **U** | `NONE` |

Zwei Typdetails aus der verifizierten Jupiter-Spezifikation:
`inAmount`/`outAmount`/`otherAmountThreshold` sind **Strings** (u64 überschreitet
Double-Präzision — passt zu unserer bigint-Arithmetik), `priceImpactPct` ist ein
**String-Dezimalbruch**, keine Basispunkte. Faktor 10 000, wenn man das
verwechselt.

---

## F. Rate Limits

| Provider | Limit | Stufe |
|---|---|---|
| DexScreener | 60 RPM (Profiles/Boosts), **300 RPM** (Pairs/Search/Tokens) | S |
| Solana Tracker Free | 2 500/Monat, **3 rps** | C |
| Solana Tracker €50 | 200 000/Monat, kein rps-Limit | C |
| Solana Tracker €200 / €397 | 1 Mio / 10 Mio pro Monat | C |
| Birdeye | CU-basiert; **RPM und Nebenläufigkeit unbekannt** | U |
| Helius | **unbekannt** | U |
| GoPlus | **unbekannt** | U |

2 500 Anfragen im Monat sind etwa 3,5 pro Stunde. Der Free-Tarif von Solana
Tracker trägt damit keine Discovery und keine Snapshot-Reihe.

---

## G. Kostenmodell

**Getrennt von den Handelskosten**, deiner Vorgabe entsprechend.

| Ebene | Enthält | Tabelle |
|---|---|---|
| **API-Kosten** | Anfragen, Credits, Compute Units je Endpunkt | `provider_requests` (neu) |
| **Handelskosten** | DEX-Gebühr, Netzgebühr, Priority Fee, Slippage, Preis-Impact | `paper_positions.costs_paid_minor` (existiert) |

Die beiden dürfen nie in derselben Zahl landen. Eine Position, deren
API-Beschaffungskosten in ihre PnL wandern, ist nicht mehr mit einem Backtest
vergleichbar.

Aus deinen CU-Angaben (S):

| Endpunkt | CU | je Token bei N=100 |
|---|---|---|
| Meme Token List | 40 | 0,4 |
| Smart Money Token List | 20 | 0,2 |
| Token Trending | 30 | 0,3 |
| Price Single | 3 | 3 |
| Token Market Data | 10 | 10 |
| Token Trade Data | 12 | 12 |
| Token Security | 25 | 25 |
| Token Creation Info | 40 | 40 |

Budgetgleichung: mit `B` CU pro Stunde und `N_k` Tokens auf Stufe `k` mit
Einzelkosten `c_k` gilt `Σ N_k · c_k ≤ B`.

Worked example, `B = 100 000 CU/h` (**Annahme**, du setzt die Zahl):

| Stufe | CU | max. Tokens bei 20 % Budget |
|---|---|---|
| Price Single | 3 | 6 666 |
| Token Market Data | 10 | 2 000 |
| Token Trade Data | 12 | 1 666 |
| Token Security | 25 | 800 |
| Token Creation Info | 40 | 500 |

Daraus folgt die Filterschärfe: **hinter dem Basisfilter höchstens ein Drittel
der Kandidaten, hinter dem Marktfilter höchstens ein Zehntel.** Das ist
Arithmetik, keine Handelsmeinung.

Spätere Forschungsfragen, die `provider_requests` beantwortbar macht:
API-Kosten je Gelegenheit, je angenommenem Trade, je Gewinner, je validiertem
Signal.

---

## H. Latenz

| Transport | Erwartung | Stufe |
|---|---|---|
| Birdeye WS `SUBSCRIBE_TOKEN_NEW_LISTING` | schnellste bekannte Discovery | C |
| Helius `transactionSubscribe` | Echtzeit mit Filtern | S |
| Helius Webhooks | Push, **Wiederholungen möglich** | S |
| Solana Tracker WSS RPC | vorhanden, ungeklärt | S |
| REST-Polling | taktgebunden | — |

Helius' 10-Minuten-Inaktivitätstimer (S) verlangt Heartbeat und Reconnect. Das
ist ein Lebenszyklusmodell, das unsere Worker heute nicht haben: sie kennen
Takte und Queue-Aufträge, keine dauerhaft offene Verbindung.

---

## I. Coverage

Ehrlich: **Coverage lässt sich heute nicht messen.**

Wie viele Tokens ein Anbieter kennt, wie schnell er ein neues Paar aufnimmt und
wie viele davon handelbar sind — das steht in keiner Dokumentation und ergibt
sich erst aus dem Betrieb.

Was ich sagen kann, ist die *Form* der Abdeckung:

| Provider | Discovery-Form | Bulk-Abruf | Stufe |
|---|---|---|---|
| Birdeye | Listen (Meme, Trending) + WS-Neulistungen | ja, Listen | S/C |
| Solana Tracker | `/tokens/latest`, `/search` mit Sortierung | `/tokens/multi/all` | S |
| DexScreener | `/token-profiles/latest`, `/latest/dex/search` | **`/tokens/v1/{chainId}/{tokenAddresses}`** — mehrere Adressen je Aufruf | S |

Die letzte Zeile ist für den ersten Adapter entscheidend, siehe Abschnitt P.

---

## J. Provider-Redundanz

Cross-Check möglich bei Preis, Liquidität, Market Cap (Birdeye / Solana Tracker
/ DexScreener) und Security (Birdeye / Solana Tracker / GoPlus).

**Der Punkt, der zählt:** Diese drei lesen dieselben On-Chain-Pools. Ihre
Übereinstimmung ist fast garantiert und beweist nichts. Jupiters Quote ist der
einzige Wert anderer Natur — er sagt nicht „was ist der Preis", sondern „was
bekäme ich".

> Eine Abweichung zwischen Jupiter und den Marktdatenanbietern ist ein Signal.
> Eine Übereinstimmung zwischen Birdeye und DexScreener ist keins.

Deshalb wird **nicht gemittelt** (§16 deiner Vorgabe). Alle Werte werden
einzeln gespeichert; `agreement`, `disagreement`, `spread`,
`freshness_difference` und `source_correlation` sind Forschungsfeatures, die
sich später aus `feature_observations` berechnen lassen.

---

## K. Datenqualität

| Tier | Bedingung |
|---|---|
| `PRIMARY` | Beobachtungszeitpunkt vom Anbieter · Schema validiert · Frische ≤ Policy · Auth ok |
| `SECONDARY` | wie oben, **aber ohne Beobachtungszeitpunkt** (`observedAt = fetchedAt`) |
| `FALLBACK` | erreichbar, Frische über Policy oder Teilfelder fehlen |
| `DERIVED` | von uns aus Rohdaten berechnet — **neu, fehlt heute in `SourceTier`** |
| `TEST_FIXTURE` | existiert als `source_type`, orthogonal zum Tier |

Zeitstempel-Semantik, soweit bekannt:

| Quelle | Feld | Folge |
|---|---|---|
| Solana Tracker `/price` | `lastUpdated` (S) | kann `PRIMARY` werden, Semantik ungeklärt |
| Helius Transactions | `timestamp`, `slot` (S) | bester Zeitstempel im Feld — on-chain |
| Jupiter `/quote` | `contextSlot` (V) | Slot, keine Uhrzeit → braucht Slot→Zeit-Auflösung |
| DexScreener | `pairCreatedAt` (S) — **Paar, nicht Preis** | **kein** Beobachtungszeitpunkt für den Preis → `SECONDARY` |
| Birdeye | unbekannt (U) | ungeklärt |

**Regel:** Ohne Beobachtungszeitpunkt ist `observedAt = fetchedAt` und
`freshnessSeconds = 0` — eine *Behauptung*, keine Messung. Solche Datensätze
dürfen höchstens `SECONDARY` sein. `snapshotSupportsEntry` setzt die Folgen
bereits durch; die Einstufung gehört in den Adapter.

Staleness je Feldklasse (**Annahmen**, zu überprüfen sobald echte Latenzen
vorliegen):

| Klasse | Grenze | | Klasse | Grenze |
|---|---|---|---|---|
| Execution-Quote | 5 s | | Holder | 15 min |
| Preis | 30 s | | Security | 60 min |
| Liquidität | 60 s | | Identität | unbegrenzt (unveränderlich) |
| Volumen / Trades | 120 s | | Social | 24 h |

---

## L. Discovery-Ökonomie

Das System muss zwei Abrufarten **explizit** unterscheiden — als Eigenschaft im
Adapter, nicht als Konvention:

| Art | Kosten | Wo sie hingehört |
|---|---|---|
| **LIST / BULK** | je Aufruf, amortisiert über N Tokens | Discovery-Stufe |
| **INDIVIDUAL** | je Token | erst hinter dem Filter |

Eine Liste über 100 Tokens kostet ein Hundertstel je Token. Das kehrt zwei
naheliegende Reihenfolgen um:

- **Smart Money gehört in die Discovery**, nicht hinter Security — als Liste
  kostet es 0,2 CU je Token, als Einzelabruf wäre es teurer als Security.
- **Identität vor Preis.** Das Token-Alter ist der billigste harte Ausschluss
  und einmalig zu holen. Ihn hinter den Preis zu setzen heißt, Preise für Tokens
  zu kaufen, die am Alter scheitern.

Für den Adapter heißt das ein zusätzliches Merkmal:

```
fetchMarket(mint)            → Einzelabruf
fetchMarketBatch(mints[])    → Bulk, wenn der Anbieter ihn hat
```

Fehlt der Bulk-Pfad, fällt die Kette auf Einzelabrufe zurück — sichtbar, mit
entsprechend höherem Kostenposten in `provider_requests`.

---

## M. Progressive Filtering

```
1. DISCOVERY       Listen + WS-Neulistungen          ~0,4 CU/Token
                   → token_candidates (dedupliziert)
2. IDENTITÄT       TOKEN_IDENTITY (einmalig, Cache)  40 CU, dann 0
                   → Alter, Creator. Zu jung/zu alt: raus
3. BASISFILTER     Price Single                       3 CU
4. MARKTFILTER     TOKEN_MARKET (Bulk, wenn möglich) 10 CU
5. TRADES          TOKEN_TRADES                      12 CU
6. SECURITY        SECURITY_REPORT (Ensemble)        25 CU
7. SMART MONEY     aus der Discovery-Liste, kein Einzelabruf
8. SOCIAL          SOCIAL_SIGNALS                    billig
9. EXECUTION       ROUTE_QUOTE mit echter Größe — Ein- UND Ausstieg
10. EV             netto nach Ausführungskosten
```

Jeder Reject wird gespeichert — mit Stufe, Grund und den bis dahin bekannten
Feldern. Ohne das gibt es später keine False-Negative-Forschung.

Und die Regel aus deiner §18: eine positive Marktdaten-Geschichte reicht nicht.
`Erwarteter Bruttoertrag > 0` bei `ausführungsbereinigter Nettoerwartung ≤ 0`
heißt **NO TRADE**.

---

## N. Feature-Observation-Modell

Die folgenreichste Schemaänderung. Heute trägt ein `token_snapshot` **eine**
Herkunft für die ganze Zeile. Dein §3 verlangt Herkunft **je Feld** — Preis von
Birdeye, Liquidität von Solana Tracker, in derselben Beobachtung.

```sql
CREATE TABLE feature_observations (
  id                  uuid PRIMARY KEY,
  token_id            uuid NOT NULL REFERENCES tokens(id),
  feature_name        text NOT NULL,          -- 'market.liquidity_usd'

  -- Genau eine der drei Wertspalten ist gesetzt.
  -- Bewusst getrennt statt jsonb: die ganze Tabelle existiert fuer
  -- numerische Auswertung (Perzentile, Korrelation). Ein jsonb-Feld
  -- wuerde jede Forschungsabfrage zu einem Cast zwingen.
  value_num           double precision,
  value_bool          boolean,
  value_text          text,

  provider            text NOT NULL,
  endpoint            text NOT NULL,
  observed_at         timestamptz NOT NULL,
  received_at         timestamptz NOT NULL,
  data_age_ms         integer NOT NULL,
  source_tier         text NOT NULL,          -- + DERIVED
  data_quality        double precision NOT NULL,
  schema_version      text NOT NULL,
  adapter_version     text NOT NULL,

  snapshot_id         uuid REFERENCES token_snapshots(id),
  decision_id         text,                   -- siehe unten
  decision_timestamp  timestamptz,

  CONSTRAINT feature_obs_one_value CHECK (
    (value_num IS NOT NULL)::int + (value_bool IS NOT NULL)::int
      + (value_text IS NOT NULL)::int = 1),

  -- Kein Feature kann nach seinem Empfang beobachtet worden sein.
  CONSTRAINT feature_obs_causality CHECK (observed_at <= received_at),

  -- §17: NO LOOK-AHEAD, als Constraint statt als Filter.
  CONSTRAINT feature_obs_no_lookahead CHECK (
    decision_timestamp IS NULL OR observed_at <= decision_timestamp)
);

-- Idempotenz: derselbe Anbieter, dasselbe Feature, derselbe
-- Beobachtungszeitpunkt sind EINE Zeile. Entschieden von der Datenbank,
-- nicht von einem vorherigen SELECT.
CREATE UNIQUE INDEX feature_obs_unique
  ON feature_observations (token_id, feature_name, provider, observed_at);
```

Drei Entwurfsentscheidungen, die Begründung verdienen:

1. **Drei Wertspalten statt `jsonb`.** Die Tabelle existiert für numerische
   Forschung. `jsonb` würde jede Perzentil- und Korrelationsabfrage zu einem
   Cast zwingen und Indizes unbrauchbar machen.
2. **Look-Ahead als CHECK.** `observed_at <= decision_timestamp` steht in der
   Datenbank, nicht in einer Abfrage. Ein vergessener Filter ist ein Bug; eine
   abgelehnte Zeile ist ein Zustand. Das ist dieselbe Linie wie beim
   Fixture-Schutz.
3. **`decision_id` ist `text` ohne Fremdschlüssel.** Grund: eine Entscheidung
   erzeugt **zwei** Gelegenheiten (Auto und Manual). `opportunity_id` wäre also
   falsch. Wir haben bereits eine Entscheidungskennung —
   `dec-<hash>` in `opportunity-pipeline.ts:167` — aber **sie wird nirgends
   gespeichert.** Voraussetzung: eine Spalte `decision_id` auf `opportunities`,
   sonst zeigt diese Referenz ins Leere.

**Größe und Aufbewahrung:** Das wird die größte Tabelle im System — bei 30
Features je Snapshot und einem Snapshot je Token und Minute wächst sie
30-mal so schnell wie `token_snapshots`. Aufbewahrungsfrist und Partitionierung
nach `received_at` gehören mitentschieden, bevor sie läuft.

**Keine Rohantworten.** Gespeichert werden normalisierte Felder plus die
anbieterspezifischen Signale, die wir behalten wollen (Solana Tracker:
`insiders`, `snipers`, `bundlers`; Birdeye: Smart Money; DexScreener: Socials,
Boosts). Nicht der Antwortkörper.

### Weitere Tabellen

| Tabelle | Zweck |
|---|---|
| `token_candidates` | Discovery-Dedup: `mint`, `first_seen_provider`, `first_seen_at`, `all_seen_providers` |
| `provider_requests` | API-Kosten: `provider`, `endpoint`, `capability`, `cost_units`, `http_status`, `latency_ms`, `token_id`, `pipeline_stage`, `decision_id` |
| `provider_capability_status` | Reifegrad je (Provider, Capability) |
| `execution_quotes` | Quote mit Alter, Route, Impact — Ein- und Ausstieg getrennt |
| `holder_observations` | Holder-Verlauf; absolute Werte und Änderungen getrennt |
| `security_observations` | Rohsignale je Anbieter, vor der eigenen Engine |

Erweiterungen: `token_snapshots` um `schema_version` und `adapter_version`,
`opportunities` um `decision_id`, `SourceTier` um `DERIVED`.

---

## O. Provider-Vertrag

Deine dreizehn Punkte, ergänzt um die beiden Reifegrade. **Alle dreizehn**
müssen erfüllt sein, bevor ein Anbieter in `MARKET_DATA_PRIORITY` aufgenommen
wird.

| # | Bedingung | Prüfbar durch |
|---|---|---|
| 1 | Endpunkt bekannt | Primärquelle |
| 2 | Response-Schema bekannt | Primärquelle |
| 3 | Auth bekannt | Primärquelle |
| 4 | Rate Limit bekannt | Primärquelle oder Tarif |
| 5 | Zeitstempel-Semantik bekannt | Primärquelle |
| 6 | Normalisierung definiert | Code-Review |
| 7 | Schema-Validierung vorhanden | Zod-Schema + Test |
| 8 | Fehlerabbildung vorhanden | Test je Fehlerklasse |
| 9 | Provider-Health integriert | `provider_status_samples` |
| 10 | Idempotenz berücksichtigt | `UNIQUE`-Index |
| 11 | Staleness-Policy definiert | Konfiguration |
| 12 | Tests vorhanden | Contract-Tests |
| 13 | **Echter Smoke-Test erfolgreich** | gegen die echte API |

Punkte 1–5 setzen `IMPLEMENTATION_CONFIDENCE = SCHEMA_VERIFIED` voraus.
Punkt 13 setzt `PRODUCTION_VERIFIED = true`.
Erst dann: `CAPABILITY_READY`.

Reifekette je (Provider, Capability):

```
CONFIGURED → CONNECTED → SCHEMA_VERIFIED → CAPABILITY_READY → PRODUCTION_ENABLED
```

Ein Anbieter kann für `TOKEN_MARKET` bereit sein und für `SMART_MONEY` nicht.

**Contract-Tests** arbeiten mit aufgezeichneten Antworten, markiert als
`PROVIDER_SCHEMA_FIXTURE`. Sie prüfen Parser und Fehlerpfade — **nie** Marktdaten
oder Handelsleistung, und sie färben keinen Provider-Status.

---

## P. Vorgeschlagener erster Adapter

### Bewertung nach deinen sieben Kriterien

| Kriterium | DexScreener | Solana Tracker | Birdeye |
|---|---|---|---|
| Coverage | mittel | mittel | **hoch** |
| Datenqualität | **niedrig** — kein Preis-Zeitstempel | **hoch** — `lastUpdated` | unbekannt |
| Kosten | **keine** | Tarif nötig | Tarif nötig |
| Latenz (REST) | unbekannt | unbekannt | unbekannt |
| Rate Limit | **300 RPM** | 3 rps (Free) | unbekannt |
| Discovery-Nutzen | gut | gut | **sehr gut** |
| Marktdaten-Nutzen | gut | gut | **sehr gut** |
| Schema bekannt | **`SCHEMA_KNOWN`** | `SCHEMA_KNOWN` | `SHAPE_ONLY` |
| Bulk-Abruf | **ja** (mehrere Adressen je Aufruf) | ja | ja |
| Auth-Hürde | **keine** | Schlüssel + Tarif | Schlüssel + Tarif |

### Empfehlung

> **DexScreener · Capability `TOKEN_MARKET` · über den Bulk-Endpunkt**

Sechs Gründe:

1. **Keine Auth-Hürde.** Der einzige der drei, mit dem sich der vollständige
   Pfad bauen und smoke-testen lässt, **ohne dass du vorher etwas kaufst.**
2. **Bulk eingebaut.** `/tokens/v1/{chainId}/{tokenAddresses}` nimmt mehrere
   Adressen je Aufruf — genau das Prinzip aus Abschnitt L, gleich im ersten
   Adapter geübt.
3. **Bestbekanntes Schema der drei Marktquellen.** `SCHEMA_KNOWN` gegen
   `SHAPE_ONLY` bei Birdeye. Ein Adapter gegen `SHAPE_ONLY` ist geraten.
4. **300 RPM tragen eine echte Snapshot-Reihe.** Der Free-Tarif von Solana
   Tracker mit 3,5 Anfragen pro Stunde nicht.
5. **De-Risking.** Wir beweisen Adapter → Schema-Validierung → Normalisierung →
   Health → Snapshot → Feature-Observation → Persistenz → Tests an einem
   kostenlosen Anbieter, bevor Geld in Birdeye fließt.
6. **Bleibt dauerhaft nützlich** als Discovery-Quelle, Cross-Check und Fallback
   — auch wenn er nie PRIMARY wird.

### Die Schwäche, die ich nicht verschweige

DexScreener liefert für den **Preis** keinen Beobachtungszeitpunkt (`pairCreatedAt`
gehört zum Paar). Er wird deshalb als **`SECONDARY`** eingestuft und kann nach
unseren eigenen Regeln **nie PRIMARY-Marktquelle** werden.

Das ist für die jetzige Phase in Ordnung und langfristig nicht:

- **Jetzt:** Wir bauen Historie, wir handeln nicht. `SECONDARY` reicht für
  Snapshots vollständig.
- **Später:** Für Einstiegsentscheidungen brauchen wir eine Quelle mit echtem
  Beobachtungszeitpunkt — Birdeye oder Solana Tracker mit bezahltem Tarif.

Das ist also ausdrücklich eine Entscheidung über den **ersten Pfad**, nicht über
die **finale Priorität**.

### Wenn du bereits einen Birdeye-Schlüssel hast

Dann ändert sich die Empfehlung — unter einer Bedingung: Du müsstest das
Response-Schema beschaffen (OpenAPI-Export, `llms.txt` oder eine aufgezeichnete
echte Antwort je Endpunkt). Mit `SCHEMA_VERIFIED` wäre **Birdeye ·
`TOKEN_MARKET`** die bessere erste Wahl, weil er auch langfristig PRIMARY
werden kann. Ohne Schema bleibt es bei DexScreener.

### Zur Discovery-Vergleichsmatrix (deine §6)

Deine Vorgabe war, den objektiven Vergleich **vor** der Priorisierung zu
erstellen. Das geht für einen Teil der Spalten nicht, und ich sage lieber warum,
als eine Tabelle mit erfundenen Zahlen zu liefern:

| Spalte | Heute bestimmbar? |
|---|---|
| Rate Limit, Kosten, Auth | **ja** — dokumentiert |
| Discovery-Form, Bulk | **ja** — dokumentiert |
| Freshness, Latenz | nein — braucht Messung |
| Coverage | nein — braucht Messung |
| Unique Signals, Overlap | nein — braucht **zwei** laufende Quellen |
| False Positive / Negative Rate | nein — braucht Kursverläufe **nach** der Entdeckung |

Overlap und Eindeutigkeit fallen automatisch aus `token_candidates` heraus,
sobald zwei Discovery-Quellen laufen: `first_seen_provider` und
`all_seen_providers` sind genau diese Messung. False-Positive- und
False-Negative-Raten brauchen zusätzlich Wochen an Kursverläufen.

**Der Vergleich ist also selbst eine Messaufgabe, die den ersten Adapter
voraussetzt.** Die Reihenfolge lässt sich nicht umdrehen, ohne zu raten.

---

## Q. Vercel- und Worker-Abhängigkeit

| Läuft **nicht** auf Vercel | Grund |
|---|---|
| WebSockets (Birdeye, Helius, Tracker) | Verbindung überlebt das Anfrageende nicht |
| Discovery-Polling | Takt |
| Snapshot-Aufnahme | Takt + Checkpoint |
| Provider-Health | Takt |
| **Rate-Limit-Budget** | zentraler Zustand über alle Aufrufe |

| Läuft auf Vercel | Grund |
|---|---|
| Dashboard | liest nur die Datenbank |
| INVEST-NOW-Bestätigung | **ein** Quote je Klick, anfragegebunden |
| Webhook-**Empfang** | kurzer HTTP-Endpunkt; Verarbeitung geht sofort in die Queue |

Das Rate-Limit-Budget ist der Grund, warum Provider-Aufrufe nicht auf beiden
Seiten stattfinden dürfen: zwei Prozesse mit je eigenem Zähler halten kein
gemeinsames Limit ein. Die INVEST-NOW-Ausnahme ist vertretbar, weil sie an einen
menschlichen Klick gebunden ist — sie kann nicht in eine Schleife geraten.

---

## R. Implementierungsreihenfolge

| # | Schritt | Warum an dieser Stelle |
|---|---|---|
| 0 | Fünf neue Capabilities ins Enum, `DERIVED` in `SourceTier` | reine Typerweiterung, blockiert sonst alles Folgende |
| 1 | `decision_id` auf `opportunities` persistieren | Voraussetzung für `feature_observations` |
| 2 | `feature_observations` + `provider_requests` (Migration) | vor dem ersten Adapter, sonst misst niemand |
| 3 | **Erster Adapter: eine Capability, ein Anbieter** | der Engpass |
| 4 | Schema-Validierung, Normalisierung, Fehlerabbildung | Vertragspunkte 6–8 |
| 5 | Provider-Health je Capability + Smoke-Test | Vertragspunkte 9, 13 → `CAPABILITY_READY` |
| 6 | Snapshot- und Feature-Observation-Schreibpfad | schließt den Pfad |
| 7 | Contract-Tests je Fehlerklasse | Vertragspunkt 12 |
| 8 | **Erst dann:** zweiter Anbieter | |
| 9 | Discovery über Listen | braucht laufende Marktdaten |
| 10 | Security-Ensemble | braucht Kandidaten |
| 11 | Jupiter-Quote im Paper-Flow | macht EV realistisch |
| 12 | `stream`-Worker | Latenzoptimierung, keine Voraussetzung |

Schritte 0–2 sind Vorarbeiten ohne Anbieterbezug und könnten vorgezogen werden.
Ich schlage sie **nicht** eigenmächtig vor — sie gehören in dieselbe Freigabe
wie der Adapter, weil sie sonst Schema ändern, ohne dass etwas darauf zugreift.

---

## Live-Data-Gate

Unverändert und durch nichts in diesem Plan gelockert:

```
CONNECTED → CAPABILITY_READY → LIVE SNAPSHOTS → BUILDING_HISTORY
  → SUFFICIENT_HISTORY → PAPER TRADING → RESEARCH → SHADOW
  → CHALLENGER → HUMAN APPROVAL → (irgendwann) LIVE
```

Der erste Meilenstein ist **nicht** ein Live-Kauf, sondern
**24/7-Paper-Trading gegen echte Marktdaten**. Auto Paper mit 100 € und Manual
Opportunity laufen parallel; `MISSED` und `USER_REJECTED` bleiben vollständig
für die Forschung erhalten und **niemals** in der Performance-PnL.

---

## Was ich zur Freigabe brauche

1. **Erster Anbieter und Capability** — meine Empfehlung: DexScreener ·
   `TOKEN_MARKET`. Oder Birdeye · `TOKEN_MARKET`, falls du Schlüssel **und**
   Schema hast.
2. **Schema-Quelle** für den gewählten Anbieter: OpenAPI, `llms.txt` oder eine
   aufgezeichnete echte Antwort. Ohne sie bleibt es bei `SHAPE_ONLY`, und dann
   wird nichts gebaut.
3. **Freigabe für die Vorarbeiten** (Schritte 0–2): Capabilities, `decision_id`,
   `feature_observations`, `provider_requests`.
4. **CU-Budget**, falls Birdeye — davon hängt die Filterschärfe ab.
