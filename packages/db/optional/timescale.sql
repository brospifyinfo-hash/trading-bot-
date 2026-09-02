-- Timescale-Erweiterung fuer die Zeitreihen-Tabellen.
--
-- Bewusst als eigene Migration: das System laeuft auch ohne TimescaleDB, dann
-- bleiben es normale Tabellen mit denselben Indizes — nur langsamer bei grossen
-- Zeitraeumen. Wer die Extension nicht hat, ueberspringt diese Datei.
--
-- Voraussetzung: CREATE EXTENSION IF NOT EXISTS timescaledb;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    -- token_snapshots ist die groesste Tabelle des Systems: ein Snapshot je
    -- beobachtetem Token je Takt, auch fuer Tokens, die nie gehandelt wurden.
    PERFORM create_hypertable('token_snapshots', 'observed_at',
                              if_not_exists => TRUE, migrate_data => TRUE);
    PERFORM create_hypertable('price_observations', 'observed_at',
                              if_not_exists => TRUE, migrate_data => TRUE);

    -- Aeltere Daten komprimieren, aber NICHT loeschen: die Historie abgelehnter
    -- Tokens ist das Forschungsmaterial, mit dem sich spaeter pruefen laesst, ob
    -- eine Ablehnung richtig war.
    ALTER TABLE token_snapshots SET (
      timescaledb.compress,
      timescaledb.compress_segmentby = 'token_id'
    );
    PERFORM add_compression_policy('token_snapshots', INTERVAL '14 days',
                                   if_not_exists => TRUE);
  END IF;
END
$$;
