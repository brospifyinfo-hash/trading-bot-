# rugcheck — geprüft

**Status:** Vertrag verifiziert
**Gemessen am:** 2026-09-10, gegen zwei echte Antworten
**Endpunkt:** `GET /v1/tokens/{mint}/report`

## Wie der Beleg entstand

Der Host ist aus der Entwicklungsumgebung weiterhin nicht erreichbar
(`api.rugcheck.xyz` → Egress-Proxy). Die beiden Antworten wurden im Browser
abgerufen und vollständig übergeben:

| Mint | Fall |
|---|---|
| `EPjFWdd5…TDt1v` (USDC) | etablierter Token — fast alles leer |
| `7jAxKsGd…zapump` (SIDE EYE BABY) | Memecoin — vollständig befüllt |

## Zugang

**Kein API-Schlüssel nötig** für den Report-Endpunkt — HTTP 200 ohne
Authentifizierung, in beiden Abrufen.

Die beiden Quellen widersprechen sich in der Beschreibung: Swagger nennt ein
Schema `ApiKeyAuth` (Header `Authorization`, „JWT token"), die FluxRPC-Doku
nennt `X-API-KEY`. Für den Report-Endpunkt spielt es keine Rolle — er hat
keinen `security`-Eintrag und antwortet ohne Schlüssel.

Mit Schlüssel: die Bulk-POSTs, `/lockers`, `/v1/tokens/verified`,
`/v1/tokens/verify*`, `POST …/report`, `POST …/vote`.

## Rate-Limit — die harte Grenze

Gemessene Antwort-Header: `x-rate-limit-limit: 15`,
`x-rate-limit-remaining: 14`. **Das Zeitfenster steht nirgends.**

Das ist die wichtigste Zahl für die Architektur. Der Marktdaten-Takt fragt 25
Token alle 20 Sekunden — 75 Anfragen je Minute. Selbst wenn die 15 pro Sekunde
gälten, wäre RugCheck damit im Marktdaten-Pfad falsch aufgehoben; gälten sie
pro Minute, wäre der Pfad sofort dicht.

**Folge:** RugCheck gehört in einen eigenen, langsamen Anreicherungstakt mit
Zwischenspeicher, nicht in `REFRESH_MARKET_DATA`. Sicherheitsdaten ändern sich
in Stunden, nicht in Sekunden.

## Die Felder, die zählen

| Gesucht | Wo es steht | Anmerkung |
|---|---|---|
| Top-10-Halter | **fehlt als Feld** | `topHolders[].pct` selbst summieren |
| Größter Halter | **fehlt als Feld** | `topHolders[0].pct` — Sortierung nicht zugesichert |
| LP gesperrt | `markets[].lp.lpLockedPct` | „verbrannt" kommt nicht vor; `burn` steht in keiner Antwort |
| Risiko | `score`, `score_normalised`, `risks[]`, `rugged` | Gesamteinstufung (Good/Warning/Danger) fehlt |

## Zwei Fallen

**1. `mintAuthority` gibt es zweimal.** Unter `token` als Adresse oder `null`,
auf oberster Ebene bei USDC als ganzes Konto-Objekt (`lamports`, `data`,
`space`). Wer die obere Ebene als Wahrheitswert liest, hält USDC für sicher
und den Memecoin für gefährlich — genau verkehrt herum. Das Schema liest
ausschließlich `token.*`.

**2. Ein leerer Token ist der Normalfall.** Bei USDC sind `topHolders` und
`markets` `null`, `totalHolders` ist `0`, `risks` ist leer. `totalHolders: 0`
heißt „nicht ermittelt", niemals „keine Halter".

## Der eigentliche Mehrwert

Nicht die Prozentzahl — die steht auch in der Kette. Sondern `owner` und
`knownAccounts`. Siehe DECISIONS §113: roh 95,7 %, nach Besitzern und ohne
Pool 55,7 %.
