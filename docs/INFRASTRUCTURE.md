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
| PostgreSQL-Schema | **READY** | 10 Migrationen gegen echtes PG 16 angewendet: 61 Tabellen, 158 Indizes, 34 CHECK-Constraints |
| Persistente Stores | **READY** | Schreiben + Zurücklesen + Rollback über den Produktionstreiber `postgres-js` geprüft |
| Worker (startfähig) | **READY** | `scheduler`, `provider-health`, `consumer` gestartet, `/ready` → 200, Queue-Zeilen geschrieben |
| Worker-Host | **BLOCKED** | Kein Host verbunden. `Dockerfile.worker` liegt bereit, ist aber ungebaut |
| Web-Build | **READY** | `pnpm --filter @sae/web build` erfolgreich, 5 Routen |
| Web zur Laufzeit | **READY** | Gegen echte Datenbank gestartet, `/api/health` → 200, `/api/diagnostics/providers` → 503 mit echten Daten |
| Vercel-Projekt | **BLOCKED** | Kein Vercel-Token, kein CLI in dieser Umgebung. Konfiguration geprüft, Verbindung muss manuell erfolgen |
| Resend | **PARTIALLY READY** | Adapter und Bestätigungskette implementiert und getestet; kein API-Schlüssel, also nie ein echter Versand |
| Marktdaten | **BLOCKED** | Kein Anbieter erreichbar. DexScreener-Adapter vorhanden, Response-Vertrag `UNVERIFIED`, Host per Egress gesperrt |
| Live Trading | **AUS (gewollt)** | Signer antwortet auf jede Signieranfrage mit 501, `execution`-Rolle ist ein leerer Platzhalter |

---

## 2. Environment Variables

Maßgeblich sind die Zod-Schemata, nicht diese Tabellen: `packages/config/src/env.ts`
(Web, Worker, Signer) und `packages/config/src/providers.ts` (Anbieter). Was dort
kein `.optional()` trägt, lässt den Prozess beim Start abbrechen.

Legende: **REQUIRED** = ohne diesen Wert startet der Prozess nicht ·
**OPTIONAL** = Funktion entfällt ohne den Wert · **BLOCKED** = Wert kann noch
nicht beschafft werden.

### 2.1 Database

| Variable | Web | Worker | Wert |
|---|---|---|---|
| `DATABASE_URL` | REQUIRED | REQUIRED | **Zwei verschiedene Endpunkte derselben Datenbank.** Web: Pooler (Neon `-pooler`, Supabase `:6543`, PgBouncer transaction mode). Worker: Direktverbindung. Migrationen laufen immer über die Direktverbindung |

### 2.2 Web / Vercel

| Variable | Status | Wert |
|---|---|---|
| `DATABASE_URL` | REQUIRED | Pooler-Endpunkt, siehe oben |
| `REDIS_URL` | REQUIRED | Gültige `redis://`-URL. **Wird von keinem Code-Pfad gelesen** — das Schema verlangt sie trotzdem. Siehe 2.7 |
| `SESSION_SECRET` | REQUIRED | ≥ 32 Zeichen. Erzeugen: `openssl rand -base64 48` |
| `APP_BASE_URL` | REQUIRED | `https://<deine-domain>` — die Basis für die INVEST-NOW-Links in den Mails |
| `RESEND_API_KEY` | OPTIONAL | Nur falls die Web-App selbst versenden soll. Heute versendet der `alerts`-Worker |
| `NODE_ENV`, `LOG_LEVEL` | OPTIONAL | Vorgabe `development` / `info` |

**Niemals auf Vercel setzen:** `SIGNER_*`, irgendeinen privaten Schlüssel. Die
Signer-Grenze ist eine Deploy-Grenze, keine Code-Konvention.

### 2.3 Worker

| Variable | Status | Wert |
|---|---|---|
| `DATABASE_URL` | REQUIRED | Direktverbindung |
| `REDIS_URL` | REQUIRED | wie oben: verlangt, ungenutzt |
| `WORKER_ROLE` | REQUIRED | Eine Rolle je Prozess. Produktiv heute: `scheduler`, `provider-health`, `consumer` |
| `SOLANA_RPC_URL` | REQUIRED | **Auch für `scheduler` und `provider-health`** — das Schema ist rollenunabhängig |
| `SOLANA_RPC_FALLBACK_URL` | OPTIONAL | Zweiter RPC-Endpunkt |
| `HEALTH_PORT` | OPTIONAL | Vorgabe 3001. Direkt aus `process.env`, nicht im Schema |

### 2.4 Market Data

Alle optional (`packages/config/src/providers.ts`). Ein Anbieter ohne Basis-URL
ist `NOT_CONFIGURED` — eine Feststellung, kein Fehler.

| Variable | Status | Wert |
|---|---|---|
| `MARKET_DATA_PRIORITY` | OPTIONAL | Komma-getrennt. Erste = PRIMARY, zweite = SECONDARY, Rest = FALLBACK |
| `DEXSCREENER_BASE_URL` | **BLOCKED** | `https://api.dexscreener.com`. Kein Schlüssel nötig. Ohne diesen Wert taucht DexScreener in keiner Kette auf. Blockiert, weil der Host per Egress gesperrt ist |
| `BIRDEYE_BASE_URL` + `BIRDEYE_API_KEY` | **REQUIRED für Birdeye** | Beide nötig. Konto bei Birdeye erforderlich |
| `JUPITER_BASE_URL` | OPTIONAL | Einziger Anbieter mit geprüftem Adapter — aber ein Router, keine Marktdatenquelle |
| `HELIUS_BASE_URL` + `HELIUS_API_KEY` | **REQUIRED für Helius** | Beide nötig. Konto bei Helius erforderlich |
| `RUGCHECK_BASE_URL` | OPTIONAL | Kein Schlüssel nötig |

### 2.5 RPC

`SOLANA_RPC_URL` ist Pflicht für jeden Worker. Der öffentliche Endpunkt
`https://api.mainnet-beta.solana.com` funktioniert zum Starten, hat aber ein
niedriges Rate-Limit — für den Dauerbetrieb gehört dort ein eigener Endpunkt
hin (Helius, QuickNode, Triton). **Nicht getestet**, weil in dieser Umgebung
kein ausgehender Zugriff besteht.

### 2.6 Resend

| Variable | Status | Wert |
|---|---|---|
| `RESEND_API_KEY` | **REQUIRED für Alerts** | Aus dem Resend-Dashboard. Ohne ihn meldet der Adapter `NOT_CONFIGURED` und sendet nichts |
| `ALERT_FROM_EMAIL` | **REQUIRED für Alerts** | Absender einer in Resend **verifizierten** Domain |
| `ALERT_TO_EMAIL` | **REQUIRED für Alerts** | Empfänger |
| `ALERT_ALLOW_TEST_EMAILS` | OPTIONAL | Nur in einer Testumgebung. Ohne den Wert verweigert der Adapter jede Mail aus einer Fixture-Gelegenheit |

Diese vier gehören auf den **Worker**-Host (Rolle `alerts`), nicht auf Vercel.

### 2.7 Redis / Queue

**Es wird keine Redis-Queue verwendet.** Die Auftragswarteschlange ist die
Tabelle `job_queue` in PostgreSQL — Begründung in `DEPLOYMENT.md`, Abschnitt 4.

`REDIS_URL` ist trotzdem in `baseEnvSchema` als Pflicht deklariert und wird von
keinem Code gelesen. `bullmq` und `ioredis` stehen als Abhängigkeiten in
`apps/worker/package.json`, ohne benutzt zu werden. Das ist eine bekannte
Unsauberkeit: sie kostet einen Pflichtwert, den niemand braucht. Bereinigen
heißt, `REDIS_URL` optional zu machen und die beiden Pakete zu entfernen —
eine Änderung am Env-Schema, deshalb nicht ohne Rücksprache gemacht.

### 2.8 Signer

Nur auf dem Signer-Host, niemals auf Vercel oder dem Worker-Host.

| Variable | Status |
|---|---|
| `SIGNER_KEY_FILE`, `SIGNER_TLS_CERT_PATH`, `SIGNER_TLS_KEY_PATH`, `SIGNER_TLS_CLIENT_CA_PATH` | REQUIRED — **Dateipfade auf Secrets**, nie der Schlüssel selbst |
| `SIGNER_TRADING_WALLET`, `SIGNER_ALLOWED_PROGRAM_IDS` | REQUIRED — fehlen sie, startet der Signer nicht |
| `SIGNER_ALLOWED_TIP_ACCOUNTS` | OPTIONAL — leere Vorgabe heißt: keine direkten Empfänger erlaubt |
| `SIGNER_MAX_SOL_OUT_PER_TX_LAMPORTS`, `SIGNER_MAX_SOL_OUT_PER_WINDOW_LAMPORTS`, `SIGNER_WINDOW_SECONDS` | REQUIRED — harte Abflussgrenzen |
| `SIGNER_PORT` | OPTIONAL — Vorgabe 8443 |

Der Signer ist heute **nicht zu deployen und soll es auch nicht sein**: er
antwortet auf jede policy-konforme Signieranfrage mit HTTP 501.

### 2.9 Monitoring

Es gibt **keine** Monitoring-Variablen — kein Sentry, kein Datadog, kein
OTLP-Endpunkt. Beobachtbarkeit läuft heute über:

- strukturierte Logs auf stdout (`pino`, Redaktion per **Allowlist**),
- `GET /api/health` auf Vercel — beantwortet „läuft der Prozess",
- `GET /api/diagnostics/providers` — beantwortet „kommt das System an Daten",
  200 bei mindestens einem verifizierten Anbieter, sonst 503,
- `HEALTH_PORT` je Worker, `/ready`.

Ein externer Dienst wäre eine neue Abhängigkeit und ist deshalb nicht ohne
Rücksprache eingebaut.

---

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
# 1. Migrationen — über die DIREKTVERBINDUNG, nicht über den Pooler
DATABASE_URL=<direkt> pnpm --filter @sae/db exec drizzle-kit migrate

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

## 5. Worker-Host: was zu tun ist

Der Worker braucht einen Host, der **langlebige Prozesse** ausführt. Vercel
kann das nicht (Begründung: `DEPLOYMENT.md`, Abschnitt 2).

**Benötigt wird genau eines davon:**

| Dienst | Konto | Berechtigung | Aufwand |
|---|---|---|---|
| **Fly.io** | Fly-Konto + Zahlungsmittel | Deploy-Token | `fly launch --dockerfile Dockerfile.worker`, drei Prozessgruppen |
| **Railway** | Railway-Konto | GitHub-Repo-Zugriff | Dockerfile-Pfad setzen, drei Dienste mit je eigener `WORKER_ROLE` |
| **Render** | Render-Konto | GitHub-Repo-Zugriff | Drei „Background Worker" mit demselben Dockerfile |
| **Hetzner / eigener Server** | Server + Docker | SSH | `docker compose` mit drei Diensten |

**Mindestbesetzung — drei Prozesse:**

```bash
WORKER_ROLE=scheduler        # genau eine Instanz
WORKER_ROLE=provider-health  # genau eine Instanz
WORKER_ROLE=consumer         # eine oder mehrere
```

Mehrere Consumer sind unbedenklich: Aufträge werden per
`FOR UPDATE SKIP LOCKED` vergeben, zwei Prozesse können denselben Auftrag nicht
bekommen. Zwei Scheduler wären nicht falsch, aber sinnlos doppelte Last.

`Dockerfile.worker` liegt im Wurzelverzeichnis. **Er ist nicht gebaut worden** —
in dieser Umgebung läuft kein Docker-Daemon. Erster Schritt auf dem Zielhost ist
deshalb ein Testbau:

```bash
docker build -f Dockerfile.worker -t sae-worker .
```

---

## 6. Vercel: was zu tun ist

`vercel.json` liegt im Wurzelverzeichnis und ist geprüft — der darin
angegebene Build-Befehl wurde ausgeführt und erzeugt das angegebene
Ausgabeverzeichnis.

| Einstellung | Wert | Warum |
|---|---|---|
| Root Directory | **Repository-Wurzel** (leer lassen) | `vercel.json` steuert den Build von dort aus |
| Framework Preset | Next.js | steht in `vercel.json` |
| Build Command | `pnpm --filter @sae/web build` | aus `vercel.json`, verifiziert |
| Install Command | `pnpm install --frozen-lockfile` | aus `vercel.json` |
| Output Directory | `apps/web/.next` | aus `vercel.json`, verifiziert |
| Node-Version | 22 | `engines` in `package.json` |
| Region | `fra1` | nah an europäischen Anbietern |

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

## 7. Bekannte Unsauberkeiten

Kein Blocker, aber dokumentiert statt versteckt:

1. **`REDIS_URL` ist Pflicht und ungenutzt.** Siehe 2.7.
2. **`0001_timescale.sql` steht nicht im Migrations-Journal.** Die Datei ist
   selbstsichernd (sie tut ohne die TimescaleDB-Erweiterung nichts), wird von
   `drizzle-kit migrate` aber auch dann nicht ausgeführt, wenn die Erweiterung
   später installiert wird. Wer Timescale einsetzen will, führt sie von Hand aus.
3. **`adapterImplemented: false` für DexScreener.** Der Adapter existiert seit
   der letzten Runde; das Flag bleibt `false`, weil er ohne geprüften Vertrag
   keine Daten liefern darf. Das Verhalten ist richtig, der Feldname ungenau.
4. **Kein Build-Schritt.** Alle Pakete exportieren TypeScript-Quellen, `tsx`
   führt sie direkt aus. Das hält Test- und Betriebscode identisch, kostet aber
   Startzeit und bindet `tsx` in den Betrieb ein.
