#!/usr/bin/env bash
#
# Migrationen anwenden und das Ergebnis pruefen — in einem Schritt.
#
# Aufruf:
#   DATABASE_URL_DIRECT='<direkter Neon-Endpunkt>' ./scripts/db-deploy.sh
#
# Der Verbindungsstring wird NIE ausgegeben: nicht in der Ausgabe, nicht im
# Fehlerfall, nicht in `set -x`. Deshalb steht hier kein `set -x` und jede
# Fehlermeldung der Werkzeuge wird gefiltert, bevor sie auf den Bildschirm
# kommt — eine Postgres-Fehlermeldung enthaelt die Zeichenfolge samt Passwort.
#
# Verwendet ausdruecklich die DIREKTE Verbindung (Neon-Host OHNE "-pooler"):
# ein Pooler im Transaction Mode traegt kein zuverlaessiges DDL.

set -euo pipefail

if [[ -z "${DATABASE_URL_DIRECT:-}" ]]; then
  echo "DATABASE_URL_DIRECT ist nicht gesetzt." >&2
  echo "Aufruf: DATABASE_URL_DIRECT='<neon-direkt>' ./scripts/db-deploy.sh" >&2
  exit 2
fi

# Sichtpruefung ohne Preisgabe: nur die Form, nie der Inhalt.
if [[ "$DATABASE_URL_DIRECT" == *"-pooler"* ]]; then
  echo "WARNUNG: Der Endpunkt enthaelt '-pooler'." >&2
  echo "Migrationen gehoeren auf die DIREKTE Verbindung (Host ohne '-pooler')." >&2
  echo "Abbruch — lieber nichts tun als DDL ueber einen Transaction-Mode-Pooler." >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Jede Ausgabe der Werkzeuge laeuft durch diesen Filter. Er ersetzt die
# Verbindungszeichenfolge und ihr Passwort, falls sie doch einmal auftauchen.
scrub() {
  local pw="${DATABASE_URL_DIRECT#*://*:}"; pw="${pw%%@*}"
  sed -e "s|${DATABASE_URL_DIRECT//|/\\|}|<DATABASE_URL_DIRECT>|g" \
      -e "s|${pw//|/\\|}|<REDACTED>|g"
}

echo "== 1/2  Migrationen anwenden =="
( cd "$ROOT/packages/db" && pnpm exec drizzle-kit migrate 2>&1 ) | scrub

echo
echo "== 2/2  Ergebnis pruefen =="
# Der Smoke-Test liest nur; --write waere hier unnoetiges Risiko auf einer
# produktiven Datenbank.
DATABASE_URL="$DATABASE_URL_DIRECT" \
  pnpm --filter @sae/worker exec tsx src/smoke/infrastructure.ts 2>&1 | scrub
