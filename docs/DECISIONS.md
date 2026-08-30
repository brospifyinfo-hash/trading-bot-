# Getroffene Entscheidungen und Abweichungen

Stand nach Phase 1. Alles hier ist revidierbar — dokumentiert, damit eine spätere
Änderung eine bewusste ist und keine stille.

---

## 1. Annahmen zu den offenen Fragen aus der Architektur

Die sechs offenen Punkte aus `ARCHITECTURE.md` §18 waren zum Zeitpunkt der
Implementierung unbeantwortet. Phase 1 hängt an keinem davon, deshalb wurde
weitergebaut — mit folgenden Annahmen, die alle konfigurierbar sind:

| # | Frage | Angenommen | Wo es sichtbar wird | Was bei Abweichung zu tun ist |
|---|---|---|---|---|
| 1 | Kapitalgröße | ~1.000 €, max. 3 % je Position, Mindestliquidität 25.000 $ | `packages/config/src/defaults.ts` | Bei deutlich mehr Kapital muss `minLiquidityUsd` steigen — sonst bindet das Exit-Kapazitäts-Gate und es kommt kein Trade zustande |
| 2 | API-Budget | ~150 $/Monat, **ohne** X/Twitter | `minSocialScore: 0` (Social geht nicht ins Gate ein) | Social-Gate erst scharfstellen, wenn die Faktoranalyse Erklärungskraft zeigt |
| 3 | Hosting | VPS + Docker Compose | `docker/docker-compose.yml` | Bei Managed-Hosting entfällt die Compose-Topologie, die Netztrennung muss anders abgebildet werden |
| 4 | Zeithorizont | Minuten bis Stunden | `watchlistRescoreIntervalSeconds: 60` | Kürzerer Horizont vervielfacht die RPC-Kosten |
| 5 | Solana-Bibliothek | **noch nicht festgelegt** | Signer-Policy arbeitet auf einer normalisierten Struktur, nicht auf Rohbytes | Entscheidung in Phase 2 nach Prüfung der aktuellen Doku; der Adapter ist der einzige betroffene Ort |
| 6 | Timescale | ja, mit Rückfallebene | `migrations/0001_timescale.sql` ist optional | Ohne Extension läuft alles weiter, nur langsamer |

**Zur Zahl 25.000 $:** Sie ist eine Ableitung, keine Messung. Bei 3 % von 1.000 €
sind das ~30 € Position; der geforderte Kapazitätsfaktor 3 bei 2 % Impact-Grenze
ist damit mit großem Abstand erfüllt. Die Schwelle schützt also nicht vor
Illiquidität für *diese* Größe, sondern schließt Token aus, die zu jung oder zu
dünn sind, um überhaupt verlässliche Daten zu liefern.

---

## 2. Abweichungen vom Phase-1-Plan

### Kein Turborepo
**Geplant:** `turbo.json` mit Task-Graph und Caching.
**Umgesetzt:** `pnpm -r`-Skripte.
**Grund:** Bei sieben Paketen ist der Task-Graph trivial; Turborepo bringt eine
zusätzliche Plattform-Binary in CI und Docker mit. Nachrüsten ist jederzeit
möglich, ohne die Struktur anzufassen.

### Keine `.js`-Endungen in Importen
**Geplant:** implizit ESM-Stil mit Endungen.
**Umgesetzt:** extensionslose relative Importe (`moduleResolution: "bundler"`).
**Grund:** `drizzle-kit` lädt die Schemadateien über CJS und scheitert an
`./identity.js`. Da die Apps ohnehin mit esbuild gebündelt werden
(Internal-Packages-Muster), ist das kein Nachteil — es bedeutet aber, dass die
Worker **nicht** direkt mit `node src/worker.ts` startbar sind, sondern über den
Build-Schritt gehen müssen. Steht so in `Dockerfile.worker`.

### Ein PitReader statt zwei
**Geplant:** getrennte `live-reader.ts` und `backtest-reader.ts`.
**Umgesetzt:** eine Implementierung `PostgresPitReader`, die immer hart auf
`observed_at <= asOf` filtert; `LivePitReader` ist nur eine dünne Hülle, die
`asOf` an die Uhr bindet.
**Grund:** Zwei Implementierungen wären eine Einladung, im Backtest-Pfad „kurz
mal" den Filter wegzulassen. So steht der Filter an genau einer Stelle, und ein
Test hält fest, dass beide Wege dasselbe Ergebnis liefern.

### Tests gegen PGlite statt Testcontainers
**Geplant:** Integrationstests via Testcontainers.
**Umgesetzt:** `@electric-sql/pglite` — echtes Postgres nach WebAssembly
kompiliert, eingebettet.
**Grund:** Kein Docker-Daemon in der Bauumgebung; zusätzlich läuft es in CI ohne
Service-Container und in rund zwei Sekunden. Es ist **kein Mock**: Vergleichs-,
Sortier- und NULL-Semantik sowie partielle Unique-Indizes verhalten sich wie in
Produktion. Grenzen: keine Timescale-Erweiterung, keine echte Nebenläufigkeit.
Beides wird in Phase 11 gegen einen echten Server nachgeprüft.

### Signer signiert noch nicht
**Umgesetzt:** Transport (mTLS) und Policy vollständig inklusive Tests; das
eigentliche Signieren antwortet mit `501`.
**Grund:** Die Bibliotheksentscheidung (offener Punkt 5) steht aus. Eine halb
implementierte Signierlogik, die niemand geprüft hat, ist gefährlicher als eine
offensichtlich fehlende. Die Policy ist der sicherheitsrelevante Teil und ist
fertig.

---

## 3. Zwei Funde aus der Implementierung

### Preis-Impact wurde bei kleinen Orders massiv überschätzt
Die naheliegende Berechnung — hypothetische Ausgabemenge minus tatsächliche,
geteilt durch die hypothetische — ist bei kleinen Beträgen relativ zur Pool-Tiefe
unbrauchbar: dort dominiert der Abrundungsfehler der Ganzzahlarithmetik. Gemeldet
wurden 10 bp, wo real etwa 0,01 bp anlagen. Da der Impact direkt in das
Kosten-Gate eingeht, hätte das reihenweise handelbare Token abgelehnt.

Behoben durch die geschlossene Form `impact = dx / (x + dx)`. Nebeneffekt: sie ist
exakt invers zu `maxAmountWithinImpact`, womit Exit-Gate und Kostenmodell
zwangsläufig konsistent bleiben. Test: `price-impact.test.ts`.

### Chain-Kosten sind bei kleinen Positionen Rundungsrauschen
Bei 100 € Volumen liegen Netzwerk- und Priority-Fee zusammen unter einem Cent —
die Ausfallrate ist in der Fiat-Summe nicht sichtbar. Sichtbar wird sie erst,
sobald ein Jito-Tip gesetzt ist; dann kostet jede fehlgeschlagene Transaktion
echtes Geld.

Praktische Folge: bei dieser Positionsgröße bestimmen **Price Impact und
Latenzdrift** die Kosten, nicht die Gebühren. Die Kalibrierung in Phase 9 muss
sich entsprechend auf die Drift konzentrieren — der mit Abstand unsicherste
Parameter des Modells. Festgehalten in `cost-model.test.ts`.

### Die erste Netztopologie hätte jeden Provider-Aufruf blockiert
Der erste Entwurf der `docker-compose.yml` hatte ein einziges `backend`-Netz mit
`internal: true`, an dem Datenbank, Redis **und** die Worker hingen. Das isoliert
zwar die Datenschicht — nimmt aber genau den Prozessen die Internetverbindung,
die RPC, Jupiter, Birdeye und Resend aufrufen müssen. Aufgefallen beim Prüfen der
aufgelösten Compose-Konfiguration, nicht beim Schreiben.

Korrigiert durch vier Netze statt zwei: `data` (intern, Postgres/Redis/Worker),
`egress` (nur Worker, ausgehend), `signing` (intern, Signer und
execution-Worker), `public` (nur Web). Ergebnis: Postgres, Redis und Signer haben
keine Route nach draußen, die Worker schon, und der Signer ist einzig vom
execution-Worker erreichbar. Ein kompromittierter Datenbankcontainer kann nichts
exfiltrieren.

**Merksatz daraus:** `internal: true` schützt nur, wenn ein Container in *keinem*
weiteren Netz hängt. Die Zuordnung ist deshalb je Dienst zu prüfen, nicht je Netz —
und zwar an der aufgelösten Konfiguration (`docker compose config`), nicht an der
geschriebenen Datei.

---

## 4. Was ausdrücklich noch nicht existiert

Keine Provider-Anbindung, kein Discovery, kein Scoring, keine Ausführung, kein
Backtest, keine Alerts, keine Authentifizierung. Das Dashboard zeigt leere Panels
statt Beispieldaten — bewusst: eine Oberfläche, die erfundene Zahlen zeigt,
gewöhnt einen daran, ihnen zu glauben.

Die Zahlen in `defaults.ts` sind plausible Ausgangswerte, **keine validierten
Parameter**. Sie sind nicht getestet, nicht optimiert und nicht als profitabel
behauptet.


---

# Phase 2 — Provider-Layer

## 5. Die Verifikation war zur Hälfte blockiert

Der Egress-Proxy dieser Umgebung lehnt die Verbindung zu den Provider-Hosts mit
`403` ab (Organisationsrichtlinie, kein Netzwerkfehler). Protokolliert sind
`lite-api.jup.ag`, `api.dexscreener.com`, `docs.helius.dev`, `docs.birdeye.so`
und `dev.jup.ag`. Erreichbar war ausschließlich `raw.githubusercontent.com`.

**Konsequenz:** Es wurde kein Endpunkt geraten. Der Provider-Layer ist
vollständig gebaut und getestet; implementiert ist genau **ein** Adapter —
Jupiter, gegen die Hersteller-eigene OpenAPI-Spezifikation. Für Helius, Birdeye,
DexScreener und RugCheck existiert bewusst kein Code, sondern je eine Datei in
`docs/providers/`, die den blockierten Host und die offenen Fragen festhält.

Ein Adapter auf Basis erinnerter Endpunkte wäre genau der Fehler, den
`ARCHITECTURE.md` §13 ausschließt: er liefert im Betrieb still falsche oder keine
Daten, und das Ergebnis ist von echten Daten nicht zu unterscheiden.

## 6. Der Jupiter-Befund, der die Signer-Policy betrifft

Die Spezifikation sagt zu `otherAmountThreshold` — der Mindestausgabemenge im
Quote — ausdrücklich: *„Not used by `/swap` endpoint to build transaction."*

Die im Quote genannte Untergrenze ist also **nicht** die, die on-chain
durchgesetzt wird. Für die Signer-Policy heißt das: die Prüfung
`minOut != null && minOut > 0` darf ihren Wert nicht aus dem Quote nehmen,
sondern muss ihn aus der dekodierten Transaktion lesen.

Dass `SignerPolicy` bereits auf einer normalisierten `DecodedTransaction`
arbeitet statt auf dem Quote-Objekt, war ursprünglich eine Testbarkeitsfrage —
es stellt sich als die inhaltlich richtige Trennung heraus. Der Dekodier-Adapter
in Phase 12 muss den Wert aus der Instruktion ziehen, nicht durchreichen.

Zweiter Punkt: Quote-Threshold und tatsächliche Untergrenze können auseinander
laufen, besonders bei `dynamicSlippage`. Die Differenz ist beim Kalibrieren zu
**messen**, nicht anzunehmen.

## 7. Ein Fund aus der Implementierung

### Der Budget-Wächter hätte sich selbst dauerhaft verklemmt

`ProviderBudget.exhausted` prüfte den Monatswechsel nicht — das tat nur
`chargeRequest()`. Ein aufgebrauchtes Budget hätte damit jede Anfrage blockiert,
und nur eine Anfrage hätte den Monatswechsel bemerkt. Der Provider wäre ab dem
ersten erschöpften Monat **dauerhaft still abgeschaltet** geblieben, ohne
Fehlermeldung, ohne Log — nur mit `MISSING(BUDGET_EXCEEDED)` bis in alle
Ewigkeit.

Gefunden durch den Test, der den Monatswechsel prüft. Behoben, plus ein
Regressionstest, der nur liest und nichts bucht.

**Muster dahinter:** Ein Zustand, der sich nur beim Schreiben aktualisiert, aber
das Schreiben selbst verhindert, ist eine Verklemmung. Lohnt sich, im
Circuit-Breaker- und Rate-Limiter-Code gegenzuprüfen — dort läuft die
Aktualisierung jeweils im Getter, nicht nur beim Verbrauch.

## 8. Wie der Layer Datenehrlichkeit durchsetzt

Drei Dinge passieren ausschließlich im `ProviderHttpClient`, und es gibt bewusst
keinen zweiten Weg an ihnen vorbei:

1. **Jede Antwort wird gegen ein Zod-Schema validiert.** Weicht sie ab, ist das
   Ergebnis `MISSING(PARSE_FAILED)` und der Provider gilt als ausgefallen — nicht
   ein halb geparstes Objekt mit `undefined`-Feldern, das weiter oben zu
   Defaultwerten wird. Ein Anbieter, der sein Format ändert, fällt sofort auf.
2. **Jeder Erfolg wird zur `Observation`** mit Quelle und Zeitstempel der
   *Antwort*, nicht der Anfrage.
3. **Rate Limit, Circuit Breaker, Budget und Health werden gemeinsam geführt.**

Dazu eine Unterscheidung, die im Betrieb zählt: HTTP 404 wird als
`NO_DATA_FOR_TOKEN` gewertet, nicht als Anbieterausfall. Ein unbekannter Token
ist kein Fehler des Providers und darf seinen Circuit Breaker nicht in dieselbe
Richtung treiben wie ein echter Ausfall — sonst schaltet eine Discovery-Welle
mit vielen unbekannten Tokens den Anbieter ab.

## 9. Was die Vertragstests belegen — und was nicht

Die Fixtures sind aus der OpenAPI-Spezifikation **abgeleitet**, nicht aus echten
Antworten aufgezeichnet: der API-Host war nicht erreichbar. Sie belegen, dass der
Adapter die *spezifizierte* Form korrekt verarbeitet — **nicht**, dass der
Anbieter sich daran hält.

Diese Lücke schließt die Laufzeitvalidierung, nicht ein weiterer Test. Sobald der
Host erreichbar ist, wird eine echte Antwort aufgezeichnet und als zusätzliches
Fixture ergänzt.
