# Solana Alpha Engine

Data-driven autonomous Solana memecoin trading system.

**Status: Architekturphase. Kein Code, kein Trading, keine validierte Strategie.**

## Dokumente

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — Systemarchitektur, Datenmodell, State Machines, Security-Modell, Datenquellen, Kosten, Deployment, Teststrategie
- [`docs/PHASE-1-PLAN.md`](docs/PHASE-1-PLAN.md) — Implementierungsplan Phase 1 (Fundament) mit exakter Dateiliste

## Grundregeln dieses Projekts

1. Default ist **Paper Trading**. Live-Trading muss bewusst und mit 2FA aktiviert werden.
2. Keine Strategie gilt als profitabel, bevor sie Backtest, Walk-Forward-Out-of-Sample und Paper Trading durchlaufen hat.
3. Fehlende Daten werden nie durch Defaultwerte ersetzt.
4. Kein API-Endpunkt geht ungeprüft in Code — jede Quelle wird in `docs/providers/<name>.md` verifiziert dokumentiert.
5. `NO TRADE` ist ein erfolgreiches Ergebnis.
