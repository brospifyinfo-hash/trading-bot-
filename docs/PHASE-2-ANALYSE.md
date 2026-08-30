# Phase 2 — Architektur-Review und Bestandsaufnahme

**Kein Implementierungsschritt.** Dies ist die in §150 der Spezifikation geforderte
erste Aufgabe. Code folgt nach Freigabe.

Das Dokument deckt beide Buchstabenlisten ab: die aus deiner Vorgabe (A–J) und die
aus §150 der Spec (A–L). Wo sie sich überschneiden, steht die Antwort einmal.

---

## A — Bestandsaufnahme: was existiert

**15 Pakete, 41 Tabellen, 462 Tests, 8 Commits.** Vollständig getestet, ohne
externe Datenquelle lauffähig.

| Paket | Inhalt | Deckt Spec-§ |
|---|---|---|
| `core` | `Observation<T>`/`Maybe<T>`, Branded IDs, bigint-Geld, Fehlertaxonomie, Trade-State-Machine | 115, 122 |
| `config` | Zod-Schemas, harte Risikogrenzen, Defaults (Paper, Live aus) | 29, 52, 141 |
| `db` | 41 Tabellen, **PitReader mit Pflicht-`asOf`** | 73, 121, 122 |
| `providers` | Rate-Limiter, Breaker, Budget, Health, HTTP mit Schema-Validierung, Jupiter-Adapter | 4, 22, 109 |
| `discovery` | Quellen-Schnittstelle, Dedup, billiges Vorsieb | 4, 5 (teilweise) |
| `scoring` | Feature-Vektor, 9 Teilscores, Engine v1.0.0 mit Gewichtsabdeckung | 19, 20 (teilweise) |
| `risk` | Positionsgröße (Minimum aus 4 Grenzen), Exposure, Circuit Breaker | 29, 52, 53, 54 |
| `decision` | Hard Gates, EV mit Wilson-Untergrenze, Entscheidungsmaschine | 2 (teilweise), 55, 132 |
| `trading` | `Executor`-Interface, `PaperExecutor`, Positionsverwaltung, 8 Exit-Regeln, Notausstieg | 26, 30–33, 61 (teilweise) |
| `execution` | Pre-Trade-Validierung (Kauf **und** Verkauf), Signatur-Auflösung, Bestandsabgleich | 14, 57 (teilweise) |
| `simulation` | Preis-Impact, Exit-Kapazität, Kostenmodell, PnL | 2, 13, 14, 46 |
| `analytics` | Trade-Kennzahlen, Faktorforschung mit Konfidenzintervallen | 85 (Grundlage), 123, 124 |
| `backtest` | Simulationsschleife über PitReader, Walk-Forward, gesäter Zufall | 121, 122 |
| `alerts` | Einmal-Tokens, Cooldown, Revalidierung mit Diff | 56–59 (teilweise) |
| `observability` | pino mit Allowlist-Redaction, Trace-IDs, Metriken | 106 (Grundlage) |

**Apps:** `signer` (Policy vollständig, Signieren offen), `worker` (Rollen sind
Platzhalter), `web` (3 Seiten, alle Gerüst).

**Was ausdrücklich NICHT existiert:** Resend-Versand (nur Env-Schema), Wallet-/
Phantom-Integration, jede Solana-Bibliothek, jede Worker-Fachlogik, jede UI mit Daten.

---

## B/C/D/E — Anforderungs-Mapping §1–§149

Legende: **✅ vorhanden** · **➕ additiv** (fehlt, kein Umbau) · **⚠️ Konflikt**
(kollidiert mit Bestehendem) · **🔒 BLOCKED** (braucht Provider)

### Trading-Philosophie und EV (§1–§3)

| § | Anforderung | Status | Anmerkung |
|---|---|---|---|
| 1 | Trading-Philosophie | ✅ | Deckt sich mit Phase-1-Zielbild |
| 2 | Realistic Expected Value | ⚠️ **teilweise** | `estimateEv` existiert mit Wilson-Untergrenze. Aber sie nimmt Kosten als **eine** Zahl (`expectedCostFraction`). Die Zerlegung (Fees, Slippage, Impact, Latenz, Failed-Tx) liegt im Kostenmodell und ist **nicht verdrahtet**. |
| 3 | Risk/Reward-Ausgabe | ➕ | Es gibt keinen strukturierten Output mit Upside/Downside/RR/Confidence. Die Decision liefert nur `kind` + Gründe. |

### Discovery und Scanning (§4, §5)

| § | Anforderung | Status | Anmerkung |
|---|---|---|---|
| 4 | Modulare Discovery, mehrere Quellen | ✅ Architektur / 🔒 Quellen | `DiscoverySource` existiert. **Null konkrete Quellen** — alle Hosts 403. |
| 5 | Fast Scanner → Initial Filter → Deep Analysis | ➕ **teilweise** | `cheapScreen` = Initial Filter ✅. Die Dreiteilung als eigene Ebenen mit getrennten Takten existiert nicht. |

### Datenanalyse (§6–§17)

| § | Anforderung | Status | Anmerkung |
|---|---|---|---|
| 6 | Market/Momentum, ~24 Kennzahlen | ➕ **teilweise** / 🔒 | `MomentumFeatures` hat 5 Felder (5m, 1h, volumeAcceleration, buys, sells). Es fehlen: 1m/15m-Fenster, Buy-/Sell-Volumen getrennt, Transaktions-Beschleunigung, Volatilität, Recent High/Low, Drawdown from High, Recovery Strength. |
| 7 | Holder-Analyse | ➕ **teilweise** / 🔒 | Vorhanden: holders, growth, distinctActors, largestCluster. Fehlt: Top5/Top20, New Holder Rate, Retention, Distribution Changes, Growth Acceleration. |
| 8 | Wallet Intelligence | ➕ / 🔒 RPC | Tabelle `wallet_transactions` existiert. **Engine nicht implementiert.** |
| 9 | Wallet Clustering | ➕ / 🔒 RPC | Tabellen + `wallet_labels`-Seed existieren. Algorithmus nicht implementiert. |
| 10 | Smart Money Engine | ➕ / 🔒 RPC | `smart_money_wallets` **mit `qualified_at`** existiert (der Look-Ahead-Schutz). Qualifikationslogik fehlt. |
| 11 | Dev Analysis | ➕ / 🔒 RPC | `dev_wallets` existiert. Engine fehlt. |
| 12 | Security / Rug Detection | ✅ Gates / 🔒 Daten | Hard Gates auf Mint-/Freeze-Authority, LP-Status, Konzentration sind implementiert und getestet. Die **Chain-Abfrage** fehlt. |
| 13 | Liquidity Analysis | ✅ | `assessExitCapacity` beantwortet „kann ich wieder raus" — vollständig. |
| 14 | Execution Analysis | ✅ **teilweise** | Kostenmodell vollständig. Route-/Latenz-/Fill-Quality-**Lernen** fehlt (→ §105). |
| 15 | Social Intelligence | ➕ / 🔒 | `socialScore` existiert und deckelt Reichweite mit Echtheit ✅. Keine Datenquelle. |
| 16 | Website Analysis | ➕ / 🔒 | Nicht vorhanden. |
| 17 | Narrative Analysis | ➕ / 🔒 | `narrativeScore` als Durchreiche vorhanden, keine Klassifikation. |

### Feature- und Score-System (§18–§22)

| § | Anforderung | Status | Anmerkung |
|---|---|---|---|
| 18 | Market Regime Engine | ➕ | **Nicht vorhanden.** Siehe Integritätsrisiko I-3. |
| 19 | Feature Engine, versioniert/timestamped/reproduzierbar | ✅ **teilweise** | `FeatureVector` mit `asOf`, aus PitReader. Es fehlt die **Persistenz** (`feature_snapshots`). |
| 20 | 13 Scores | ⚠️ **9 von 13** | Vorhanden: Security, Liquidity, Momentum, Holder, Execution, SmartMoney, Social, Dev, Narrative + Final. **Fehlen als eigenständige Scores:** Data Quality, Risk, Confidence. |
| 21 | Confidence Score | ⚠️ **Namenskonflikt** | Es gibt `ev.confidence` = Breite des Wilson-Intervalls. Die Spec meint etwas anderes: Anzahl **ähnlicher historischer Fälle**. Siehe Konflikt K-4. |
| 22 | Data Quality Score | ⚠️ **Namenskonflikt** | Es gibt `dataCompleteness` (Anteil vorhandener Felder). Die Spec will zusätzlich Alter, Widersprüche, Provider-Ausfälle, Latenz. Siehe Konflikt K-5. |

### Entry (§23–§25)

| § | Anforderung | Status |
|---|---|---|
| 23 | Vier Entry-Modelle (Early/Confirmation/Momentum/Retest) | ➕ **nicht vorhanden** — es gibt genau ein implizites Modell |
| 24 | Entry-Timing-Lernen | ➕ / 🔒 braucht Daten |
| 25 | Nicht blind früh kaufen | ✅ Hard Gates setzen das bereits durch |

### Exit und Verlustbegrenzung (§26–§39)

| § | Anforderung | Status | Anmerkung |
|---|---|---|---|
| 26 | 9 Loss-Minimization-Regeln | ✅ **8 von 9** | Vorhanden: Stop, Dynamic, Liquidity, Dev-Sell, Smart-Money, Security, Momentum-Failure, Emergency. **Fehlt:** Execution-Failure-Exit. |
| 27 | Stop-Loss-Optimierung über 9 Distanzen | ➕ | Der Backtest kann es, die Suchschleife fehlt. |
| 28 | Volatility-aware Risk | ➕ | Volatilität ist kein Feature (→ §6). |
| 29 | Position Sizing | ✅ **vollständig** | Minimum aus 4 Grenzen, Property-getestet. |
| 30 | Partial TP Engine | ✅ **vollständig** | Inkl. Mehrfachauslösung bei Sprüngen. |
| 31 | TP-Strukturen A–E lernen | ➕ | Siehe Integritätsrisiko I-7 (Overfitting-Maschine). |
| 32 | Runner/Moonbag | ✅ | `STRONG_RUNNER` lockert, Verengung gewinnt immer. |
| 33 | Dynamic Exit + **EXIT SCORE 0–100** | ⚠️ **teilweise** | 8 Regeln liefern Aktionen, **keinen numerischen Score**. |
| 34 | Profit Protection | ✅ **teilweise** | Trailing-Verengung vorhanden, schwellenbasierte Absicherung nicht. |
| 35 | Break-Even-Logik | ➕ | Nicht vorhanden. |
| 36 | **MAE** | ➕ | Nicht vorhanden — weder Spalte noch Berechnung. |
| 37 | **MFE** | ➕ | Nicht vorhanden. |
| 38 | Exit Efficiency | ➕ | Braucht MFE + Liquiditätsprüfung. |
| 39 | Entry Quality | ➕ | Braucht MAE/MFE + Zeitmessung. |

### Fehleranalyse (§40–§42)

| § | Anforderung | Status |
|---|---|---|
| 40 | False Positives, Failure Reason | ➕ — `rejections` existiert, aber keine Nachanalyse ausgeführter Trades |
| 41 | False Negatives | ➕ |
| 42 | **Missed Opportunity Analysis** | ➕ **Kernlücke** — siehe Teil F |

### Learning und Research (§43–§50)

| § | Anforderung | Status |
|---|---|---|
| 43 | Learning Loop / Research Batch | ➕ nicht vorhanden |
| 44 | Strategy Hypothesis | ➕ nicht vorhanden |
| 45 | Automatic Strategy Generation | ➕ nicht vorhanden |
| 46 | Optimierungsziel: robuster risk-adjusted EV | ✅ als Prinzip, ➕ als Mechanik |
| 47 | Strategy Quality Score | ➕ |
| 48 | Robustheit unter 2×/3× Slippage | ➕ — Kostenmodell ist parametrisierbar, Sweep fehlt |
| 49 | Monte Carlo / Trade Sequence | ➕ |
| 50 | Risk of Ruin | ➕ |

### Portfolio-Risiko (§51–§55)

| § | Anforderung | Status |
|---|---|---|
| 51 | Korrelierte Positionen | ➕ — **wichtige Lücke**, aktuell werden Positionen als unabhängig behandelt |
| 52 | Portfolio Risk Engine | ✅ **teilweise** — Exposure, Positionszahl, Tagesverlust vorhanden; Wochen-Drawdown und korrelierte Exposure fehlen |
| 53 | Loss Streak Protection | ✅ `CONSECUTIVE_LOSSES`-Breaker |
| 54 | **No Martingale** | ✅ **strukturell** — Sizing hat keinen Verlust-Eingang, eine Recovery-Logik wäre nicht einbaubar ohne die Signatur zu ändern |
| 55 | Auto-Mode-Entscheidung, 7 Gates | ✅ **vollständig** (AutoGate) |

### Manual Mode (§56–§59)

| § | Anforderung | Status | Anmerkung |
|---|---|---|---|
| 56 | Alert mit 26 Feldern | ⚠️ **teilweise** | Revalidierung ✅, aber **Confidence, Expected Value, Potential Upside/Downside, Risk/Reward fehlen im Datenmodell** (→ §3, §21) |
| 57 | Manual Email Validation, 9 Prüfungen | ✅ **6 von 9** | Vorhanden: Preis, Liquidität, Security, Score, Alter. **Fehlen:** Smart-Money-Daten, Slippage/Impact-Neuberechnung, EV-Neuberechnung, Portfolio-Risiko |
| 58 | Response Time messen | ➕ | Zeitstempel-Kette fehlt |
| 59 | Manual Response Window | ✅ **teilweise** | Token-TTL 15 min existiert, ist aber nicht als konfigurierbares Fenster modelliert |

### Paper Trading (§60–§84) — **die größte Lücke**

| § | Anforderung | Status | Anmerkung |
|---|---|---|---|
| 60 | Paper läuft **immer** parallel | ⚠️ **echter Konflikt** | Siehe K-1 |
| 61 | Auto Paper €100 je Opportunity | ⚠️ | Siehe K-2 (fix €100 vs. Sizing) |
| 62 | Manual Paper als Opportunity | ➕ | Nicht vorhanden |
| 63 | 9 Opportunity-States | ⚠️ | Siehe K-3 (Zustände überlappen) |
| 64–68 | Confirmed / Missed / Revalidation / Rejection | ➕ | Kernlücke |
| 69–70 | Getrennte Statistiken + Opportunity Analytics | ➕ | `computeTradeStatistics` ist die Grundlage, Kategorie-Achse fehlt |
| 71 | Auto + Manual parallel auf derselben Opportunity | ➕ | Siehe Integritätsrisiko I-10 |
| 72 | Getrennte Thresholds Auto/Manual | ⚠️ | Aktuell **ein** Parametersatz |
| 73 | Same Information Set, kein Look-Ahead | ✅ **strukturell** durch PitReader |
| 74 | Drei getrennte Portfolios | ➕ |
| 75–78 | Learning-Labels, User ≠ Market Failure | ➕ |
| 79–81 | Response-Time-Analyse, Realismus, Vergleich | ➕ |
| 82 | Ablaufzeit in der E-Mail | ➕ |
| 83 | **Paper Trade Integrity** (Einfrieren) | ⚠️ **teilweise** | `positions` speichert `entryFinalScore` + `scoreEngineVersion`, **nicht den Feature-Vektor** |
| 84 | Test Trade vs. Paper Portfolio getrennt | ⚠️ | Siehe K-2 |

### Feature- und Strategie-Forschung (§85–§101)

| § | Anforderung | Status |
|---|---|---|
| 85 | Feature Performance Engine | ✅ **Grundlage** — `compareFactor` + `splitByThreshold` + Wilson-Intervalle |
| 86 | Feature Interaction | ➕ — aktuell nur einzelne Schwellwerte |
| 87 | Feature Marginal Value | ➕ |
| 88–90 | Feature/Signal/Strategy Decay | ➕ |
| 91 | Regime-spezifische Strategien | ➕ / hängt an §18 |
| 92–95 | Champion/Challenger, Shadow, Promotion, Rollback | ➕ |
| 96 | Strategy Versioning, 15 Felder | ⚠️ **6 von 15** | `strategy_versions` hat id, strategyId, version, parameters, reason, backtestRunId, createdAt, activatedAt/By, retiredAt. **Fehlen:** Features, Weights, Entry/Exit/Risk Logic, Research Dataset, Validation/OOS/Shadow Metrics, Promotion Status |
| 97 | Model Versioning | ➕ |
| 98–101 | ML, Targets, Multi-Horizon, Exit Prediction | ➕ / 🔒 braucht Daten |
| 102 | **AI keine Black Box** | ✅ **strukturell** — es gibt keinen Codepfad, über den ein Modell eine Entscheidung ausgibt |

### Attribution und Execution-Lernen (§103–§109)

| § | Anforderung | Status |
|---|---|---|
| 103 | Entry/Exit-Counterfactuals | ➕ — **muss über PitReader laufen**, siehe I-5 |
| 104 | Exit Attribution | ➕ — `exitReason` existiert, die Analyse fehlt |
| 105 | Execution Learning | ➕ |
| 106 | Latency Analysis, 6 Zeitstempel | ➕ **teilweise** — `executionDelayMs` existiert, die Kette nicht |
| 107 | Trade Quality Score | ➕ |
| 108 | Strategy Health Score | ➕ |
| 109 | Automatic Pause | ✅ **teilweise** — Breaker decken Drawdown, Datenausfall, Provider ab; Strategy Degradation fehlt |

### Statistik und Anti-Overfitting (§110–§131)

| § | Anforderung | Status |
|---|---|---|
| 110 | Research in Batches, nicht nach jedem Trade | ➕ **als Mechanik**, ✅ als Prinzip |
| 111–112 | Automatisches Lernen, Paper als Trainingsdaten | ➕ |
| 113 | 45 Trade-Event-Felder | ⚠️ **~12 von 45** vorhanden |
| 114 | 24 Trade-Result-Felder | ⚠️ **~8 von 24** vorhanden |
| 115 | Immutable Entry Snapshot | ⚠️ siehe K-6 |
| 116–119 | Verteilungen, Outlier, Contribution | ➕ |
| 120 | Parameter-Stabilität ±5/10/20 % | ➕ |
| 121 | Temporal Validation | ✅ **vollständig** — `buildWalkForwardWindows`, wirft bei gekürztem Fenster |
| 122 | Anti-Overfitting (8 Punkte) | ✅ **3 von 8 strukturell** — Look-Ahead (PitReader), Data Leakage (PitReader), Unrealistic Fills (Kostenmodell). **Offen:** Survivorship, Selection Bias, Overfitting, Future Information in neuen Pfaden, Hindsight Optimization |
| 123 | Sample-Size-Schranken | ✅ `MIN_SAMPLE_FOR_VERDICT`, `sufficientSample` |
| 124 | Bootstrap / Konfidenzintervalle | ✅ **teilweise** — Wilson vorhanden, Bootstrap nicht |
| 125 | Korrelationsanalyse | ➕ |
| 126 | Fragility Score | ➕ |
| 127–129 | Research Report, Insights, **No False Confidence** | ➕ Mechanik / ✅ Prinzip (`TOO_LITTLE_DATA`, `profitFactor = null`) |
| 130 | Promotion Safety, 10 Gates | ➕ |
| 131 | 15 Optimierungsfragen | ➕ |

### Architektur und Datenmodell (§132–§149)

| § | Anforderung | Status |
|---|---|---|
| 132 | Decision-Kette | ✅ **weitgehend** — es fehlen Market Regime und Prediction |
| 133 | Exit-Kette | ✅ **weitgehend** — es fehlen MFE/MAE und Regime |
| 134 | Gesamtarchitektur, 30 Ebenen | ✅ **~16 von 30** |
| 135 | 18 Tabellen | ⚠️ **4 von 18** — siehe Teil F |
| 136–138 | Datentrennung, 4+3 Kategorien | ➕ **Kernlücke** |
| 139 | Ultimate Learning Loop | ➕ |
| 140 | **Research nie mit echtem Kapital** | ✅ **strukturell** — `PaperExecutor` und `LiveExecutor` sind getrennte Implementierungen |
| 141 | Auto Promotion = OFF als Default | ➕ |
| 142 | Production-Strategy-Change protokollieren | ➕ |
| 143–145 | Research Freedom, keine Zufallsmutation, Batch-Versionierung | ➕ |
| 146–148 | Degradation, Health States, **No Edge Mode** | ➕ |
| 149 | Endprinzip | ✅ deckt sich |

**Zusammenfassung:** von den 149 Anforderungen sind **rund 38 ganz oder weitgehend
vorhanden**, **rund 95 additive Lücken**, **8 echte Konflikte**, und **rund 25
zusätzlich providerabhängig**.

---

## D — Die acht echten Konflikte

Diese kollidieren mit Bestehendem und brauchen eine Entscheidung, bevor gebaut wird.

### K-1 · Paper ist derzeit ein *Modus*, die Spec will einen *Strom* — **gravierend**

`DEFAULT_BOT_MODE` modelliert `execution: "paper" | "live"` als sich
**ausschließende** Alternative. §60 und §138 verlangen das Gegenteil: Paper Trading
läuft **immer**, unabhängig davon, ob Auto, Manual oder Live aktiv ist.

**Vorschlag:** Der Modus-Begriff wird ersetzt. Statt einer Achse `paper|live` gibt
es drei unabhängige Ströme:

```
AUTO_PAPER      immer an, nicht abschaltbar (Forschungsdatenstrom)
MANUAL_PAPER    immer an, nicht abschaltbar
LIVE            eigener Schalter, Default aus, 2FA-pflichtig
```

Begründung: „Paper" ist kein Betriebsmodus, sondern die Datenerhebung. Sie
abschaltbar zu machen heißt, den Lernprozess an eine Bedienentscheidung zu koppeln —
und genau das verbietet §138. Betrifft `config/defaults.ts`, `positions.mode`,
`decision/engine.ts`. **Kleiner Umbau, aber ein echter.**

### K-2 · €100-Testtrade vs. risikobasierte Positionsgröße — **statistisch relevant**

§61 verlangt „virtuellen €100 Trade". §29 und der bestehende `computePositionSize`
liefern eine risikobasierte Größe. §84 löst es auf: `TEST TRADE` = isolierte €100,
`PAPER PORTFOLIO` = Portfolio mit mehreren Positionen.

**Das sind zwei verschiedene Renditeverteilungen.** Ein fixer €100-Trade und ein
nach Stop-Abstand skalierter Trade haben unterschiedliche Varianz, unterschiedlichen
Drawdown und unterschiedliches Ruin-Risiko. Werden sie in einer Statistik gemischt,
ist jede Kennzahl bedeutungslos.

**Vorschlag:** zwei getrennte, dauerhaft parallele Ströme mit eigener Statistik —
`sizing_mode: FIXED_100 | RISK_BASED` als Pflichtspalte auf jeder Paper-Position, und
**kein Aggregat, das über beide summiert**. Der Vergleich der beiden ist selbst ein
Forschungsergebnis (§29: „Was bringt risikobasiertes Sizing tatsächlich?").

### K-3 · Die neun Opportunity-States überlappen — **braucht deine Entscheidung**

§63 listet: `PENDING, SEEN, CONFIRMED, REJECTED, EXPIRED, MISSED, CANCELLED,
EXECUTED, INVALIDATED`. Drei Paare sind nicht trennscharf:

| Paar | Problem |
|---|---|
| `EXPIRED` / `MISSED` | §65 nennt beide gemeinsam („Status: MISSED / EXPIRED"). Sie beschreiben dasselbe Ereignis — Fenster abgelaufen, keine Reaktion. |
| `CONFIRMED` / `EXECUTED` | Bestätigung und tatsächliche Eröffnung sind zwei Schritte, aber `EXECUTED` ist bereits ein Zustand der **Position**, nicht der Opportunity. |
| `CANCELLED` / `INVALIDATED` | §67 nennt zusätzlich `EXPIRED_BY_REVALIDATION` — ein vierter Begriff für denselben Bereich. |

**Vorschlag: sieben trennscharfe Zustände**, wobei `MISSED` keine State, sondern eine
**Klassifikation** von `EXPIRED` wird (nämlich: abgelaufen *und* der Verlauf danach
war profitabel — das ist die Größe, die §66 auswerten will):

```
OFFERED ──► SEEN ──► CONFIRMED ──► POSITION_OPENED
   │          │          │
   │          │          └──► INVALIDATED   (Revalidierung fehlgeschlagen)
   │          └──► REJECTED                 (Nutzer lehnt bewusst ab)
   ├──► EXPIRED                             (Fenster abgelaufen, keine Reaktion)
   └──► CANCELLED                           (System zieht zurück: Security-Event etc.)
```

`MISSED_OPPORTUNITY` wird daraus abgeleitet: `EXPIRED` **und** hypothetischer Verlauf
über Schwelle. Damit ist die Zählung eindeutig, statt von der Reihenfolge zweier
gleichbedeutender States abzuhängen.

### K-4 · Zwei verschiedene Dinge heißen „Confidence"

Vorhanden: `ev.confidence` = Breite des Wilson-Intervalls auf die Trefferquote.
§21 meint: Anzahl **ähnlicher historischer Fälle** („nur 25 vs. 5.000").

Das sind verwandte, aber nicht identische Größen. **Vorschlag:** umbenennen in
`evIntervalConfidence` (bestehend) und `caseConfidence` (neu, §21). Der Final
Confidence Score kombiniert beide. Ohne Trennung wird später niemand mehr wissen,
welche Zahl im Alert steht.

### K-5 · `dataCompleteness` ≠ Data Quality Score

Vorhanden: Anteil vorhandener Felder. §22 will zusätzlich Alter, Widersprüche,
Provider-Ausfälle, Latenz, historische Datenqualität.

**Vorschlag:** `dataCompleteness` bleibt als **ein Eingang** von
`dataQualityScore` (0–100). Nicht ersetzen — die bestehenden Gates hängen daran und
sind getestet.

### K-6 · Der Entry-Snapshot ist heute nicht eingefroren

`positions` speichert `entryFinalScore` und `scoreEngineVersion`, **nicht** den
Feature-Vektor. §83 und §115 verlangen das Einfrieren aller entscheidungsrelevanten
Daten. §113 listet 45 Felder.

**Vorschlag:** eigene Tabelle `feature_snapshots`, append-only, mit
**DB-seitigem Schreibschutz** (`REVOKE UPDATE, DELETE`) für die Anwendungsrolle.
Ein Kommentar „bitte nicht ändern" ist keine Durchsetzung.

### K-7 · Ein Parametersatz für Auto und Manual

§72 verlangt getrennte Thresholds. Heute gibt es genau einen
`StrategyParameters`-Satz und eine `strategy_versions`-Zeile.

**Vorschlag:** `strategy_versions.stream ENUM(auto, manual)` — beide Ströme
versionieren und **unabhängig promoten**. Sonst zwingt eine Manual-Verbesserung zu
einer Auto-Promotion.

### K-8 · Der Execution-Failure-Exit fehlt in den Loss-Regeln

§26 listet neun Regeln, acht existieren. Der neunte — Ausstieg, wenn die
**Ausführung** wiederholt scheitert — fehlt. Kein Umbau, aber er gehört zu den
Regeln, nicht in die Fehlerbehandlung: eine Position, aus der man nicht herauskommt,
ist ein Risikoereignis.

---

## E — Provider- und Datenabhängigkeiten je Bereich

| Bereich | Ohne Provider baubar | Braucht Live-Daten | BLOCKED durch |
|---|---|---|---|
| Paper-Kategorien, States, Statistik | **vollständig** | — | — |
| EV-Komposition, Risk/Reward | **vollständig** | Kalibrierung | — |
| MAE/MFE/Exit Efficiency | **Mechanik vollständig** | Werte | Preisreihe |
| Exit Score | **vollständig** | Gewichtung | — |
| Champion/Challenger, Shadow, Promotion | **vollständig** | Entscheidung | — |
| Fragility, Monte Carlo, Risk of Ruin | **vollständig** | Eingangsverteilung | — |
| Feature Performance / Interaction / Decay | **vollständig** | Daten | — |
| Market Regime | **Mechanik** | Labels | Marktdaten |
| Entry-Modelle (4 Varianten) | **Mechanik** | Vergleich | Zeitreihe |
| Smart Money / Clustering / Dev | Datenmodell steht | alles | **RPC** |
| Security-Engine | Gates stehen | Chain-Abfrage | **RPC** |
| Social / Website / Narrative | Score-Funktionen stehen | alles | **Social-API** |
| Discovery-Quellen | Rahmen steht | alles | **DexScreener o. ä.** |
| ML | — | alles | Daten |

---

## F/K — Datenmodell-Review und Zielmodell

### Was von deinen 18 Tabellen existiert

| Vorgeschlagen | Status |
|---|---|
| `paper_trades` | ✅ existiert (Paper-Zusatzdaten zu Positionen) |
| `paper_positions` | ✅ `positions` mit `mode=paper` |
| `paper_position_events` | ✅ `position_events` |
| `strategy_versions` | ✅ existiert, **6 von 15 Feldern** |
| `execution_events` | ✅ **teilweise** `executions` |
| `paper_opportunities`, `manual_opportunities`, `manual_responses`, `missed_opportunities`, `user_rejections`, `strategy_results`, `learning_events`, `feature_snapshots`, `strategy_candidates`, `model_versions`, `research_batches`, `research_reports`, `market_regimes` | ➕ **fehlen** |

### Wo ich dir widerspreche — begründet

**Vorschlag 1: `missed_opportunities` und `user_rejections` NICHT als eigene Tabellen.**

Beide beschreiben dieselbe Entität (eine Manual Opportunity) in einem anderen
Ausgang. Eigene Tabellen bedeuten, dass dieselbe Opportunity kopiert oder über
Fremdschlüssel verdoppelt wird — und **genau daraus entsteht Doppelzählung**, also
das Risiko, das du ausschließen willst.

Die Trennung, die tatsächlich schützt, verläuft woanders: zwischen **Opportunity**
(eine Beobachtung, kein Kapital) und **Position** (gebundenes Kapital). Eine
verpasste Gelegenheit kann nicht in die Performance geraten, weil sie **keine Zeile in
`paper_positions` erzeugt** — nicht, weil ein Filter sie ausschließt.

**Vorschlag 2: eine `opportunities`-Tabelle statt `paper_opportunities` +
`manual_opportunities`.**

Beide Ströme erzeugen dieselbe Entität zum selben Zeitpunkt aus demselben
Feature-Snapshot. Zwei Tabellen bedeuten doppelte Fremdschlüssel auf denselben
Snapshot und zwei Wege, dieselbe Frage zu stellen. Eine Tabelle mit
`stream ENUM(auto, manual)` hält §71 sauber ab: dieselbe Marktbeobachtung, zwei
unabhängige Zeilen.

**Vorschlag 3: eine eigene `opportunity_outcomes`-Tabelle.**

Das ist der Kern. Sie speichert, **was mit dem Token danach passiert ist** — für
*jede* Opportunity, auch abgelehnte und verpasste. Sie hat bewusst:

- **keine** Verbindung zu Kapital
- **keine** PnL-Spalte in Portfoliowährung
- nur hypothetische Renditen, MFE, MAE über feste Horizonte (5m/15m/30m/1h/4h)

Damit ist §42, §66 und §78 erfüllt **und** strukturell unmöglich, sie in eine
Performance-Abfrage zu ziehen: es gibt schlicht keine Spalte, die sich mit
`realized_pnl` verrechnen ließe.

### Zielmodell (17 neue Tabellen)

```
feature_snapshots ──────┐  append-only, REVOKE UPDATE/DELETE
                        │  45 Felder aus §113, ein Snapshot je Entscheidung
                        ▼
                  opportunities ──────► opportunity_outcomes
                  (stream, state)       (hypothetisch, KEIN Kapital)
                        │
          ┌─────────────┴─────────────┐
          ▼                           ▼
   manual_responses            paper_positions
   (SEEN/CONFIRMED/REJECTED)   (nur AUTO-ENTER + MANUAL-CONFIRMED)
   mit Zeitstempelkette §106    sizing_mode: FIXED_100 | RISK_BASED
                                        │
                                        ▼
                               paper_position_events
                               trade_outcomes (MAE/MFE/§114)
```

```
strategy_candidates ──► research_batches ──► research_reports
        │                      │
        ▼                      ▼
strategy_versions      learning_events
(+ stream, lifecycle,  model_versions
   9 fehlende Felder)  market_regimes  (mit observed_at, nie rückwirkend)
        │
        ▼
strategy_evaluations  (Backtest / WalkForward / OOS / Shadow je Version)
        │
        ▼
promotion_decisions   (§142: Vorher/Nachher, Grund, alle Gates)
```

**Constraints, die die Invarianten erzwingen:**

| Invariante | Durchsetzung |
|---|---|
| MISSED ≠ LOSS | `opportunity_outcomes` hat keine Kapitalspalte |
| USER_REJECTED ≠ LOSS | erzeugt keine `paper_positions`-Zeile |
| PAPER ≠ LIVE | `paper_positions` und `live_positions` sind getrennte Tabellen, nicht eine Spalte |
| Kein nachträgliches Ändern | `REVOKE UPDATE, DELETE ON feature_snapshots` |
| Keine Doppel-Opportunity | `UNIQUE (token_id, stream, decided_at)` |
| Keine Vermischung Auto/Manual | jede Statistik-View verlangt `stream` als Pflichtparameter |

---

## G — Review der Paper-Trading-Lifecycle-States

Siehe K-3 für den Zustandsvorschlag. Zusätzlich drei Punkte:

**1. Der Zustandsautomat darf nicht mit `TradeState` verschmelzen.**
`TradeState` beantwortet „ist die Transaktion bestätigt". `OpportunityState`
beantwortet „hat der Mensch reagiert". Ein gemeinsames Enum erzeugt unmögliche
Übergänge (`SEEN → SUBMITTED`) und macht jede Statistik mehrdeutig. **Zwei
Automaten, eine Referenz.**

**2. `EXPIRED` braucht einen Zeitgeber, keinen Nutzer.**
Ein Zustand, der nur beim nächsten Nutzerbesuch gesetzt wird, ist bei der Auswertung
falsch: die Opportunity wäre bis zum Login „offen". Der Übergang muss vom Scheduler
kommen, nicht vom Klick.

**3. §67 ist ein eigener Ausgang, kein Ablauf.**
Klickt der Nutzer *rechtzeitig*, aber die Revalidierung scheitert, ist das
`INVALIDATED` — der Nutzer war verfügbar. Das ist forschungsseitig etwas ganz
anderes als `EXPIRED` und darf nicht in die Missed-Rate.

---

## H — Review der Learning-/Research-Pipeline

Die vorgeschlagene Kette ist richtig. Vier Ergänzungen:

**1. Die OOS-Aufteilung muss VOR der Hypothesengenerierung feststehen.**
Sonst entsteht Selection Bias: eine Hypothese, die aus Daten gewonnen wurde, die
später als „Out-of-Sample" dienen, ist nicht out-of-sample. Der `research_batch`
muss die Zeitgrenzen **einfrieren, bevor** er Hypothesen erzeugt.

**2. Shadow Trading braucht denselben `PitReader`.**
Sonst sieht der Challenger Daten, die der Champion zum selben Zeitpunkt nicht hatte —
und gewinnt aus dem falschen Grund.

**3. Champion und Challenger müssen dieselben Opportunities sehen (§93).**
Das heißt: die Opportunity-Erzeugung darf **nicht** von der Strategie abhängen. Heute
erzeugt die Decision-Engine implizit nur Zeilen für Kandidaten, die durchkommen.
**Konsequenz:** `opportunities` muss für **jeden bewerteten Token** entstehen, nicht
nur für ENTER. Das ist zugleich die Kontrollgruppe für §41/§42.

**4. §110 „nicht nach jedem Trade" braucht eine harte Sperre.**
Vorschlag: `research_batches` mit `min_new_trades` und einer Unique-Bedingung, die
zwei Batches über demselben Datenbereich verhindert.

---

## I — Risiken für Datenintegrität und falsche Performance

| # | Risiko | Wirkung | Gegenmaßnahme |
|---|---|---|---|
| I-1 | Missed/Rejected geraten in Performance | Manual-Performance wird geschönt | Strukturelle Trennung Opportunity/Position (Teil F) |
| I-2 | Fixe €100 und risikobasierte Trades gemischt | Jede Verteilungskennzahl bedeutungslos | `sizing_mode` als Pflicht-Achse, kein Aggregat darüber |
| I-3 | **Regime-Label rückwirkend vergeben** | Look-Ahead, der wie eine Erkenntnis aussieht | `market_regimes` mit `observed_at`, nie Backfill |
| I-4 | Counterfactuals (§103) nutzen Zukunftsdaten | Alternative Exits sehen immer besser aus | Zwingend über `PitReader` mit `asOf` |
| I-5 | Feature-Snapshot nachträglich verändert | Historie passt zum Ergebnis, nicht umgekehrt | DB-seitiger Schreibschutz |
| I-6 | Hypothese und OOS aus derselben Periode | Selection Bias | Zeitgrenzen vor Hypothesengenerierung einfrieren |
| I-7 | **TP-/Stop-Suche über 9×5 Varianten** (§27, §31) | Klassische Overfitting-Maschine | Fragility-Score + OOS-Pflicht + Parameter-Sensitivität ±5/10/20 % als Promotionsgate |
| I-8 | Survivorship: nur entdeckte Tokens im Ledger | Missed-Rate systematisch zu niedrig | Nicht behebbar — **als bekannte Grenze dokumentieren**, nicht wegrechnen |
| I-9 | Manual-Paper mit *medianer* Reaktionszeit | Glättet die schlechtesten Fälle weg | **Tatsächliche** Reaktionszeit je Opportunity verwenden (§58) |
| I-10 | Auto und Manual auf demselben Token (§71) | Exposure doppelt gezählt oder doppelt ignoriert | Portfolio-Limits **je Strom** getrennt führen |
| I-11 | `EXPIRED` erst beim nächsten Login gesetzt | Opportunities scheinbar dauerhaft offen | Zeitgesteuerter Übergang durch Scheduler |
| I-12 | Research-Batch über überlappende Daten | Dieselbe Erkenntnis mehrfach „bestätigt" | Unique-Bedingung auf Datenbereich |

---

## §150 D/E — Entry- und Exit-Modell

### Entry (§23, §132)

Vorschlag, mathematisch:

```
ENTER  ⟺  HardGates = PASS
      ∧  dataQualityScore ≥ minDataQuality
      ∧  finalScore ≥ threshold(stream)
      ∧  realisticEV_lower > 0
      ∧  caseConfidence ≥ minCases(stream)
      ∧  riskReward ≥ minRR
      ∧  positionSize ≥ minNotional
      ∧  portfolioExposure(stream) + size ≤ limit
      ∧  entryModel.triggered(features, asOf)
```

`realisticEV_lower` ist der Wilson-Untergrenzen-EV **nach** vollständigem
Kostenabzug (§2). Die vier Entry-Modelle (§23) sind austauschbare Prädikate mit
eigener ID — damit im Backtest einzeln messbar, wie bei den Exit-Regeln.

### Exit (§26, §33, §133)

Vorschlag: der bestehende Regelsatz bleibt und bekommt einen **Exit Score** als
zusätzliche, nicht ersetzende Ebene:

```
exitScore = Σ wᵢ · ruleᵢ.pressure(state)      // 0..100
```

Wichtig: der Score ist laut §33 „Entscheidungshilfe, kein alleiniger Exit-Befehl".
Die **Rangfolge aus Phase 1 bleibt bindend** — Risiko-Stop schlägt Stop Loss schlägt
Trailing schlägt Take Profit. Der Score wirkt nur innerhalb der Trailing-Ebene und
für die Runner-Entscheidung. Andernfalls könnte ein hoher Score einen Risiko-Stop
überstimmen, und das wäre ein Rückschritt.

---

## §150 J — Anti-Overfitting: was schon greift, was fehlt

| Mechanismus | Status |
|---|---|
| Look-Ahead | ✅ `PitReader` mit Pflicht-`asOf`, Test als Falle |
| Data Leakage | ✅ dieselbe Vorkehrung |
| Unrealistic Execution | ✅ gemeinsames Kostenmodell, Drift immer zulasten |
| Sample Size | ✅ `MIN_SAMPLE_FOR_VERDICT`, `sufficientSample` |
| Konfidenzintervalle | ✅ Wilson, überlappende Intervalle = kein Unterschied |
| Temporal Split | ✅ Walk-Forward, wirft bei gekürztem Fenster |
| **Selection Bias** | ➕ fehlt — OOS-Grenzen vor Hypothesengenerierung |
| **Survivorship** | ➕ teilweise — Kontrollgruppe existiert (WATCH), Discovery-Blindheit bleibt |
| **Parameter-Fragilität** | ➕ fehlt — ±5/10/20 %-Sweep |
| **Outlier-Abhängigkeit** | ➕ fehlt — §117/§118 |
| **Hindsight Optimization** | ➕ fehlt — Promotionsgates |

---

## J/L — Priorisierter Implementierungsplan

Reihenfolge nach Abhängigkeit, nicht nach Aufwand. Alles in P0–P2 ist **ohne
externe Datenquelle vollständig baubar**.

### P0 — Fundament (blockiert alles Weitere)

| # | Arbeitspaket | Deckt | Warum zuerst |
|---|---|---|---|
| 1 | **Modus → Ströme** (K-1) | §60, §138 | Ohne das kann Paper nicht dauerhaft laufen |
| 2 | **`feature_snapshots`** + Schreibschutz | §83, §113, §115 | Ohne eingefrorene Snapshots ist kein Lernen möglich |
| 3 | **`opportunities` + `manual_responses` + `opportunity_outcomes`** | §62–§68, §135 | Der Kern der Kategorientrennung |
| 4 | **Opportunity-State-Machine** (K-3) | §63 | Getrennt von `TradeState` |
| 5 | **Kategorie-getrennte Statistik** + die 4 Invarianten-Tests | §69, §70, §74, §136 | Macht die Trennung nachweisbar |
| 6 | `sizing_mode` als Pflicht-Achse (K-2) | §61, §84 | Verhindert vermischte Verteilungen |

### P1 — Trading Brain (reine Logik)

| # | Arbeitspaket | Deckt |
|---|---|---|
| 7 | Realistic-EV-Komposition (Kostenmodell → EV) | §2 |
| 8 | Risk/Reward-Ausgabe mit Upside/Downside/RR | §3 |
| 9 | `dataQualityScore` + `caseConfidence` als eigene Scores (K-4, K-5) | §21, §22 |
| 10 | MAE/MFE/Exit Efficiency/Entry Quality | §36–§39 |
| 11 | Exit Score als zusätzliche Ebene | §33 |
| 12 | Market-Regime-Engine (Mechanik, Labels später) | §18, I-3 |
| 13 | Vier Entry-Modelle als schaltbare Prädikate | §23 |
| 14 | Execution-Failure-Exit (K-8) | §26 |
| 15 | Latenz-Zeitstempelkette | §58, §106 |
| 16 | Korrelierte Exposure je Strom | §51, I-10 |

### P2 — Research und Self-Learning

| # | Arbeitspaket | Deckt |
|---|---|---|
| 17 | `strategy_candidates` + Lifecycle-Zustände | §45, §96 |
| 18 | `research_batches` mit eingefrorenen Zeitgrenzen | §110, §145, I-6 |
| 19 | Feature Performance / Interaction / Marginal Value / Decay | §85–§89 |
| 20 | Fragility, Parameter-Sensitivität, Outlier-Beitrag | §117–§120, §126 |
| 21 | Monte Carlo, Risk of Ruin | §49, §50 |
| 22 | Shadow Trading über denselben PitReader | §93 |
| 23 | Champion/Challenger + 10 Promotionsgates | §92, §94, §130 |
| 24 | Strategy Health States + Degradation + Rollback | §95, §108, §146, §147 |
| 25 | Research Reports, No-Edge-Mode | §127–§129, §148 |
| 26 | Counterfactuals über PitReader | §103, I-4 |

### P3 — Blockiert oder datenabhängig

Smart Money, Clustering, Dev-Analyse, Security-Chain-Abfrage, Social, Website,
Narrative, Discovery-Quellen, ML, Entry-Timing-Lernen. **Architektur wird in P1/P2
vorbereitet, Implementierung wartet auf Provider.**

---

## Was ich von dir brauche

Vier Entscheidungen, bevor P0 beginnt:

1. **K-1** — Modus zu Strömen umbauen? (Empfehlung: ja, §138 verlangt es)
2. **K-3** — sieben Zustände statt neun, `MISSED` als Klassifikation? (Empfehlung: ja)
3. **Datenmodell** — `opportunities` + `opportunity_outcomes` statt vier
   Einzeltabellen? (Empfehlung: ja, verhindert Doppelzählung strukturell)
4. **K-2** — beide Sizing-Ströme dauerhaft parallel, ohne gemeinsames Aggregat?
   (Empfehlung: ja, der Vergleich ist selbst ein Forschungsergebnis)
