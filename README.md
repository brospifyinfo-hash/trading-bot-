# Solana Alpha Engine

Datengetriebenes autonomes Trading-System für Solana-Memecoins.

**Status: `P3 = BLOCKED BY LIVE DATA`.**

Die Pipeline ist gebaut und verdrahtet: dauerhafte Queue, Scheduler, Consumer mit
Retry und Dead Letter, persistente Schreibpfade, Datenbank-Invarianten,
Provider-Health im Minutentakt. Was fehlt, ist eine erreichbare Marktdatenquelle.
Ohne sie entstehen keine Snapshots, keine Scores, keine Gelegenheiten und keine
Paper-Trades — und das ist Absicht, nicht ein offener Punkt.

Kein Live-Trading. Keine validierte Strategie. Keine Kennzahl aus echten Daten.
Eine vollständig vorbereitete Pipeline ist **kein Beleg für Profitabilität**.

## Dokumente

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — Systemarchitektur, Datenmodell, State Machines, Security-Modell, Datenquellen, Kosten, Deployment, Teststrategie
- [`docs/PHASE-1-PLAN.md`](docs/PHASE-1-PLAN.md) — Implementierungsplan Phase 1
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — getroffene Annahmen und Abweichungen vom ursprünglichen Plan
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — Betriebsarchitektur: was auf Vercel läuft und was ausdrücklich nicht
- [`docs/BLOCKED.md`](docs/BLOCKED.md) — was auf echte Daten wartet und warum
- [`docs/providers/`](docs/providers/) — Verifikationsstand je Datenquelle

## Grundregeln

1. Default ist **Paper Trading**. Live-Trading muss bewusst und mit 2FA aktiviert werden.
2. Keine Strategie gilt als profitabel, bevor sie Backtest, Walk-Forward-Out-of-Sample und Paper Trading durchlaufen hat.
3. Fehlende Daten werden nie durch Defaultwerte ersetzt — durchgesetzt durch `Maybe<T>` und die Lint-Regel `sae/no-numeric-fallback`.
4. Kein API-Endpunkt geht ungeprüft in Code — jede Quelle wird in `docs/providers/<name>.md` verifiziert dokumentiert.
5. `NO TRADE` ist ein erfolgreiches Ergebnis.

## Was Phase 1 liefert

| Paket | Inhalt |
|---|---|
| `packages/core` | `Observation<T>`/`Maybe<T>`, Branded IDs, bigint-Geldarithmetik, Fehlertaxonomie, Trade-State-Machine |
| `packages/config` | Zod-Schemas für Env und Strategieversionen, harte Risikogrenzen, konservative Defaults |
| `packages/db` | Drizzle-Schema (41 Tabellen), Migrationen, **PitReader** mit Pflicht-`asOf` |
| `packages/simulation` | Preis-Impact, Exit-Kapazität, Kostenmodell, PnL — ein Modell für Paper, Backtest und Live |
| `packages/observability` | pino mit Allowlist-Redaction, Trace-IDs, Metrik-Registry |
| `packages/providers` | Provider-Schnittstellen, Token-Bucket, Circuit Breaker, Budget-Wächter, Health-Tracking, HTTP-Client mit Schema-Validierung, Jupiter-Quote-Adapter |
| `packages/scoring` | Feature-Vektor, neun Teilscores, Score-Engine v1.0.0 mit Gewichtsabdeckung |
| `packages/risk` | Risikobasierte Positionsgröße, Portfolio-Exposure, Circuit Breaker |
| `packages/decision` | Hard Gates, EV-Schätzung mit Wilson-Untergrenze, Entscheidungsmaschine |
| `packages/trading` | `Executor`-Interface, `PaperExecutor`, Positionsverwaltung mit TP/SL/Trailing, acht einzeln schaltbare Exit-Regeln, Notausstieg mit Tranchenplanung |
| `packages/analytics` | Trade-Kennzahlen nach §4, Faktorforschung mit Konfidenzintervallen und Stichproben-Schranke |
| `packages/backtest` | Simulationsschleife über den `PitReader`, Walk-Forward-Aufteilung, deterministischer Zufallsgenerator |
| `packages/discovery` | Quellen-Schnittstelle, Deduplizierung, billiges Vorsieb, Discovery-Durchlauf |
| `packages/alerts` | Einmal-Tokens, Alert-Cooldown, Live-Revalidierung mit Diff |
| `packages/execution` | Pre-Trade-Validierung für Kauf und Verkauf, Signatur-Auflösung, Bestandsabgleich |
| `apps/signer` | Policy-Engine mit Programm-Allowlist, Abflussgrenzen, Replay-Schutz |
| `packages/pipeline` | Idempotenz, Checkpoints, Backoff, Scheduler-Takte, Aufnahme mit Herkunft, Anbieterkette aus der Konfiguration |
| `packages/research` | Forschungs-Batches mit eingefrorenen Zeitgrenzen, Kandidaten-Lebenszyklus, Promotionsgates, No-Edge-Modus |
| `apps/worker` | Rollenbasierter Prozess, dauerhafte Queue, Scheduler, Consumer mit Dead Letter, Graceful Shutdown |
| `apps/web` | Trading-Terminal-Shell mit Modus-Anzeige und Emergency Stop |

## Entwicklung

```bash
pnpm install
pnpm check        # typecheck + lint + test
pnpm test         # 910 Tests, inkl. No-Look-Ahead, Persistenz und Queue gegen
                  # echtes Postgres (PGlite, kein Mock)
```

Datenbank-Migrationen:

```bash
pnpm db:generate                       # Schema → neue Migration
pnpm --filter @sae/db exec drizzle-kit migrate   # anwenden (vorwärts-only)
```

Lokal mit Docker:

```bash
cp .env.example .env      # Werte eintragen
./scripts/dev-up.sh
```

## Die vier Vorkehrungen, auf die alles Weitere aufbaut

1. **`Maybe<T>`** — fehlende Daten können nicht stillschweigend zu Zahlen werden. Der Compiler erzwingt die Fallunterscheidung, die Lint-Regel verbietet numerische Ersatzwerte in handelsrelevantem Code.
2. **`PitReader`** — jede Lesemethode verlangt `asOf`. Es gibt keine Methode, die „den aktuellen Stand" liefert; Look-Ahead ist damit ein Compile-Fehler statt einer Disziplinfrage.
3. **Ein Kostenmodell** — Paper Trading, Backtest und Live-Pre-Check rechnen mit denselben Funktionen. Golden-File-Tests machen jede Änderung sichtbar.
4. **Versionierung ab dem ersten Datensatz** — `score_engine_version`, `strategy_version_id`, `cost_model_version` an jeder Entscheidung. Nachträglich wäre die Historie wertlos.


## Betriebsarchitektur in einem Absatz

Vier Dinge, die getrennt laufen müssen und deshalb getrennt deployt werden:

| Teil | Wo | Warum dort |
|---|---|---|
| Web, Dashboard, API, Bestätigungs-Flow | Vercel | anfragegetrieben, kurze Laufzeit, gut horizontal skalierbar |
| Scheduler, Consumer, Provider-Health | dauerhaft laufender Host (Container/VM) | Prozesse mit Takt und Zustand; eine Serverless-Funktion endet nach jeder Anfrage |
| PostgreSQL | verwalteter Dienst | Quelle der Wahrheit, inklusive Queue |
| Datenquellen | extern | eigener Rate-Limit- und Ausfallraum |

**Der Worker gehört ausdrücklich nicht auf Vercel.** Details und die Begründung
stehen in [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).
