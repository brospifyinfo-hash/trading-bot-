# Infrastruktur: was läuft wo, und was fehlt noch

Diese Datei ist die Checkliste für ein Deployment. Sie beschreibt **den
tatsächlichen Zustand**, nicht die Zielarchitektur — was noch fehlt, steht als
`BLOCKED` oder `REQUIRED` drin und nicht als Platzhalterwert.

Die Architektur selbst (warum der Worker nicht auf Vercel läuft, wie Worker und
Vercel kommunizieren) steht in [`DEPLOYMENT.md`](DEPLOYMENT.md).

---

## 1. Status je Baustein

| Baustein | Status | Belegt durch |
|---|---|---|
| GitHub-Repository | **READY** | `main` sauber, synchron, einziger Branch |
| PostgreSQL-Schema | **READY** | 10 Migrationen gegen echtes PG 16 angewendet: 61 Tabellen, 158 Indizes, 34 CHECK-Constraints. Zweitlauf ist ein No-Op |
| Neon-Projekt | **BLOCKED** | Kein Neon-Zugang, `console.neon.tech` per Egress gesperrt. Migrationspfad auf den Direktendpunkt umgestellt und verifiziert |
| Persistente Stores | **READY** | Schreiben + Zurücklesen + Rollback über den Produktionstreiber `postgres-js` geprüft |
| Worker (startfähig) | **READY** | `scheduler`, `provider-health`, `consumer` gestartet, `/ready` → 200, Queue-Zeilen geschrieben |
| Worker-Host (Railway) | **BLOCKED** | Kein Railway-Zugang. `Dockerfile.worker` + `railway/*.json` liegen bereit; der Dateisatz des Images wurde nachgestellt und der Worker daraus gestartet, das Image selbst ist **ungebaut** |
| Web-Build | **READY** | `pnpm --filter @sae/web build` erfolgreich, 5 Routen |
| Web zur Laufzeit | **READY** | Gegen echte Datenbank gestartet, `/api/health` → 200, `/api/diagnostics/providers` → 503 mit echten Daten |
| Vercel-Projekt | **BLOCKED** | Kein Token, kein CLI, `api.vercel.com` per Egress gesperrt. Root Directory muss auf `apps/web` gesetzt werden — der erste Deploy scheiterte an der Framework-Erkennung, siehe Abschnitt 6 |
| Resend | **PARTIALLY READY** | Adapter und Bestätigungskette implementiert und getestet; kein API-Schlüssel, also nie ein echter Versand |
| Marktdaten | **BLOCKED** | Kein Anbieter erreichbar. DexScreener-Adapter vorhanden, Response-Vertrag `UNVERIFIED`, Host per Egress gesperrt |
| Live Trading | **AUS (gewollt)** | Signer antwortet auf jede Signieranfrage mit 501, `execution`-Rolle ist ein leerer Platzhalter |

---

## 2. Environment Variables

Maßgeblich sind die Zod-Schemata, nicht diese Tabelle: `packages/config/src/env.ts`
(Web, Worker, Signer) und `packages/config/src/providers.ts` (Anbieter). Was dort
kein `.optional()` trägt, lässt den Prozess beim Start abbrechen.

### Die Matrix

| VARIABLE | VERCEL | RAILWAY | REQUIRED | PURPOSE |
|---|---|---|---|---|
| `DATABASE_URL` | ✅ **gepoolt** | ✅ **direkt** | ja | Laufender Betrieb. Zwei verschiedene Endpunkte **derselben** Neon-Datenbank |
| `DATABASE_URL_DIRECT` | — | optional | nein | Nur für Migrationen/DDL. Fehlt er, gilt `DATABASE_URL` |
| `SESSION_SECRET` | ✅ | — | ja (Web) | Sitzungssignatur, ≥ 32 Zeichen |
| `APP_BASE_URL` | ✅ | — | ja (Web) | Basis der INVEST-NOW-Links in den Mails |
| `WORKER_ROLE` | — | ✅ | ja (Worker) | `scheduler` \| `provider-health` \| `consumer` — je Dienst genau einer |
| `SOLANA_RPC_URL` | — | ✅ | ja (Worker) | **Auch für `scheduler` und `provider-health`** — das Schema ist rollenunabhängig |
| `SOLANA_RPC_FALLBACK_URL` | — | optional | nein | Zweiter RPC-Endpunkt |
| `PORT` | automatisch | automatisch | nein | Setzt die Plattform. Der Worker richtet den Health-Port danach aus |
| `HEALTH_PORT` | — | optional | nein | Nur wenn der Port von Hand gesetzt wird (Compose, lokal). Vorgabe 3001 |
| `RESEND_API_KEY` | optional | ✅ (alerts) | für Alerts | Ohne ihn meldet der Adapter `NOT_CONFIGURED` und sendet nichts |
| `ALERT_FROM_EMAIL` | — | ✅ (alerts) | für Alerts | Absender einer in Resend **verifizierten** Domain |
| `ALERT_TO_EMAIL` | — | ✅ (alerts) | für Alerts | Empfänger |
| `ALERT_ALLOW_TEST_EMAILS` | — | optional | nein | Nur in einer Testumgebung. Ohne den Wert keine Mail aus einer Fixture |
| `MARKET_DATA_PRIORITY` | — | optional | nein | Reihenfolge der Anbieterkette, komma-getrennt |
| `DEXSCREENER_BASE_URL` | — | optional | nein | `https://api.dexscreener.com`. Ohne ihn taucht DexScreener in keiner Kette auf |
| `BIRDEYE_BASE_URL` + `BIRDEYE_API_KEY` | — | optional | beide zusammen | Konto bei Birdeye nötig |
| `JUPITER_BASE_URL` | — | optional | nein | Router, keine Marktdatenquelle |
| `HELIUS_BASE_URL` + `HELIUS_API_KEY` | — | optional | beide zusammen | Konto bei Helius nötig |
| `RUGCHECK_BASE_URL` | — | optional | nein | Kein Schlüssel nötig |
| `NODE_ENV`, `LOG_LEVEL` | optional | optional | nein | Vorgabe `development` / `info` |
| `SIGNER_*` | **NIEMALS** | **NIEMALS** | — | Nur auf einem eigenen Signer-Host. Siehe 2.2 |

**`REDIS_URL` gibt es nicht mehr.** Sie war Pflicht und wurde von keiner
Codezeile gelesen; `bullmq` und `ioredis` waren ungenutzte Abhängigkeiten. Alles
entfernt — Begründung und die dabei gerettete Retry-Politik stehen in
`DECISIONS.md`, Entscheidung 77. Sie brauchen auf Railway **keinen**
Redis-Dienst.

### 2.1 Die zwei Neon-Endpunkte

Eine Datenbank, zwei Verbindungszeichenfolgen. Neon zeigt beide im Dashboard:

| | Host enthält | Wofür |
|---|---|---|
| **Pooled** | `-pooler` | Vercel — hunderte kurzlebige Instanzen, der Pooler bündelt sie |
| **Direct** | kein `-pooler` | Railway und **alle Migrationen** — DDL über einen Transaction-Mode-Pooler ist nicht zuverlässig |

`prepare: false` ist im Client fest gesetzt und keine Vorsichtsmaßnahme, sondern
Pflicht: ein Pooler gibt die Verbindung nach jeder Transaktion weiter, und ein
vorbereitetes Statement liegt dann auf einer anderen.

### 2.2 Signer

Nur auf einem eigenen Signer-Host, **niemals** auf Vercel oder Railway:
`SIGNER_KEY_FILE`, `SIGNER_TLS_CERT_PATH`, `SIGNER_TLS_KEY_PATH`,
`SIGNER_TLS_CLIENT_CA_PATH` (alle **Dateipfade auf Secrets**, nie der Schlüssel
selbst), `SIGNER_TRADING_WALLET`, `SIGNER_ALLOWED_PROGRAM_IDS`,
`SIGNER_ALLOWED_TIP_ACCOUNTS` (leere Vorgabe = keine direkten Empfänger),
die drei Abflussgrenzen und `SIGNER_PORT`.

Der Signer ist heute **nicht zu deployen und soll es auch nicht sein**: er
antwortet auf jede policy-konforme Signieranfrage mit HTTP 501.

### 2.3 Monitoring

Es gibt **keine** Monitoring-Variablen — kein Sentry, kein Datadog, kein OTLP.
Beobachtbarkeit läuft über strukturierte Logs auf stdout (`pino`, Redaktion per
Allowlist), `GET /api/health` (läuft der Prozess), `GET /api/diagnostics/providers`
(kommt das System an Daten — 200 nur bei mindestens einem verifizierten
Anbieter, sonst 503) und `/ready` je Worker.

## 3. Provider-Matrix

**Keine Zeile davon ist gemessen.** In dieser Umgebung ist kein einziger
Anbieter erreichbar (Egress-Sperre, HTTP 403 am Proxy), und die
Dokumentationsseiten sind ebenfalls gesperrt. Kosten, Rate-Limits und
Echtzeitverhalten stammen aus der Spezifikation V1 und sind damit
**UNVERIFIED** — sie sind hier notiert, damit man weiß, was zu prüfen ist,
nicht als bestätigte Zusage.

| Provider | Daten | API | Kosten | Rate Limits | Echtzeit | Historie | Security | Status |
|---|---|---|---|---|---|---|---|---|
| **DexScreener** | Preis, Liquidität, Volumen, Market Cap, Discovery | REST, kein Schlüssel | kostenlos (V1) | 300 rpm (V1) | Push nein, Poll ja | nein | — | **BLOCKED: EGRESS** — Adapter gebaut, Vertrag `UNVERIFIED` |
| **Birdeye** | Preis, Liquidität, Volumen, Preishistorie | REST + Schlüssel | kostenpflichtig ab Stufe | staffelabhängig | ja (V1) | ja | — | **NOT_CONFIGURED** — kein Konto, kein Adapter |
| **Jupiter** | Route-Quotes, Swap-Transaktionen | REST, kein Schlüssel | kostenlos (V1) | unbekannt | ja | nein | — | **NOT_CONFIGURED** — Adapter vorhanden und gegen die eigene OpenAPI geprüft, aber Router, keine Marktdatenquelle |
| **Helius** | Holder-Verteilung, On-chain | REST + Schlüssel | kostenpflichtig ab Stufe | staffelabhängig | ja | ja | — | **NOT_CONFIGURED** — kein Konto, kein Adapter |
| **RugCheck** | Security-Report, Rug-Erkennung | REST, kein Schlüssel | unbekannt | unbekannt | — | — | ja | **NOT_CONFIGURED** — kein Adapter |
| **Solana RPC** | On-chain, Kontostände, Transaktionen | JSON-RPC | öffentlich kostenlos, dediziert kostenpflichtig | öffentlich sehr eng | ja | begrenzt | — | **NOT_CONFIGURED** |

### Welche Datenart woher käme

| Bedarf | Anbieter | Abgedeckt? |
|---|---|---|
| Token Discovery | DexScreener | Adapter blockiert |
| Preis, Liquidity, Volume, Market Cap | DexScreener, Birdeye | Adapter blockiert / kein Konto |
| Holder Growth | Helius | **kein Adapter** |
| Buy/Sell Pressure | — | **keine Quelle benannt** |
| Smart Money | — | **keine Quelle benannt** |
| Wallet Activity | Helius | **kein Adapter** |
| Security / Rug Detection | RugCheck | **kein Adapter** |
| On-chain Data | Solana RPC, Helius | **kein Adapter** |
| Social Data | — | **keine Quelle benannt** |
| DEX / Execution Quotes | Jupiter | Adapter vorhanden und geprüft |
| Solana RPC | eigener Endpunkt | nicht konfiguriert |

Drei Bedarfe haben **überhaupt keine benannte Quelle**: Buy/Sell Pressure,
Smart Money, Social Data. Sie stehen so auch nicht in der Spezifikation V1. Ein
Adapter dafür wäre eine Erfindung, solange nicht feststeht, welcher Anbieter sie
liefern soll.

---

## 4. Was nach dem Deployment auszuführen ist

In dieser Reihenfolge. Jeder Schritt ist ein echter Aufruf, kein Klickpfad.

```bash
# 1. Migrationen — über die DIREKTVERBINDUNG (Neon-Host OHNE "-pooler")
DATABASE_URL_DIRECT=<neon-direkt> pnpm --filter @sae/db exec drizzle-kit migrate

# 2. Infrastruktur prüfen (nur lesend)
DATABASE_URL=<direkt> pnpm --filter @sae/worker smoke:infra

#    ... oder mit echtem Schreibtest, der zurückrollt
DATABASE_URL=<direkt> pnpm --filter @sae/worker exec tsx src/smoke/infrastructure.ts --write

# 3. Anbieter prüfen — ein Aufruf, keine Wiederholung
DATABASE_URL=<direkt> pnpm --filter @sae/worker smoke:dexscreener

# 4. Die ganze Kette, stufenweise
DATABASE_URL=<direkt> pnpm --filter @sae/worker smoke:pipeline So11111111111111111111111111111111111111112

# 5. Von außen gegen die Web-App
curl -i https://<deine-domain>/api/health
curl -i https://<deine-domain>/api/diagnostics/providers
```

Exit-Codes von 2–4: `0` alles grün · `1` echter Fehlschlag · `3` Sperre
(Voraussetzung fehlt) · `2` Aufruffehler. Der Unterschied zwischen `1` und `3`
ist der Punkt: eine Sperre ist kein Fehlschlag, und ein Fehlschlag löst sich
nicht durch Warten.

---

## 5. Railway: die drei Worker-Dienste

Drei **getrennte Dienste** im selben Railway-Projekt, aus demselben Repository
und demselben Dockerfile. Sie unterscheiden sich ausschliesslich durch
`WORKER_ROLE`. Die vollständige Anleitung steht in
[`railway/README.md`](../railway/README.md); hier nur das Wesentliche:

| Dienst | `WORKER_ROLE` | Config-Datei | Repliken |
|---|---|---|---|
| Scheduler | `scheduler` | `railway/scheduler.json` | 1 |
| Provider Health | `provider-health` | `railway/provider-health.json` | 1 |
| Consumer | `consumer` | `railway/consumer.json` | 1..n |

Builder, Dockerfile-Pfad, Start Command, Restart Policy und Healthcheck stehen
in den JSON-Dateien und müssen nicht geklickt werden. Root Directory bleibt
**leer** (Repository-Wurzel), Branch ist `main`, und **kein** Dienst bekommt
eine öffentliche Domain.

Railway führt **keine** Migrationen aus — kein `releaseCommand`. Drei Dienste,
die beim Start dieselbe Migration fahren wollen, sind drei gleichzeitige
DDL-Läufe auf derselben Datenbank.

`Dockerfile.worker` ist **nicht gebaut worden** — in dieser Umgebung läuft kein
Docker-Daemon. Verifiziert wurde stattdessen der Dateisatz, den er erzeugt: die
`COPY`-Anweisungen nachgestellt, `pnpm install --frozen-lockfile` darin
ausgeführt (21 Manifeste, erfolgreich) und der Worker mit demselben
`WORKDIR`/`CMD` daraus gestartet — `/ready` antwortete mit 200. Der erste
Schritt auf Railway bleibt trotzdem ein Testbau.

## 6. Vercel: was zu tun ist

**Root Directory ist `apps/web` — nicht die Repository-Wurzel.** Das ist die
einzige Einstellung, die von Hand gesetzt werden muss; alles Weitere erkennt
Vercel selbst.

Der Grund ist keine Vorliebe, sondern die Reihenfolge in Vercels Build:
**die Framework-Erkennung liest die `package.json` im Root Directory, und zwar
bevor der Build-Befehl überhaupt läuft.** Steht dort kein `next`, bricht der
Deploy ab mit

> No Next.js version detected. Make sure your package.json has next in either
> dependencies or devDependencies.

Genau das passierte mit Root Directory = Repository-Wurzel: die Wurzel-
`package.json` führt nur Werkzeuge (TypeScript, ESLint, Vitest, tsx), `next`
steht in `apps/web/package.json`. `buildCommand` und `outputDirectory` konnten
daran nichts ändern — sie kommen erst nach der Erkennung zum Zug.

`next` in die Wurzel-`package.json` zu schreiben wäre die falsche Abhilfe: sie
würde eine Abhängigkeit erfinden, die dort nicht hingehört, und die
Monorepo-Grenze aufweichen. Richtig ist, Vercel auf das Verzeichnis zu zeigen,
dessen `package.json` `next` tatsächlich führt.

| Einstellung | Wert | Warum |
|---|---|---|
| Root Directory | **`apps/web`** | das Verzeichnis, dessen `package.json` `next` führt |
| Framework Preset | Next.js | wird jetzt korrekt erkannt; steht zusätzlich in `apps/web/vercel.json` |
| Build Command | *leer lassen* | Vercel erkennt `next build` |
| Install Command | *leer lassen* | Vercel installiert den pnpm-Workspace von der Repository-Wurzel aus |
| Output Directory | *leer lassen* | `.next` relativ zum Root Directory |
| Node-Version | 22 | `engines` in `package.json` |
| Region | `fra1` | aus `apps/web/vercel.json` |

`vercel.json` liegt deshalb in **`apps/web/`**, nicht mehr im Wurzelverzeichnis:
Vercel liest die Datei aus dem Root Directory. Sie enthält nur noch, was Vercel
nicht selbst erkennen kann — Region und `maxDuration`. Build-, Install- und
Ausgabepfad stehen bewusst nicht mehr darin: sie relativ zum neuen Root
Directory noch einmal festzuschreiben wäre genau die Fehlerquelle, die diesen
Deploy hat scheitern lassen.

**Die pnpm-Workspace-Abhängigkeiten bleiben dabei intakt.** `apps/web` hängt an
vier Paketen per `workspace:*` (`@sae/core`, `@sae/config`, `@sae/db`,
`@sae/observability`); die Lockfile und `pnpm-workspace.yaml` liegen in der
Repository-Wurzel, und Vercel installiert von dort. Lokal nachgestellt: aus
`apps/web` heraus lösen alle vier Symlinks korrekt auf, und `pnpm build` von
dort erzeugt `.next` mit allen fünf Routen einschliesslich beider dynamischer
API-Routen.

**Der CI-Build ist davon nicht betroffen.** `.github/workflows/ci.yml` ruft
`pnpm --filter @sae/web build` aus der Repository-Wurzel auf — das funktioniert
unverändert und wurde nach der Umstellung erneut ausgeführt.

**Es gibt bewusst keine `crons`-Sektion.** Vercel Cron löst höchstens minütlich
aus, und die Positionsüberwachung eines Memecoins im Minutenraster ist keine
Überwachung. Der Takt gehört auf den Worker-Host.

Nach dem ersten Deployment prüfen:

```bash
curl -i https://<deine-domain>/api/health                  # 200 erwartet
curl -i https://<deine-domain>/api/diagnostics/providers   # 503 erwartet, solange kein Anbieter verifiziert ist
```

Ein 503 auf dem zweiten Endpunkt ist der **richtige** Zustand, solange keine
Marktdatenquelle erreichbar ist. Er wird erst 200, wenn ein Anbieter einen
echten Smoke-Test mit 2xx bestanden hat.

---

## 6b. Neon: was einzurichten ist

Eine Datenbank für beide Umgebungen — kein getrenntes Vercel- und
Railway-Schema. Der Unterschied liegt nur im Endpunkt (siehe 2.1).

1. Projekt anlegen, Region **Europa** (nah an Vercel `fra1`).
2. Aus dem Dashboard **beide** Connection Strings kopieren: den gepoolten
   (Host mit `-pooler`) und den direkten (ohne).
3. Migrationen einmal von der eigenen Maschine fahren:
   ```bash
   DATABASE_URL_DIRECT=<neon-direkt> pnpm --filter @sae/db exec drizzle-kit migrate
   ```
4. Prüfen, dass wirklich alles da ist:
   ```bash
   DATABASE_URL=<neon-direkt> pnpm --filter @sae/worker smoke:infra
   ```
   Erwartet: 10 Migrationen, alle benötigten Tabellen, alle 7
   Sicherheits-Constraints scharf, und Check 5 belegt, dass eines davon
   tatsächlich auslöst.

**Extensions: keine nötig.** Nachgeprüft, nicht angenommen — nach dem
vollständigen Migrationslauf gegen ein nacktes PostgreSQL 16 war genau eine
Extension installiert: `plpgsql`, die Vorgabe. `gen_random_uuid()` ist seit
PostgreSQL 13 im Kern und braucht kein `pgcrypto`. Keine Migration enthält ein
`CREATE EXTENSION`.

TimescaleDB unterstützt Neon **nicht**. Das ist folgenlos: `0001_timescale.sql`
steht ohnehin nicht im Journal (siehe Abschnitt 7) und ist zusätzlich
selbstsichernd — ohne die Erweiterung tut sie nichts. Das System läuft ohne sie
mit denselben Indizes, nur langsamer bei sehr grossen Zeiträumen.

**Bestehende Daten:** `drizzle-kit migrate` ist additiv und vorwärts-only. Es
löscht nichts. Ein zweiter Lauf gegen denselben Stand ist ein No-Op — verifiziert.

## 6c. Resend: was einzurichten ist

Der Adapter ist implementiert und getestet, hat aber **nie eine echte Mail
versendet** — ohne `RESEND_API_KEY` meldet er `NOT_CONFIGURED` und sendet nichts.

1. Konto anlegen, Domain hinzufügen.
2. Resend zeigt daraufhin die zu setzenden DNS-Einträge an — typischerweise
   ein DKIM-Eintrag und ein Eintrag für die Versanddomain. **Die konkreten
   Namen und Werte erzeugt Resend je Domain**; sie stehen im Resend-Dashboard
   unter der Domain. Ich kann sie hier nicht angeben, ohne sie zu erfinden.
3. Diese Einträge bei Ihrem DNS-Anbieter setzen, in Resend auf „Verify" warten.
4. `RESEND_API_KEY`, `ALERT_FROM_EMAIL` (Adresse **auf der verifizierten
   Domain**) und `ALERT_TO_EMAIL` als Variablen setzen — auf dem Railway-Dienst,
   der später die Rolle `alerts` fährt, **nicht** auf Vercel.

Der Schlüssel gehört ausschliesslich in die Plattform-Variablen, niemals ins
Repository.

**Sicherheitsgrenze, die dabei gilt:** eine E-Mail löst niemals unmittelbar
eine Ausführung aus. Der INVEST-NOW-Klick trägt ein Einmal-Token
(`consumedAt` — ein zweiter Klick ist `ALREADY_CONSUMED`), und danach wird der
gesamte Zustand **neu** erhoben und gegen den Alert gestellt. Der Alert-Preis
wird nie als Einstieg verwendet. Ohne erreichbare Quelle blockt die Kette mit
`NO_LIVE_DATA`, und in dieser Phase endet sie ohnehin bei `executes: "PAPER"`
bzw. `LIVE_TRADING_DISABLED`.

## 7. Bekannte Unsauberkeiten

Kein Blocker, aber dokumentiert statt versteckt:

1. **`0001_timescale.sql` steht nicht im Migrations-Journal.** Die Datei ist
   selbstsichernd (sie tut ohne die TimescaleDB-Erweiterung nichts), wird von
   `drizzle-kit migrate` aber auch dann nicht ausgeführt, wenn die Erweiterung
   später installiert wird. Wer Timescale einsetzen will, führt sie von Hand aus.
2. **`adapterImplemented: false` für DexScreener.** Der Adapter existiert seit
   der letzten Runde; das Flag bleibt `false`, weil er ohne geprüften Vertrag
   keine Daten liefern darf. Das Verhalten ist richtig, der Feldname ungenau.
3. **Kein Build-Schritt.** Alle Pakete exportieren TypeScript-Quellen, `tsx`
   führt sie direkt aus. Das hält Test- und Betriebscode identisch, kostet aber
   Startzeit und bindet `tsx` in den Betrieb ein.
