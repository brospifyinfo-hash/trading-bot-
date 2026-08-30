# Phase 2 — Leitplanken

Wörtlich übernommen aus der Vorgabe. Sie stehen hier, damit sie im Verlauf der
Implementierung nicht verwässern — die Invarianten unten werden Testnamen.

## Dreiteilung, strikt

1. Was architektonisch und logisch implementiert werden kann.
2. Was erst mit echten Live-Daten validiert werden kann.
3. Was aktuell wegen des Egress-/Provider-Problems `BLOCKED` ist.

Fehlende Provider führen **nicht** dazu, Anforderungen zu vereinfachen oder
wegzulassen. Keine Fake-Daten, keine erfundenen API-Responses, keine scheinbar
funktionierenden Integrationen. Stattdessen: Provider-Abstraktion mit sauberer
`BLOCKED`-Kennzeichnung, damit der echte Anbieter später ohne Umbau andockt.

## Prioritäten

```
ROBUSTHEIT                 >  SCHNELLIGKEIT
REALISTISCHE DATEN         >  DUMMY-DATEN
RISK MANAGEMENT            >  TRADE FREQUENCY
OUT-OF-SAMPLE VALIDATION   >  BACKTEST-PERFORMANCE
```

## Invarianten

Diese vier sind nicht verhandelbar und werden je als eigener Test geführt:

| Invariante | Technische Durchsetzung |
|---|---|
| `MISSED OPPORTUNITY ≠ LOSS` | eigene Tabelle, nicht `positions` — ein Join kann sie nicht versehentlich in die Performance ziehen |
| `USER REJECTED ≠ LOSS` | dieselbe Trennung; nie als ausgeführter Manual Trade behandelt |
| `PAPER TRADE ≠ LIVE TRADE` | getrennte `mode`-Achse, getrennte Statistik, getrennte Freigabe |
| `HISTORICAL PROFITABILITY ≠ GARANTIERTE ZUKÜNFTIGE PROFITABILITÄT` | Out-of-Sample-Pflicht, Konfidenzintervalle, kein Urteil unter Mindeststichprobe |

## Strategie-Promotion

Die Production Strategy ändert sich **nicht** nach einzelnen Trades. Jede neue
Strategie durchläuft vollständig:

```
Research → Backtest → Walk Forward → Out-of-Sample → Shadow Trading → Champion/Challenger
```

Erst danach darf über eine Promotion überhaupt nachgedacht werden.

## Bestand

Phase-1-Komponenten werden nicht unnötig neu gebaut. Bestehend und funktionierend:

```
Discovery → Screen → Scoring → Decision → Sizing → Pre-Trade-Check
→ simulierte Execution → Position Management → Reconciliation
→ Statistics → Backtest
```
plus der abgesicherte Manual-Mode-Flow.

## Arbeitsweise

Erst Analyse (A–J), dann Architektur-Review, dann Freigabe abwarten. Eine bessere
technische Lösung darf vorgeschlagen werden — aber begründet, und die Architektur
wird nie stillschweigend geändert.
