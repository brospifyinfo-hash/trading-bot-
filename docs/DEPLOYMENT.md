# Betrieb

Wie dieses System deployt wird, und vor allem: **was ausdrücklich nicht auf
Vercel gehört**.

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

Redis bleibt als schneller Transport sinnvoll; die Zustellgarantie trägt es
nicht. Ein Auftrag, der eingereiht wurde, muss einen Neustart des Workers, einen
Absturz mitten in der Bearbeitung und einen Ausfall des Queue-Knotens überleben.
Deshalb ist `job_queue` eine Tabelle:

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
| Vercel (Web) | `DATABASE_URL` (**Pooler**), `REDIS_URL`, `SESSION_SECRET`, `APP_BASE_URL`, `RESEND_API_KEY`, `ALERT_FROM_EMAIL`, `ALERT_TO_EMAIL` |
| Worker | `DATABASE_URL` (direkt), `REDIS_URL`, `WORKER_ROLE`, `SOLANA_RPC_URL`, `HEALTH_PORT`, `MARKET_DATA_PRIORITY`, Anbieter-URLs und -Schlüssel |
| Signer | ausschließlich `SIGNER_*`, alle als Dateipfade auf Secrets |

Der Resend-Schlüssel gehört auf **beide** Seiten nur dorthin, wo tatsächlich
versendet wird — heute ist das der `alerts`-Worker, nicht die Web-App. Ist
`ALERT_ALLOW_TEST_EMAILS` nicht gesetzt, verweigert der Adapter jede Mail aus
einer Fixture-Gelegenheit.

### `vercel.json`

Liegt im Repository-Wurzelverzeichnis. Es baut ausschließlich `@sae/web`; die
Worker sind darin bewusst nicht erwähnt, weil sie dort nicht laufen. **Es gibt
keine `crons`-Sektion** — Vercel Cron löst höchstens minütlich aus, und die
Positionsüberwachung eines Memecoins im Minutenraster ist keine Überwachung.
Der Takt gehört auf den Worker-Host.

## 7. Health

Jeder Worker öffnet einen HTTP-Health-Port (`HEALTH_PORT`, Standard 3001). Er
meldet `ready`, solange kein Herunterfahren läuft. Web hat `/api/health`.

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
  Adapter (heute: nur Jupiter, und der ist ein Router, keine Marktdatenquelle),
- daraus eine kalibrierte Kostenannahme statt der derzeitigen Festlegung,
- eine Strategie, die Backtest, Walk-Forward, Out-of-Sample und Shadow Trading
  durchlaufen hat,
- eine bewusste, mit 2FA bestätigte Freischaltung des Live-Modus.
