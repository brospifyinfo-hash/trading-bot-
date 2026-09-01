# Provider- und Capability-Status

**Stand:** 2026-09-01. Die Messungen stammen vom 2026-08-30 und sind unverändert gültig — der Egress ist derselbe.
**Regel:** Kein Endpunkt in diesem Dokument ist geraten. Wo ich die Doku nicht lesen
konnte, steht `UNVERIFIZIERT` — nicht ein Pfad aus dem Gedächtnis.

---

## 0. Die Korrektur vorweg

Frühere Formulierungen von mir („1 von 5 Providern verifiziert") konnten so gelesen
werden, als sei Jupiter einsatzbereit. Das ist falsch.

| | Jupiter | Helius | Birdeye | DexScreener | RugCheck | Solana Public RPC |
|---|---|---|---|---|---|---|
| **Vertrag verifiziert** | ✅ OpenAPI | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Zur Laufzeit erreichbar** | ❌ 403 | ❌ 403 | ❌ 403 | ❌ 403 | ❌ 403 | ❌ 403 |

**Zur Laufzeit funktioniert kein einziger Provider.** Erreichbar war ausschließlich
`raw.githubusercontent.com` — daher konnte Jupiters eigene OpenAPI-Spezifikation
gelesen werden. Der Adapter ist danach gebaut und getestet, aber **nie gegen die
echte API gelaufen**.

Gemessene Ablehnungen (Egress-Proxy, `403 to CONNECT`, Organisationsrichtlinie):

```
api.jup.ag:443              lite-api.jup.ag:443
api.dexscreener.com:443     mainnet.helius-rpc.com:443
public-api.birdeye.so:443   api.rugcheck.xyz:443
api.mainnet-beta.solana.com:443
```

Die Sperre trifft **Hosts, nicht Anbieter**. Ein Anbieterwechsel löst sie nicht.

---

## 0b. Resend — der einzige Anbieter mit fertigem Adapter

Resend ist kein Marktdatenanbieter und steht deshalb nicht in der Tabelle oben.
Der Adapter (`packages/alerts/src/resend.ts`) ist gebaut und getestet, aber
ebenfalls **nie gegen die echte API gelaufen** — `api.resend.com` ist aus diesem
Container nicht erreichbar.

| | Status |
|---|---|
| Vertrag | dokumentiert (`POST /emails`, Bearer-Auth, `idempotency-key`) |
| Adapter | implementiert, 14 Tests gegen eine injizierte `fetch`-Attrappe |
| Zur Laufzeit erreichbar | **nicht geprüft** |
| Ohne `RESEND_API_KEY` | `NOT_CONFIGURED`, sendet nichts |
| Fixture-Gelegenheit | `REFUSED`, außer `ALERT_ALLOW_TEST_EMAILS=true` |

---

## 1. Was ohne Provider funktioniert

1028 Tests, 96 Dateien — die gesamte Logik hinter der Provider-Grenze. Sie ist
provider-unabhängig, weil alle Eingänge als Schnittstelle definiert sind:

| Schnittstelle | Paket | Wartet auf |
|---|---|---|
| `RouterProvider` | providers | Jupiter (Adapter existiert, ungetestet gegen live) |
| `MarketDataProvider` | providers | Birdeye / DexScreener |
| `DiscoverySource` | discovery | DexScreener / Launchpad |
| `ChainState` | execution | Solana RPC |
| `BacktestDataSource` | backtest | eigene `token_snapshots` **oder** OHLCV-API |

---

## 2. Blockierte Provider im Detail

### 2.1 Solana RPC (inkl. Helius) — **kritischste Sperre**

| | |
|---|---|
| **Zweck** | On-Chain-Wahrheit. Ohne sie gibt es kein Security-Gate, keine Reconciliation und keine Ausführung. |
| **Benötigte Daten** | Account-Zustand (Mint-/Freeze-Authority, Token-Programm, Extensions) · Token-Supply und größte Halter · Signaturhistorie einer Adresse · geparste Swap-Transaktionen · Token- und SOL-Bestände · Blockhash · Priority-Fee-Schätzung · Transaktion senden und Status abfragen |
| **Benötigte Endpunkte** | **Protokollmethoden**, nicht Anbieter-API — sie sind Teil der Solana-JSON-RPC-Spezifikation. Aus meinem Wissen: `getAccountInfo`, `getTokenSupply`, `getTokenLargestAccounts`, `getTokenAccountsByOwner`, `getBalance`, `getSignaturesForAddress`, `getTransaction`, `getLatestBlockhash`, `sendTransaction`, `getSignatureStatuses`. **Vor Implementierung gegen die aktuelle Solana-RPC-Doku zu prüfen.** Helius' *erweiterte* APIs (Enhanced Transactions, DAS) sind anbieterspezifisch und `UNVERIFIZIERT`. |
| **Warum blockiert** | `mainnet.helius-rpc.com:443` und `api.mainnet-beta.solana.com:443` → 403 CONNECT |
| **Fallback** | **Keiner.** Jeder RPC-Anbieter erfüllt dieselbe Rolle, aber alle laufen über denselben Proxy. Ein eigener Node wäre theoretisch ein Ausweg, ist hier aber ebenso wenig erreichbar. |
| **Teilweise umsetzbar?** | **Ja, weitgehend.** Security-Scoring, Cluster-Algorithmus, Holder-Auswertung, Reconciliation-Vergleich und Pre-Trade-Validierung sind gebaut und getestet — sie arbeiten alle gegen die `ChainState`-Schnittstelle. Es fehlt genau eine Adapterklasse. |

### 2.2 Birdeye — Marktdaten und Historie

| | |
|---|---|
| **Zweck** | Preis-, Liquiditäts- und Volumenzeitreihen. Grundlage des Momentum-Scores und — als einziger Weg zu *historischen* Daten ohne Vorlaufzeit — des Backtests auf echten Daten. |
| **Benötigte Daten** | Preis · Liquidität · Market Cap · Volumen über mehrere Fenster · OHLCV-Kerzen mit Historie · Trades · Holderzahl über Zeit |
| **Benötigte Endpunkte** | `UNVERIFIZIERT`. Ich habe die Dokumentation nicht gelesen und nenne deshalb keine Pfade. |
| **Warum blockiert** | `public-api.birdeye.so:443` und `docs.birdeye.so:443` → 403 CONNECT |
| **Fallback** | Für *aktuelle* Werte: DexScreener (ebenfalls blockiert). Für *Historie*: **kein API-Fallback** — aber ein Selbstversorgungspfad, siehe unten. |
| **Teilweise umsetzbar?** | Ja. `MarketDataProvider` und Momentum-Score stehen. |

**Der Selbstversorgungspfad:** `token_snapshots` plus der `PitReader` bedeuten, dass
das System **seine eigene Historie aufbaut**, sobald *irgendein* Marktdaten-Provider
läuft. Nach N Tagen Betrieb ist ein Backtest auf selbst erhobenen Daten möglich —
ohne historische API. Das senkt die Birdeye-Abhängigkeit von „notwendig" auf
„beschleunigend", kostet aber Vorlaufzeit.

### 2.3 DexScreener — Discovery

| | |
|---|---|
| **Zweck** | **Der Eingang der Kette.** Ohne Entdeckung neuer Paare hat das System nichts zu bewerten. |
| **Benötigte Daten** | Neue Handelspaare · Basisdaten je Paar (Preis, Liquidität, Volumen, Erstellungszeit) · Token-Metadaten |
| **Benötigte Endpunkte** | `UNVERIFIZIERT`. |
| **Warum blockiert** | `api.dexscreener.com:443` → 403 CONNECT |
| **Fallback** | Grundsätzlich jede Quelle, die neue Paare meldet — Launchpad-Streams oder eigenes Log-Monitoring über RPC-Subscriptions. Alle über denselben Proxy blockiert. |
| **Teilweise umsetzbar?** | Ja, bis auf die Quelle selbst. `DiscoverySource`-Schnittstelle, Deduplizierung, billiges Vorsieb und Durchlaufschleife sind fertig und getestet. Es fehlt **genau eine Klasse**. |

### 2.4 RugCheck — Zweitmeinung Security

| | |
|---|---|
| **Zweck** | Unabhängige Zweitmeinung. Ausdrücklich **nicht** primäre Quelle: laut Architektur §13.3 werden die kritischen Sicherheitsprüfungen selbst gegen die Chain gemacht. |
| **Benötigte Daten** | Risiko-Flags · LP-Status · Holder-Konzentration |
| **Benötigte Endpunkte** | `UNVERIFIZIERT`. |
| **Warum blockiert** | `api.rugcheck.xyz:443` → 403 CONNECT |
| **Fallback** | **Ja, und zwar geplant** — die eigene Security-Engine gegen die Chain. |
| **Teilweise umsetzbar?** | **Vollständig.** Das Security-Gate funktioniert ohne RugCheck, sobald RPC verfügbar ist. Von den vier ist dies der einzige wirklich verzichtbare. |

### 2.5 Jupiter — Sonderfall

Vertrag verifiziert (Hersteller-OpenAPI über GitHub), Adapter implementiert und
gegen schema-abgeleitete Fixtures getestet. **Aber `api.jup.ag` ist zur Laufzeit
ebenso blockiert.** Der Adapter ist nie gegen die echte API gelaufen.

Was das konkret bedeutet: die Laufzeitvalidierung im `ProviderHttpClient` würde eine
abweichende Antwort als `MISSING(PARSE_FAILED)` melden und den Provider als
ausgefallen führen — statt still falsch zu rechnen. Der erste echte Aufruf ist damit
abgesichert, aber er hat noch nicht stattgefunden.

---

## 3. Rangfolge der Sperren

1. **Solana RPC** — ohne sie kein Security-Gate, keine Reconciliation, keine Ausführung. Blockiert am meisten.
2. **DexScreener (oder eine Discovery-Quelle)** — ohne sie kein Eingang.
3. **Jupiter-Laufzeit** — ohne sie keine Quotes, also keine realistische Kostenrechnung und keine Ausführung.
4. **Birdeye** — beschleunigend, nicht notwendig (Selbstversorgungspfad).
5. **RugCheck** — verzichtbar.

**Mit RPC + einer Discovery-Quelle + Jupiter-Laufzeit wäre das System im
Paper-Betrieb lauffähig.** Drei Hosts, nicht fünf.
