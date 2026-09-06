#!/usr/bin/env bash
# Migrationen vorwaerts fahren.
#
# Es gibt bewusst kein Rollback: ein Rueckwaertsschritt in einer Datenbank, die
# Handelshistorie fuehrt, verliert Forschungsdaten. Ein Fehler wird durch eine
# neue Vorwaertsmigration behoben.
#
# ---------------------------------------------------------------------------
# Warum hier nicht mehr `psql -f` ueber die SQL-Dateien laeuft
#
# Genau das stand hier vorher:
#
#     for file in packages/db/migrations/*.sql; do
#       psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$file"
#     done
#
# Das wendet die Migrationen an, ohne Drizzles Journal (`__drizzle_migrations`)
# zu aktualisieren. Danach ist das Schema migriert, aber `drizzle-kit migrate`
# haelt jede Migration fuer offen und wuerde sie erneut fahren — beim naechsten
# Lauf in CI oder ueber den GitHub-Workflow. Zwei Wege, die dieselbe Datenbank
# unterschiedlich beurteilen, sind schlimmer als ein Weg, der fehlt.
#
# Dasselbe Muster wie die Timescale-Datei in Entscheidung 78: eine Datei im
# Migrationsordner, die nie im Journal stand, hat zweimal die Frage ausgeloest,
# ob das Schema vollstaendig ist.
#
# Es gibt jetzt genau einen Migrationsweg, und alle drei Aufrufer benutzen ihn:
# dieses Skript, docker/docker-compose.yml und .github/workflows/db-migrate.yml.
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."

# drizzle.config.ts liest DATABASE_URL_DIRECT zuerst und faellt auf
# DATABASE_URL zurueck. Die Pruefung hier ist nur fuer eine lesbare Meldung —
# die Konfiguration bricht sonst mit derselben Aussage ab.
if [[ -z "${DATABASE_URL_DIRECT:-}" && -z "${DATABASE_URL:-}" ]]; then
  echo "Weder DATABASE_URL_DIRECT noch DATABASE_URL gesetzt." >&2
  echo "Migrationen brauchen die direkte Verbindung (bei Neon: OHNE '-pooler')." >&2
  exit 1
fi

# Warnung statt Abbruch: lokal gibt es keinen Pooler, und wer bewusst einen
# gepoolten Endpunkt benutzt, soll es merken statt blockiert zu werden.
case "${DATABASE_URL_DIRECT:-${DATABASE_URL:-}}" in
  *-pooler*)
    echo "WARNUNG: der Endpunkt enthaelt '-pooler'." >&2
    echo "DDL ueber einen Transaction-Mode-Pooler ist nicht zuverlaessig." >&2
    ;;
esac

pnpm --filter @sae/db exec drizzle-kit migrate
echo "Migrationen abgeschlossen."
