#!/usr/bin/env bash
# Migrationen vorwaerts fahren.
#
# Es gibt bewusst kein Rollback: ein Rueckwaertsschritt in einer Datenbank, die
# Handelshistorie fuehrt, verliert Forschungsdaten. Ein Fehler wird durch eine
# neue Vorwaertsmigration behoben.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${DATABASE_URL:?DATABASE_URL muss gesetzt sein}"

for file in packages/db/migrations/*.sql; do
  echo "Migration: $(basename "$file")"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$file"
done
echo "Migrationen abgeschlossen."
