# Solana Alpha Engine — Systemarchitektur

**Status:** Entwurf v0.1 — Architekturphase, noch kein Code.
**Datum:** 2026-08-30
**Scope:** Data-driven autonomous Solana memecoin trading system.

---

## 0. Vorbemerkung: was dieses Dokument *nicht* behauptet

- Es gibt hier **keine Aussage über Profitabilität**. Kein Score, kein Filter, keine Strategie in diesem Dokument ist validiert. Validierung passiert ausschließlich über Backtest + Out-of-Sample + Paper Trading (Kapitel 8, 17).
- **API-Details in Kapitel 13 sind Planungsstand aus meinem Modellwissen, nicht verifiziert.** Verbindliche Regel für die Implementierung: vor *jeder* Provider-Integration wird die aktuelle Live-Dokumentation geprüft und das Ergebnis in `docs/providers/<name>.md` festgehalten (Base-URL, API-Version, Auth-Schema, Rate Limits, Preis, gelieferte Felder, historische Verfügbarkeit, Datum der Prüfung). Kein Endpunkt geht ungeprüft in Code. Wenn ein hier genannter Endpunkt nicht mehr existiert, wird das dokumentiert — nicht geraten.
- Latenz-, Kosten- und Fill-Modelle sind **Modelle**. Sie werden gegen real gemessene Werte kalibriert, sobald der Paper-Betrieb läuft (Kapitel 8.4).

---

## 1. Zielbild und Nicht-Ziele

### Ziel
Ein System, das Solana-Memecoins selbstständig entdeckt, mehrdimensional bewertet, und daraus eine **nachvollziehbare, versionierte, reproduzierbare** Handelsentscheidung ableitet — mit Kapitalerhalt als oberster Priorität.

### Explizite Nicht-Ziele
| Nicht-Ziel | Begründung |
|---|---|
| MEV-/Latenz-Sniping im Millisekundenbereich | Anderes Problem, andere Infrastruktur (Jito-Bundles, Geyser-Colo, Rust). Unser Edge soll aus *Analysequalität* kommen, nicht aus Latenz. Wir konkurrieren nicht mit Sniper-Bots um den ersten Block. |
| Maximale Trade-Anzahl | Zielgröße ist risikoadjustierter Erwartungswert, nicht Aktivität. |
| Vollautomatische Strategie-Selbstoptimierung im Live-Betrieb | Overfitting-Falle. Strategien werden versioniert und manuell freigegeben (Kapitel 17.4). |
| „Der Bot findet alles" | Coverage ist bewusst begrenzt durch Provider-Rate-Limits und Kostenbudget. Lieber 200 Tokens/Tag gründlich als 20.000 oberflächlich. |

### Der zentrale Denkfehler, den dieses System vermeiden soll
Die meisten Memecoin-Bots berechnen einen Score und handeln ab Schwellwert. Das ist keine Trading-Entscheidung, sondern eine Sortierung. Eine Trading-Entscheidung braucht:

```
EV = P(win) · E[R | win] − P(loss) · E[|R| | loss] − E[Kosten]
```

`P(win)` und `E[R]` sind **empirische Größen**, die man nur aus der eigenen realisierten Verteilung schätzen kann. Vor dem ersten validierten Datensatz ist `EV = UNKNOWN` — und `UNKNOWN` bedeutet in diesem System **kein Live-Trade**, nicht „nimm 50 %". Siehe Kapitel 9.4 (Calibration Gate).

---

## 2. Systemarchitektur (Überblick)

```
                         ┌────────────────────────────────────────┐
   Browser  ────HTTPS───►│  apps/web  (Next.js, App Router)       │
   (Dashboard,           │  • UI + Read-Models                    │
    Manual Confirm)      │  • BFF-Routen (nur lesen + Intents)    │
                         │  • KEIN Signer, KEIN RPC-Write         │
                         └───────┬───────────────────┬────────────┘
                                 │ SQL (read)        │ enqueue intent
                                 ▼                   ▼
                         ┌──────────────┐    ┌──────────────────┐
                         │  PostgreSQL  │◄──►│  Redis + BullMQ  │
                         │  (+Timescale)│    │  Queues + Locks  │
                         └──────▲───────┘    └────────┬─────────┘
                                │                     │
        ┌───────────────────────┴─────────────────────┴───────────────────┐
        │                    apps/worker  (N Prozesse, rollenbasiert)     │
        │                                                                 │
        │  discovery → screening → enrichment → scoring → decision        │
        │  positions (TP/SL/Trailing) · reconciler · scheduler · alerts   │
        └───────┬──────────────────────────────────┬──────────────────────┘
                │ Provider-Calls (HTTP/WS)         │ signRequest (mTLS, intern)
                ▼                                  ▼
   ┌────────────────────────────┐       ┌─────────────────────────────┐
   │  Externe Datenquellen      │       │  apps/signer                │
   │  RPC · Jupiter · Birdeye   │       │  • einziger Ort mit Key     │
   │  DexScreener · Social · AI │       │  • eigene Policy-Engine     │
   └────────────────────────────┘       │  • kein Netz nach außen     │
                                        └──────────┬──────────────────┘
                                                   │ signierte TX
                                                   ▼
                                        ┌─────────────────────────────┐
                                        │  Solana RPC (send/confirm)  │
                                        └─────────────────────────────┘
```

### Architekturprinzipien

1. **Der Browser handelt nie.** `apps/web` erzeugt höchstens *Intents*. Jede tatsächliche Ausführung passiert im Worker, nach eigener Revalidierung.
2. **Der Signer ist eine eigene Vertrauenszone.** Selbst ein vollständig kompromittierter Execution-Worker kann keine beliebige Transaktion signieren lassen — der Signer prüft eigenständig (Kapitel 12.2).
3. **Alles, was eine Entscheidung beeinflusst hat, wird persistiert** — inklusive der Frage, *wann wir es wussten* (`observed_at`). Ohne das ist kein ehrlicher Backtest möglich (Kapitel 17.1).
4. **Fehlende Daten sind niemals ein Defaultwert.** Typ-erzwungen (Kapitel 5.4).
5. **Ein einziges Kostenmodell** wird von Paper Trading *und* Backtest *und* Live-Pre-Trade-Check benutzt. Sonst driften die drei auseinander und die Statistik lügt.

---

## 3. Service-Aufteilung

| Service | Verantwortung | Skaliert | Hat Secrets |
|---|---|---|---|
| `apps/web` | Dashboard, Konfiguration, Manual-Confirm-Flow, Read-APIs | 1–2 | Session-Secret, DB-RO-User |
| `apps/worker:discovery` | Neue Tokens/Pairs finden, deduplizieren, Kandidaten anlegen | 1 | Provider-Keys |
| `apps/worker:enrichment` | Market-, Security-, Holder-, Wallet-, Social-Daten holen | 2–4 | Provider-Keys |
| `apps/worker:scoring` | Feature-Vektor bauen, Sub-Scores, Final Score, Snapshot schreiben | 1–2 | — |
| `apps/worker:decision` | Hard Gates, EV, Risk-Check, Signal erzeugen (ENTER/WATCH/REJECT) | 1 | — |
| `apps/worker:execution` | Pre-Trade-Revalidierung, Quote, TX bauen, an Signer, senden, bestätigen | 1 (Singleton) | Signer-mTLS-Cert |
| `apps/worker:positions` | Offene Positionen überwachen, TP/SL/Trailing/Dynamic Exit auslösen | 1 (Singleton) | — |
| `apps/worker:paper` | Paper-Fills simulieren, Paper-Positionen führen | 1 | — |
| `apps/worker:reconciler` | DB-Position ⇄ On-Chain abgleichen, Drift-Events | 1 | — |
| `apps/worker:alerts` | Resend-Mails, Dedup/Cooldown | 1 | Resend-Key |
| `apps/worker:scheduler` | Repeatable Jobs: Snapshots, Health, Daily/Weekly Summary | 1 | — |
| `apps/signer` | Transaktionen signieren, Policy durchsetzen | 1 | **Private Key** |

**Warum `execution` und `positions` Singletons sind:** Nebenläufige Exit-Entscheidungen auf derselben Position sind eine der klassischen Quellen für Doppelverkäufe. Statt das über verteilte Locks zu lösen, wird die Nebenläufigkeit strukturell ausgeschlossen. Zusätzlich Postgres-Advisory-Locks pro Mint als zweite Ebene (Kapitel 11.5).

### Warum Monorepo statt Microservices mit eigenen Repos
Ein Solo-/Kleinteam-System. Ein pnpm-Workspace mit Turborepo gibt uns geteilte Typen (`packages/core`), *ein* Kostenmodell, *ein* Schema — bei getrennten Repos driften genau diese Dinge auseinander, und das ist hier der teuerste denkbare Fehler.

---

## 4. Datenfluss

### 4.1 Discovery → Entscheidung

```
[1] DISCOVERY          neue Pairs / Launches / Volumen-Spikes
    │                  → dedupe über (chain, mint) UNIQUE
    │                  → tokens INSERT ... ON CONFLICT DO NOTHING
    ▼
[2] CHEAP SCREEN       nur billige Daten (1 Provider-Call, oder cached)
    │                  Alter, Liquidität, Mint/Freeze Authority, Pool-Typ
    │                  ~90 % fallen hier raus  →  rejections (reason=CHEAP_SCREEN)
    ▼                  Zweck: Provider-Budget schützen
[3] ENRICHMENT         parallel, mit per-Provider-Rate-Limiter:
    │                  market · security · holders · devwallet · smartmoney · social
    │                  jedes Ergebnis = Observation<T> mit observed_at
    ▼
[4] FEATURE BUILD      rohe Observations → deterministischer Feature-Vektor
    │                  fehlende Inputs werden als MISSING markiert, nicht ersetzt
    ▼
[5] SCORING            Sub-Scores → Final Score   (score_engine_version)
    ▼
[6] HARD GATES         boolesche Killkriterien — überschreiben JEDEN Score
    ▼
[7] EV ESTIMATE        empirische Verteilung des Score-Buckets − Kostenmodell
    ▼
[8] RISK / PORTFOLIO   Sizing, Exposure, Circuit Breakers
    ▼
[9] DECISION           ENTER | WATCH | REJECT   → signals + decision_inputs
    │
    ├── MANUAL MODE ──► E-Mail-Alert (Kapitel 9)
    └── AUTO MODE   ──► trade_intents (Kapitel 10)
```

**Wichtig zu Schritt [2]:** Die Reihenfolge ist ein Kostenmodell, keine Logik-Präferenz. Teure Calls (Holder-Historie, Wallet-Clustering, Social) laufen erst, wenn die billigen Hard Facts bestanden sind. Ein Token, das an Schritt [2] scheitert, kostet uns fast nichts.

### 4.2 Snapshot-Pfad (für Backtest und Forensik)
Parallel zu jedem Scoring-Durchlauf wird ein `token_snapshots`-Datensatz geschrieben: der komplette Zustand, den das System *zu diesem Zeitpunkt kannte*. Für WATCH-Tokens läuft zusätzlich ein Re-Scoring-Takt (konfigurierbar, z. B. 60 s), damit wir Zeitreihen bekommen — auch für Tokens, die wir nie gehandelt haben. Ohne diese „Kontrollgruppe" ist keine Faktorforschung möglich (Kapitel 17.3, Survivorship Bias).

---

## 5. Datenbankmodell

### 5.1 Grundsätze
- **PostgreSQL 16+**, Erweiterung **TimescaleDB** für die Zeitreihen-Tabellen (`token_snapshots`, `price_observations`). Fallback ohne Timescale: native declarative partitioning nach `observed_at` (monatlich). Beides wird von Drizzle unterstützt; die Entscheidung fällt in Phase 3 nach einem Volumen-Test.
- **Append-only für alles Entscheidungsrelevante.** `signals`, `scores`, `position_events`, `executions` werden nie geUPDATEt. Zustand ergibt sich aus dem letzten Event.
- **Jede externe Beobachtung trägt zwei Zeitstempel:** `observed_at` (wann *wir* es gesehen haben) und `source_ts` (wofür der Provider es datiert). Backtests filtern **ausschließlich** auf `observed_at`.
- **Jede Entscheidung trägt eine Version:** `score_engine_version`, `strategy_version_id`, `provider_set_hash`.

### 5.2 Tabellen (Kernmodell)

**Identität & Zugang**
| Tabelle | Zweck | Wichtige Constraints |
|---|---|---|
| `users` | Konten | `email UNIQUE` |
| `user_totp` | 2FA-Secrets (verschlüsselt) | 1:1 zu users |
| `sessions` | Server-Sessions | TTL, IP/UA-Binding |
| `wallets` | Trading-/Main-Wallet-**Adressen** (nie Keys) | `pubkey UNIQUE`, `role ENUM(trading, treasury, watch)` |

**Token-Domäne**
| Tabelle | Zweck |
|---|---|
| `tokens` | Kanonischer Token. `mint UNIQUE`. Interne UUID als `token_id`. |
| `token_pools` | Pools/Pairs pro Token (DEX, Pool-Adresse, Quote-Mint, erstellt_am) |
| `token_snapshots` | **Hypertable.** Zeitreihe des bekannten Zustands (Preis, MC, Liq, Vol, Holders, Sub-Scores, Final Score, data_completeness) |
| `token_security` | Security-Beobachtungen, append-only, versioniert nach `check_version` |
| `token_social` | Social-Beobachtungen, append-only |
| `token_wallet_metrics` | Holder-/Cluster-Kennzahlen pro Zeitpunkt |
| `token_narratives` | AI-klassifizierte Narrative + Confidence + Modell-Version |

**Wallet-Intelligenz**
| Tabelle | Zweck |
|---|---|
| `wallet_transactions` | Normalisierte Swap-Events pro Wallet (mint, side, amount, sol_value, ts, sig) |
| `smart_money_wallets` | Qualifizierte Wallets. **`qualified_at` ist kritisch** — eine Wallet zählt für eine Entscheidung nur, wenn sie *vor* deren Zeitpunkt qualifiziert war (Kapitel 17.2) |
| `wallet_labels` | Bekannte CEX-/Bridge-/Router-/Burn-Adressen. Ohne diese Liste ist Clustering wertlos |
| `wallet_clusters` | Cluster-Kopf, `method_version`, `computed_at` |
| `wallet_cluster_members` | Zuordnung + Kanten-Evidenz + Confidence |
| `dev_wallets` | Dev-Historie pro Wallet: Launches, Rugs, realisierte PnL, Verhaltensmuster |

**Strategie & Entscheidung**
| Tabelle | Zweck |
|---|---|
| `strategies` | Logische Strategie |
| `strategy_versions` | **Immutable.** Parameter-JSON, Grund, Autor, Backtest-Ergebnis-Ref, `activated_at`, `activated_by` |
| `scores` | Score-Ergebnis + alle Sub-Scores + `input_hash` |
| `decision_inputs` | Kompletter Feature-Vektor als JSONB + Hash (Replay-fähig) |
| `signals` | ENTER/WATCH/REJECT + Begründungen (`reasons[]`, `risks[]`) + EV-Schätzung |
| `rejections` | Jeder interessante, aber nicht gehandelte Token + strukturierter Grund |

**Handel**
| Tabelle | Zweck |
|---|---|
| `trade_intents` | Absicht zu handeln. `idempotency_key UNIQUE`. Partieller Unique-Index verhindert doppelte offene Intents pro Mint |
| `orders` | Konkreter Auftrag (Entry/TP/SL/Exit) mit Zielgrößen |
| `executions` | Ausführungsversuch: Quote, Route, Slippage, Signatur, Status, Fehler |
| `positions` | Offene/geschlossene Position, `mode ENUM(paper, live)` |
| `position_events` | **Append-only Timeline**: opened, tp1_hit, partial_sold, trail_armed, sl_hit, closed, reconciled |
| `take_profit_levels` | Konfigurierte + erreichte TP-Stufen pro Position |
| `paper_trades` | Paper-spezifische Zusatzdaten (simulierte Kosten-Breakdown) |

**Betrieb**
| Tabelle | Zweck |
|---|---|
| `risk_events` | Circuit-Breaker-Auslösungen, Limit-Verletzungen |
| `circuit_breaker_state` | **Persistent** — ein Neustart darf keinen Daily-Loss-Lockout aufheben |
| `provider_health` | Health-Status/Latenz/Fehlerrate je Datenquelle über Zeit |
| `alerts` / `email_alerts` | Alert-Historie + Dedup-Keys + Cooldown-Fenster |
| `manual_trade_tokens` | Einmal-Tokens für E-Mail-Buttons (gehasht, TTL, single-use) |
| `reconciliation_events` | Abweichungen DB ⇄ Chain |
| `system_events` | Start/Stop/Mode-Wechsel/Deploy/Config-Change (Audit-Trail) |
| `backtest_runs` / `backtest_trades` | Reproduzierbare Backtest-Läufe inkl. Code-Commit-Hash |

### 5.3 Der wichtigste Index
```sql
-- Point-in-time Zugriff: „was wussten wir über Token X um 12:00?"
CREATE INDEX ON token_snapshots (token_id, observed_at DESC);
-- Verhindert zwei gleichzeitig offene Intents auf denselben Mint
CREATE UNIQUE INDEX trade_intents_one_open_per_mint
  ON trade_intents (token_id)
  WHERE status IN ('created','validating','executing');
```

### 5.4 Typ-erzwungene Datenehrlichkeit
Kein Trading-Input ist ein nackter `number`. Alles ist:

```ts
type Observation<T> = {
  value: T;
  source: ProviderId;
  observedAt: Date;   // wann WIR es sahen  → Backtest-Filter
  sourceTs: Date | null;
  confidence: number; // 0..1
};

type Maybe<T> = Observation<T> | { kind: 'MISSING'; reason: MissingReason };
```

Der Compiler zwingt damit jede Feature-Funktion, den Fall `MISSING` zu behandeln. Ein `?? 0` auf einem Trading-Input ist per ESLint-Regel verboten. Fehlende Daten senken `data_completeness` und können ein Hard Gate auslösen — sie werden nie stillschweigend zu einer Zahl.

---

## 6. API-Struktur

Trennung: **Read-APIs** (Dashboard, unkritisch) vs. **Command-APIs** (erzeugen Intents, streng geschützt).

### 6.1 Read (Next.js Route Handlers, Session-Auth)
```
GET  /api/scanner                 Marktscanner-Liste (Filter, Paging)
GET  /api/tokens/:mint            Detail + aktuelle Scores + Snapshot-Historie
GET  /api/tokens/:mint/timeline   Discovery→Decision-Timeline
GET  /api/positions               offene/geschlossene Positionen (paper|live)
GET  /api/positions/:id           Position + vollständige Event-Timeline
GET  /api/trades/:id              Trade-Detail: erwartet vs. real, Slippage, Fees
GET  /api/performance             Portfolio-Kennzahlen, gefiltert nach mode/version
GET  /api/research/factor         Faktoranalyse (Bucket → WinRate/EV/PF/DD)
GET  /api/rejections              Rejection-Log mit Gründen
GET  /api/health                  Provider-Health + Circuit-Breaker-Status
GET  /api/strategies/:id/versions Strategie-Historie
```

### 6.2 Command (POST, CSRF + Session + 2FA-Step-up)
```
POST /api/bot/mode                { manual|auto, paper|live }  → 2FA für live
POST /api/bot/emergency-stop      sofortiger globaler Stop
POST /api/config/strategy         erzeugt NEUE strategy_version (nie in-place)
POST /api/trade/manual/validate   Live-Revalidierung eines Intents  (Kapitel 9.2)
POST /api/trade/manual/confirm    finale Bestätigung → enqueue     (Kapitel 9.3)
POST /api/positions/:id/close     manueller Exit
POST /api/backtest/run            Backtest-Lauf starten
```

**Regel:** Keine Command-Route führt selbst einen Trade aus. Sie schreibt einen Intent und enqueued einen Job. Die Ausführung passiert im `execution`-Worker mit eigener, unabhängiger Prüfung. Der Grund: eine XSS/CSRF-Lücke im Web-Layer darf maximal einen *Vorschlag* erzeugen, nie eine Transaktion.

### 6.3 Interne Signer-API (nicht öffentlich, mTLS, nur im Docker-Netz)
```
POST /sign   { unsignedTxBase64, intentId, policyContext }
             → 200 { signedTxBase64 }  |  409 { policyViolation }
```

---

## 7. Trading-State-Machine

### 7.1 Token-Lifecycle
```
DISCOVERED ─► SCREENING ─► ENRICHING ─► SCORED ─┬─► CANDIDATE ─► DECIDED
     │            │            │                ├─► WATCHLIST ──┐
     └────────────┴────────────┴────────────────┴─► REJECTED    │
                                                    ▲            │
                                       Re-Scoring-Takt ──────────┘
```
`WATCHLIST` ist kein Endzustand — Tokens werden im Takt neu bewertet und können nach `CANDIDATE` wandern. `REJECTED` mit Grund `SECURITY_CRITICAL` ist dagegen terminal (Blacklist).

### 7.2 Trade-/Position-Lifecycle
```
                     ┌──────────────────────────────────────────┐
INTENT_CREATED       │                                          │
      │              │                                          │
      ▼              │                                          │
PRE_TRADE_VALIDATION ┤─► ABORTED_STALE     (Marktzustand verändert)
      │              ├─► ABORTED_POLICY    (Gate/Risk/Breaker)
      ▼              └─► ABORTED_EXPIRED   (Intent zu alt)
   QUOTED
      │
      ▼
   SIGNING ──────────► SIGN_REJECTED  (Signer-Policy)
      │
      ▼
  SUBMITTED
      │
      ├─► CONFIRMED ──► OPEN ──► PARTIALLY_CLOSED ──► CLOSING ──► CLOSED
      │                   │            │                 ▲
      │                   └────────────┴─────────────────┘
      │
      ├─► FAILED (on-chain revert / slippage) ──► terminal, geloggt
      │
      └─► UNKNOWN  ──► RECONCILING ──► {CONFIRMED | FAILED}
```

**`UNKNOWN` ist der wichtigste Zustand der ganzen Maschine.** Er entsteht, wenn wir eine Transaktion gesendet haben, aber die Bestätigung nicht beobachten konnten (RPC-Timeout, Neustart, Netzwerkfehler). Er darf **niemals** als `FAILED` behandelt werden — sonst kauft der Bot erneut und hält am Ende die doppelte Position. `UNKNOWN` blockiert weitere Aktionen auf diesem Mint, bis der Reconciler die Signatur on-chain aufgelöst hat (Kapitel 11.6).

---

## 8. Paper-Trading-Architektur

### 8.1 Grundidee
Paper Trading ist **kein vereinfachter Pfad**. Es benutzt dieselbe Decision-Engine, dieselbe Risk-Engine, dasselbe Position-Management und dasselbe Kostenmodell wie Live. Der einzige Unterschied liegt in der letzten Schicht:

```
Decision → Risk → Execution-Planung → ┬─► LiveExecutor   (signiert & sendet)
                                      └─► PaperExecutor  (simuliert Fill)
```
Beide implementieren dasselbe Interface `Executor`. Das garantiert, dass Paper-Statistiken tatsächlich etwas über den Live-Betrieb aussagen.

### 8.2 Fill-Simulation
Standard-Testkapital: **100 € virtuell** (konfigurierbar).

Der `PaperExecutor` holt im Live-Betrieb einen **echten Quote** vom Router (Jupiter) für die geplante Größe. Das ist der ehrlichste verfügbare Preis, weil er Route und Price Impact real berücksichtigt. Darauf werden modelliert:

| Kostenkomponente | Modellierung |
|---|---|
| Price Impact | aus dem echten Quote (`outAmount` vs. Referenzpreis) |
| Zusätzlicher Slippage | Latenzmodell: Preisdrift zwischen Quote-Zeitpunkt und angenommenem Fill-Zeitpunkt, aus gemessener Verteilung |
| DEX-Fee | im Quote enthalten |
| Netzwerk-Fee | Basis-Fee + gemessene Signaturkosten |
| Priority Fee | dieselbe Fee-Strategie wie Live (nicht null!) |
| Jito-Tip | falls Live-Pfad Bundles nutzt, identisch angesetzt |
| Fehlgeschlagene TX | Ausfallwahrscheinlichkeit aus Live-Messung; ein Fail kostet Fees ohne Fill |
| Exit-Liquidität | vor jedem simulierten Exit wird geprüft, ob die Größe zum modellierten Impact überhaupt rausgeht |

**Partial Fills:** auf Solana-AMMs gibt es keine Teilausführung im Orderbuch-Sinn — eine Swap-TX geht ganz durch oder revertet. Modelliert wird stattdessen realistisch: *TX-Fehlschlag bei Slippage-Überschreitung* und *Aufteilung großer Orders in mehrere TX* (wenn Sizing das vorsieht).

### 8.3 Ausgabeformat
```
Virtual Capital     € 100.00
Virtual Entry       € 100.00
Current Value       € 137.42
Estimated Costs     €   2.31   (DEX 0.87 · Network 0.04 · Priority 0.31 · Impact 1.09)
Realistic PnL       + € 35.11
```
Die Kosten sind aufgeschlüsselt, weil eine aggregierte Zahl nicht falsifizierbar ist.

### 8.4 Kalibrierung
Sobald Live-Trades existieren, vergleicht ein Job kontinuierlich **simulierte vs. reale** Ausführung (Slippage, Latenz, Fee, Fehlerrate) und schreibt die Abweichung nach `system_events`. Systematische Abweichung > Schwellwert ⇒ Paper-Statistiken werden im Dashboard als *unkalibriert* markiert. Ein Paper-Ergebnis, das man nicht gegen die Realität geprüft hat, ist eine Behauptung.

### 8.5 Statistiken (§4 des Master Prompts)
Berechnet als SQL-Views über `positions` + `position_events`, gefiltert nach `mode`, `strategy_version_id`, `score_engine_version`:
Total/Win/Loss Trades, Win Rate, Avg/Median Win & Loss, Profit Factor, EV/Trade, Total PnL, Max Drawdown, Avg Holding Time, Best/Worst, Consecutive Wins/Losses, Fees, Slippage.
Zusätzlich Bucket-Auswertungen nach Market Cap, Liquidität, Token-Alter, Final Score, Social/Smart-Money/Momentum/Risk-Score, Entry-/Exit-Strategie (Kapitel 17.3).

---

## 9. Manual-Mode-Flow

```
[1] Decision = ENTER, Modus = MANUAL
        │
        ▼
[2] Alert-Dedup prüfen  (Cooldown 30 min pro Mint; Ausnahme: Score +N Punkte)
        │
        ▼
[3] trade_intents INSERT (status=awaiting_user, expires_at = now + 15 min)
        │
        ▼
[4] manual_trade_tokens: 32 Byte Zufall, SHA-256 gehasht gespeichert,
    single-use, TTL 15 min   →  Klartext NUR in der E-Mail
        │
        ▼
[5] Resend: "Potential Trade Detected — $TOKEN — Score 91/100"
    Inhalt: Token, Contract, Preis, MC, Liquidität, Alter, Volumen, Holder,
            alle Sub-Scores, Final Score, Risk Level,
            WARUM erkannt (reasons[]), Hauptrisiken (risks[]),
            Suggested Entry / Stop / TP-Stufen, Positionsgröße,
            geschätzte Ausführungskosten, erwartetes R/R,
            Zeitstempel, Strategy Version
    Button: [ INVEST NOW ] → /trade/<intentId>?t=<token>
```

### 9.1 Warum der Button nichts ausführt
Der Link enthält **keine vorbereitete Transaktion und keine Autorisierung**. Er identifiziert nur einen Intent. Selbst wer die E-Mail abfängt, kann ohne eingeloggte Session nichts auslösen.

### 9.2 Beim Öffnen der Seite
1. Session-Auth prüfen (kein Login ⇒ Login-Redirect, Token bleibt gültig)
2. Einmal-Token prüfen: Hash-Match, nicht verbraucht, nicht abgelaufen
3. **Vollständige Live-Revalidierung**: Token neu laden, Preis neu laden, Liquidität neu prüfen, Security neu prüfen, Slippage neu berechnen, Hard Gates neu auswerten, Circuit Breaker prüfen
4. Ergebnis als **Diff** anzeigen: „Alert-Zeitpunkt vs. jetzt"
5. Bei signifikanter Verschlechterung ⇒ **Trade blockiert**: `Trade expired — market conditions changed` mit konkreter Begründung (welche Größe sich wie verändert hat)

Konfigurierbare Abbruchkriterien, z. B.: Preis > X % über Alert-Preis, Liquidität < Y % des Alert-Werts, Security-Level verschlechtert, Intent älter als 15 min.

### 9.3 Bestätigung
Anzeige: TOKEN · ENTRY · POSITION SIZE · MAX SLIPPAGE · EXPECTED COST · RISK · STOP · TP-LEVELS.
`CONFIRM TRADE` POSTet mit CSRF-Token **und** der `revalidation_id` aus Schritt 9.2. Der Execution-Worker akzeptiert nur Revalidierungen, die jünger als 60 s sind — und prüft *selbst noch einmal*, bevor er signieren lässt. Drei unabhängige Prüfungen (Alert, Seite, Worker), weil zwischen jeder Sekunden vergehen.

### 9.4 Calibration Gate
Der Übergang von PAPER nach LIVE ist ein bewusster, geschützter Schalter — und er ist gesperrt, solange nicht erfüllt ist:
- Mindestanzahl Paper-Trades (konfigurierbar, Vorschlag ≥ 100 pro Strategieversion)
- Out-of-Sample-Ergebnisse vorhanden (Walk-Forward, Kapitel 17.2)
- Profit Factor und EV/Trade werden **angezeigt, nicht bewertet** — die Freigabe trifft der Mensch, mit 2FA-Step-up
- Die UI macht dabei keine Empfehlung. Sie zeigt Zahlen inkl. Konfidenzintervall und Sample-Größe.

---

## 10. Auto-Mode-Flow

Identisch bis Schritt [9] der Decision-Pipeline. Danach:

```
ENTER  ─►  AutoGate: ALLE müssen TRUE sein
           ├─ hard gates passed
           ├─ final_score ≥ strategy.min_score
           ├─ EV > 0  UND  ev_confidence ≥ min_confidence
           ├─ position sizing gültig (> Mindestgröße, < Maxgröße)
           ├─ portfolio exposure nach Trade ≤ Limit
           ├─ open positions < max_open_positions
           ├─ daily loss breaker CLOSED
           ├─ consecutive loss breaker CLOSED
           ├─ alle kritischen Provider HEALTHY
           ├─ keine offene UNKNOWN-Position auf diesem Mint
           └─ Modus = LIVE und explizit aktiviert
        ▼
   trade_intents (auto) ─► execution worker ─► Position ─► positions worker
```

Ein einziges `false` ⇒ `REJECT` mit exaktem Grund in `rejections`. Es gibt keinen „Score war so gut, wir machen eine Ausnahme"-Pfad. Das ist bewusst nicht implementierbar.

---

## 11. Risk Engine

### 11.1 Hard Gates (überschreiben jeden Score)
| Gate | Auslöser ⇒ NO TRADE |
|---|---|
| Security | Risk Level `CRITICAL`; Mint Authority aktiv (ohne Ausnahme-Regel); Freeze Authority aktiv; Transfer-Hook/Fee-Extension mit Sell-Blockade |
| Liquidität | unter Minimum; LP nicht gesperrt/verbrannt bei Neuemission |
| Exit | modellierter Exit der geplanten Größe überschreitet max. Impact |
| Konzentration | Top-10-Holder (cluster-bereinigt) über Schwellwert |
| Dev | erkanntes Rug-Muster in der Historie |
| Kosten | erwarteter Edge ≤ erwartete Ausführungskosten |
| Daten | `data_completeness` unter Schwellwert oder kritischer Provider `DOWN`/`STALE` |
| Portfolio | Exposure-, Positions-, Verlustlimit erreicht |

### 11.2 Position Sizing (risikobasiert, nicht fix)
```
riskBudget      = portfolioValue × riskPerTradePct        (z. B. 1 %)
stopDistance    = |entry − stop| / entry
sizeByRisk      = riskBudget / stopDistance
sizeByLiquidity = maxNotionalFür(maxPriceImpactPct)       ← aus Pool-Tiefe
sizeByCap       = portfolioValue × maxPositionPct         (z. B. 1–5 %)
sizeByConfidence= sizeByRisk × f(ev_confidence)           ← f ∈ [0.25, 1.0]

positionSize = min(sizeByRisk, sizeByLiquidity, sizeByCap, sizeByConfidence)
```
Das Minimum, nie ein Durchschnitt. Der bindende Constraint bei Memecoins ist fast immer `sizeByLiquidity` — und genau der wird von den meisten Bots ignoriert.

### 11.3 Circuit Breakers
Persistiert in `circuit_breaker_state`, damit ein Neustart keinen Lockout löscht.

| Breaker | Wirkung |
|---|---|
| Daily Loss Limit (z. B. 5 %) | Auto-Trading pausiert bis zum nächsten Fenster; Positionsmanagement läuft weiter |
| Max Consecutive Losses | Cooldown |
| Max Slippage / Price Impact | Einzeltrade abgebrochen |
| Max Position / Portfolio Exposure | Entry blockiert |
| Provider-, RPC-, DEX-Failure | Entry blockiert (Exits bleiben möglich) |
| Data Staleness | Entry blockiert |
| Reconciliation-Drift | **alles** pausiert, manueller Eingriff nötig |

**Asymmetrie-Regel:** Breaker blockieren *Einstiege* härter als *Ausstiege*. Ein System, das wegen eines Provider-Ausfalls eine laufende Position nicht mehr schließen kann, hat das Risiko vergrößert statt verkleinert.

### 11.4 Exit-Engine
**Statisch (konfigurierbar):** TP1 +25 % / 20 % · TP2 +50 % / 20 % · TP3 +100 % / 25 % · TP4 +200 % / 25 % · Rest 10 % Trailing.
**Stop Loss:** fester Prozentsatz + Risk-Stops bei Liquiditätskollaps, Dev-Verkauf, Insider-Verkauf, Smart-Money-Exit, Security-Statuswechsel.
**Dynamic Take Profit:** ein deterministischer, testbarer Regelsatz über Momentum, Buy/Sell-Ratio, Smart-Money-Verhalten, Volumenbeschleunigung, Holder-Wachstum, Liquidität, Social-Momentum. Momentum stark ⇒ Runner laufen lassen; Momentum kollabiert ⇒ Gewinnmitnahme beschleunigen. Jede Regel bekommt eine ID und wird im Backtest einzeln aus-/eingeschaltet messbar gemacht. Kein LLM entscheidet hier irgendetwas.
**Emergency Exit:** prüft *zuerst* Liquidität, Route, erwarteten Slippage und tatsächlich verfügbaren Exit — verkauft nicht blind in ein leeres Buch.

### 11.5 Duplicate-Trade-Schutz (vier Ebenen)
1. Idempotency-Key auf `trade_intents`
2. Partieller Unique-Index (ein offener Intent pro Mint)
3. `pg_advisory_xact_lock(hashtext(mint))` im Execution-Pfad
4. On-Chain-Balance-Check unmittelbar vor dem Signieren

### 11.6 Reconciliation
Zyklisch (z. B. alle 60 s) und nach jedem Neustart: DB-Positionen ⇄ tatsächliche Token-Account-Balances + SOL-Balance. Jede `SUBMITTED`/`UNKNOWN`-Signatur wird aufgelöst. Abweichung ⇒ `reconciliation_events` + Auto-Trading-Pause bei materieller Differenz. **Eine gesendete Transaktion gilt nie als erfolgreich, nur weil sie gesendet wurde.**

---

## 12. Security Model

### 12.1 Absolute Verbote (CI-geprüft)
Keine Private Keys / Seeds in: Source Code, Datenbank, Logs, Frontend, Git, AI-Prompts, Error-Reports, Sentry-Breadcrumbs.
Durchsetzung: `gitleaks` im Pre-Commit **und** in CI, ein pino-Redaction-Layer mit Allowlist statt Blocklist, plus ein Test, der den serialisierten Log-Output gegen bekannte Key-Muster prüft.

### 12.2 Signer-Isolation
`apps/signer` ist ein eigener Container **ohne ausgehende Internetverbindung** (Docker-Netzwerk `internal: true`). Er akzeptiert nur mTLS-Verbindungen vom Execution-Worker. Er prüft **eigenständig und unabhängig vom Aufrufer**:

- Ist das Programm im Allowlist (Jupiter-Router, Token-Programm, System-Programm, ATA)?
- Fließt SOL nur an erwartete Empfänger?
- Liegt der SOL-Abfluss unter dem harten Maximum pro TX und pro Zeitfenster?
- Entspricht der Ziel-Mint dem, was im referenzierten Intent steht?
- Ist `minimumOutAmount` gesetzt und plausibel (kein Slippage von 100 %)?
- Ist die Intent-ID neu (Replay-Schutz)?

Bei Verstoß: Ablehnung + `risk_event`. Der Punkt: ein kompromittierter Execution-Worker kann damit kein Wallet leerräumen.

### 12.3 Wallet-Trennung
`treasury` (Hauptvermögen, Cold, nie im System) ⇄ `trading` (nur Arbeitskapital, Hot). Nachfüllung ist ein manueller Vorgang. Das System kennt die Treasury-Adresse nur lesend.

### 12.4 Auth
Single-User-System: E-Mail-Magic-Link über Resend + **verpflichtende TOTP-2FA** für alle Command-Routen. Step-up-2FA (erneute Eingabe) für: Live-Modus aktivieren, Emergency Stop aufheben, Strategie-Version aktivieren, Risikolimits erhöhen. Sessions server-seitig, kurze TTL, IP/UA-Binding.

### 12.5 Secrets
Environment-Variablen aus einem Secret-Manager (Docker Secrets / SOPS+age / 1Password Connect), niemals aus `.env` im Image. Der Signer-Key liegt als eigenes Docker-Secret vor, ausschließlich in den Signer-Container gemountet. Zod-Validierung aller Env-Vars beim Start — fehlt etwas, startet der Prozess nicht (fail fast statt „läuft halb").

---

## 13. Externe Datenquellen

> **Verifikationspflicht:** Die folgenden Angaben stammen aus meinem Modellwissen und sind **nicht geprüft**. Vor jeder Integration wird die offizielle Live-Doku gelesen und `docs/providers/<name>.md` angelegt mit: Base-URL, Version, Auth, Rate Limits, Preis, Felder, historische Tiefe, Prüfdatum. Weicht die Realität ab, gilt die Realität.

### 13.1 Provider-Abstraktion
```ts
interface MarketDataProvider {
  readonly id: ProviderId;
  health(): Promise<ProviderHealth>;
  getTokenMarket(mint: string): Promise<Maybe<TokenMarket>>;
  getOhlcv(mint: string, tf: Timeframe, from: Date, to: Date): Promise<Maybe<Candle[]>>;
}
```
Jede Kategorie (Market, Security, Holder, Wallet, Social, Router) hat ein solches Interface. Provider sind austauschbar und über Config priorisierbar (Primary/Fallback). Ein `ProviderRegistry` mit Health-Tracking, Rate-Limiter (Token-Bucket pro Provider) und Circuit Breaker sitzt davor.

### 13.2 Kandidaten (zu verifizieren)

| Kategorie | Kandidat | Erwartete Rolle | Zu klären |
|---|---|---|---|
| RPC / On-Chain | **Helius** | Primär-RPC, Enhanced Transactions, DAS, Webhooks/Streams | Plan, Rate Limits, WS-Limits |
| RPC Fallback | QuickNode / Triton / eigener Node | Ausfallsicherheit | Kosten |
| Router / Execution | **Jupiter** | Quote + Swap-TX-Bau | Aktuelle Base-URL & API-Version, Rate Limits, ob API-Key nötig |
| Market Data | **Birdeye** | Preis, Volumen, OHLCV, Holder-Trends | Tarif, historische Tiefe, Chain-Header |
| Market Data (frei) | **DexScreener** | Discovery neuer Pairs, Basisdaten | Rate Limit, keine Historie |
| Launchpad | **Pump.fun / PumpPortal** | Launch-Discovery | Offiziell vs. inoffiziell — Stabilitätsrisiko dokumentieren |
| Token-Risk | **RugCheck** | Zweitmeinung Security | API-Verfügbarkeit, Preis |
| Social | **X/Twitter API v2** | Mentions, Engagement, KOL | Tarifkosten, Read-Limits — teuerste Position |
| AI | **Anthropic Claude API** | Narrativ-Klassifikation, Website-/Social-Qualitätsanalyse | Kosten pro 1k Analysen |
| E-Mail | **Resend** | Alerts | Sende-Limits, Domain-Verifikation |

### 13.3 Security-Prüfungen: eigen vs. fremd
Die kritischen Checks (Mint Authority, Freeze Authority, Token-Programm/Extensions, LP-Ownership, Top-Holder-Verteilung) werden **selbst direkt gegen die Chain** geprüft, nicht von einem Drittanbieter übernommen. Grund: das sind die Gates, an denen Kapital hängt — eine fremde API kann ausfallen, veralten oder falsch parsen. Dritt-Scores dienen als *zusätzliche* Meinung, nie als alleinige Quelle.

### 13.4 Wallet-Clustering — realistische Einschränkung
`getSignaturesForAddress` über hunderte Wallets ist teuer und langsam. Praktikabler Zuschnitt: Clustering nur für die **Top-50-Holder** eines Kandidaten, mit aggressivem Cache pro Wallet.
Kanten: gemeinsame Funding-Quelle · synchrone Entries (Δt-Fenster über ≥ k gemeinsame Tokens) · gemeinsame Gegenparteien · identische Transfer-Beträge.
Dann Thresholding + Connected Components (später ggf. Louvain).
**Bekannte Fehlerquelle:** CEX-Hot-Wallets, Bridges und Router funden tausende unabhängige Nutzer. Ohne die Label-Liste (`wallet_labels`) entsteht ein einziger Riesencluster und die Analyse ist wertlos. Die Label-Pflege ist deshalb Teil der Implementierung, kein Nice-to-have.

### 13.5 Social — die Ehrlichkeitsregel
Ein existierender X-Account ist **kein** positives Signal. Bewertet wird Authentizität:
Follower/Following-Verhältnis · Account-Alter vs. Followerzahl (implausible Wachstumsraten) · Engagement-Rate-Verteilung · Textduplikate unter Mentions · Konzentration der Mentions auf wenige Accounts · Erstellungsdatum-Clustering der Engager.
Ergebnis: `SOCIAL_AUTHENTICITY_SCORE` und `SOCIAL_MOMENTUM_SCORE`, getrennt. Ohne Daten: `MISSING`, nicht 50.

---

## 14. Kostenübersicht

> Größenordnungen, **nicht verifiziert** — werden in Phase 5 gegen die realen Preisseiten geprüft und hier korrigiert.

| Posten | Größenordnung / Monat | Anmerkung |
|---|---|---|
| RPC (Helius o. ä.) | mittlerer zweistelliger bis niedriger dreistelliger $-Bereich | Hauptkostentreiber ist Holder-/Wallet-Analyse |
| Market Data (Birdeye) | niedriger bis mittlerer dreistelliger $-Bereich | historische OHLCV treibt den Tarif |
| DexScreener | 0 | Rate-limitiert |
| X/Twitter API | dreistellig | **teuerste und am ehesten verzichtbare Position** |
| Anthropic API | niedrig zweistellig | nur qualitative Analysen, nicht pro Snapshot |
| Resend | 0–20 | |
| VPS (Docker, 8 vCPU / 32 GB / NVMe) | 40–80 | Postgres + Redis + Worker |
| Backups / Monitoring | 10–30 | |

**Kostenkontrolle als Architektur:** Das Cheap-Screen in Schritt [2] existiert genau deshalb. Zusätzlich pro Provider ein hartes Monatsbudget in der Config — bei Überschreitung schaltet der Provider auf `DEGRADED`, statt eine überraschende Rechnung zu erzeugen.

**Empfehlung zum Start:** X/Twitter-Integration in Phase 8 hinter einem Feature-Flag bauen, aber erst bezahlen, wenn die Faktoranalyse (Kapitel 17.3) zeigt, dass Social überhaupt Erklärungskraft hat. Genau dafür ist das Rejection-Log da.

---

## 15. Deployment-Architektur

### 15.1 Warum nicht Vercel
Das System braucht dauerhafte WebSocket-Verbindungen, sekündliches Position-Monitoring und einen Prozess, der nie kalt startet. Serverless ist dafür das falsche Modell. **Empfehlung: ein VPS/Dedicated Server mit Docker Compose** (Hetzner/Latitude, EU-Region, nahe am RPC-Provider). Optional kann `apps/web` separat auf Vercel laufen — die Worker nicht.

### 15.2 Compose-Topologie
```
networks:
  public    → web (Reverse Proxy, TLS)
  backend   → web, worker, postgres, redis
  signing   → worker(execution), signer      [internal: true — kein Internet]

services:
  caddy       Reverse Proxy + automatisches TLS
  web         Next.js
  worker-*    je Rolle ein Container (discovery, enrichment, scoring,
              decision, execution, positions, paper, alerts, reconciler,
              scheduler)
  signer      isoliert, Key als Docker Secret
  postgres    + TimescaleDB, WAL-Archiv, tägliches Backup off-site
  redis       AOF persistence (Queue-Verlust = verlorene Trades)
  grafana     Dashboards
  loki/promtail  Logs
```

### 15.3 Betriebsregeln
- **Migrationen:** Drizzle, forward-only, im Deploy-Schritt vor dem Worker-Start. Ein Worker mit veraltetem Schema startet nicht.
- **Graceful Shutdown:** Worker beenden laufende Jobs, bevor sie sterben. Der Execution-Worker akzeptiert bei `SIGTERM` keine neuen Jobs, wartet aber auf Bestätigung laufender Transaktionen.
- **Deploy-Regel:** Kein Deploy bei offenen Live-Positionen ohne bewusste Bestätigung. Der Deploy-Task prüft das.
- **Backups:** Postgres täglich verschlüsselt off-site + PITR über WAL. Die Datenbank *ist* das Forschungsergebnis — sie ist wertvoller als der Code.

---

## 16. Teststrategie

| Ebene | Was | Werkzeug |
|---|---|---|
| Unit (deterministisch) | Scoring-Funktionen, Sizing, TP/SL/Trailing, Kostenmodell, PnL, Slippage-Rechnung | Vitest, feste Fixtures |
| Property-Based | Sizing überschreitet nie Limits; PnL-Identitäten; Score ∈ [0,100]; Gates monoton | fast-check |
| Golden-File | Score-Engine-Output gegen eingefrorene Fixtures ⇒ **jede unbeabsichtigte Score-Änderung bricht CI** | Vitest Snapshots |
| Contract | Provider-Adapter gegen aufgezeichnete echte Responses | msw / nock, Fixtures aus Live-Calls |
| State-Machine | Alle Übergänge, insbesondere `UNKNOWN` → `RECONCILING` | Vitest |
| Integration | Postgres + Redis echt, gesamte Pipeline mit Fake-Providern | Testcontainers |
| Failure-Injection | RPC down, Quote leer, DB weg, Redis weg, stale Daten, doppelte Jobs, Provider liefert Müll | eigenes Chaos-Harness |
| Security | Kein Key in Logs/Errors; Signer lehnt manipulierte TX ab; Einmal-Token nicht wiederverwendbar; CSRF | Vitest + gitleaks |
| No-Look-Ahead | **Test, dass der Backtest-Reader keinen Datensatz mit `observed_at > asOf` zurückgeben kann** | Vitest |
| Backtest-Reproduzierbarkeit | Gleicher Lauf, gleiche Daten ⇒ bit-identisches Ergebnis | CI-Job |

**Der wichtigste einzelne Test** ist der No-Look-Ahead-Test. Ohne ihn ist jede Backtest-Zahl im System potenziell erfunden — und erfundene Zahlen sind schlimmer als keine Zahlen, weil man auf sie Kapital setzt.

---

## 17. Anti-Look-Ahead, Anti-Overfitting, Faktorforschung

### 17.1 Point-in-Time-Zugriff typerzwungen
Es gibt im Backtest-Modus **keine API, die „den aktuellen Stand" liefert**:
```ts
interface PitReader {                       // asOf ist Pflichtparameter
  snapshotAt(tokenId: string, asOf: Date): Promise<TokenSnapshot | null>;
  smartMoneyQualifiedAt(asOf: Date): Promise<WalletId[]>;
}
```
Der Live-Reader und der Backtest-Reader implementieren dasselbe Interface. Die Feature-Builder bekommen ausschließlich den `PitReader` injiziert — sie haben keinen Datenbankzugriff. Damit ist Look-Ahead kein Disziplinproblem mehr, sondern ein Compile-Fehler.

### 17.2 Die Smart-Money-Look-Ahead-Falle
Der häufigste unentdeckte Fehler in Wallet-Intelligence-Systemen: man baut heute eine Liste profitabler Wallets und testet damit die Vergangenheit. Dann „erkennt" das System natürlich Gewinner — es kannte sie ja bereits.
Gegenmaßnahme: `smart_money_wallets.qualified_at`. Für eine Entscheidung zum Zeitpunkt `t` zählen nur Wallets mit `qualified_at <= t`. Die Qualifikation läuft rollierend und wird historisch mitgeschrieben, nicht rückwirkend neu berechnet.

### 17.3 Faktorforschung & Survivorship Bias
Das Research-Dashboard beantwortet: *Welche Faktoren erzeugen tatsächlich Erwartungswert?*
Bucket-Vergleiche (Smart Money > 80 vs. < 50; Liquidität > 100k vs. < 20k; Social > 80 vs. < 50) mit Trade Count, Win Rate, EV, Profit Factor, Drawdown, Average Return — **immer mit Konfidenzintervall und Sample-Größe**. Ein Bucket mit 7 Trades bekommt kein Urteil, sondern den Hinweis „zu wenig Daten".
Damit das nicht auf Überlebenden basiert, werden **auch abgelehnte Tokens weiterverfolgt** (`token_snapshots` läuft für WATCH/REJECTED weiter). Nur so lässt sich messen, ob eine Ablehnung richtig war. Das Rejection-Log ist Forschungsmaterial, kein Papierkorb.

### 17.4 Anti-Overfitting-Regeln (verbindlich)
1. Walk-Forward: Training → Validation → **Out-of-Sample**, rollierend. Nur OOS-Zahlen werden berichtet.
2. Parameteranzahl pro Strategieversion begrenzt; jede neue Parameterachse muss begründet werden.
3. Jeder Optimierungslauf wird protokolliert — auch die verworfenen. Wer nur den besten Lauf speichert, betreibt Selbsttäuschung.
4. Eine neue Strategieversion geht **nie automatisch live**. Sie durchläuft: Backtest → Paper → manuelle Freigabe mit 2FA.
5. Keine Feature-Neuberechnung auf alten Snapshots ohne Versionsbump.
6. Verbot per Code-Review: kein Entfernen „unrealistischer" Trades aus der Statistik, keine Null-Slippage-, Null-Fee- oder Perfect-Fill-Annahme.

### 17.5 Rolle der AI
AI liefert **strukturierte Features**, nie Entscheidungen: Narrativ-Klassifikation, Website-Legitimitätsindikatoren, Social-Sentiment/Anomalie-Interpretation, qualitativer Kontext.
Jede AI-Ausgabe wird als typisiertes Schema (Zod-validiert) mit Modell-ID, Prompt-Version und Confidence gespeichert. Die Decision-Engine ist deterministisch. Ein LLM kann in diesem System keinen Trade auslösen — es gibt schlicht keinen Codepfad dafür.

---

## 18. Offene Entscheidungen (brauchen deinen Input)

| # | Frage | Warum sie die Architektur betrifft | Mein Vorschlag |
|---|---|---|---|
| 1 | Kapitalgröße & Zielposition | Bestimmt, ob Liquiditäts-Gate 20k oder 200k ansetzt und ob Memecoins überhaupt handelbar sind | Erst nennen, dann Gates kalibrieren |
| 2 | Monatsbudget für Daten-APIs | Entscheidet über Birdeye-Tarif und ob X/Twitter überhaupt kommt | Start bei ~150 $/Monat ohne Twitter |
| 3 | Hosting: VPS oder Managed | Worker brauchen Dauerbetrieb | Hetzner + Docker Compose |
| 4 | Zeithorizont der Strategie (Sekunden/Minuten/Stunden) | Bestimmt Snapshot-Takt, RPC-Kosten, Latenzbudget | Minuten bis Stunden — nicht Sniping |
| 5 | Solana-Lib: `@solana/kit` (v2) oder `web3.js` v1 | Ökosystem-Kompatibilität vs. Zukunftsfähigkeit | In Phase 2 gegen aktuelle Doku prüfen, dann festlegen |
| 6 | Timescale oder native Partitionierung | Betriebsaufwand vs. Query-Komfort | Timescale, wenn der VPS es trägt |

---

## 19. Bekannte Risiken dieses Systems

Ehrlichkeitshalber, weil sie die Erfolgswahrscheinlichkeit real begrenzen:

1. **Der Memecoin-Markt ist überwiegend adversariell.** Ein erheblicher Teil der Tokens ist so gebaut, dass genau solche Bots die Exit-Liquidität stellen. Das Security- und Cluster-Modul ist die Verteidigung dagegen, aber es ist ein Wettrüsten, kein gelöstes Problem.
2. **Datenqualität ist die Obergrenze.** Ein Score kann nicht besser sein als die Beobachtung darunter. Deshalb `data_completeness` als First-Class-Gate.
3. **Sample-Größe.** Um eine Win Rate auf ±5 % zu schätzen, braucht es mehrere hundert Trades. Vorher sind alle Kennzahlen Rauschen — das Dashboard muss das anzeigen, statt eine schöne Zahl zu suggerieren.
4. **Regime-Wechsel.** Was im Bull funktioniert, funktioniert im Bear nicht. Deshalb Market-Regime-Detection (§47) und regime-abhängige Parameter — aber jede Anpassung muss durch dieselbe Walk-Forward-Prüfung.
5. **Ausführungsrealität.** Zwischen Entscheidung und Fill vergehen Sekunden. Bei Memecoins sind das oft zweistellige Prozentpunkte. Das Kostenmodell muss deshalb pessimistisch kalibriert und laufend nachgemessen werden.
