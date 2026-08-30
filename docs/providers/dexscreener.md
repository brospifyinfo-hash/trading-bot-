# dexscreener — nicht geprüft

**Status:** Verifikation blockiert
**Grund:** Der Egress-Proxy dieser Umgebung lehnt die Verbindung zum Dokumentations-
und API-Host mit `403` ab (Organisationsrichtlinie). Kein Umgehen, keine Vermutungen.
**Datum des Versuchs:** 2026-08-30

## Kein Code

Für diesen Provider existiert **kein Adapter**. Die Provider-Schnittstelle in
`packages/providers` ist implementiert und getestet; ein Adapter wird ergänzt,
sobald die Dokumentation geprüft werden kann.

Ein Adapter auf Basis erinnerter Endpunkte wäre der genaue Fehler, den
`ARCHITECTURE.md` §13 ausschließt: er würde im Betrieb still falsche oder gar
keine Daten liefern, und das Ergebnis wäre nicht von echten Daten zu unterscheiden.

## Vor der Implementierung zu klären

Siehe Checkliste in `README.md` dieses Verzeichnisses.
