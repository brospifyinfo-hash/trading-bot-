# Railway: drei Dienste, ein Repository

Drei **getrennte Railway-Dienste** im selben Projekt, alle aus demselben
Repository und demselben Dockerfile. Sie unterscheiden sich **ausschliesslich**
durch die Variable `WORKER_ROLE`.

Das ist keine Sparmassnahme, sondern der Punkt der Architektur: ein Image, viele
Rollen. Getrennte Images driften auseinander, und ein Worker, der in Produktion
anderen Code ausführt als der, den die Tests prüfen, ist kein geprüfter Worker.

## Was Railway je Dienst braucht

| Einstellung | Wert |
|---|---|
| Repository | `brospifyinfo-hash/trading-bot-` |
| Branch | `main` |
| Root Directory | **leer lassen** (Repository-Wurzel) |
| Config-as-code Path | `railway/scheduler.json` · `railway/provider-health.json` · `railway/consumer.json` |
| Dienst-Typ | **kein** Web-Service, keine öffentliche Domain |

Alles Übrige — Builder, Dockerfile-Pfad, Start Command, Restart Policy,
Healthcheck — steht in der jeweiligen JSON-Datei und muss nicht geklickt werden.

## Die eine Variable, die die Dienste unterscheidet

| Dienst | `WORKER_ROLE` | Repliken |
|---|---|---|
| Scheduler | `scheduler` | **1** — zwei verdoppeln nur die Last |
| Provider Health | `provider-health` | **1** |
| Consumer | `consumer` | 1..n — skalierbar |

Mehrere Consumer sind unbedenklich: Aufträge werden per
`FOR UPDATE SKIP LOCKED` vergeben, zwei Prozesse können denselben Auftrag nicht
bekommen.

`WORKER_ROLE` wird im Dockerfile bewusst **nicht** gesetzt: ein Container ohne
ausdrückliche Rolle soll sichtbar nicht starten, statt stillschweigend eine
falsche zu übernehmen.

## Variablen für alle drei Dienste

| Variable | Wert |
|---|---|
| `DATABASE_URL` | Neon **Direktverbindung** (Host **ohne** `-pooler`) |
| `SOLANA_RPC_URL` | eigener RPC-Endpunkt |
| `WORKER_ROLE` | je Dienst, siehe oben |

Optional, nur wenn die jeweilige Funktion gebraucht wird:
`DATABASE_URL_DIRECT` (für Migrationen von einem Railway-Dienst aus),
`SOLANA_RPC_FALLBACK_URL`, `LOG_LEVEL`.

Nur für einen künftigen `alerts`-Dienst: `RESEND_API_KEY`,
`ALERT_FROM_EMAIL`, `ALERT_TO_EMAIL`.

**Niemals auf Railway setzen:** `SIGNER_*` oder irgendeinen privaten Schlüssel.

`PORT` setzt Railway selbst — der Worker liest ihn und richtet den Health-Port
danach aus. Nicht von Hand setzen.

## Warum kein Web-Service

Diese drei Dienste brauchen keine öffentliche Domain. Sie sprechen mit niemandem
ausser der Datenbank und den Anbietern; die Web-Oberfläche läuft auf Vercel und
kommuniziert mit ihnen **ausschliesslich über PostgreSQL**. Eine öffentliche
Domain wäre eine Angriffsfläche ohne Gegenwert.

Der Healthcheck auf `/ready` läuft Railway-intern und braucht dafür keine
Domain.

## Migrationen

Railway führt **keine** Migrationen aus. Kein `releaseCommand` in den Configs,
und das ist Absicht: drei Dienste, die beim Start alle dieselbe Migration fahren
wollen, sind drei gleichzeitige DDL-Läufe auf derselben Datenbank.

Migrationen laufen einmal, von Hand, über die Direktverbindung:

```bash
DATABASE_URL_DIRECT=<neon-direkt> pnpm --filter @sae/db exec drizzle-kit migrate
```

Reihenfolge beim Deploy: **erst Migration, dann Worker, dann Web.** Die
Migrationen sind additiv, ein alter Prozess läuft also gegen ein neues Schema
weiter — umgekehrt nicht.
