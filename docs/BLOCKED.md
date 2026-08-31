# Was blockiert ist — und woran genau

Stand: 2026-08-31, nach der Persistenzschicht: dauerhafte Queue, echte
Schreibpfade, Datenbank-Invarianten, Consumer mit Dead Letter.

Diese Datei ist bewusst kurz und konkret. Sie beantwortet eine Frage: **was
fehlt, damit dieses System läuft?**

---

## Die eine Ursache

Der Egress dieses Containers lässt keine Verbindung zu den Marktdatenquellen zu.
Gemessen, nicht vermutet — alle antworten mit `403 CONNECT`:

| Host | Zweck | Messung |
|---|---|---|
| `api.dexscreener.com` | Marktdaten, Discovery | 403 CONNECT |
| `public-api.birdeye.so` | Marktdaten, Preishistorie | 403 CONNECT |
| `api.jup.ag` / `lite-api.jup.ag` | Routing, Swap | 403 CONNECT |
| `mainnet.helius-rpc.com` | Holder, RPC | 403 CONNECT |
| `api.rugcheck.xyz` | Sicherheitsbefunde | 403 CONNECT |
| `api.mainnet-beta.solana.com` | RPC | 403 CONNECT |

Erreichbar ist ausschließlich `raw.githubusercontent.com`. Daher stammt der
einzige verifizierte Anbietervertrag im Repo: Jupiters eigene
OpenAPI-Spezifikation.

---

## Komponentenstatus

### Vollständig gebaut und getestet — läuft ohne Provider

| Komponente | Ort |
|---|---|
| Kategorientrennung, vier Invarianten | `@sae/analytics`, `@sae/core` |
| Trading Brain (EV, RR, Scores, Exits, Regime, Entry-Modelle) | `@sae/decision`, `@sae/scoring`, `@sae/trading` |
| Forschungsapparat (Kandidaten, Batches, Fragilität, Monte Carlo, Gates) | `@sae/research` |
| Worker-Sicherheit (Idempotenz, Backoff, Wiederaufnahme) | `@sae/pipeline` |
| Scheduler mit getrennten Takten | `@sae/pipeline` |
| Aufnahmeentscheidung mit Herkunft und Frische | `@sae/pipeline` |
| Provider-Status, Fähigkeiten, Fallback-Kette | `@sae/providers` |
| Dashboard-Datenschicht mit Leerzuständen | `@sae/db` |
| **Dauerhafte Queue** (Anspruch mit Frist, Wiederholung, Dead Letter) | `job_queue`, `JobQueueRepository` |
| **Consumer** mit Handler-Registry und Fehlerklassifikation | `apps/worker/src/consumer.ts` |
| **Persistente Stores** (Idempotenz, Checkpoint, gesehene Schlüssel, Provider-Health) | `@sae/db/stores` |
| **Schreibpfade** für Gelegenheiten, Snapshots, Paper-Positionen, Latenz, Forschung | `@sae/db/repositories` |
| **Datenbank-Invarianten** (Unique-Indizes, CHECK-Constraints, optimistische Sperre) | Migration `0007_integrity`, `0008_job_queue` |
| **Provider-Health im Minutentakt**, persistiert | `apps/worker/src/roles/provider-health.ts` |

### BLOCKED BY LIVE DATA — Architektur steht, Ausführung wartet

| Komponente | Was fehlt konkret | Was schon steht |
|---|---|---|
| **Marktdaten-Adapter** | Ein erreichbarer Anbieter und dessen geprüfte Endpunkt-Spezifikation | Konfiguration (Basis-URL, Schlüssel), Statusmodell, Kette, Aufnahmelogik |
| **Discovery-Job** | Eine Quelle, die neue Tokens liefert | Dedup, Cheap Screen, Checkpoint-Wiederaufnahme, Takt |
| **Feature-Snapshots** | Snapshots, aus denen sie gebaut werden | Schema mit Schreibschutz, `Maybe`-Semantik, Hashing |
| **Gelegenheiten, Auto/Manual Paper** | Bewertbare Tokens | Zustandsautomat, Verzweigung, Kategorien, Statistik |
| **EV, Trefferquote, Strategieleistung** | Abgeschlossene Paper-Trades | Rechenwege, Mindeststichproben, Konfidenzintervalle |
| **Strategie-Promotion** | Alles oben, plus ein kalibriertes Kostenmodell | Zehn Gates; `COST_MODEL_CALIBRATED` steht ausdrücklich auf `FAIL` |
| **P3 insgesamt** (Smart Money, Clustering, Dev, Social, Narrative) | Die jeweiligen Datenquellen | Felder existieren als `MISSING`, Scores führen sie als `NOT_COMPUTABLE` |

### Bewusst nicht gebaut

| Was | Warum nicht |
|---|---|
| Adapter mit erfundenen Endpunktpfaden | Ein Pfad, den niemand geprüft hat, erzeugt Fehlschläge, die wie Anbieterprobleme aussehen |
| Beispiel- oder Demodaten im Dashboard | Eine Oberfläche mit erfundenen Zahlen gewöhnt einen daran, ihnen zu glauben |
| Ein Simulator als Provider-Ersatz | Er würde die gesamte Kette grün färben und nichts beweisen |
| Handler-Inhalt für datenabhängige Auftragsarten | Die Aufträge sind verdrahtet und laufen durch; ohne Kettenmitglied ist ihr Ergebnis `NO_SOURCE`. Sie erfinden weder Snapshot noch Score. |
| Marktdatenquelle als Kettenmitglied ohne geprüften Adapter | Sie wäre ein Mitglied, das bei jeder Abfrage scheitert — und der Fehlschlag sähe aus wie ein Anbieterproblem statt wie eine fehlende Implementierung |

---

## Was passiert, sobald eine Quelle antwortet

Es gibt keinen Startknopf. Die Kette löst sich selbst aus:

1. Die Rolle `provider-health` misst **immer** — auch im blockierten Zustand —
   und schreibt jede Messung nach `provider_status_samples`.
2. Der Scheduler liest daraus alle 30 Sekunden `anyMarketDataUsable()`. Meldet
   eine Marktdatenquelle `CONNECTED` oder `DEGRADED`, wird die Startbedingung
   wahr — **ohne Neustart**, auch um drei Uhr nachts.
3. Im nächsten Tick werden `FAST_DISCOVERY`, `MARKET_UPDATE`, `PAPER_MONITOR`
   und die übrigen datenabhängigen Takte fällig und in `job_queue` eingereiht;
   der `consumer` zieht sie.
4. Sobald genug Snapshots vorliegen (`minSnapshotsForAnalysis`), wechselt die
   Pipeline von `BUILDING_HISTORY` nach `RUNNING`.
5. Auto Paper und Manual Opportunity öffnen **gemeinsam** — unabhängig davon,
   ob Live-Handel je freigegeben wird.

Live bleibt davon getrennt: es verlangt zusätzlich eine Freigabe, keinen
Notstopp, und Daten der Stufe `PRIMARY` oder `SECONDARY` innerhalb der
Frischegrenze.

---

## Womit anfangen

Genau eine Sache: **eine erreichbare Marktdatenquelle.** Alles andere hängt
daran und beschleunigt danach nur noch.

Sobald sie steht, baut der `PitReader` die Historie aus `token_snapshots` selbst
auf — die übrigen Anbieter (Holder, Sicherheit, Social) verkürzen die Wartezeit,
sind aber für den Anlauf nicht nötig.
