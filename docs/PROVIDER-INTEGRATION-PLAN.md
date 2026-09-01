# Provider-Integrationsplan — Analyse zu Spezifikation V1

**Stand:** 2026-09-01 · **Status:** Analyse, kein Code · **Nächster Schritt:** deine Freigabe

---

## 0. Was ich in dieser Umgebung verifizieren konnte — und was nicht

Das ist die wichtigste Vorbemerkung, weil sie den Wert jeder folgenden Zeile bestimmt.

Gemessen, nicht vermutet:

| Zugang | Ergebnis |
|---|---|
| `curl` auf alle sechs Doku-Hosts | `000` — Verbindung scheitert |
| `WebFetch` auf `docs.birdeye.so`, `developers.jup.ag` | `EGRESS_BLOCKED` |
| `WebSearch` | **funktioniert** — liefert Titel, URLs, Zusammenfassungen |

**Ich kann keine einzige Dokumentationsseite lesen.** Suchergebnisse geben mir
Seitentitel und die Zusammenfassung eines kleinen Modells — nicht die
Primärquelle. Ein Response-Schema lässt sich daraus nicht ableiten.

Deshalb führe ich vier Evidenzstufen, und jede Aussage unten trägt eine davon:

| Stufe | Bedeutung |
|---|---|
| **V** — verifiziert | Ich habe die Primärquelle in dieser Umgebung gelesen. Gilt für **genau einen** Fall: Jupiters eigene OpenAPI über `raw.githubusercontent.com`, geprüft am 2026-08-30. |
| **S** — Spec | Steht in deiner Spezifikation V1, von dir der offiziellen Doku zugeschrieben. Deine Verifikation, nicht meine. |
| **C** — korroboriert | Ein Suchergebnis bestätigt, dass eine Doku-Seite mit diesem Namen existiert, oder gibt eine Zahl wieder. Die Seite selbst habe ich nicht gelesen. |
| **U** — unverifiziert | Weder noch. Wird nicht implementiert. |

**Kein einziges Response-Schema hat Stufe V** — außer Jupiter Swap v1.

---

## 1. Drei Befunde, die vor allem anderen kommen

### 1.1 Jupiter: drei widersprüchliche Pfade — BLOCKIEREND

| Quelle | Base-URL | Endpunkte | Stufe |
|---|---|---|---|
| `docs/providers/jupiter.md` (mein Repo, aus Hersteller-OpenAPI) | `https://api.jup.ag/swap/v1` | `GET /quote`, `POST /swap` | **V** |
| Deine Spezifikation V1, §16 | `https://api.jup.ag/swap/v2` | `GET /order`, `POST /execute` | S |
| Suchtreffer | `.../ultra/v1/order`, `lite-api.jup.ag/ultra/v1/execute` | `/order` + `/execute`, Parameter `taker` | C |

Die Semantik, die du beschreibst — `/order` liefert Quote **plus** fertige
Transaktion, `taker` optional für reine Preisabfragen, `/execute` mit „managed
landing" — passt exakt auf das, was die Suchtreffer **Ultra API** nennen, nicht
auf „Swap v2".

Das ist kein Formfehler. Der Unterschied entscheidet über:

- **wer signiert.** Swap v1 gibt eine unsignierte Transaktion zurück, die wir
  signieren und selbst senden. Ultra `/execute` sendet für uns — das verschiebt
  die Grenze zum Signer-Prozess, und diese Grenze ist unser Sicherheitsmodell.
- **`otherAmountThreshold`.** Meine verifizierte Notiz zu Swap v1 hält fest:
  der im Quote genannte Mindestausgabewert wird **nicht** zum Bauen der
  Transaktion benutzt. Die tatsächlich durchgesetzte Untergrenze steht in der
  Transaktion. Ob das bei `/order` genauso ist, weiß ich nicht — und davon
  hängt ab, woher `SignerPolicy` ihren `minOut` liest.

**Vor jeder Zeile Jupiter-Code muss geklärt sein, welche der drei Oberflächen
gilt.** Ich rate nicht.

### 1.2 Wir haben acht Capabilities, nicht sieben

Deine Spezifikation listet sieben. `packages/providers/src/capability.ts:33`
führt acht — `SOCIAL_SIGNALS` fehlt in deiner Liste. Für die DexScreener-Rolle
(§9/§10 deiner Spezifikation) ist genau die relevant; sie muss nicht neu
erfunden werden.

### 1.3 Listen-Endpunkte amortisieren, Einzel-Endpunkte nicht

Das ist die zentrale Kostenerkenntnis, und sie strukturiert das ganze
Progressive Filtering.

Aus deinen CU-Angaben (Stufe S):

| Endpunkt | CU | Kosten **je Token** bei N Tokens |
|---|---|---|
| Meme Token List | 40 | 40 / N |
| Smart Money Token List | 20 | 20 / N |
| Token Trending | 30 | 30 / N |
| Price Single | 3 | 3 |
| Token Market Data | 10 | 10 |
| Token Security | 25 | 25 |
| Token Creation Info | 40 | 40 |

Eine Liste über 100 Tokens kostet 0,4 CU je Token. Dieselbe Information je
Token einzeln zu holen kostet das Hundertfache. **Listen gehören deshalb in die
Discovery, Einzelabfragen erst hinter den Filter** — nicht umgekehrt.

Konkret: Smart Money als *Liste* ist billig genug für die Discovery-Stufe. Smart
Money je Token wäre es nicht. Das kehrt die naheliegende Reihenfolge um, in der
Smart Money erst spät kommt.

---

## A. Provider-Matrix

| Provider | Rolle | Auth | Doku gelesen? | Adapter im Repo | Nächster Schritt |
|---|---|---|---|---|---|
| **Birdeye** | Discovery, Markt, Trades, Security, Smart Money | API-Key (S) | nein | nein | Doku-Export beschaffen |
| **Solana Tracker** | Discovery, Markt, Risk, Holder, Dev/Insider, RPC | `x-api-key` (S) | nein | nein | Doku-Export + Tarif klären |
| **DexScreener** | Discovery, Metadaten, Socials, Cross-Check | keine (S) | nein | nein | Doku-Export |
| **Helius** | RPC, Transaktionen, Wallets, Streams, Webhooks | API-Key in URL (S) | nein | nein | Doku-Export |
| **GoPlus** | Security (tertiär), TX-Simulation | (U) | nein | nein | **`llms.txt` + OpenAPI holen** |
| **Jupiter** | Route, Quote, Ausführung | keine für Quote (V, Swap v1) | **ja, Swap v1** | nein | **Pfadkonflikt klären** |

GoPlus ist der einzige Anbieter, für den ein Suchtreffer eine
maschinenlesbare Spezifikation nennt (`docs.gopluslabs.io/llms.txt`, plus
OpenAPI). Das ist der billigste Weg zu Stufe V — wenn du eine dieser Dateien
beschaffst, kann ich sie hier lesen, sofern sie über einen erreichbaren Host
liegt.

---

## B. Capability-Mapping

Hypothese, nicht Festlegung. `?` heißt: die Spezifikation legt es nahe, das
Schema ist aber unbekannt.

| Capability | Birdeye | Solana Tracker | DexScreener | Helius | GoPlus | Jupiter |
|---|---|---|---|---|---|---|
| `TOKEN_DISCOVERY` | P (S) | S (S) | F (S) | — | — | — |
| `TOKEN_MARKET` | P (S) | S (S) | F (S) | — | — | X-Check (V) |
| `PRICE_HISTORY` | P (S) | ? | — | — | — | — |
| `SOCIAL_SIGNALS` | ? | ? (S: Socials-Filter) | P (S) | — | — | — |
| `SECURITY_REPORT` | S (S) | S (S) | — | — | T (C) | — |
| `HOLDER_DISTRIBUTION` | ? (C: 35 CU) | S (S) | — | abgeleitet | ? | — |
| `ROUTE_QUOTE` | — | — | — | — | — | **P (V)** |
| `SWAP_TRANSACTION` | — | — | — | — | — | **P (V)** |

P = Primär · S = Sekundär · F = Fallback · T = Tertiär · X = Cross-Check

---

## C. Endpunkte

Alles Stufe S, außer Jupiter. Ich liste sie so, wie du sie angegeben hast, ohne
Ergänzungen.

**Birdeye** (S): `/defi/price` · `/defi/history_price` · `/defi/v3/ohlcv` ·
`/defi/token_overview` · `/defi/v3/token/txs` · `/defi/token_trending` ·
`/defi/v3/token/meme/list` · `/defi/v3/token/meme/detail/single` ·
`/defi/token_security` · `/smart-money/v1/token/list` · `/defi/v3/search`
Zusätzlich korroboriert (C): `/defi/v3/token/holder`, WebSocket mit
`SUBSCRIBE_PRICE`, `SUBSCRIBE_TOKEN_NEW_LISTING`, `SUBSCRIBE_BASE_QUOTE_PRICE`.

**Solana Tracker** (S), Base `https://data.solanatracker.io`:
`/tokens/latest` · `/tokens/multi/all` · `/tokens/{tokenAddress}` · `/search` ·
`/price` · `/stats/{token}` · `/stats/{token}/{pool}` ·
`/tokens/{tokenAddress}/ath` · `/wallet/{owner}` · `/deployer/{wallet}`
RPC (S): `https://rpc-mainnet.solanatracker.io`, `wss://rpc-mainnet.solanatracker.io`

**DexScreener** (S): `/token-profiles/latest/v1` · `/community-takeovers/latest/v1` ·
`/token-boosts/latest/v1` · `/token-boosts/top/v1` ·
`/latest/dex/pairs/{chainId}/{pairId}` · `/latest/dex/search` ·
`/token-pairs/v1/{chainId}/{tokenAddress}` · `/tokens/v1/{chainId}/{tokenAddresses}`

**Helius** (S): `https://mainnet.helius-rpc.com/?api-key=` ·
`wss://mainnet.helius-rpc.com/?api-key=` · `POST /v0/transactions` ·
`POST /v0/webhooks` · WS-Methoden `transactionSubscribe`, `accountSubscribe`,
`logsSubscribe`

**GoPlus** (C): Solana Token Security API und Solana Transaction Simulation API
existieren laut Suchtreffern; **Pfade unverifiziert**.

**Jupiter** (V, Swap v1): `GET /quote` · `POST /swap` · `POST /swap-instructions` ·
`GET /program-id-to-label` — siehe aber Befund 1.1.

---

## D. Response-Schemas

**Der schwächste Teil dieser Analyse, und ich sage das deutlich.**

| Endpunkt | Bekannte Felder | Stufe |
|---|---|---|
| Jupiter `GET /quote` | `inputMint`, `outputMint`, `inAmount`, `outAmount`, `otherAmountThreshold`, `swapMode`, `slippageBps`, `priceImpactPct`, `routePlan`; optional `platformFee`, `contextSlot`, `timeTaken` | **V** |
| Solana Tracker `/price` | `price`, `priceQuote`, `liquidity`, `marketCap`, `lastUpdated` | S |
| DexScreener Pairs | `priceNative`, `priceUsd`, `txns`, `volume`, `priceChange`, `liquidity`, `fdv`, `marketCap`, `pairCreatedAt`, `websites`, `socials`, `boosts` | S |
| Helius `POST /v0/transactions` | `signature`, `fee`, `feePayer`, `slot`, `timestamp`, `nativeTransfers`, `tokenTransfers`, `accountData` | S |
| Solana Tracker `/search` (Sortierfelder) | `liquidityUsd`, `marketCapUsd`, `volume`, `volume_5m…1h`, `holders`, `buys`, `sells`, `top10`, `dev`, `insiders`, `snipers`, `fees`, `createdAt`, `lpBurn`, `curvePercentage` | S |
| **Birdeye — sämtliche Endpunkte** | — | **U** |
| **GoPlus — sämtliche Endpunkte** | — | **U** |

Zwei Typ-Details aus der verifizierten Jupiter-Spezifikation, die für uns zählen:
`inAmount`/`outAmount`/`otherAmountThreshold` sind **Strings** (u64 überschreitet
Double-Präzision — passt zu unserer bigint-Arithmetik), und `priceImpactPct` ist
ein **String-Dezimalbruch**, keine Basispunkte. Wer das verwechselt, rechnet um
den Faktor 10 000 falsch.

---

## E. Timestamp-Qualität

Der entscheidende Punkt für den `PitReader`: liefert die Antwort einen
Beobachtungszeitpunkt, oder müssen wir den Empfangszeitpunkt nehmen?

| Quelle | Feld | Stufe | Folge |
|---|---|---|---|
| Solana Tracker `/price` | `lastUpdated` | S | brauchbar als `observedAt`, Semantik ungeklärt |
| DexScreener Pairs | `pairCreatedAt` (Paar, nicht Preis) | S | **kein** Beobachtungszeitpunkt für den Preis |
| Helius Transactions | `timestamp`, `slot` | S | bester Zeitstempel im ganzen Feld — on-chain |
| Jupiter `/quote` | `contextSlot`, `timeTaken` | V | Slot, keine Uhrzeit — braucht Slot→Zeit-Auflösung |
| Birdeye | — | U | ungeklärt |

**Regel, die daraus folgt:** liefert ein Anbieter keinen Beobachtungszeitpunkt,
ist `observedAt = fetchedAt` und `freshnessSeconds = 0` — was eine *Behauptung*
ist, keine Messung. Solche Datensätze dürfen höchstens `SECONDARY` sein, nie
`PRIMARY`. `snapshotSupportsEntry` in `packages/pipeline/src/ingestion.ts` setzt
das bereits durch; die Einstufung muss im Adapter passieren, nicht später.

---

## F. Rate Limits

| Provider | Limit | Stufe |
|---|---|---|
| DexScreener | 60 RPM (Profiles/Boosts), 300 RPM (Pairs/Search/Tokens) | S |
| Solana Tracker Free | 2 500 Anfragen/Monat, **3 rps** | C |
| Solana Tracker €50 | 200 000/Monat, kein rps-Limit | C |
| Solana Tracker €200 / €397 | 1 Mio / 10 Mio pro Monat | C |
| Birdeye | CU-basiert; **RPM/Concurrency unbekannt** | U |
| Helius | **unbekannt** | U |
| GoPlus | **unbekannt** | U |

**Folge:** Solana Tracker Free mit 3 rps und 2 500 Anfragen/Monat trägt keine
Discovery. 2 500 Anfragen im Monat sind ~3,5 pro Stunde. Als PRIMARY-Discovery
scheidet der Free-Tarif aus; als SECONDARY-Cross-Check auf wenige Kandidaten ist
er brauchbar.

---

## G. Kostenmodell

Aus deinen CU-Angaben (S). Die Rechnung darunter ist meine, mit einem
**angenommenen** Budget — die Zahl musst du setzen.

Sei `B` das CU-Budget pro Stunde und `N_k` die Zahl der Tokens, die Stufe `k`
erreichen. Dann gilt für jede Stufe mit Einzelabfrage-Kosten `c_k`:

```
Σ_k  N_k · c_k  ≤  B
```

Worked example mit `B = 100 000 CU/h` (Annahme) und einer Discovery, die
1 000 Kandidaten pro Stunde liefert:

| Stufe | Endpunkt | CU | max. Tokens bei 20 % des Budgets |
|---|---|---|---|
| Discovery | Meme List + Trending (Listen) | 70/Aufruf | ~alle, amortisiert |
| Basisfilter | Price Single | 3 | 6 666 |
| Marktfilter | Token Market Data | 10 | 2 000 |
| Trades | Token Trade Data | 12 | 1 666 |
| Security | Token Security | 25 | 800 |
| Creation | Token Creation Info | 40 | 500 |

Die Zahlen sagen: **hinter dem Basisfilter darf höchstens ein Drittel der
Kandidaten übrig bleiben, hinter dem Marktfilter höchstens ein Zehntel.** Das
ist keine Meinung über Trading, sondern eine Budgetgleichung.

`Token Creation Info` ist mit 40 CU der teuerste Einzelabruf — aber sein Ergebnis
ist **unveränderlich**. Einmal geholt, nie wieder. Das gehört in einen
permanenten Cache, nicht in einen Takt.

---

## H. Latenz

| Transport | Erwartung | Stufe | Eignung |
|---|---|---|---|
| Birdeye WebSocket | `SUBSCRIBE_TOKEN_NEW_LISTING` für Neulistungen | C | schnellste bekannte Discovery |
| Helius `transactionSubscribe` | Echtzeit, Filter | S | Rohdaten für eigene Ableitungen |
| Helius Webhooks | Push, **Wiederholungen möglich** | S | asynchron, braucht Idempotenz |
| Solana Tracker WSS RPC | vorhanden | S | ungeklärt |
| REST-Polling | Takt-gebunden | — | Fallback |

Helius' 10-Minuten-Inaktivitäts-Timer (S) verlangt Heartbeat und Reconnect. Das
ist ein eigener Worker-Baustein, den es heute nicht gibt — unsere
Worker-Infrastruktur kennt Takte und Queue-Aufträge, aber keine dauerhafte
Verbindung mit Lebenszeichen.

---

## I. Provider-Redundanz

Cross-Check möglich bei: **Preis** (Birdeye / Solana Tracker / DexScreener /
Jupiter-Quote), **Liquidität** (Birdeye / Solana Tracker / DexScreener),
**Market Cap** (dieselben drei), **Security** (Birdeye / Solana Tracker / GoPlus).

Und jetzt der Punkt, den §20 deiner Spezifikation richtig benennt und den ich
schärfen möchte:

Jupiters Quote ist der **einzige** Preis mit anderer Natur. Die anderen drei
lesen dieselben On-Chain-Pools und melden deshalb notwendigerweise Ähnliches —
Übereinstimmung ist dort fast garantiert und beweist nichts. Der Jupiter-Quote
dagegen sagt, was wir **tatsächlich bekämen**, inklusive Route und Impact.

**Eine Abweichung zwischen Jupiter und den Marktdatenanbietern ist ein Signal.
Eine Übereinstimmung zwischen Birdeye und DexScreener ist keins.**

---

## J. Datenqualität

Vorschlag für die Einstufung, gebunden an das, was ein Anbieter nachweislich
liefert — nicht an seinen Namen:

| Tier | Bedingung |
|---|---|
| `PRIMARY` | Beobachtungszeitpunkt vom Anbieter · Schema validiert · Frische ≤ Policy · Auth ok |
| `SECONDARY` | wie oben, aber ohne Beobachtungszeitpunkt (`observedAt = fetchedAt`) |
| `FALLBACK` | erreichbar, aber Frische über Policy oder Teilfelder fehlen |
| `DERIVED` | von uns aus Rohdaten berechnet (Helius → Dev-/Insider-Aktivität) — **neu** |
| `TEST_FIXTURE` | existiert bereits als `source_type`, getrennt vom Tier |

`DERIVED` fehlt heute in `SourceTier` (`capability.ts:190`) und muss ergänzt
werden — mit einer Entscheidung darüber, ob abgeleitete Daten eine
Einstiegsentscheidung tragen dürfen. Mein Vorschlag: ja, aber nie allein.

---

## K. Progressive Filtering

Reihenfolge nach Kosten und Informationswert, nicht nach Bequemlichkeit:

```
1. DISCOVERY            Listen-Endpunkte + WS-Neulistungen     ~0,4 CU/Token
                        → token_candidates (dedupliziert)
2. IDENTITÄT            Creation Info (einmalig, Cache)        40 CU, dann 0
                        → Alter, Creator. Zu jung/zu alt: raus
3. BASISFILTER          Price Single                            3 CU
                        → kein Preis, kein Kandidat
4. MARKTFILTER          Token Market Data                      10 CU
                        → Liquidität, Volumen, MCap
5. TRADES               Token Trade Data                       12 CU
                        → Momentum-Rohfeatures
6. SECURITY             Token Security (+ Tracker Risk)        25 CU
                        → harte Blocker; alles andere als Feature
7. SMART MONEY          aus der Discovery-Liste, kein Einzelabruf
8. SOCIAL               DexScreener-Metadaten                  billig
9. JUPITER-QUOTE        /quote mit echter Positionsgröße        —
                        → Ein- UND Ausstieg prüfen
10. EV                  netto nach Ausführungskosten
```

Zwei Abweichungen von deinem Entwurf, beide begründet:

- **Identität vor Basisfilter.** Das Alter ist der billigste harte Ausschluss
  überhaupt und einmalig zu holen. Ihn hinter den Preis zu setzen heißt, Preise
  für Tokens zu kaufen, die am Alter scheitern.
- **Smart Money nicht als eigene Stufe.** Als Liste kostet es fast nichts und
  gehört in die Discovery. Als Einzelabruf je Token wäre es teurer als Security.

Jeder Reject wird gespeichert (§26) — mit Stufe, Grund und den bis dahin
bekannten Feldern. Ohne das gibt es später keine False-Negative-Forschung.

---

## L. Capability-Lücken

Was keiner der sechs liefert:

| Fehlt | Warum es zählt | Ersatz |
|---|---|---|
| **Exit-Liquidität bei Größe X** | §33: +500 % nützen nichts, wenn nicht verkäuflich | Jupiter-Quote in Gegenrichtung mit realer Größe |
| **Wallet-PnL-Historie** | „gute Wallet" empirisch statt vom Anbieter | selbst aus Helius-Transaktionen ableiten |
| **Social-Aktivität über Zeit** | Existenz eines X-Kontos ist kein Signal | keiner; nur Existenz (DexScreener) |
| **Order-Book-Tiefe** | auf AMMs gibt es keine | Preis-Impact-Kurve über mehrere Quote-Größen |
| **Slot→Zeit-Auflösung** | Jupiter liefert `contextSlot`, wir brauchen Zeit | Helius RPC |

Der letzte Punkt ist unscheinbar und wichtig: ohne Slot→Zeit können wir einen
Quote nicht sauber in die Zeitachse einordnen — und damit nicht gegen
Look-Ahead prüfen.

---

## M. Neue Capabilities — 8 von 17 empfohlen

Mein Maßstab: eine Capability verdient einen eigenen Wert nur, wenn (a) die
Kette sie unabhängig auflösen kann, (b) sie eine eigene Staleness-Policy hat und
(c) ein Anbieter für sie einzeln `READY` sein kann.

**Empfohlen (8):**

| Neu | Begründung | Nutzer in der Pipeline |
|---|---|---|
| `TOKEN_TRADES` | Trade-Ebene, Staleness in Sekunden statt Minuten | Momentum-Stufe |
| `TOKEN_CREATION` | **unveränderlich** — völlig anderes Cache- und Kostenprofil | Identitätsstufe |
| `TOKEN_METADATA` | Name, Symbol, Decimals; mutabel, billig | Anzeige, Alert |
| `SMART_MONEY` | eigene Auth-/Tarifstufe (S: paketabhängig) | Discovery |
| `WALLET_ACTIVITY` | Rohdaten für eigene Ableitungen | Dev-/Insider-Forschung |
| `TRANSACTION_HISTORY` | historische Rekonstruktion | Replay, §60 |
| `EXECUTION_SIMULATION` | anderer Fehlermodus als ein Quote | Vor-Ausführung |
| `MARKET_STREAM` | ein WebSocket kann tot sein, während REST lebt — **eigene Gesundheit** | Discovery, Monitoring |

**Nicht empfohlen (9), mit Grund:**

| Abgelehnt | Grund |
|---|---|
| `TOKEN_RISK` | Duplikat von `SECURITY_REPORT` |
| `TOKEN_SOCIAL` | Duplikat von `SOCIAL_SIGNALS` (existiert bereits) |
| `DEV_ACTIVITY`, `INSIDER_ACTIVITY` | **Features**, keine Capabilities — Felder in `SECURITY_REPORT` bzw. abgeleitet aus `WALLET_ACTIVITY` |
| `LIQUIDITY_HISTORY` | dieselbe Endpunktfamilie wie `PRICE_HISTORY` |
| `WALLET_HISTORY` | Zeitfenster von `WALLET_ACTIVITY`, kein eigener Vertrag |
| `RPC` | **Transport**, keine Fähigkeit — gehört in die Provider-Konfiguration |
| `TRANSACTION_STREAM` | von `MARKET_STREAM` abgedeckt, wenn wir es als „Stream-Gesundheit" fassen |
| `REALTIME_MARKET_STREAM` | Langform von `MARKET_STREAM` |
| `EXECUTION_QUOTE` | Duplikat von `ROUTE_QUOTE` |

Ergebnis: **8 vorhandene + 8 neue = 16 Capabilities.**

---

## N. Datenbank-Änderungen

| Tabelle | Art | Zweck | Spezifikation |
|---|---|---|---|
| `token_candidates` | **neu** | Discovery-Dedup: `mint`, `first_seen_provider`, `first_seen_at`, `all_seen_providers` | §49 |
| `feature_observations` | **neu** | Ein Feature, ein Anbieter, ein Zeitstempel: `feature_name`, `value`, `provider`, `endpoint`, `observed_at`, `received_at`, `data_age_ms`, `source_tier`, `quality` | §21, §48 |
| `provider_requests` | **neu** | Kostenzuordnung: `provider`, `endpoint`, `capability`, `cost_units`, `http_status`, `latency_ms`, `token_id`, `pipeline_stage`, `decision_id` | §38 |
| `provider_capability_status` | **neu** | Reifegrad je (Provider, Capability): `CONFIGURED → CONNECTED → SCHEMA_VERIFIED → CAPABILITY_READY → PRODUCTION_ENABLED` | §65 |
| `execution_quotes` | **neu** | Quote mit Alter, Route, Impact — Ein- und Ausstieg getrennt | §32, §33 |
| `holder_observations` | **neu** | Holder-Verlauf; absolute Werte und Änderungen getrennt | §29 |
| `security_observations` | **neu** | Rohsignale je Anbieter, vor der eigenen Engine | §15 |
| `token_snapshots` | **erweitern** | `schema_version`, `adapter_version` | §61 |
| `rejections` | **erweitern** | Pipeline-Stufe des Rejects | §26 |
| `SourceTier` | **erweitern** | `DERIVED` ergänzen | §35 |

`feature_observations` ist die folgenreichste Änderung. Heute trägt ein
`token_snapshot` **eine** Herkunft für die ganze Zeile. §21 verlangt Herkunft je
Feld — Preis von Birdeye, Liquidität von Solana Tracker, in derselben Zeile.
Das geht nur mit einer schmalen Tabelle. Sie wird die größte im System; die
Aufbewahrungsfrist gehört mitentschieden.

---

## O. Worker-Änderungen

| Worker | Änderung | Neu? |
|---|---|---|
| `market-refresh` | echte Adapter statt leerer Kette; Checkpoint bleibt | bestehend |
| `discovery` | Listen-Endpunkte + Dedup nach `token_candidates` | bestehend, leer |
| `enrichment` | Security-Ensemble aus drei Quellen | bestehend, leer |
| **`stream`** | dauerhafte WebSockets: Connect, Heartbeat, Reconnect, Backoff, Resume, Dedup | **neu** |
| **`webhook-ingest`** | Helius-Push, idempotent über `SeenKeys` | **neu** |
| `provider-health` | Reifegrad je Capability statt je Provider | erweitern |

Der `stream`-Worker ist der einzige echte Neubau. Unsere Infrastruktur kennt
Takte und Queue-Aufträge — eine Verbindung, die *offen bleibt* und dabei
Lebenszeichen braucht, ist ein anderes Lebenszyklusmodell.

---

## P. Vercel / Worker

| Läuft **nicht** auf Vercel | Grund |
|---|---|
| WebSockets (Birdeye, Helius, Tracker) | Verbindung überlebt das Anfrageende nicht |
| Discovery-Polling | Takt |
| Snapshot-Aufnahme | Takt + Checkpoint |
| Provider-Health | Takt |
| Rate-Limit-Budget | zentraler Zustand über alle Aufrufe |

| Läuft auf Vercel | Grund |
|---|---|
| Dashboard | liest nur die Datenbank |
| INVEST-NOW-Bestätigung | **einzelner** Jupiter-Quote pro Klick, anfragegebunden |
| Webhook-**Empfang** | HTTP-Endpunkt; Verarbeitung geht sofort in die Queue |

Die letzte Zeile ist eine Nuance: Helius-Webhooks *empfangen* darf Vercel — die
Anfrage ist kurz. Verarbeiten darf es sie nicht; sie gehen als Queue-Auftrag an
den Worker. Sonst hängt die Verarbeitung an einem 15-Sekunden-Deckel.

Das Rate-Limit-Budget (§37) ist der Grund, warum Provider-Aufrufe *nicht* auf
beiden Seiten stattfinden dürfen: zwei Prozesse mit je eigenem Zähler halten
kein gemeinsames Limit ein.

---

## Q. Implementierungsreihenfolge

Sortiert nach Risiko und Abhängigkeit, nicht nach Interesse.

| # | Schritt | Warum zuerst |
|---|---|---|
| 0 | **Jupiter-Pfad klären** | blockiert das Sicherheitsmodell |
| 1 | **Ein** Marktdaten-Adapter, `TOKEN_MARKET` | schaltet die Snapshot-Historie frei — der Engpass |
| 2 | Smoke-Test + `CAPABILITY_READY` (§63) | ohne ihn ist „verbunden" eine Vermutung |
| 3 | `provider_requests` + Budget | vor dem zweiten Adapter, sonst misst niemand |
| 4 | Discovery über Listen | erst wenn Markt läuft |
| 5 | Security-Ensemble | braucht Kandidaten |
| 6 | Jupiter-Quote in den Paper-Flow | macht EV realistisch |
| 7 | `stream`-Worker | Latenzoptimierung, nicht Voraussetzung |
| 8 | Helius-Rohdaten → eigene Wallet-Features | teuerste Ableitung, größter Eigenwert |

Schritt 1 mit **einem** Anbieter, nicht mit dreien. Ein Adapter, dessen Daten in
die Historie fließen, ist mehr wert als drei halbe.

---

## R. Risiken

| Risiko | Bewertung | Gegenmaßnahme |
|---|---|---|
| **Jupiter-Pfad falsch** | hoch, sofort | Klärung vor Code |
| **CU-Explosion** | hoch | Budget vor dem zweiten Adapter; Listen vor Einzelabrufen |
| **Scheinunabhängigkeit** | hoch, unsichtbar | `feature_observations` mit Anbieter je Feld; Korrelation als Forschungsfrage |
| **Schema-Drift** | mittel, schleichend | `schema_version` je Zeile, Contract-Tests |
| **WS-Abbruch** | mittel | Heartbeat + Reconnect + Dedup |
| **Webhook-Wiederholung** | mittel | `SeenKeys` — bereits gebaut |
| **Free-Tarif-Limits** | mittel | Solana Tracker Free trägt keine Discovery |
| **Stale Data** | hoch | Staleness je Feldklasse, nicht global |
| **Vendor-Score als Wahrheit** | hoch, konzeptionell | Vendor-Score ist Feature; eigene Engine entscheidet |

Zur Staleness (§22) mein Vorschlag als Ausgangspunkt — **Annahmen, keine
Messungen**, zu überprüfen sobald echte Latenzen vorliegen:

| Feldklasse | Grenze |
|---|---|
| Execution-Quote | 5 s |
| Preis | 30 s |
| Liquidität | 60 s |
| Volumen / Trades | 120 s |
| Holder | 15 min |
| Security | 60 min |
| Creation | unbegrenzt (unveränderlich) |
| Social | 24 h |

---

## S. Empfehlung

**Bedingt** — jede Zeile gilt erst nach Schema-Verifikation.

| Bereich | PRIMARY | SECONDARY | FALLBACK |
|---|---|---|---|
| Discovery | Birdeye (Listen + WS) | DexScreener | Solana Tracker |
| Markt | Birdeye | Solana Tracker | DexScreener |
| Ausführungswahrheit | **Jupiter** | — | — |
| On-Chain | Helius | Solana Tracker RPC | — |
| Security | **eigene Engine** | Birdeye + Solana Tracker | GoPlus |
| Smart Money | Birdeye (Liste) | eigene Helius-Ableitung | — |

**Drei Abweichungen von deiner Hypothese:**

1. **DexScreener vor Solana Tracker in der Discovery.** Keine Auth, 300 RPM (S)
   — der Free-Tarif von Solana Tracker mit 3 rps und 2 500 Anfragen im Monat (C)
   trägt keine Discovery. Sobald du einen bezahlten Tarif hast, dreht sich das um.
2. **Jupiter als eigene Kategorie „Ausführungswahrheit", nicht als Cross-Check.**
   Er beantwortet eine andere Frage als die Marktdatenanbieter: nicht „was ist
   der Preis", sondern „was bekäme ich". Ihn in denselben Topf zu werfen
   verschenkt genau das Signal, das eine Abweichung trägt.
3. **Smart Money aus der Discovery-Liste, nicht als eigene Stufe.** Kostenfrage,
   siehe Abschnitt G.

---

## Freigabe

Bevor eine Zeile Adaptercode entsteht, brauche ich von dir:

1. **Jupiter:** welche Oberfläche gilt — Swap v1, Swap v2 oder Ultra?
2. **Schemas:** OpenAPI-Export, `llms.txt` oder ein aufgezeichneter
   Beispiel-Response je Endpunkt, den ich implementieren soll. GoPlus' `llms.txt`
   ist der billigste Anfang.
3. **Tarife:** welcher Birdeye-Plan, welcher Solana-Tracker-Plan? Davon hängt
   das CU-Budget ab und damit das ganze Progressive Filtering.
4. **Erster Adapter:** welcher Anbieter, welche eine Capability?

Ohne 1 und 2 bleibt es bei UNVERIFIED, und dann wird nichts gebaut.
