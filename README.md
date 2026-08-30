# Solana Alpha Engine

Datengetriebenes autonomes Trading-System für Solana-Memecoins.

**Status: Phase 1 (Fundament) und Phase 2 (Provider-Layer) implementiert. Kein Trading, keine validierte Strategie.**

## Dokumente

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — Systemarchitektur, Datenmodell, State Machines, Security-Modell, Datenquellen, Kosten, Deployment, Teststrategie
- [`docs/PHASE-1-PLAN.md`](docs/PHASE-1-PLAN.md) — Implementierungsplan Phase 1
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — getroffene Annahmen und Abweichungen vom ursprünglichen Plan
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
| `apps/signer` | Policy-Engine mit Programm-Allowlist, Abflussgrenzen, Replay-Schutz |
| `apps/worker` | Rollenbasierter Prozess, Queue-Definitionen, Graceful Shutdown |
| `apps/web` | Trading-Terminal-Shell mit Modus-Anzeige und Emergency Stop |

## Entwicklung

```bash
pnpm install
pnpm check        # typecheck + lint + test
pnpm test         # 190 Tests, inkl. No-Look-Ahead gegen echtes Postgres (PGlite)
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
