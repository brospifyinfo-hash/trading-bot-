-- Erweiterungen und Rollen.
--
-- Getrennte Lese- und Schreibrolle: die Weboberflaeche liest ausschliesslich.
-- Selbst bei einer SQL-Injection im Web-Layer laesst sich damit keine Position
-- veraendern und kein Intent anlegen.

CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sae_ro') THEN
    CREATE ROLE sae_ro LOGIN;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE sae TO sae_ro;
GRANT USAGE ON SCHEMA public TO sae_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO sae_ro;
