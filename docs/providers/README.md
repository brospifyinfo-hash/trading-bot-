# Provider-Verifikation

Regel aus `ARCHITECTURE.md` §13: **kein API-Endpunkt geht ungeprüft in Code.**
Jede Quelle bekommt hier eine Datei mit Base-URL, Version, Auth, Rate Limits,
Preis, gelieferten Feldern, historischer Tiefe und Prüfdatum.

## Stand der Prüfung

| Provider | Status | Quelle | Datum |
|---|---|---|---|
| Jupiter (Swap/Quote) | **teilweise verifiziert** | Hersteller-eigene OpenAPI-Spezifikation | 2026-08-30 |
| Helius | **nicht geprüft** — Host blockiert | — | — |
| Birdeye | **nicht geprüft** — Host blockiert | — | — |
| DexScreener | **nicht geprüft** — Host blockiert | — | — |
| RugCheck | **nicht geprüft** — Host blockiert | — | — |

## Warum nicht geprüft

Der Egress-Proxy dieser Umgebung lehnt die Verbindung zu den Dokumentations- und
API-Hosts mit `403` ab (Organisationsrichtlinie). Betroffen und protokolliert:

```
lite-api.jup.ag:443      403 (CONNECT abgelehnt)
api.dexscreener.com:443  403 (CONNECT abgelehnt)
docs.helius.dev:443      403 (CONNECT abgelehnt)
docs.birdeye.so:443      403 (CONNECT abgelehnt)
dev.jup.ag               403 (Egress-Policy)
```

Erreichbar war ausschließlich `raw.githubusercontent.com`. Darüber ließ sich die
Hersteller-eigene OpenAPI-Spezifikation von Jupiter beziehen — eine Primärquelle,
wenn auch keine vollständige.

**Konsequenz für den Code:** Es wurde kein Endpunkt geraten. Der Provider-Layer
ist vollständig gebaut und getestet, aber nur der Jupiter-Adapter ist
implementiert — und auch der nur gegen die Felder, die in der Spezifikation
stehen. Alles Weitere bleibt bewusst leer, bis die Hosts erreichbar sind.

## Wenn die Hosts erreichbar werden

Je Provider zu klären und hier einzutragen:

1. Base-URL und aktuelle API-Version
2. Auth-Schema (Header-Name, Key-Format, ob überhaupt nötig)
3. Rate Limits je Tarif — Anfragen pro Sekunde *und* pro Monat
4. Preis je Tarif
5. Gelieferte Felder, Typen und Einheiten (besonders: Dezimalstellen, String vs. Zahl)
6. Historische Tiefe — ab wann verfügbar, in welcher Auflösung
7. Verhalten bei Rate Limit: Statuscode, `Retry-After`-Header
8. Verhalten bei unbekanntem Token: leeres Ergebnis oder Fehler
