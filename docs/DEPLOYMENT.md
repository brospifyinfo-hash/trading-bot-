# Betrieb

Wie dieses System deployt wird, und vor allem: **was ausdrücklich nicht auf
Vercel gehört**.

> Die Deployment-Checkliste mit dem tatsächlichen Status je Baustein, der
> vollständigen Env-Var-Matrix und der Provider-Matrix steht in
> [`INFRASTRUCTURE.md`](INFRASTRUCTURE.md). Diese Datei hier erklärt das Warum,
> jene das Was-jetzt-zu-tun-ist.

## 1. Die Trennung

Vier Teile mit unterschiedlichen Lebensdauern. Sie zu vermischen ist der Fehler,
den man erst im Betrieb bemerkt.

| Teil | Laufzeitmodell | Deployziel |
|---|---|---|
| **WEB / DASHBOARD / API / AUTH** | anfragegetrieben, Sekunden | Vercel |
| **WORKER / QUEUE / SCHEDULER** | dauerhaft, Minuten bis Wochen | Container oder VM (Fly.io, Railway, Render, Hetzner, ECS …) |
| **DATENBANK** | dauerhaft, zustandsbehaftet | verwaltetes PostgreSQL (Neon, Supabase, RDS …) |
| **DATENQUELLEN** | extern | Anbieter, mit eigenem Rate-Limit- und Ausfallraum |

## 2. Warum der Worker nicht auf Vercel läuft

Das ist keine Vorsichtsmaßnahme, sondern eine Eigenschaft des Ausführungsmodells.
Eine Serverless-Funktion endet, wenn die Antwort raus ist. Vier Dinge, die dieses
System braucht, überleben das nicht:

1. **Ein Takt, der weiterläuft.** Der Scheduler prüft alle fünf Sekunden, was
   fällig ist. Als Serverless-Funktion bräuchte er einen externen Cron je Takt —
   und Vercel Cron löst höchstens minütlich aus. Die Positionsüberwachung eines
   Memecoins im Minutenraster ist keine Überwachung.
2. **Ein Anspruch, der gehalten wird.** Ein Consumer beansprucht einen Auftrag
   mit einer Frist (`job_queue.lease_until`) und gibt ihn frei, wenn er fertig
   ist. Endet der Prozess mitten drin, ist der Auftrag bis zum Fristablauf
   blockiert. Bei einer Funktion, die nach jeder Anfrage endet, wäre das der
   Normalfall statt der Ausnahme.
3. **Ein Verbindungspool, der sich lohnt.** Jede Instanz baut ihre eigenen
   Verbindungen auf. Bei anfragegetriebener Skalierung heißt das: hunderte
   kurzlebige Verbindungen gegen eine Datenbank, die einige Dutzend verträgt.
4. **Ein Laufzeitdeckel, der nicht stört.** Ein Forschungslauf über Monate an
   Historie ist nicht in der Zeit fertig, die eine Anfrage haben darf.

**Was stattdessen richtig ist:** Vercel bekommt Web, Dashboard, API und den
Bestätigungs-Flow. Die Worker laufen als langlebige Prozesse woanders. Beide
sprechen ausschließlich über die Datenbank miteinander — es gibt keinen direkten
Aufruf vom Dashboard in den Worker und keinen umgekehrt.

## 3. Prozesse

Ein Image, die Rolle kommt aus `WORKER_ROLE`.

| Rolle | Aufgabe | Läuft ohne Marktdaten |
|---|---|---|
| `provider-health` | misst im Minutentakt jeden Anbieter, schreibt `provider_status_samples` | **ja** — das ist der Takt, mit dem das System von selbst anläuft |
| `scheduler` | reiht fällige Aufträge in `job_queue` ein | ja (reiht dann nur datenunabhängige Takte ein) |
| `consumer` | zieht Aufträge, führt sie aus, entscheidet über Wiederholung und Dead Letter | ja |
| `discovery`, `enrichment`, `scoring`, `decision`, `execution`, `positions`, `paper`, `reconciler`, `alerts` | **Platzhalter**, bis eine Marktdatenquelle erreichbar ist | — |

Mindestbetrieb: **eine** Instanz `scheduler`, **eine** `provider-health`, **eine
oder mehrere** `consumer`. Mehrere Consumer sind unbedenklich: die Aufträge
werden per `FOR UPDATE SKIP LOCKED` vergeben, zwei Prozesse können denselben
Auftrag nicht bekommen.

Genau **eine** Scheduler-Instanz. Zwei wären nicht falsch (der Auftragsschlüssel
enthält das Zeitfenster, doppelte Einreihungen werden abgelehnt), aber sie
verdoppeln ohne Nutzen die Last.

## 4. Warum die Queue in Postgres liegt

Ein Auftrag, der eingereiht wurde, muss einen Neustart des Workers, einen
Absturz mitten in der Bearbeitung und einen Ausfall des Queue-Knotens überleben.
Redis trägt diese Zustellgarantie nicht. Deshalb ist `job_queue` eine Tabelle:

- `UNIQUE (dedupe_key) WHERE state IN ('QUEUED','RUNNING')` — derselbe fachliche
  Vorgang liegt höchstens einmal offen in der Queue.
- `job_queue_history` — ein abgeschlossener Schlüssel bleibt bekannt, auch
  nachdem die Queue-Zeile aufgeräumt wurde. Sonst höbe ein Aufräumlauf die
  Idempotenz auf.
- `lease_until` — stirbt ein Worker, läuft die Frist ab und der Auftrag wird
  erneut vergeben. Der Versuchszähler läuft dabei weiter: ein Auftrag, der drei
  Worker mitgerissen hat, ist ein Verdacht und kein Zufall.
- `state = 'DEAD'` — ein endgültig gescheiterter Auftrag verschwindet nicht. Das
  ist die Fehlerart, die man sonst erst Wochen später an einer Lücke in den
  Daten bemerkt.

## 4b. Datenbank-Verbindungen — der Punkt, an dem Vercel wehtut

Zwei Fehler, die beide erst unter Last auffallen:

**Ein Pool je Anfrage.** `createDatabase()` im Request-Handler legt bei jeder
Anfrage einen neuen Verbindungspool an. Eine Serverless-Instanz bedient viele
Anfragen, und viele Instanzen laufen parallel — das Ergebnis sind hunderte
kurzlebige Verbindungen gegen eine Datenbank, die einige Dutzend verträgt.

*Behoben:* `getDatabase()` cacht auf Modulebene (`packages/db/src/client.ts`).
Die Web-App holt ihre Verbindung ausschließlich über `apps/web/lib/db.ts`. Auf
Vercel überlebt der Cache den Warm Start; beim Cold Start wird er neu aufgebaut.

**Ein zu großer Pool.** `SERVERLESS_DB_OPTIONS` setzt `max: 1` und
`idle_timeout: 10`. Das klingt wenig und ist genau richtig: die Skalierung
übernimmt der Pooler vor der Datenbank, nicht der einzelne Prozess.

### Was Production braucht

| Einstellung | Web (Vercel) | Worker (Container) |
|---|---|---|
| `DATABASE_URL` | **Pooler-Endpunkt** (Neon pooled, Supabase `:6543`, PgBouncer transaction mode) | Direktverbindung |
| Poolgröße je Prozess | 1 | 10 |
| `idle_timeout` | 10 s | 20 s |
| Prepared Statements | aus (`prepare: false`) | aus |
| Migrationen ausführen | **nein** | ja, vor dem Start |

`prepare: false` ist keine Vorsichtsmaßnahme, sondern Pflicht: ein Pooler im
Transaction Mode gibt die Verbindung nach jeder Transaktion weiter, und ein
vorbereitetes Statement liegt dann auf einer anderen.

## 5. Datenbank

Migrationen sind **vorwärts-only**. Ein Rollback in einer Datenbank, die
Handelshistorie führt, verliert Forschungsdaten.

```bash
pnpm --filter @sae/db exec drizzle-kit migrate
```

Reihenfolge beim Deploy: **erst Migration, dann Worker, dann Web.** Die
Migrationen sind additiv, ein alter Prozess läuft also gegen ein neues Schema
weiter — umgekehrt nicht.

## 6. Umgebungsvariablen

Namen und Zweck stehen in [`.env.example`](../.env.example). Drei Regeln:

1. **Kein Wert im Repository.** `.env` und `.env.*` sind in `.gitignore`, mit
   Ausnahme von `.env.example`.
2. **Der private Schlüssel taucht in keinem Schema auf.** Er existiert nur als
   Docker-Secret und wird ausschließlich in den Signer-Container gemountet.
3. **Der Resend-Schlüssel kommt aus `RESEND_API_KEY`**, nie aus dem Code.

Wer welche Variablen braucht:

| Ziel | Variablen |
|---|---|
| Vercel (Web) | `DATABASE_URL` (**Pooler**), `SESSION_SECRET`, `APP_BASE_URL` |
| Worker (Railway) | `DATABASE_URL` (direkt), `WORKER_ROLE`, `SOLANA_RPC_URL`, optional `MARKET_DATA_PRIORITY` und Anbieter-URLs/-Schlüssel |
| Signer | ausschließlich `SIGNER_*`, alle als Dateipfade auf Secrets |

Die vollständige Liste, getrennt nach Pflicht und Optional und gegen die
Zod-Schemata geprüft, steht in Abschnitt 6b.

Der Resend-Schlüssel gehört auf **beide** Seiten nur dorthin, wo tatsächlich
versendet wird — heute ist das der `alerts`-Worker, nicht die Web-App. Ist
`ALERT_ALLOW_TEST_EMAILS` nicht gesetzt, verweigert der Adapter jede Mail aus
einer Fixture-Gelegenheit.

### `vercel.json`

Liegt in **`apps/web/`**, nicht im Wurzelverzeichnis — Vercel liest die Datei
aus dem Root Directory, und das ist `apps/web` (Begründung in
`INFRASTRUCTURE.md`, Abschnitt 6: die Framework-Erkennung braucht dort ein
`package.json` mit `next`).

Die Datei enthält nur, was Vercel nicht selbst erkennen kann: Region und
`maxDuration`. Die Worker sind darin bewusst nicht erwähnt, weil sie dort nicht
laufen. **Es gibt keine `crons`-Sektion** — Vercel Cron löst höchstens minütlich
aus, und die Positionsüberwachung eines Memecoins im Minutenraster ist keine
Überwachung. Der Takt gehört auf den Worker-Host.

## 6b. Worker und Vercel: wer redet mit wem

Die kurze Antwort: **gar nicht direkt.** Es gibt keinen HTTP-Aufruf von Vercel in
einen Worker und keinen umgekehrt. Beide Seiten kennen nur die Datenbank.

```
   Browser
      |
      v
+---------------------------+
|  VERCEL  (@sae/web)       |   Next.js: Dashboard, API, Auth,
|  anfragegetrieben         |   Bestätigungs-Flow, /api/diagnostics/providers
+---------------------------+
      |  liest / schreibt (Pooler-Endpunkt, max 1 Verbindung je Prozess)
      v
+---------------------------------------------------------------+
|  POSTGRESQL   job_queue · job_queue_history · provider_requests |
|               provider_capability_status · provider_status_...  |
|               snapshots · decisions · opportunities · paper_... |
+---------------------------------------------------------------+
      ^  liest / schreibt (Direktverbindung, Pool 10)
      |
+---------------------------+
|  WORKER-HOST              |   ein Image, Rolle aus WORKER_ROLE:
|  langlebige Prozesse      |   scheduler · consumer · provider-health
+---------------------------+
      |  HTTPS nach draußen
      v
   ANBIETER (DexScreener, Jupiter, RPC …)
```

**Welche Queue?** `job_queue` — eine Tabelle in derselben PostgreSQL-Datenbank
(Begründung in Abschnitt 4). Kein SQS, kein BullMQ, kein separater Broker.

Es gibt **keine** Redis-Abhängigkeit mehr. `REDIS_URL` war Pflicht im Schema
und wurde von keiner Codezeile gelesen; `bullmq` und `ioredis` waren ungenutzte
Abhängigkeiten aus dem Entwurf vor der Postgres-Queue. Alles entfernt (siehe
`DECISIONS.md`, Entscheidung 77). Für Railway heißt das: **kein Redis-Dienst
nötig**.

**Wer reiht heute ein?** Ausschließlich der `scheduler`-Worker
(`apps/worker/src/roles/scheduler.ts` → `JobDispatcher.enqueue`), per
`INSERT … ON CONFLICT DO NOTHING` auf dem `dedupe_key`. Der nächste
Consumer-Takt zieht die Zeile per `FOR UPDATE SKIP LOCKED`.

**Reiht Vercel ein?** Heute **nein**. Die Web-App liest ausschließlich —
Dashboard-Abfragen und `/api/diagnostics/providers`. Es gibt derzeit keine
Route, die `job_queue` beschreibt. Die Repository-Methode dafür existiert
(`packages/db/src/repositories/job-queue.ts`), sie wird von der Web-Seite nur
noch nicht aufgerufen. Wenn eine Aktion im Dashboard später einen Auftrag
auslösen soll, ist das der vorgesehene Weg: Zeile schreiben, Antwort geht raus,
bevor der Auftrag läuft — sie bestätigt die Einreihung, nicht das Ergebnis.

**Wie sieht Vercel Ergebnisse?** Es liest die Zieltabelle. Kein Callback, kein
Webhook, kein offener Socket. Deshalb überlebt der Weg einen Cold Start, einen
Worker-Neustart und ein Vercel-Deployment mitten in der Bearbeitung.

### Zwei verschiedene `DATABASE_URL`

Dieselbe Datenbank, zwei Endpunkte. Das ist kein Versehen:

| | Vercel (Web) | Worker-Host |
|---|---|---|
| Endpunkt | **Pooler** (Neon `-pooler`, Supabase `:6543`, PgBouncer transaction mode) | **Direktverbindung** (Neon direkt, Supabase `:5432`) |
| Warum | hunderte kurzlebige Instanzen; der Pooler bündelt sie auf wenige echte Verbindungen | wenige langlebige Prozesse; ein Pooler dazwischen brächte nur Latenz |
| Poolgröße je Prozess | 1 | 10 |
| Prepared Statements | aus | aus |
| Migrationen | nein | ja, vor dem Start — über `DATABASE_URL_DIRECT`, ein Pooler im Transaction Mode verträgt DDL nicht zuverlässig |

### Environment Variables, vollständig

Maßgeblich ist das Schema in `packages/config/src/env.ts`, nicht diese Tabelle —
was dort `optional()` fehlt, lässt den Prozess beim Start abbrechen.

**Vercel (@sae/web)** — Pflicht (`webEnvSchema`):

| Variable | Wert |
|---|---|
| `DATABASE_URL` | Pooler-Endpunkt |
| `SESSION_SECRET` | ≥ 32 Zeichen, zufällig (`openssl rand -base64 48`) |
| `APP_BASE_URL` | `https://<deine-domain>` |

Optional: `RESEND_API_KEY` (nur falls die Web-App selbst versenden soll — heute
versendet der `alerts`-Worker), `NODE_ENV`, `LOG_LEVEL`.

**Nicht auf Vercel setzen:** `SIGNER_*`, `WALLET_*`, irgendeinen privaten
Schlüssel. Die Signer-Grenze ist eine Deploy-Grenze, keine Code-Konvention.

**Worker-Host** — Pflicht (`workerEnvSchema`):

| Variable | Wert |
|---|---|
| `DATABASE_URL` | Direktverbindung (Neon-Host **ohne** `-pooler`) |
| `WORKER_ROLE` | eine Rolle je Prozess |
| `SOLANA_RPC_URL` | **Pflicht, auch für `scheduler` und `provider-health`** — das Schema ist rollenunabhängig |

Optional: `SOLANA_RPC_FALLBACK_URL`, `HEALTH_PORT` (Standard 3001, direkt aus
`process.env`), `RESEND_API_KEY` + `ALERT_FROM_EMAIL` + `ALERT_TO_EMAIL` (für
`alerts`), `SIGNER_URL` + `SIGNER_CLIENT_CERT_PATH` + `SIGNER_CLIENT_KEY_PATH`
(nur `execution`), `NODE_ENV`, `LOG_LEVEL`.

Anbieter-Variablen liegen in einem eigenen Schema
(`packages/config/src/providers.ts`) und sind **alle optional**:
`MARKET_DATA_PRIORITY`, `DEXSCREENER_BASE_URL`, `BIRDEYE_BASE_URL`,
`BIRDEYE_API_KEY`, `JUPITER_BASE_URL`, `HELIUS_BASE_URL`, `HELIUS_API_KEY`,
`RUGCHECK_BASE_URL`, `ALERT_ALLOW_TEST_EMAILS`. Ein Anbieter ohne Basis-URL ist
`NOT_CONFIGURED` — eine Feststellung, kein Fehler.

DexScreener braucht **keinen** Schlüssel, aber `DEXSCREENER_BASE_URL` muss
gesetzt sein, sonst gilt er als nicht konfiguriert und taucht in keiner Kette
auf. Was er darüber hinaus braucht, ist ausgehender Zugriff auf
`api.dexscreener.com` — siehe `docs/providers/dexscreener.md`.

**Signer-Host** (existiert noch nicht produktiv): ausschließlich `SIGNER_*`, alle
als Dateipfade auf Secrets, nie als Wert in einer Env-Variablen.

### Minimalbesetzung

Drei Prozesse auf dem Worker-Host, plus Vercel:

```bash
WORKER_ROLE=scheduler       pnpm --filter @sae/worker start
WORKER_ROLE=provider-health pnpm --filter @sae/worker start
WORKER_ROLE=consumer        pnpm --filter @sae/worker start   # 1..n
```

Genau eine `scheduler`- und eine `provider-health`-Instanz, beliebig viele
`consumer`.

## 7. Health

Jeder Worker öffnet einen HTTP-Health-Port (`HEALTH_PORT`, Standard 3001). Er
meldet `ready`, solange kein Herunterfahren läuft. Web hat `/api/health` — das
beantwortet „läuft der Prozess", mehr nicht.

### `GET /api/diagnostics/providers`

Die Frage danach: **kommt dieses System an Daten, und wenn nein, woran hängt
es?** Beantwortbar ohne Kenntnis des Codes.

HTTP-Status des Endpunkts selbst: **200**, wenn mindestens ein Anbieter
`productionVerified` ist, sonst **503**. Ein Monitoring, das nur den Statuscode
liest, bekommt damit die richtige Antwort.

| Feld | Bedeutung |
|---|---|
| `headline` | `PROVIDER VERIFIED` \| `BLOCKED` \| `WAITING FOR PROVIDER` \| `NO PROVIDER CONFIGURED` |
| `anyProductionVerified` | ob irgendein Anbieter je eine echte 2xx-Antwort geliefert hat |
| `providers[].state` | `CONFIGURED` \| `CONNECTED` \| `BLOCKED` \| `CAPABILITY_READY` \| `PRODUCTION_ENABLED` |
| `providers[].implementationConfidence` | `NONE` \| `SHAPE_ONLY` \| `SCHEMA_KNOWN` \| `SCHEMA_VERIFIED` |
| `providers[].productionVerified` | nur `true` nach einem echten Smoke-Test mit 2xx |
| `providers[].schemaValidated` | `true` / `false` / **`null`** (noch nie validiert) |
| `providers[].lastSuccessAt` · `lastSuccessLatencyMs` | letzte erfolgreiche Antwort und ihre Latenz |
| `providers[].lastFailureAt` · `lastFailureClass` · `lastFailureReason` | letzter Fehler, klassifiziert |
| `providers[].lastSmokeTestAt` · `lastSmokeTestStatus` · `lastSmokeTestDetail` | letzter Smoke-Test |
| `providers[].requestsLastHour` | Anzahl Anfragen in der letzten Stunde |
| `providers[].errorRateLastHour` | Fehlerquote — **`null`** bei null Anfragen, nicht `0` |
| `chains[]` | die Anbieterkette je Capability: Mitglieder, einsatzbereite, Begründung |

`null` heißt hier durchgehend „nicht gemessen" und nie „null". Eine Fehlerquote
von 0 % ohne eine einzige Anfrage wäre eine Aussage über nichts.

Was der Endpunkt **nicht** ausgibt: Verbindungszeichenfolgen, API-Schlüssel,
Anbieter-Rohantworten. Auch der `catch`-Zweig bindet den Fehler nicht — eine
Postgres-Verbindungsfehlermeldung enthält die Verbindungszeichenfolge.

### Deployment-Smoke-Test

Nach dem Deployment auf dem Worker-Host ausführen. Er simuliert nichts: jede
Stufe ist ein echter Aufruf, und der Lauf endet an der ersten Stufe, die nicht
durchkommt.

```bash
DATABASE_URL=<direkt> pnpm --filter @sae/worker exec tsx src/smoke/pipeline.ts \
  So11111111111111111111111111111111111111112
```

Die Stufen:

```
1. SCHEMA CONTRACT          geprüftes Response-Schema vorhanden?
2. REAL RESPONSE            echter Abruf: HTTP-Status, Latenz, Datensätze
3. PRODUCTION_VERIFIED      Reifegrad wird gesetzt — nur nach echtem 2xx
4. MARKET SNAPSHOT          normalisiert und in snapshots aufgenommen
5. FEATURE VECTOR           aus der Historie über den PitReader
6. DECISION
7. OPPORTUNITY (AUTO + MANUAL)
8. 100 EUR AUTO PAPER
```

| Exit-Code | Bedeutung |
|---|---|
| `0` | alle Stufen PASS |
| `1` | eine Stufe FAIL — echter Fehler |
| `3` | eine Stufe BLOCKED — Voraussetzung fehlt (Egress, Schema, Historie) |
| `2` | Aufruffehler (Mint oder `DATABASE_URL` fehlt) |

Der Unterschied zwischen `1` und `3` ist der Punkt: eine Sperre ist kein
Fehlschlag, und ein Fehlschlag löst sich nicht durch Warten.

Einzelner Anbieter-Smoke-Test, ohne die restliche Kette:

```bash
DATABASE_URL=<direkt> pnpm --filter @sae/worker exec tsx src/smoke/dexscreener.ts
```

Ein Aufruf, keine Wiederholung. Das Ergebnis landet in `provider_requests` und
im Reifegrad — auch ein 403, denn ein nicht dokumentierter Fehlschlag ist ein
verlorener Befund.

## 8. Startbedingung

Das System handelt nicht, weil es läuft, sondern weil eine Quelle antwortet. Die
Kette ist:

```
provider-health misst
   → schreibt provider_status_samples
      → scheduler liest daraus anyMarketDataUsable()
         → reiht datenabhängige Takte ein
            → consumer arbeitet sie ab
```

Solange keine Marktdatenquelle `CONNECTED` oder `DEGRADED` ist, bleiben die
datenabhängigen Takte stehen. Das Dashboard zeigt dann `WAITING FOR LIVE MARKET
DATA` — nicht Null, nicht einen letzten bekannten Wert.

Der Scheduler liest die Lage alle 30 Sekunden neu aus der Datenbank. Ein
Anbieter, der um drei Uhr nachts wiederkommt, wird also bemerkt, ohne dass
jemand etwas neu startet.

## 8b. Sicherheit

Was in dieser Phase gilt und geprüft ist:

- **Kein privater Schlüssel im Repository.** Er taucht in keinem Env-Schema auf
  und existiert nur als Docker-Secret im Signer-Container.
- **Keine API-Schlüssel im Code.** Resend liest aus `RESEND_API_KEY`, Anbieter
  aus ihren jeweiligen Variablen. Der Secrets-Audit über alle getrackten
  Dateien läuft in jeder Runde.
- **Keine Secrets im Log.** `@sae/observability` redigiert per **Allowlist**:
  was nicht ausdrücklich erlaubt ist, wird ersetzt. Eine Blocklist schützt nur
  vor den Feldnamen, an die jemand gedacht hat.
- **Keine Secrets im Dashboard.** Die Dashboard-Abfragen lesen keine
  Anbieterschlüssel; die Verbindungszeichenfolge bleibt im Prozessspeicher und
  erscheint in keiner Ausgabe.
- **Keine rohen Anbieter-Antworten in der Datenbank.** Gespeichert werden die
  geparsten Felder plus Herkunft, nicht der Rohkörper.

Für einen späteren Live-Betrieb gilt zusätzlich: die Wallet-Signierung läuft
über einen eigenen Prozess (`apps/signer`) mit mTLS, Programm-Allowlist und
harten Abflussgrenzen. Ein Web-Request erreicht ihn nie direkt — die Trennung
existiert bereits im Code und darf nicht aufgeweicht werden.

## 9. Was vor einem Live-Deployment noch fehlt

Kein Punkt davon ist durch Code allein zu lösen:

- eine erreichbare Marktdatenquelle mit einem gegen ihre Spezifikation geprüften
  Adapter. Stand heute: der DexScreener-Adapter ist gebaut und getestet, aber
  sein Response-Vertrag ist `UNVERIFIED` und der Host in dieser Umgebung per
  Egress gesperrt (HTTP 403). Er lehnt deshalb jede Antwort ab, statt zu raten.
  Jupiter ist erreichbar, aber ein Router und keine Marktdatenquelle. Details
  und der genaue Freischaltschritt: `docs/providers/dexscreener.md`,
- daraus eine kalibrierte Kostenannahme statt der derzeitigen Festlegung,
- eine Strategie, die Backtest, Walk-Forward, Out-of-Sample und Shadow Trading
  durchlaufen hat,
- eine bewusste, mit 2FA bestätigte Freischaltung des Live-Modus.
