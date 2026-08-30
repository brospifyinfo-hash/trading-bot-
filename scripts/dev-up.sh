#!/usr/bin/env bash
# Lokale Entwicklungsumgebung.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "Keine .env vorhanden. Kopiere .env.example nach .env und trage Werte ein." >&2
  exit 1
fi

docker compose -f docker/docker-compose.yml up -d postgres redis
echo "Warte auf Postgres..."
until docker compose -f docker/docker-compose.yml exec -T postgres pg_isready -U sae >/dev/null 2>&1; do
  sleep 1
done

pnpm install
./scripts/migrate.sh
echo "Bereit. Web starten mit: pnpm --filter @sae/web dev"
