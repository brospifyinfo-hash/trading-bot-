# Optionale SQL-Schritte — keine Migrationen

Was hier liegt, wird von `drizzle-kit migrate` **nicht** ausgeführt und soll es
auch nicht. Diese Dateien sind Betriebsschritte, die man von Hand anwendet,
wenn die jeweilige Voraussetzung erfüllt ist.

## Warum getrennt von `migrations/`

`timescale.sql` lag urspruenglich als `migrations/0001_timescale.sql` im
Migrationsordner, stand aber nicht im Journal (`meta/_journal.json`) — und
drizzle liest ausschliesslich das Journal. Die Datei sah also wie eine
Migration aus und war nie eine.

Sie nachtraeglich ins Journal aufzunehmen waere die schlechtere Loesung
gewesen. Drizzle wendet eine Migration genau dann an, wenn

    letzte_angewendete.created_at < migration.when

Ein Eintrag mit einem `when` zwischen `0000_init` und `0002_opportunities`
haette bedeutet:

| | Ergebnis |
|---|---|
| frische Datenbank | laeuft mit — 11 Migrationen |
| bereits migrierte Datenbank | `1788262311821 < 1788132972903` ist falsch → laeuft **nie** — 10 Migrationen |

Damit waeren frische und bestehende Datenbanken dauerhaft auseinandergelaufen,
und zwar unbemerkt. Ein Schema-Unterschied, den niemand sieht, ist schlimmer
als ein fehlendes Feature.

## `timescale.sql`

Legt `token_snapshots` und `price_observations` als TimescaleDB-Hypertables an
und richtet eine Kompressionspolitik ein.

**Voraussetzung:** die Erweiterung `timescaledb` ist installiert.

    CREATE EXTENSION IF NOT EXISTS timescaledb;

**Auf Neon nicht verfuegbar.** Neon unterstuetzt TimescaleDB nicht; dort
entfaellt dieser Schritt ersatzlos. Das System laeuft ohne ihn mit denselben
Indizes, nur langsamer bei sehr grossen Zeitraeumen — die Datei ist zusaetzlich
selbstsichernd und tut ohne die Erweiterung nichts.

Anwenden (nur bei selbst betriebenem PostgreSQL mit TimescaleDB):

    psql "$DATABASE_URL_DIRECT" -f packages/db/optional/timescale.sql

Nach den Migrationen ausfuehren, nicht davor: die Tabellen muessen existieren.
