# Was blockiert ist — und woran genau

Stand: 2026-08-31, nach der Verdrahtung von Worker, Scheduler, Pipeline und
Dashboard.

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
| BullMQ-Jobkörper für datenabhängige Takte | Ohne Daten hätten sie keinen Inhalt; die Takte werden erst gar nicht fällig |

---

## Was passiert, sobald eine Quelle antwortet

Es gibt keinen Startknopf. Die Kette löst sich selbst aus:

1. Der Takt `PROVIDER_HEALTH` läuft **immer** — auch im blockierten Zustand.
   Er ist der einzige, der keine Marktdaten braucht.
2. Meldet er eine Quelle als `CONNECTED`, wird `marketDataAvailable` wahr.
3. Im nächsten Tick werden `FAST_DISCOVERY`, `MARKET_UPDATE`, `PAPER_MONITOR`
   und die übrigen datenabhängigen Takte fällig.
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
