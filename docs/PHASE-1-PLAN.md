# Phase 1 — Implementierungsplan (Fundament)

**Vorbedingung:** deine Freigabe. Vor dieser Freigabe wird kein Code geschrieben.

## Ziel von Phase 1

Nicht: „ein bisschen Trading zum Laufen bringen".
Sondern: **die Primitive bauen, die alle späteren Phasen zwingend richtig machen.**

Konkret vier Dinge, die man später nicht mehr nachrüsten kann, ohne alles anzufassen:

1. `Observation<T>` / `Maybe<T>` — fehlende Daten können nicht mehr stillschweigend zu Zahlen werden.
2. `PitReader` — Look-Ahead wird zum Compile-Fehler statt zum Disziplinproblem.
3. Ein einziges `CostModel` — Paper, Backtest und Live-Pre-Check können nicht auseinanderdriften.
4. Versionierung (`score_engine_version`, `strategy_version_id`) ab dem ersten Datensatz — nachträglich ist die Historie wertlos.

Am Ende von Phase 1 läuft: `docker compose up` → Postgres + Redis + leerer Worker + Next.js-Shell, `pnpm test` grün, CI grün. **Noch keine Provider, noch kein Scoring, noch kein Trade.**

---

## Dateiliste

### A. Workspace-Wurzel

| Datei | Warum |
|---|---|
| `package.json` | pnpm-Workspace-Root, Turborepo-Tasks (`build`, `test`, `lint`, `typecheck`, `db:migrate`) |
| `pnpm-workspace.yaml` | Workspace-Definition `apps/*`, `packages/*` |
| `turbo.json` | Task-Graph + Caching |
| `tsconfig.base.json` | `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`. Diese drei Flags fangen später echte Trading-Bugs |
| `.gitignore` | `.env*`, `*.key`, `*.pem`, `secrets/` explizit — bevor irgendein Key existiert |
| `.gitleaks.toml` | Secret-Scanning-Regeln, inkl. Solana-Keypair-Muster (64-Byte-Array, base58-Seeds) |
| `.env.example` | Alle Variablen dokumentiert, **ohne Werte** |
| `README.md` | Setup, Betriebsregeln, „Live-Trading ist standardmäßig aus" |
| `vitest.workspace.ts` | Testkonfiguration über alle Packages |
| `eslint.config.mjs` | Inkl. **Custom-Rule `no-numeric-fallback-on-observation`** — verbietet `?? 0` / `\|\| 0` auf `Maybe<T>` |

### B. `packages/core` — Domänenkern, keine I/O

| Datei | Warum |
|---|---|
| `src/observation.ts` | `Observation<T>`, `Maybe<T>`, `MissingReason`, Helper `isPresent`, `requireValue`. **Das wichtigste File des Projekts** |
| `src/ids.ts` | Branded Types: `TokenId`, `Mint`, `WalletAddress`, `IntentId`, `PositionId`. Verhindert, dass eine Mint-Adresse dort landet, wo eine Pool-Adresse hingehört |
| `src/money.ts` | `Lamports`, `Usd`, `Eur`, `TokenAmount` mit Dezimalstellen. **Keine Floats für Beträge** — `bigint` + explizite Skalierung |
| `src/time.ts` | `Instant`, `Duration`, `asOf`-Helfer. Eine einzige Zeitquelle (injizierbare `Clock`), damit Tests deterministisch sind |
| `src/token.ts` | `Token`, `TokenPool`, `TokenSnapshot`, `TokenLifecycleState` |
| `src/decision.ts` | `Signal`, `SignalKind` (ENTER/WATCH/REJECT), `Reason`, `Risk`, `RejectionReason` als **geschlossenes Enum** (keine freien Strings — sonst ist das Rejection-Log nicht auswertbar) |
| `src/trade.ts` | `TradeIntent`, `Order`, `Execution`, `Position`, `PositionEvent`, `TradeState` |
| `src/state-machine.ts` | Generische, typsichere State-Machine + Übergangstabelle. Illegale Übergänge werfen |
| `src/trade-state-machine.ts` | Die konkrete Maschine aus Architektur §7.2 inkl. `UNKNOWN → RECONCILING` |
| `src/errors.ts` | Fehlertaxonomie: `RetryableError` vs. `TerminalError` vs. `PolicyViolation`. Bestimmt Retry-Verhalten überall |
| `src/result.ts` | `Result<T, E>` für Pfade, in denen Exceptions das Kontrollflussbild verschlechtern |
| `src/__tests__/*.test.ts` | Property-Tests für Money-Arithmetik und State-Machine |

### C. `packages/config` — Konfiguration & Strategie-Schema

| Datei | Warum |
|---|---|
| `src/env.ts` | Zod-Schema aller Env-Vars, **fail-fast beim Start**. Ein Worker mit fehlendem RPC-URL darf nicht halb laufen |
| `src/strategy-schema.ts` | Zod-Schema einer Strategieversion: Score-Schwellen, Liquiditäts-Minima, TP-Stufen, SL, Trailing, Sizing, Limits. Ist zugleich die Validierung der Dashboard-Eingaben |
| `src/defaults.ts` | Konservative Startwerte. **`mode: 'paper'`, `live: false` fest verdrahtet** |
| `src/risk-limits.ts` | Harte Obergrenzen, die eine Strategieversion *nicht* überschreiben darf (Notbremse gegen Fehlkonfiguration) |
| `src/__tests__/strategy-schema.test.ts` | u. a.: TP-Prozente summieren ≤ 100, Stop < Entry, Limits konsistent |

### D. `packages/db` — Schema, Migrationen, PIT-Zugriff

| Datei | Warum |
|---|---|
| `src/client.ts` | Drizzle-Client, Pooling, getrennte RO-/RW-Rollen |
| `src/schema/identity.ts` | `users`, `user_totp`, `sessions`, `wallets` |
| `src/schema/tokens.ts` | `tokens`, `token_pools`, `token_snapshots` (Hypertable), `token_security`, `token_social`, `token_wallet_metrics`, `token_narratives` |
| `src/schema/wallets.ts` | `wallet_transactions`, `smart_money_wallets` (**mit `qualified_at`**), `wallet_labels`, `wallet_clusters`, `wallet_cluster_members`, `dev_wallets` |
| `src/schema/strategy.ts` | `strategies`, `strategy_versions`, `scores`, `decision_inputs`, `signals`, `rejections` |
| `src/schema/trading.ts` | `trade_intents`, `orders`, `executions`, `positions`, `position_events`, `take_profit_levels`, `paper_trades` |
| `src/schema/ops.ts` | `risk_events`, `circuit_breaker_state`, `provider_health`, `alerts`, `email_alerts`, `manual_trade_tokens`, `reconciliation_events`, `system_events`, `backtest_runs`, `backtest_trades` |
| `src/pit/reader.ts` | **`PitReader`-Interface — `asOf` ist Pflichtparameter, es gibt keine „latest"-Methode** |
| `src/pit/live-reader.ts` | Implementierung für den Live-Betrieb (`asOf = now`) |
| `src/pit/backtest-reader.ts` | Implementierung mit hartem `WHERE observed_at <= asOf` |
| `src/pit/__tests__/no-look-ahead.test.ts` | **Der zentrale Test:** legt Datensätze vor und nach `asOf` an und beweist, dass die späteren nie zurückkommen |
| `migrations/0000_init.sql` | Initiales Schema inkl. Indizes aus Architektur §5.3 |
| `optional/timescale.sql` | Hypertables + Retention/Compression — **keine Migration**, wird von Hand angewendet (siehe `packages/db/optional/README.md`) |
| `src/seed/wallet-labels.ts` | Startliste bekannter CEX-/Bridge-/Router-/Burn-Adressen. **Ohne diese Liste ist Clustering wertlos** (Architektur §13.4) |

### E. `packages/simulation` — das eine Kostenmodell

| Datei | Warum |
|---|---|
| `src/cost-model.ts` | Netzwerk-Fee, Priority Fee, Jito-Tip, DEX-Fee, Price Impact, Latenz-Drift, TX-Fehlerrate → `ExecutionCostEstimate` |
| `src/price-impact.ts` | Constant-Product-Näherung aus Pool-Tiefe; für Backtests ohne Live-Quote |
| `src/exit-capacity.ts` | „Bekomme ich Größe X zu ≤ Y % Impact wieder raus?" — Input für das Exit-Hard-Gate |
| `src/pnl.ts` | PnL inkl. Teilverkäufen, gewichtetem Einstand, allen Kosten. Eine Implementierung für Paper *und* Live |
| `src/__tests__/cost-model.test.ts` | Golden-File-Tests. **Kostenmodell-Änderungen brechen CI sichtbar** — sonst ändert sich die Historie unbemerkt |
| `src/__tests__/pnl.property.test.ts` | Property-Tests: Summe der Teilverkäufe = Gesamtposition; PnL ohne Bewegung + Kosten = negativ |

### F. `packages/observability`

| Datei | Warum |
|---|---|
| `src/logger.ts` | pino, strukturiertes JSON, **Redaction per Allowlist** (nicht Blocklist) |
| `src/metrics.ts` | Prometheus-Counter/Histogramme: Provider-Latenz, Entscheidungen, Fills, Slippage |
| `src/trace.ts` | Correlation-IDs über Queue-Grenzen (`decision_id` → `intent_id` → `execution_id`) — Grundlage der Trade-Detail-Timeline |
| `src/__tests__/redaction.test.ts` | **Serialisiert ein Objekt mit Fake-Key und prüft, dass er im Output nicht vorkommt** |

### G. `apps/worker` — Skelett

| Datei | Warum |
|---|---|
| `src/queues.ts` | BullMQ-Queue-Definitionen, Namen, Job-Typen, Retry-/Backoff-Policies pro Queue |
| `src/worker.ts` | Rollenbasierter Einstiegspunkt (`WORKER_ROLE=discovery\|scoring\|…`) |
| `src/lifecycle.ts` | Graceful Shutdown: `SIGTERM` → keine neuen Jobs, laufende zu Ende, insbesondere TX-Bestätigungen |
| `src/health.ts` | Liveness/Readiness für Compose-Healthchecks |
| `src/roles/*.ts` | Ein leerer, typisierter Stub je Rolle — die Struktur steht, die Logik kommt in Phase 4+ |

### H. `apps/web` — Shell

| Datei | Warum |
|---|---|
| `app/layout.tsx`, `app/globals.css` | Dark Trading-Terminal-Basis (Tailwind), hohe Informationsdichte, keine Animationen |
| `app/(auth)/login/page.tsx` | Magic-Link-Login |
| `app/(app)/page.tsx` | Dashboard-Gerüst: Scanner links / Analyse Mitte / Trade-Setup rechts / Statusleiste oben |
| `lib/auth.ts` | Session, TOTP-Setup, Step-up-Guard für Command-Routen |
| `app/api/health/route.ts` | Read-API-Beispiel + Smoke-Test-Ziel |
| `components/BotStatusBar.tsx` | Modus (Manual/Auto, Paper/Live), Breaker-Status, **🛑 Emergency Stop** |

### I. `apps/signer` — isolierter Signer (Gerüst)

| Datei | Warum |
|---|---|
| `src/server.ts` | mTLS-HTTP-Server, nur im internen Docker-Netz |
| `src/policy.ts` | **Unabhängige Policy-Prüfung** (Programm-Allowlist, SOL-Abfluss-Limit, Mint-Match, `minOut` gesetzt, Replay-Schutz) |
| `src/keystore.ts` | Key aus Docker-Secret laden, im Speicher halten, nie loggen, nie serialisieren |
| `src/__tests__/policy.test.ts` | Manipulierte Transaktionen werden abgelehnt — inkl. „Empfänger getauscht" und „minOut = 0" |

### J. Infrastruktur

| Datei | Warum |
|---|---|
| `docker/docker-compose.yml` | Netz-Topologie aus Architektur §15.2, inkl. `signing` als `internal: true` |
| `docker/Dockerfile.web`, `.worker`, `.signer` | Multi-Stage, non-root, minimal |
| `docker/postgres/init.sql` | Extensions, RO-/RW-Rollen |
| `.github/workflows/ci.yml` | typecheck → lint → unit → integration (Testcontainers) → gitleaks. **Merge nur bei grün** |
| `scripts/dev-up.sh`, `scripts/migrate.sh` | Reproduzierbares lokales Setup |

---

## Was Phase 1 bewusst **nicht** enthält

Keine Provider-Integration, kein Discovery, kein Scoring, keine Execution, kein Backtest. Das ist Absicht: erst steht das Fundament mit Tests, dann wird darauf gebaut. Ein Scoring-Modul, das man vor dem `PitReader` schreibt, muss man später komplett neu schreiben.

---

## Definition of Done für Phase 1

- [ ] `pnpm install && pnpm typecheck && pnpm lint && pnpm test` grün
- [ ] `docker compose up` startet Postgres, Redis, Worker-Skelett, Web-Shell
- [ ] Migrationen laufen sauber vorwärts, Schema entspricht Architektur §5
- [ ] `no-look-ahead.test.ts` grün und **beweist**, dass der Backtest-Reader keine Zukunftsdaten liefert
- [ ] `redaction.test.ts` grün — kein Key gelangt in Logs
- [ ] Signer lehnt manipulierte Transaktionen ab
- [ ] `gitleaks` findet nichts
- [ ] Default-Konfiguration ist **Paper, Live aus** — verifiziert durch Test
- [ ] `docs/ARCHITECTURE.md` und dieser Plan sind im Repo

**Aufwandsschätzung:** ~2–3 fokussierte Arbeitstage bis alle Häkchen stehen.

---

## Danach (nur zur Orientierung)

Phase 2 Provider-Layer + Verifikation der APIs (`docs/providers/*.md`) → Phase 3 Discovery + Cheap Screen → Phase 4 Security-Engine (Chain-direkt) → Phase 5 Market/Momentum → Phase 6 Wallet-Intelligence + Clustering → Phase 7 Social/AI → Phase 8 Scoring + Decision → Phase 9 Paper Trading → Phase 10 Backtest/Walk-Forward → Phase 11 Risk/Circuit Breaker → Phase 12 Execution + Signer scharf → Phase 13 Manual Mode + Resend → Phase 14 Auto Mode → Phase 15 Dashboard/Research → Phase 16 Monitoring → Phase 17 Security-Audit → Phase 18 Produktion.
