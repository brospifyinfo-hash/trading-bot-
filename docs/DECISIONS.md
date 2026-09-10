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
| 6 | Timescale | ja, mit Rückfallebene | `optional/timescale.sql`, keine Migration | Ohne Extension läuft alles weiter, nur langsamer |

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


---

# Phasen 8 & 11 — Scoring, Risk, Entscheidung

## 10. „Nicht berechenbar" ist kein mittlerer Score

Ein Teilscore, dessen Eingaben fehlen, liefert `NOT_COMPUTABLE` — nicht 50. Ein
neutraler Ersatzwert wäre die bequemste Art, fehlende Daten unbemerkt in eine
Entscheidung einfließen zu lassen: der Endscore sähe unauffällig aus, obwohl die
Hälfte der Grundlage fehlt.

Der Endscore wird deshalb auf das **tatsächlich abgedeckte Gewicht** normiert,
und die Abdeckung ist selbst ein Hard Gate (`MIN_WEIGHT_COVERAGE = 0.6`). Unter
dieser Schwelle gibt es gar keinen Endscore — `null`, nicht eine niedrige Zahl.
Eine Zahl ohne Aussage ist gefährlicher als keine Zahl.

## 11. Der Bootstrap-Widerspruch beim Erwartungswert

`EV = p(win) · E[R|win] − (1−p) · E[|R||loss] − Kosten` braucht eine eigene
realisierte Verteilung. Ohne Trades gibt es keine Verteilung, ohne Verteilung
keine Schätzung — und ohne Schätzung dürfte nicht gehandelt werden. Das ist ein
Zirkelschluss, kein Detail.

Aufgelöst über den Modus, nicht über einen Kompromisswert:

| Modus | `EV = UNKNOWN` | Begründung |
|---|---|---|
| Paper | **zulässig**, wird als Grund protokolliert | Genau hier wird die Stichprobe erzeugt |
| Live | **Ablehnung** (`EV_UNKNOWN_INSUFFICIENT_HISTORY`) | Echtes Geld wird nicht auf eine unbekannte Größe gesetzt |

Das ist zugleich die technische Umsetzung des Calibration Gate: Live-Trading ist
nicht nur durch einen Schalter gesperrt, sondern durch das Fehlen der Daten,
ohne die die Entscheidung gar nicht getroffen werden kann.

## 12. Entschieden wird auf der Untergrenze, nicht auf der Punktschätzung

Bei 12 Trades und 75 % Trefferquote ist die Punktschätzung schmeichelhaft und
statistisch bedeutungslos. Die Engine benutzt deshalb die untere Grenze des
95-%-**Wilson-Intervalls** auf die Trefferquote und setzt sie in dieselbe
EV-Formel ein.

Praktische Folge: bei drei von drei Gewinnern liefert der naive Anteil 100 % und
Wilson unter 50 %. Der Unterschied ist genau der Betrag, um den ein
optimistischer Backtest danebenliegt.

Die Konfidenz ergibt sich aus der **Breite** des Intervalls, nicht aus seiner
Lage: eine enge Schätzung ist vertrauenswürdiger als eine breite, unabhängig
davon, wie günstig sie ausfällt. Sie skaliert die Positionsgröße (Faktor 0,25 bis
1,0) — sie verkleinert also, statt heimlich zu blockieren. Ob überhaupt gehandelt
wird, entscheiden die Hard Gates, sichtbar und mit Begründung.

## 13. Ein Kalibrierungsbefund aus dem Test, kein Bug

Der ursprüngliche Test-Fixture war als „guter Token" gedacht: saubere Security,
120.000 $ Liquidität, Volumenbeschleunigung 2,4×, 900 Holder, drei qualifizierte
Käufer. Er erreicht **73** — und fällt damit unter die Standardschwelle von 75.

Erste Reaktion wäre gewesen, die Schwelle zu senken. Das wäre der Anfang von
Parameteranpassung an ein Wunschergebnis. Stattdessen: der Befund ist
festgehalten (`solidButNotEnoughFeatures`, eigener Test) und der Fixture zu einem
tatsächlich starken Token gemacht.

Was der Befund zeigt: mit den Standardgewichten reicht „überall solide" nicht für
einen Einstieg. Drei qualifizierte Käufer ergeben im Smart-Money-Teilscore 38 von
100, und bei 12 % Gewicht zieht das den Endscore unter die Schwelle. Das ist die
beabsichtigte Konservativität — und es ist gut, dass sie messbar ist, statt
behauptet.

**Die Gewichte in `WEIGHTS` sind begründete Ausgangswerte, keine validierten
Parameter.** Sie stammen aus Überlegung, nicht aus Daten. Genau dafür gibt es das
Research-Dashboard: es soll zeigen, welche Faktoren tatsächlich Erwartungswert
erzeugen, und die Gewichte danach korrigieren — nicht umgekehrt.

## 14. Positionsgröße: das Minimum, nie ein Mittelwert

Vier unabhängige Obergrenzen — Risikobudget, Liquidität, Portfolio-Deckel,
EV-Konfidenz. Es gilt die kleinste. Jede beschreibt eine andere Art, sich zu
ruinieren, und keine lässt sich durch die anderen ausgleichen.

Der Property-Test hält fest, dass das Ergebnis nie eine der vier überschreitet.
Bei Memecoins bindet fast immer die Liquidität — genau die Grenze, die die
meisten Bots nicht kennen.

## 15. Circuit Breaker: die Asymmetrie ist Absicht

Breaker blockieren **Einstiege** härter als **Ausstiege**. Genau zwei dürfen alles
anhalten: `EMERGENCY_STOP` (manuell) und `RECONCILIATION_DRIFT` (interner und
tatsächlicher Bestand laufen auseinander — dann ist auch ein Verkauf ein Schuss
ins Dunkle). Alle anderen, Tagesverlust eingeschlossen, lassen die
Positionsverwaltung weiterlaufen.

Der Grund: ein System, das wegen eines Provider-Ausfalls seine laufenden
Positionen nicht mehr schließen kann, hat das Risiko vergrößert statt
verkleinert. Ein eigener Test hält die Liste der `ALL_TRADING`-Breaker fest,
damit sie nicht versehentlich wächst.

Zweite Regel: der Zustand liegt in der Datenbank. Ein gespeicherter Lockout gilt
bis zum Ablauf seiner Abkühlzeit — auch wenn die auslösende Bedingung gerade
nicht mehr zutrifft. Sonst genügt ein kurz erholtes Portfolio, um sofort
weiterzuhandeln.


---

# Phasen 9 & 10 — Paper-Ausführung, Positionsverwaltung, Statistik

## 16. Die Drift geht immer zulasten des Trades

Zwischen Quote und Fill vergehen Sekunden. Wer annimmt, dass die Preisbewegung in
dieser Zeit „mal so, mal so" ausfällt und sich im Mittel aufhebt, mittelt einen
Vorteil ein, den es im Live-Betrieb nicht gibt: die Trades, bei denen der Preis
günstig läuft, werden häufiger gefüllt, und die ungünstigen scheitern an der
Slippage-Grenze — mit Gebühren, aber ohne Gegenwert.

Der `PaperExecutor` verwendet deshalb `Math.max(0, drift)`: eine günstige Drift
wird als 0 gewertet, eine ungünstige voll angesetzt. Ein Test hält das fest.

Zweiter Punkt: Zufallsquellen sind **injiziert**, nicht `Math.random`. Ein
Backtest, der bei jedem Lauf etwas anderes ergibt, ist keine Messung.

## 17. Keine Teilausführung, sondern Fehlschlag

Auf Solana-AMMs gibt es keine Teilausführung im Orderbuchsinn — eine
Swap-Transaktion geht ganz durch oder revertiert. Modelliert wird deshalb der
reale Mechanismus: Fehlschlag bei überschrittener Slippage, mit anfallenden
Gebühren und ohne Gegenwert. Dazu ein davon unabhängiger Fehlschlag (abgelaufener
Blockhash, Programmfehler) mit derselben Rate, die auch im Kostenmodell steht.

Ein Abbruch **vor** dem Senden verursacht dagegen keine Kosten — dort wären sie
eine Erfindung. Auch das ist ein eigener Test.

## 18. Rangfolge in der Positionsverwaltung

Vier Ebenen, in dieser Reihenfolge:

1. **Sofortausstieg aus Risikogründen** — schlägt alles andere
2. **Stop Loss**
3. **Trailing Stop**, mit den Anpassungen der dynamischen Regeln
4. **Take-Profit-Stufen**

Der Stop steht bewusst **vor** den TP-Stufen: fällt der Kurs in einem Tick unter
den Stop und überschreitet gleichzeitig eine TP-Schwelle, ist der Verlustschutz
das Dringendere. Bei Memecoins ist das kein Randfall.

Umgekehrt lösen bei einem Sprung **mehrere TP-Stufen gemeinsam** aus. Wer nur die
nächste nimmt, lässt die übersprungenen liegen und verkauft sie später zu
schlechteren Kursen.

Zwei weitere Regeln: bei mehreren Verengungsvorschlägen für den Trailing Stop
gewinnt der **engste**, und **gelockert wird nie**, solange irgendeine Regel
verengen will. Im Zweifel schützen, nicht hoffen.

## 19. Risiko-Stops sind Ereignisse, keine Kursbewegungen

Ein Liquiditätsabzug, ein verkaufender Entwickler, ein verschlechterter
Sicherheitsstatus — das sind Gründe zum Ausstieg, unabhängig davon, ob die
Position im Plus steht. Getestet mit einer Position bei +200 %.

Ausnahme mit Absicht: aussteigendes Smart Money zieht nur den Trailing Stop eng,
statt sofort zu verkaufen. Es ist ein Signal, keine Notlage — ein weiterlaufender
Kurs soll noch mitgenommen werden.

## 20. Ein Fund beim Notausstieg

Der erste Entwurf prüfte bei zu vielen Tranchen nur noch, ob die **ganze**
Position zum höheren Impact auf einmal herausgeht. Fiel auch das durch, war das
Ergebnis `NO_VIABLE_EXIT` — obwohl **größere Tranchen** zum höheren Impact
funktioniert hätten.

Aufgefallen beim Nachrechnen der Testzahlen (die zunächst falsch waren, nicht der
Code). Ergänzt: bei zu vielen Tranchen wird erst der Komplettverkauf zum
Maximal-Impact geprüft, dann Tranchen zum Maximal-Impact, und erst danach
aufgegeben.

**Warum das zählt:** jede zusätzliche Transaktion ist im Notfall selbst ein
Risiko, weil der Kurs zwischen ihnen weiterläuft. Die Reihenfolge — wenige große
Tranchen vor vielen kleinen — ist deshalb nicht beliebig.

`NO_VIABLE_EXIT` bleibt eine **Feststellung, keine Handlungsanweisung**: hier muss
ein Mensch entscheiden.

## 21. Die Statistik verweigert Urteile

Drei Vorkehrungen in `packages/analytics`, jede mit einem eigenen Test:

| Fall | Verhalten | Warum |
|---|---|---|
| Keine Trades | `winRate = null` | Null Trades ergeben keine Trefferquote — nicht 0 %, nicht 50 % |
| Keine Verluste | `profitFactor = null` | Bei einer Stichprobe ohne einen einzigen Verlust ist die Stichprobe das Problem, nicht die Strategie |
| Unter 100 Trades | `sufficientSample = false` | Eine Win Rate aus neun Trades ist Rauschen, und die Zahl allein sieht nicht danach aus |

In der Faktorforschung zusätzlich: ein Bucket unter der Mindestgröße bekommt
**kein Urteil**, auch wenn er gut aussieht. Und ein Unterschied, dessen
Wilson-Intervalle sich überschneiden, gilt als **nicht beobachtet** — egal wie
verlockend die Punktschätzung ist.

`splitByThreshold` schließt Trades **ohne** Merkmalswert aus beiden Buckets aus.
Sie einer Seite zuzuschlagen wäre genau die stille Verzerrung, die eine
Faktoranalyse wertlos macht.

Und die Formulierung der Ergebnisse ist Absicht: „Unterschied beobachtet — kein
Kausalitätsnachweis und keine Zusage für die Zukunft."

## 22. Exit-Regeln einzeln schaltbar — und warum

Acht Regeln, jede mit eigener ID, einzeln aktivierbar. Nicht aus Bequemlichkeit:
ein Regelsatz, den man nur als Ganzes an- und ausschalten kann, ist nicht
auswertbar. Man weiß am Ende nicht, welche Regel geholfen und welche geschadet
hat — und optimiert dann das Ganze auf ein Ergebnis, das eine einzelne Regel
verursacht hat.


---

# Phase 11 — Backtest

## 23. Der No-Look-Ahead-Test ist eine Falle, keine Prüfung

Der Harness ruft seine Datenquellen ausschließlich mit der aktuellen
Simulationszeit auf. Der Test dazu prüft nicht einen Rückgabewert, sondern
installiert eine Quelle, die **wirft**, sobald ein Zeitpunkt jenseits der
Simulationszeit angefragt wird.

Der Unterschied ist wichtig: eine Prüfung auf Rückgabewerte übersieht, wenn der
Harness in die Zukunft greift und das Ergebnis zufällig gleich aussieht. Eine
Falle lässt den Lauf abstürzen, statt ein schönes Ergebnis zu liefern.

Zusätzlich prüft ein Test, dass die angefragten Zeitpunkte lückenlos und
sprungfrei in Schrittweiten fortschreiten.

## 24. Der Erwartungswert kennt nur die eigene Vergangenheit

Innerhalb eines Backtest-Laufs wird die EV-Schätzung aus den **bis dahin
geschlossenen** Trades gebildet, nicht aus dem Gesamtergebnis. Das ist eine
eigene Form von Look-Ahead, die leicht zu übersehen ist: man rechnet den
Erwartungswert am Ende aus und wendet ihn rückwirkend auf alle Entscheidungen an.

Praktische Folge: mit der Standard-Mindeststichprobe von 100 Trades bleibt
`EV = UNKNOWN` über kurze Läufe hinweg — und wird im Paper-Modus akzeptiert. Genau
so ist der Bootstrap gedacht.

## 25. Der Fund: kostenlose Ausstiege

Der erste Entwurf des Harness ließ Positionen über `evaluatePosition` schließen
und verbuchte dabei **nur die Einstiegskosten**. Die Ausstiege liefen nicht über
den Executor und waren damit gratis.

Das ist die stillste Art, einen Backtest zu beschönigen: in der Statistik stehen
ja Kosten — nur eben die halben. Niemandem fällt eine fehlende Zahl auf, die
nirgends steht.

Gemessene Wirkung auf dem Test-Fixture:

| | vorher | nachher |
|---|---|---|
| Kosten | 1,47 € | **3,01 €** |
| Netto-PnL | −11,89 € | **−13,40 €** |
| Max Drawdown | 13,10 € | 13,90 € |

Behoben: jeder Teilverkauf wird mit demselben Kostenmodell belastet wie der
Einstieg. Regressionstest vergleicht die Durchschnittskosten je Trade mit und
ohne Take-Profit-Stufen — mehr Teilverkäufe müssen teurer sein.

**Muster dahinter:** ein Kostenposten, der an einer Stelle korrekt gebucht und an
einer anderen vergessen wird, ist schwerer zu finden als einer, der ganz fehlt.
Beim nächsten Pfad, der Kapital bewegt (Live-Execution, Reconciliation), gezielt
danach suchen.

## 26. Reihenfolge im Simulationsschritt

Erst offene Positionen verwalten, dann neue Einstiege suchen. Umgekehrt würde
jede bestehende Position mit einem Schritt Verzögerung verwaltet — und genau in
dieser Verzögerung passieren die Verluste. Ein eigener Test hält die Reihenfolge
fest.

## 27. Walk-Forward: lieber ein Fehler als ein gekürztes Fenster

Reicht der Zeitraum nicht für ein vollständiges Fenster, wirft der Aufbau —
statt ein verkürztes Out-of-Sample-Fenster zu erzeugen. Ein gekürztes Fenster
sähe wie ein gültiges Ergebnis aus, wäre aber auf weniger Daten gestützt, als die
Berichtszeile behauptet.

Ebenso: `stepDays`, `trainingDays` und die übrigen müssen positive ganze Zahlen
sein; ein negativer Schritt würde eine Endlosschleife erzeugen.

## 28. Determinismus per Konstruktion

`Math.random` kommt im Backtest nicht vor. Der Zufall stammt aus einem
gesäten mulberry32-Generator, die Preisdrift aus einer halbnormalen Ziehung
darüber. Zwei Läufe mit gleichem Startwert liefern bit-identische Ergebnisse —
ein Test hält das fest, ein zweiter, dass ein anderer Startwert etwas anderes
ergibt.

Ohne das lässt sich nicht sagen, ob eine Verbesserung von der Änderung kommt oder
vom Würfel.

**Die Skalierung der Drift ist die unsicherste Annahme des gesamten Modells.**
Sie ist ein Parameter, kein Messwert, und wird erst durch den Vergleich mit
realen Ausführungen zu einem.


---

# Phasen 3 & 13 — Discovery und Manual-Mode-Sicherheit

## 29. Das Vorsieb ist ein Kostenmodell, keine Bewertung

Rund neun von zehn entdeckten Tokens fallen im billigen Vorsieb heraus — mit
Daten, die die Discovery-Quelle ohnehin mitliefert oder die ein einziger
RPC-Aufruf ergibt. Erst der Rest geht in die teure Anreicherung.

Deshalb ist das Sieb **absichtlich grob**: die Liquiditätsschwelle liegt bei der
*Hälfte* des eigentlichen Gates, weil Liquidität zunehmen kann. Wer hier fein
filtert, verliert Kandidaten, bevor die eigentliche Analyse sie je gesehen hat —
und merkt es nie, weil sie im Rejection-Log unter einem groben Grund
verschwinden.

## 30. Endgültig ausgeschlossen ist etwas anderes als gerade nicht geeignet

| Grund | terminal? | Warum |
|---|---|---|
| Mint-/Freeze-Authority aktiv | ja | Ändert sich in aller Regel nicht |
| Bereits als Betrug bekannt | ja | Ergebnis früherer Läufe |
| Liquidität zu dünn | **nein** | Momentaufnahme, kann in fünf Minuten anders sein |
| Token zu jung | **nein** | Wird von allein älter |
| Market Cap zu hoch | **nein** | Kann fallen |

Nur die nicht-terminalen Fälle bleiben in Beobachtung — und genau die sind später
die **Kontrollgruppe**. Ohne sie beruht jede Faktoranalyse ausschließlich auf dem,
was tatsächlich gehandelt wurde.

## 31. Eine ausgefallene Quelle wird benannt, nicht verschwiegen

Der Discovery-Durchlauf ist tolerant gegenüber ausgefallenen Quellen — aber
**nicht** gegenüber stillem Datenverlust. Jede Quelle, die nichts geliefert hat,
steht mit ihrem Grund im Ergebnis.

Ohne das sieht ein Lauf mit halber Abdeckung aus wie ein ruhiger Markt. Das ist
derselbe Fehlertyp wie ein Defaultwert für fehlende Daten, nur eine Ebene höher.

Nebenbei: die Autoritätsprüfung läuft nur für **neue** Mints. Sie kostet je Mint
einen RPC-Aufruf; sie für längst bekannte Tokens zu wiederholen wäre reine
Budgetverschwendung. Ein Test hält das fest.

## 32. Der Einmal-Token identifiziert, er autorisiert nicht

Der wichtigste Satz zum `INVEST NOW`-Button. Konkret umgesetzt in drei
Eigenschaften:

1. **Gespeichert wird nur der SHA-256-Hash.** Der Klartext existiert nur in der
   E-Mail. Wer die Datenbank liest, kann keinen Trade auslösen.
2. **`session` ist ein Pflichtparameter** der Prüffunktion und wird als erstes
   geprüft. Die Signatur macht es unmöglich, den Token allein als Berechtigung zu
   behandeln — das wäre genau der Fehler, gegen den das Verfahren gebaut ist.
   Ein Test prüft, dass ein *gültiger* Token ohne Session abgelehnt wird.
3. **Einmalig und kurzlebig** (15 Minuten). Ein zweiter Klick läuft ins Leere,
   ein alter Link aus dem Postfach ebenso.

Die Reihenfolge der Prüfungen ist dabei selbst eine Entscheidung: Session zuerst,
damit die Antwort nichts darüber verrät, ob der Token überhaupt existiert.

## 33. Die Revalidierung zeigt einen Diff, keine Momentaufnahme

Zwischen Alert und Klick vergehen Minuten. Bei Memecoins ist das eine Ewigkeit.

Der Nutzer sieht deshalb nicht „so sieht es jetzt aus", sondern „das hat sich
geändert, seit du die Mail bekamst" — Preis, Liquidität, Score und Risikostufe
jeweils mit beiden Werten und der Veränderung. Jede blockierende Änderung ist als
solche markiert.

Eine Verschlechterung der **Sicherheitsbewertung blockiert immer**, unabhängig von
jeder Schwelle: sie bedeutet, dass die Grundlage des Alerts nicht mehr gilt.

## 34. Drei unabhängige Prüfungen, nicht eine

| Zeitpunkt | Was geprüft wird |
|---|---|
| Alert | Vollständige Entscheidungskette, Hard Gates, EV |
| Bestätigungsseite | Alles neu erhoben, gegen den Alert-Stand gestellt |
| Execution-Worker | Revalidierung jünger als 60 Sekunden und passend zum Intent |

Zwischen jeder vergehen Sekunden — und in Sekunden passiert bei Memecoins genug.
Die Revalidierung bekommt deshalb eine eigene, kurzlebige Kennung, die der Worker
gegenprüft; eine abgelaufene oder fremde Kennung wird abgelehnt.


---

# Phase 12/17 — Sicherheitsnetz für den Kapitalpfad

## 35. Der Fund: die Validierung kannte nur den Kauf

Die Pre-Trade-Validierung war implizit auf einen Einstieg gebaut. Sichtbar wurde
es erst beim Durchsehen, nicht durch einen fehlgeschlagenen Test — die Tests
prüften ja auch nur Käufe.

Für einen Verkauf stimmt fast nichts davon:

| Prüfung | Kauf | Verkauf |
|---|---|---|
| `inAmount` | Lamports | **Token-Einheiten** |
| Zielbestand | muss **leer** sein | muss **reichen** |
| SOL-Abfluss | Betrag + Gebühren | **nur Gebühren** |
| Relevanter Mint | `outputMint` | **`inputMint`** |

Ohne die Unterscheidung hätte `POSITION_ALREADY_HELD` jeden Ausstieg blockiert —
also genau den Pfad, auf den es im Ernstfall ankommt.

Dabei fiel ein zweiter Fall auf, der jetzt einen eigenen Test hat: eine voll
investierte Wallet ohne SOL für die Gebühren kommt aus ihrer Position **nicht
heraus**. Der Verkauf kostet zwar kein Kapital, aber die Transaktion kostet
Gebühren, und ohne die geht gar nichts.

**Muster:** eine Validierung, die nur den häufigeren Pfad kennt, sieht vollständig
aus. Der seltenere Pfad ist hier der wichtigere.

## 36. Der Guthabencheck deckt Betrag UND Gebühren ab

Nur den Handelsbetrag zu prüfen ist der klassische Fehler. Die Transaktion
scheitert dann on-chain, kostet trotzdem Gebühren, und im Log steht ein
nichtssagender Programmfehler. Zwei getrennte Ablehnungsgründe
(`INSUFFICIENT_SOL_FOR_TRADE` und `INSUFFICIENT_SOL_FOR_FEES`), damit im
Rejection-Log unterscheidbar bleibt, was tatsächlich fehlte.

Dazu eine Mietreserve, damit die Wallet nicht auf null fällt.

## 37. Was die Pre-Trade-Validierung ausdrücklich NICHT prüft

Sie prüft nicht, ob der Trade eine gute Idee ist — das haben Score, Hard Gates
und Erwartungswert erledigt. Sie prüft, ob die Transaktion, die gleich gebaut
wird, das tut, was der Intent sagt.

Konkret: bei unbekanntem Erwartungswert lehnt sie **nicht** ab. Diese Entscheidung
fällt in der Decision-Engine, die den Modus kennt (Paper erlaubt `UNKNOWN`, Live
nicht). Dieselbe Regel an zwei Stellen zu prüfen führt dazu, dass sie irgendwann
auseinanderlaufen — und dann gilt die strengere, ohne dass jemand es beschlossen
hat.

Sie sammelt außerdem **alle** Fehler statt beim ersten abzubrechen. Wer nur den
ersten meldet, repariert im Zweifel dreimal.

## 38. `STILL_UNKNOWN` ist nicht `FAILED` — und wird es erst mit Ablauf

Der Reconciler kennt vier Ausgänge für eine gesendete Transaktion:

- `CONFIRMED` / `FAILED` — der Knoten weiß es
- `STILL_UNKNOWN` — der Knoten hat sie noch nicht gesehen. **Kein Fehlschlag.**
- `EXPIRED_UNCONFIRMABLE` — älter als die Blockhash-Lebensdauer

Der Unterschied zwischen den letzten beiden ist der Kern: `EXPIRED` bedeutet
nicht „wir wissen es nicht", sondern „sie kann nicht mehr eingebracht werden".
Erst das rechtfertigt, sie als gescheitert zu behandeln.

Eine unbekannte Transaktion vorschnell als fehlgeschlagen zu werten, ist die
Ursache der doppelten Position — und die ist teuer, weil niemand sie bemerkt, bis
der Bestandsabgleich anschlägt.

## 39. Bestandsabgleich: Toleranz ist kein Nachlassen

Eine harte Gleichheitsprüfung würde das System ständig anhalten:
Transferabgaben, Rundung bei Rebasing-Tokens, ein noch nicht verbuchter
Teilverkauf. Und ein System, das ständig grundlos anhält, wird abgeschaltet —
dann greift die Prüfung nie mehr.

Deshalb 1 % relative Toleranz für gewöhnliche Abweichungen. **Immer materiell**
sind dagegen:

- **Position verschwunden** — entweder wurde ohne unser Wissen verkauft, oder der
  Einstieg ist nie erfolgt
- **Verwaister Bestand** — ein Token, von dem die Buchhaltung nichts weiß. Der
  gefährlichere Fall: eine Position, die niemand überwacht, hat weder Stop noch
  Take Profit

Ein zu **hoher** Bestand ist ebenfalls eine Abweichung, keine gute Nachricht:
vielleicht wurde zweimal gekauft.

Materielle Abweichung hält **alles** an, auch Verkäufe. Wenn interner und
tatsächlicher Bestand auseinanderlaufen, ist jede weitere Order ein Schuss ins
Dunkle.

## 40. Ströme statt Modus — Paper ist keine Betriebsart

Phase 1 führte `execution: "paper" | "live"` als sich ausschließende Modi. Das
war falsch, und zwar nicht nur unbequem: es macht die **Datenerhebung**
abschaltbar. Wer aus Vorsicht auf Paper stellt oder Live abschaltet, verliert
genau in den interessanten Phasen die Beobachtungen.

Ersetzt durch drei Ströme, die parallel laufen:

| Strom | Abschaltbar | Bewegt Kapital |
|---|---|---|
| `AUTO_PAPER` | nein | nein |
| `MANUAL_PAPER` | nein | nein |
| `LIVE` | ja, Default aus | ja |

`ALWAYS_ON_STREAMS` ist eine Konstante, keine Einstellung — eine Einstellung,
die man setzen kann, wird irgendwann gesetzt. Auch der **Notstopp hält die
Paper-Ströme nicht an**: er soll Kapital schützen, nicht die Beobachtung. Sonst
fehlt ausgerechnet für die Phase, die den Stopp ausgelöst hat, die Datenbasis.

## 41. Gelegenheit und Position sind verschiedene Dinge — mit verschiedenen Tabellen

Eine Gelegenheit ist eine **Beobachtung**, kein Kapital. Sie entsteht für jeden
bewerteten Token, nicht nur für die mit `ENTER` — sonst können Champion und
Challenger nicht dieselben Gelegenheiten sehen (§93), und es gäbe keine
Kontrollgruppe für die Ablehnungen.

`opportunity_outcomes` hat deshalb **keine Kapitalspalte**: keine Positionsgröße,
kein realisiertes Ergebnis, nur hypothetische Anteile und MFE/MAE je Horizont.
Das ist der Kern der Kategorientrennung. Eine verpasste oder abgelehnte
Gelegenheit kann nicht in eine Performance-Aussage geraten, weil es schlicht
keine Spalte gibt, die sich mit einem Ergebnis verrechnen ließe — nicht, weil
irgendwo ein Filter sie ausschließt. Filter sind Vereinbarungen; irgendeine
künftige Abfrage hält sich nicht daran.

## 42. MISSED ist eine Klassifikation, kein Zustand

Der Zustandsautomat der Gelegenheit hat acht Zustände (`OFFERED`, `SEEN`,
`USER_CONFIRMED`, `POSITION_OPENED`, `REJECTED`, `INVALIDATED`, `EXPIRED`,
`CANCELLED`) — `MISSED` ist keiner davon.

Grund: ob sich eine Reaktion gelohnt hätte, weiß man zum Zeitpunkt des Ablaufs
noch nicht. `MISSED` ist eine nachträgliche Klassifikation von `EXPIRED` anhand
des beobachteten Hochs. Ohne Verlaufsdaten bleibt es `EXPIRED` — und wird nicht
optimistisch zu einer verpassten Gelegenheit erklärt.

Bewusst getrennt von `TradeState`: eine Gelegenheit, die nie zu einer Position
wurde, hat keinen Handelszustand. Ein gemeinsamer Automat hätte Zustände wie
„abgelehnt" mit „geschlossen" in einer Tabelle vermischt.

## 43. Die vier Invarianten sind Code, nicht Disziplin

`MISSED ≠ LOSS`, `USER_REJECTED ≠ LOSS`, `PAPER ≠ LIVE` und „keine Kennzahl über
verschiedene Sizing-Verfahren" stehen als je eigener Test in
`packages/analytics/src/__tests__/invariants.test.ts`. Vier technische Sperren:

1. **Kein Kapitalbezug** an Beobachtungen (`ObservationRow` hat keine
   `Money`-Spalte) — verpasst und abgelehnt können strukturell nicht zu Verlusten
   werden.
2. **`PaperStream = Exclude<TradingStream, "LIVE">`** plus `mode: "paper"` am
   Trade: ein Live-Trade ist in dieser Auswertung nicht darstellbar. Dazu eine
   Laufzeitprüfung für ungetypte Datenbankzeilen, wo Typen nicht mehr helfen.
   Zwei der Tests sind `@ts-expect-error`-Zusicherungen: fällt eine Typschranke
   weg, schlägt der Typecheck mit „unused directive" fehl.
3. **`computeCategoryStatistics` wirft** bei gemischten Schlüsseln statt still zu
   mitteln. Eine Kennzahl über zwei Sizing-Verfahren ist nicht ungenau, sie ist
   bedeutungslos — und still gemittelt sieht sie aus wie eine Aussage.
4. **Die Form von `CategoryReport` ist im Test festgenagelt.** Ein später
   ergänztes Summenfeld lässt den Test fehlschlagen und erzwingt eine
   Entscheidung statt einer Gewohnheit.

Ein bewusst nicht gemachtes Zugeständnis: es gibt in `analytics` **keine**
Funktion, die über Kategorien oder Sizing-Verfahren hinweg summiert. Das ist
Absicht, keine Lücke.

## 44. `producedPosition` und `stillOpen` sind getrennt

Beim Zusammenfassen der Beobachtungen fallen Gelegenheiten ohne
Beobachtungskategorie an. Zwei verschiedene Fälle: eine eröffnete Position ist
ein Ergebnis, eine noch offene Gelegenheit ist noch gar nichts. Eine gemeinsame
Zahl wäre in beide Richtungen falsch — sie ließe offene Fälle wie Erfolge
aussehen.

Zusammen mit den Beobachtungskategorien ergeben beide wieder alle Gelegenheiten:
die Aufstellung ist abstimmbar, nichts verschwindet.

## 45. Die MISSED-Schwelle ist eine Berichtskonvention, keine Messung

`DEFAULT_MISSED_MFE_THRESHOLD = 0.25` ist **nicht** aus Daten abgeleitet.
Begründung nur für die Größenordnung: ein Round Trip kostet bei 100 EUR Einsatz
nach dem Kostenmodell etwa 1,5 bis 3 Prozent, alles knapp darüber wäre kein
verpasster Gewinn, sondern Rauschen. 25 Prozent liegt deutlich darüber.

Sobald die Verteilung der `hypotheticalMfe` aus echten Beobachtungen vorliegt,
gehört der Wert überprüft und ersetzt. Bis dahin steht er als Konvention da und
nicht als Erkenntnis.

## 46. Schreibschutz auf den Beweisspalten

`feature_snapshots` und `manual_responses` bekommen in Migration
`0002_opportunities.sql` ein `REVOKE UPDATE, DELETE` für die Anwendungsrolle.

Beides sind Beweise: der eingefrorene Feature-Vektor, gegen den entschieden
wurde, und die tatsächliche Reaktionszeit des Nutzers. Wären sie änderbar,
könnte eine spätere Auswertung nachträglich zu ihrem eigenen Ergebnis passen —
ohne dass es jemand merkt. Der `DO $$`-Block prüft erst, ob die Rolle existiert,
damit Tests gegen PGlite ohne Rollen weiterhin durchlaufen.

## 47. `USER_CONFIRMED` statt `CONFIRMED`

Beim Schreiben des Tests „teilt keinen einzigen Zustand mit dem Handelsautomaten"
fiel auf: `CONFIRMED` kam in **beiden** Zustandsräumen vor und bedeutete
Verschiedenes.

| Automat | `CONFIRMED` bedeutete |
|---|---|
| `TradeState` | die Transaktion ist on-chain bestätigt |
| `OpportunityState` | der Nutzer hat den Alert bestätigt |

Zwei Vokabulare mit einem gemeinsamen Wort sind in Logs und Abfragen nicht
auseinanderzuhalten, und ein Filter über beide fällt nicht auf — er liefert
plausibel aussehende Zeilen. Deshalb heißt der Zustand der Gelegenheit jetzt
`USER_CONFIRMED`, ebenso die Reaktionsart in `manual_responses.kind`.

Der Test steht als Regel: **die beiden Zustandsräume sind disjunkt.** Alle
übrigen Paare waren schon vorher unterscheidbar (`POSITION_OPENED` gegen `OPEN`,
`REJECTED` gegen `SIGN_REJECTED`, `EXPIRED` gegen `ABORTED_EXPIRED`) — die
Kollision war die einzige.

Die Kategorie heißt weiterhin `CONFIRMED_MANUAL_PAPER_PERFORMANCE`: das ist der
vom Nutzer vorgegebene Name, und dort gibt es keine Verwechslungsgefahr.

Kein Migrationsaufwand: `state` und `kind` liegen als `text` in der Datenbank,
die Aufzählung existiert nur in TypeScript. Später wäre derselbe Schritt eine
Datenmigration gewesen.

## 48. Der Erwartungswert kennt jetzt beide Ausführungen

`estimateEv` bekam die Kosten als fertigen Anteil gereicht. Drei Fehler, die
darin bequem Platz hatten:

1. **Nur der Einstieg wurde gerechnet.** Ein Trade hat zwei Ausführungen.
2. **Das Ausstiegsvolumen ist ein anderes.** Bei +200 % ist die Verkaufsorder
   dreimal so groß wie der Einstieg, und DEX-Fee, Impact und Drift wirken auf
   dieses Volumen. „Kosten mal zwei" unterschätzt genau die Trades, die den
   Erwartungswert tragen.
3. **Doppelt abgezogen.** Realisierte Renditen sind bereits netto. Zieht man
   Modellkosten nochmals ab, sinkt der EV mit jeder Verbesserung des
   Kostenmodells — ein Fehler, der wie Vorsicht aussieht.

`composeRealisticEv` bewertet deshalb beide Äste getrennt:

```
EV(p) = p · (Gewinn − Ausstiegskosten bei Gewinnvolumen)
      − (1−p) · (Verlust + Ausstiegskosten bei Verlustvolumen)
      − Einstiegskosten
```

`returnBasis` ist Pflichtfeld ohne Default — es gibt keine vertretbare Annahme
über die Herkunft einer Stichprobe. Bei `NET_OF_COSTS` wird nicht noch einmal
abgezogen, und ein Caveat sagt, dass der EV dann die historischen und nicht die
aktuellen Kosten enthält. Für die aktuelle Ausführungslage ist das Kostengate
zuständig, nicht der EV.

Der Breakeven liegt **über** dem reinen Round Trip, weil der Ausstieg am
gestiegenen Volumen kostet: `R = (k + Einstieg) / (1 − k)`.

## 49. RR ist kein Erwartungswert — und sagt das selbst

`computeRiskReward` trägt in jeder Ausgabe den Satz, dass ein
Szenarienverhältnis ohne Trefferquote nichts über Profitabilität sagt. RR 5:1
bei 10 % Trefferquote ist ein Verlustgeschäft, und diese Zahl steht sonst
unkommentiert in Alerts.

Drei Unterschiede zur üblichen Rechnung:

- **Der Stop ist teurer als der Stop.** Stopabstand plus Slippage bis zum Fill
  plus beide Ausführungen. `stopSlippageBps` ist Pflichtfeld: bei einem Memecoin
  im Abverkauf ist das der größte Posten, und ein stiller Nullwert ließe jeden
  Stop besser aussehen, als er sich verhält.
- **Jede Leiterstufe einzeln.** Eigenes Volumen, eigene Kosten.
- **Rest ohne Plan zählt nicht.** Mit Trailing Stop wird der Rest an dessen
  Untergrenze bewertet (erreichtes Hoch minus Trailing-Abstand — eine Untergrenze,
  kein Zielkurs). Ohne Trailing Stop bleibt er aus der Chance heraus.

## 50. Zwei Dinge hießen „Confidence"

`EvEstimate.confidence` (Breite des Wilson-Intervalls) heißt jetzt
`evIntervalConfidence`. Daneben steht `caseConfidence` aus §21: die Anzahl
ähnlicher historischer Fälle.

Verwandt, aber verschieden: viele Fälle mit breiter Streuung heißen „das Muster
trennt nicht", wenige Fälle mit enger Streuung heißen „wir wissen es noch
nicht". Unter einem Namen wäre im Alert später nicht mehr erkennbar gewesen,
welche der beiden dort steht.

`combineConfidence` nimmt das **Minimum**, nicht den Mittelwert: die schwächere
Größe begrenzt, was über den Fall gesagt werden kann. Ein Mittelwert erlaubte,
eine breite Ergebnisstreuung mit einer großen Fallzahl zuzudecken.

`caseConfidence` führt den `bucketKey` mit. Die Fallzahl hängt vollständig
davon ab, wie eng „ähnlich" definiert ist — eine weitere Definition liefert mehr
Fälle und damit höhere Konfidenz, ohne dass sich am Wissen etwas geändert hätte.
Mitgeführt ist das wenigstens sichtbar.

## 51. Datenqualität ist nicht ausgleichbar

`dataCompleteness` bleibt, wird aber zu **einem von fünf** Eingängen:
Vollständigkeit, Frische, Latenz, Konsistenz, Provider-Gesundheit. Die vier
neuen sind genau die Fälle, in denen Vollständigkeit lügt — alle Felder da, aber
vier Minuten alt; alle Felder da, aber zwei Provider widersprechen sich.

Zwei Regeln, die beim Testen entstanden sind:

- **Eine ungeprüfte Dimension wird nicht zur bestandenen.** „Wir haben nicht auf
  Widersprüche geprüft" darf nicht zu „keine Widersprüche" werden. Sie geht
  nicht in den Mittelwert ein und steht in `unassessed`; das Gate verlangt
  zusätzlich eine Mindestzahl beurteilter Dimensionen.
- **Der Mittelwert allein reicht als Gate nicht.** 20 % der Felder plus fünf
  Widersprüche kommen mit drei perfekten Dimensionen immer noch auf 64 Punkte.
  Deshalb prüft das Gate zusätzlich jede einzelne Dimension gegen eine
  Untergrenze. Die Schwelle wurde **nicht** an den Fall angepasst — das wäre
  Parameteranpassung an einen Wunsch; stattdessen ist der Aggregator korrigiert.

Der Score fließt **nicht** in den Handelsscore ein. Verrechnet man beides, ist
hinterher nicht erkennbar, welche der zwei Größen die Entscheidung getragen hat.

## 52. Einstiegsqualität misst nur, was vor dem Hoch passiert ist

MFE, MAE, Exit Efficiency und Entry Quality kommen aus demselben Kursverlauf,
beurteilen aber verschiedene Entscheidungen. Der Punkt, an dem die übliche
Rechnung schiefgeht: für die **Einstiegsqualität** zählt nur der Rückgang **vor**
dem Hoch. Ein Einbruch danach ist ein Ausstiegsproblem.

Zwei Verläufe mit identischem MFE und identischem MAE — erst −50 % dann +100 %,
gegen erst +100 % dann −50 % — sind völlig verschiedene Trades. Nur die
Reihenfolge trennt sie, und ein Gesamt-MAE wirft beide zusammen: man bestraft
den Einstieg für einen verpassten Ausstieg und optimiert anschließend die
falsche Seite.

Weitere Festlegungen:

- **MFE bleibt negativ**, wenn der Kurs nie über den Einstieg kam. Auf 0
  gedeckelt würde es behaupten, es habe einen Ausstieg zum Einstandskurs gegeben.
- **Exit Efficiency ist `null`**, wenn es nie einen Gewinn zu holen gab — nicht
  0 („alles verpasst") und nicht 1 („perfekt").
- **Unsortierte Verläufe werfen.** Stilles Sortieren würde einen Fehler in der
  Zeitreihenabfrage verdecken, und die Reihenfolge ist hier die ganze Aussage.
- **Zusammenfassungen nehmen Mediane.** Ein einzelner Verzehnfacher zieht jeden
  Mittelwert so weit hoch, dass die Kennzahl nur noch diesen Trade beschreibt.

## 53. Ausstiegsgründe sind ODER-verknüpft

Der Exit Score (§33) beantwortet eine andere Frage als der Einstiegsscore. Ein
Token mit 82 Punkten beim Einstieg ist zwei Stunden später nicht „immer noch
eine 82": beim Halten ist das Kapital schon drin, ein Ausstieg kostet erneut,
und ein Teil des Verlaufs ist inzwischen bekannt.

Beim Testen fiel auf, dass der Mittelwert hier der falsche Aggregator ist — und
zwar auf eine Art, die den ganzen Score entwertet: **zwei voll ausgeschlagene
Dimensionen von fünf ergeben 40 Punkte**, unter jeder Handlungsschwelle. Der
Score würde also erst ausschlagen, wenn alles schlecht ist, und dann hat längst
eine der harten Regeln gefeuert. Genau die Grauzone, für die es ihn gibt, sähe
er nie.

Stattdessen die Gegenwahrscheinlichkeit `1 − Π(1 − dᵢ)`: ein einzelner
entscheidender Befund trägt allein, zweimal 50 ergibt 75, und nichts davon
braucht eine Gewichtung, die sich später passend machen ließe.

Zwei weitere Festlegungen:

- **Der Score darf allein keinen vollständigen Ausstieg auslösen.** Höchste
  Stufe ist ein Teilverkauf; für einen ganzen Ausstieg braucht es ein Ereignis,
  das eine der harten Regeln sieht.
- **Nicht berechenbar führt zu keinem Rat, nicht zu „halten".** Halten wäre
  ebenfalls eine Entscheidung und hier durch nichts gedeckt.

## 54. Ein Regime-Label darf nie rückwirkend entstehen

I-3 ist das gefährlichste Integritätsrisiko der Regime-Engine: wer im Nachhinein
sagt „das war eine Risk-Off-Phase" und die Trades dieser Phase auswertet, hat
den Ausgang benutzt, um die Bedingung zu definieren. Das Ergebnis ist
zwangsläufig gut und vollständig wertlos.

Durchgesetzt an drei Stellen, weil eine nicht reicht:

| Ebene | Mechanismus |
|---|---|
| Laufzeit | `RegimeTimeline` wirft bei einem Eintrag vor dem letzten |
| Schema | `UNIQUE (observed_at)` — kein zweites Label für denselben Moment |
| Datenbank | `REVOKE UPDATE, DELETE ON market_regimes` |

Dazu: `regimeAt()` liefert vor dem ersten Eintrag `UNKNOWN` und nicht das erste
bekannte Regime — rückwärts extrapoliert wäre genau derselbe Look-Ahead.

**Hysterese** ist kein Komfort: ohne sie flattert das Label, und jede spätere
Auswertung nach Regime mischt Phasen, die nur Rauschen trennt. Drei
Bestätigungen und eine Mindestverweildauer.

`UNKNOWN` ist ein vollwertiges Regime und der häufigste Zustand, solange kein
Provider läuft. Die Eingaben sind bewusst aus **eigenen** Daten gebildet
(Breite, Medianrendite, Listing-Rate, eigene Stop-Quote) — ein externer
Marktindex wäre ein erfundener Endpoint.

## 55. Vier Einstiegsmodelle, damit Einstiege überhaupt auswertbar werden

Bisher gab es genau ein implizites Modell: „Score hoch genug, Gates bestanden,
kauf". Fällt damit die Trefferquote, weiß niemand, ob das Frühkaufen schlechter
geworden ist oder das Nachkaufen bestätigter Bewegungen — es gibt keine zwei
Zahlen zum Vergleichen.

Drei Regeln machen die vier Modelle (EARLY, CONFIRMATION, MOMENTUM, RETEST)
messbar:

- **Einzeln abschaltbar**, wie die Exit-Regeln.
- **Mehrfachtreffer bleiben mehrfach.** Auf das erste passende Modell reduziert,
  hinge die Zuordnung an der Array-Reihenfolge — und die Statistik misst am Ende
  die Sortierung.
- **`NOT_COMPUTABLE` ist nicht `NO_MATCH`.** Ein Modell ohne Datengrundlage
  darf nicht als „hat nicht ausgelöst" zählen. Sonst sieht ein Modell, dessen
  Daten oft fehlen, aus wie ein zurückhaltendes, und seine Trefferquote wird an
  den wenigen Fällen gemessen, in denen zufällig alles vorlag.

Inhaltlich: EARLY verlangt zusätzlich eine verteilte Käuferbasis — „früh" ohne
sie ist nur ein anderes Wort für „vor allen anderen im Ausstieg eines Einzelnen".
RETEST ist nach oben begrenzt, sonst wäre es ein Name für fallendes Messer
fangen.

## 56. Ein RPC-Ausfall ist kein Beleg für Illiquidität

Die neunte Verlustregel (K-8, §26) steht bei den Verlustregeln und nicht in der
Fehlerbehandlung: eine Position, aus der man nicht herauskommt, ist ein
Risikoereignis.

Ihr Kern ist eine Unterscheidung, deren Fehlen teuer wird. Zählt man einen
RPC-Ausfall wie überschrittene Slippage, dann löst **ein einziger
Providerausfall gestückelte Notausstiege über das gesamte Portfolio aus** —
gleichzeitig, und ausgerechnet in dem Moment, in dem niemand zuverlässig handeln
kann. Aus einem Betriebsproblem wird ein realisierter Verlust.

| Klasse | Ursachen | Reaktion |
|---|---|---|
| Marktseitig | Slippage überschritten, keine Route, Blockhash abgelaufen | eskalieren, gestückelt aussteigen |
| Betrieblich | RPC weg, kein SOL für Gebühren, Signer lehnt ab | Alarm, neue Einstiege anhalten, **nicht verkaufen** |

Wer nicht aussteigen kann, darf nicht einsteigen — deshalb hält ein
Betriebsalarm neue Einstiege an. Bestehende Positionen bleiben, weil der Markt
nicht die Ursache ist und ein Verkauf unter Zwang teuer ist. Und ausdrücklich
nicht: die Signer-Policy lockern, um herauszukommen.

## 57. Menschliche und systembedingte Latenz sind verschiedene Probleme

Eine einzelne Gesamtlatenz sagt nicht, ob das System langsam war oder der
Mensch. Systemlatenz lässt sich wegprogrammieren, menschliche Reaktionszeit
nicht — eine Gesamtzahl leitet also genau die Optimierung an, die nichts bringt.

Neun Stufen von `OBSERVED` bis `CONFIRMED`, jeder Abschnitt einzeln, plus zwei
Regeln:

- **Monoton oder Fehler.** Ein Schritt vor seinem Vorgänger wirft, statt auf
  null gedeckelt zu werden. Auseinanderlaufende Uhren erzeugen sonst negative
  Teilzeiten, die sich in einem Mittelwert gegenseitig aufheben.
- **Übersprungene Stufen werden markiert.** Ein Auto-Trade hat keinen Alert;
  ohne Markierung sähe `DECIDED→QUOTED` später aus wie ein `DECIDED→ALERTED`,
  das zufällig sehr lang war.

`summarizeLatency` liefert Perzentile und **keinen Mittelwert**: bei
Ausführungszeiten ist der Schwanz die Kostenquelle. Wer den Mittelwert
optimiert, verbessert die Fälle, die ohnehin schnell waren.

`actualResponseMs` nimmt eine **einzelne** Kette und keine Zusammenfassung —
I-9 als Typ. `latency_samples` hat entsprechend eine Zeile je Vorgang und keine
aggregierte Spalte: sobald irgendwo ein `avg_response_ms` steht, wird
irgendwann damit simuliert.

## 58. Getrennte Exposure-Bücher, und Unbekanntes gilt als korreliert

Zwei Probleme unter einem Namen:

**Ströme dürfen sich nicht blockieren (I-10).** Zusammengezählt blockiert ein
voll investiertes Paper-Portfolio den Live-Handel, obwohl dort kein Euro liegt;
gar nicht gezählt ist die Konzentration innerhalb eines Stroms unsichtbar. Also
getrennte Bücher — und `StreamExposureBook` hat bewusst **keine** Gesamtsumme,
weil eine solche Zahl sofort in einem Gate landen würde.

**Zehn Positionen können eine sein (§51).** Zehn Tokens desselben Deployers
fallen gemeinsam; zehn Positionen zu je 3 % sind dann keine 30 % gestreutes
Risiko, sondern eine Position von 30 %.

Die wichtigste Festlegung betrifft das Unbekannte: eine Position ohne bekannte
Korrelationsgruppe wird **nicht** als unkorreliert behandelt, sondern kommt in
einen gemeinsamen Topf. Andernfalls wäre fehlende Information die bequemste Art,
jedes Konzentrationslimit zu umgehen — und zwar genau so lange, wie die
Clustering-Daten fehlen. Also: solange am längsten.

## 59. Die Prüfkette lässt sich nicht abkürzen

`CandidateState` hat keinen Übergang von `HYPOTHESIS` nach `PROMOTED` — und
auch keinen Umweg dorthin. Backtest → Walk Forward → Out-of-Sample → Shadow ist
im Zustandsautomaten erzwungen, nicht empfohlen. Wer abkürzen will, muss den
Automaten ändern, und das fällt in einer Codeänderung auf.

`advanceCandidate` hat bewusst **keinen `force`-Parameter**. Eine Ausnahme, die
man im Notfall setzen kann, wird im Notfall gesetzt — und ein Notfall ist genau
der Moment, in dem eine ungeprüfte Strategie am gefährlichsten ist.

`PROMOTED` heißt „ein Mensch kann sie jetzt scharfschalten", nicht „aktiv". Das
Scharfschalten bleibt ein Vorgang an `strategy_versions` mit `activatedBy`.

`REJECTED` ist ein häufiges und gutes Ergebnis, kein Fehlschlag des Systems.

## 60. Zeitgrenzen werden vor der Hypothese eingefroren

I-6 beschreibt keinen Betrug, sondern einen Ablauf: man schaut sich die Daten
an, findet ein Muster, prüft es — und wählt den Prüfzeitraum so, dass er zu dem
passt, was man gesehen hat. Danach ist das Ergebnis zwangsläufig gut, und
niemand kann die Reihenfolge rekonstruieren.

`freezeBatch` schreibt die vier Grenzen mit einem Hash fest;
`assertFrozenBefore` weist jede Hypothese ab, die älter ist als das Einfrieren.
Die Reihenfolge ist damit prüfbar statt eine Frage des guten Gewissens.

Dazu eine **Sperrfrist** zwischen Training und Prüfung, mindestens so lang wie
die maximale Haltedauer: sonst läuft eine kurz vor `trainTo` eröffnete Position
in den Prüfzeitraum hinein, und ihr Ausgang gehört beiden Bereichen.

Überlappende Batches sind nicht verboten, aber gemessen (I-12).
`countIndependentConfirmations` zählt Wiederholungen über dieselben Daten nicht
mit: „drei Bestätigungen" und „drei Bestätigungen, davon zwei aus denselben
Daten" sind verschiedene Aussagen.

## 61. Ohne Korrektur für vielfaches Testen ist Faktoranalyse eine Fehlerquelle

45 Features gegen drei Schwellen sind 135 Hypothesen. Auf dem üblichen
5-%-Niveau sind rund **sieben „signifikante" Ergebnisse allein durch Zufall** zu
erwarten — und die sehen genauso aus wie echte. Wer die sieben schönsten davon
einbaut, hat Rauschen fest verdrahtet.

`comparisons` ist deshalb Pflichtfeld der Feature-Analyse. Bei einem Test ergibt
sich das vertraute z = 1,96, bei 135 rund 3,5; die Intervalle werden breiter,
und ein Befund muss stärker sein, um sich gegen die Zahl der Versuche
durchzusetzen. Ein Test führt denselben Datensatz einmal als Einzelbefund
(getrennt) und einmal als einen von 135 (nicht getrennt) vor.

Bonferroni ist strenger als nötig. Das ist hier die richtige Richtung: ein
übersehener echter Faktor kostet eine verpasste Chance, ein falsch bestätigter
kostet Geld.

Weitere Festlegungen der Feature-Analyse:

- **Mindeststichprobe je Zelle**, nicht insgesamt. Eine Wechselwirkung braucht
  vier belegte Zellen; eine große Gesamtzahl mit einer fast leeren Zelle ergibt
  eine Wechselwirkung, die an drei Trades hängt.
- **Grenznutzen auf derselben Menge.** Zwei getrennte Läufe unterscheiden sich
  schon durch ihre Zusammensetzung — dann misst man die Auswahl statt das Gate.
  Trades ohne Featurewert bleiben drin; sie still zu entfernen wäre die
  bequemste Art, ein Gate gut aussehen zu lassen.
- **Zerfall in gleich große Zeitblöcke**, nicht in gleich große Stichproben:
  Zerfall ist eine Aussage über die Zeit, und gleich große Stichproben verzerren
  sie genau dann, wenn die Handelsfrequenz sich geändert hat.

## 62. Plateau, Gipfel, Hang

Der zentrale Begriff der Fragilitätsanalyse. I-7 nennt den Fall: neun
Take-Profit-Varianten gegen fünf Stop-Varianten sind 45 Kombinationen, und die
beste davon sieht immer gut aus. Das ist keine Erkenntnis, sondern eine
Eigenschaft des Suchens.

| Form | Beobachtung | Bedeutung |
|---|---|---|
| **Plateau** | Ergebnis bleibt bei ±5/10/20 % stabil | der Wert war eine Entscheidung, aber keine kritische |
| **Gipfel** | fällt in **jede** Richtung stark ab | Overfitting-Signatur — Spitzen entstehen in verrauschten Oberflächen von selbst |
| **Hang** | wird in eine Richtung besser | die Grenze wurde gesetzt, nicht gefunden; die Suche ist nicht fertig |

Ein Gipfel ist **nicht** „ein besonders guter Parameter", sondern ein Grund zur
Ablehnung.

Dazu der Ausreißerbeitrag (§126): kippt das Ergebnis ohne den besten Trade ins
Minus, wurde ein Glücksfall gemessen und kein Vorteil. Fragilität ist ein
**Gate**, kein Punktwert — gute Kennzahlen werden nicht gegen einen Befund
aufgerechnet.

## 63. Monte Carlo zieht aus den eigenen Trades und simuliert Pfade

Zwei Entscheidungen bestimmen, ob die Antwort etwas wert ist.

**Gezogen wird aus der eigenen Verteilung, nicht aus einer Normalverteilung.**
Memecoin-Renditen sind viele kleine Verluste und seltene sehr große Gewinner.
Eine angepasste Normalverteilung hätte dieselbe Streuung und völlig andere
Enden — sie unterschätzt genau das, wonach gefragt wird.

**Simuliert werden Pfade, keine Summen.** Maximaler Rückgang und Ruinrisiko
hängen an der Reihenfolge; dieselben Trades anders sortiert ergeben denselben
Endstand und einen völlig anderen Drawdown. Und die Frage „hätte ich das
ausgehalten" hängt am Drawdown.

Der **Block-Bootstrap** ist deshalb Default: Trades sind zeitlich korreliert,
weil Marktphasen zusammenhängen. Wer unabhängig zieht, zerlegt jede Verlustserie
und bekommt zu freundliche Drawdowns. Ein Test misst genau diesen Unterschied.

Eine zu kleine Stichprobe fällt durch das Gate, statt „unbekannt" zu liefern:
ohne Grundlage gibt es keinen Anlass, echtes Geld zu riskieren.

## 64. Champion und Challenger sehen dasselbe Objekt

Lässt man zwei Strategien unabhängig laufen, handeln sie verschiedene Tokens zu
verschiedenen Zeiten. Der Vergleich ihrer Trefferquoten misst dann zum großen
Teil, welche Gelegenheiten jede zufällig gesehen hat — und ein Challenger, der
einfach öfter einsteigt, sammelt mehr Gewinner ein, ohne besser zu sein.

Deshalb bekommt `runShadowComparison` **einen** Feature-Vektor pro Gelegenheit
und reicht dasselbe Objekt an beide. Ein Test prüft die Objektidentität.

Verglichen wird **paarweise**: die Fälle, in denen beide gleich entscheiden,
sagen über den Unterschied nichts. Gerechnet wird auf den Abweichungen — und ein
Herausforderer, dessen Intervalle überlappen, ist nicht besser, sondern nur
anders.

## 65. Zehn Gates, und keine Freigabe aus dem Code

**Alle zehn müssen bestehen, eines reicht zur Ablehnung.** Es gibt keine
Gewichtung und keinen Gesamtscore, gegen den sich ein durchgefallenes Gate
aufrechnen ließe — ein Durchschnitt über Gates verwandelt jede harte Bedingung
in eine Empfehlung.

Zwei Eigenschaften machen das Modul zur Sperre statt zur Checkliste:

- **`evaluatePromotionGates` kann keine Freigabe erteilen.** Kein Codepfad setzt
  `HUMAN_APPROVAL` auf `PASS`. Das Ergebnisfeld heißt `readyForHumanReview` und
  nicht `approved`; der Unterschied ist der ganze Zweck.
- **Nicht bewertbar zählt wie durchgefallen.** „Wir konnten es nicht prüfen" ist
  kein Argument dafür, echtes Geld einzusetzen — getrennt ausgewiesen, aber mit
  derselben Folge.

Das Gate `COST_MODEL_CALIBRATED` steht derzeit auf `FAIL`, weil kein Provider
erreichbar ist. Das ist beabsichtigt und keine Lücke: eine Strategie, deren
Kosten geschätzt sind, darf kein echtes Geld bewegen.

## 66. Ein erwarteter Rückgang ist keine Verschlechterung

Die Monte-Carlo-Simulation hat vor der Freigabe gesagt, dass 30 % Drawdown in
jedem zwanzigsten Verlauf vorkommen. Tritt er ein, ist das die **Bestätigung**
des Modells, nicht sein Widerspruch. Wer hier abschaltet, schaltet systematisch
am Tiefpunkt ab — und eine abgeschaltete Strategie hat keinen Erwartungswert
mehr.

Verschlechterung heißt deshalb: das Ergebnis liegt **außerhalb** der Vorhersage.
Konkret — die Obergrenze des laufenden Trefferquoten-Intervalls liegt unter der
Validierungsuntergrenze (die günstigste Lesart der Gegenwart unter der
ungünstigsten der Vergangenheit), oder der Rückgang übersteigt den schlechtesten
simulierten Verlauf.

Aus `DEGRADED` führt kein Weg direkt zurück nach `HEALTHY`: eine Strategie, die
außerhalb ihrer Vorhersage lag, ist nicht dadurch wieder gesund, dass die
nächsten Trades besser liefen. Sie muss über `WATCH`.

## 67. Anhalten darf die Automatik, Aktivieren nicht

Die Asymmetrie ist die wichtigste Regel des Health-Moduls:

- **Anhalten** schützt Kapital und ist deshalb automatisierbar.
- **Aktivieren** ist es nicht — auch nicht das Zurückschalten auf eine früher
  geprüfte Version. Geprüft wurde sie gegen eine andere Marktlage.

Deshalb gibt es `suspend` als Vorgang und `planRollback` als **Vorschlag** mit
`requiresHumanApproval: true` als Literaltyp.

Der Rollback überspringt Versionen, aus denen schon einmal zurückgerollt wurde:
sonst pendelt das System zwischen zwei Versionen hin und her und erzeugt bei
jedem Wechsel Kosten, ohne je eine Entscheidung zu treffen.

## 68. Der Bericht stellt den Zufall daneben

Ein System, das nur Berichte über gefundene Zusammenhänge kennt, erzeugt so
lange welche, bis es welche gibt. Deshalb trägt jeder Forschungsbericht die
Gegenzahl: **wie viele Befunde allein durch Zufall zu erwarten waren.**

Fünf bestätigte Zusammenhänge bei 135 Versuchen und rund sieben erwarteten
Scheinbefunden sind kein Ergebnis — sie sind weniger, als der Zufall liefert.
`findingsVsChance` unter 1 führt deshalb zu `NO_EDGE`, egal wie die Liste
aussieht.

Befunde ohne belegte Trennung kommen gar nicht erst in die Liste: ein
`NO_DIFFERENCE` ist kein schwacher Befund, sondern keiner. Und „nichts gefunden"
wird von „nichts prüfbar" getrennt — zu wenig Daten heißt nicht, dass kein
Vorteil da ist.

Der **No-Edge-Modus** (§148) ist kein Alarm, sondern eine Feststellung. Er hält
den Live-Handel an und lässt Auto Paper und Manual Paper weiterlaufen, damit die
nächste Marktphase auf Daten trifft. Nicht handeln ist dort das Ergebnis, nicht
das Scheitern.

## 69. Counterfactuals bekommen eine Uhr, keine Bitte

Wer den ganzen Kursverlauf kennt, findet immer einen besseren Ausstieg. „Bei
+180 % statt bei +40 % verkaufen" ist keine Regel, sondern eine Beobachtung im
Rückblick. Wertet man Alternativen so aus, sieht jede besser aus als das, was
tatsächlich passiert ist — und das System lernt, seine Ausstiege für schlecht zu
halten, obwohl es sie nicht besser hätte treffen können.

`guardedSource` umhüllt die Datenquelle mit einer Simulationsuhr und **wirft**
bei jeder Anfrage jenseits der aktuellen Zeit. Look-Ahead ist damit ein Fehler
zur Laufzeit und nicht ein besonders gutes Ergebnis. Die Schranke ist bewusst
`async`: als synchroner Wurf ginge sie an jedem Aufrufer vorbei, der die Methode
mit `.catch()` statt `await` benutzt — und das ist genau der Aufrufer, der sie
am nötigsten hat.

Eine Alternative, die nicht auslöst, wird am tatsächlichen Schluss bewertet und
ausdrücklich nicht am späteren Hoch. Zusammenfassungen nehmen den **Median** und
verlangen eine **Mehrheit** besserer Fälle: ein einzelner Verzehnfacher, den die
Alternative hätte laufen lassen, bestimmt sonst jeden Mittelwert — und genau
diesen einen Fall findet man im Rückblick immer.

## 70. Fünf Provider-Zustände, weil drei die falsche Frage beantworten

`HEALTHY / DEGRADED / DOWN` reicht der Handelslogik, aber nicht der Anzeige.
„DOWN" beantwortet die einzige Frage nicht, die man beim Hinsehen hat: **liegt
es an mir?**

| Zustand | Bedeutung | Behoben durch |
|---|---|---|
| `NOT_CONFIGURED` | Keine Basis-URL, kein Schlüssel | Konfiguration |
| `BLOCKED` | Das Netz lässt die Verbindung nicht zu | Netzwerkfreigabe |
| `UNAVAILABLE` | Konfiguriert, antwortet nicht | Warten oder Anbieterwechsel |
| `DEGRADED` | Antwortet eingeschränkt (Fehler, Limit, Budget) | Drosseln |
| `CONNECTED` | Liefert verwertbare Daten | — |

Der Unterschied zwischen `BLOCKED` und `UNAVAILABLE` ist im Moment der ganze
Befund: **alle Quellen sind gesperrt, keine ist ausgefallen.** Wäre beides
„DOWN", würde man den Fehler beim Anbieter suchen.

`classifyFailure` ist bewusst konservativ: was nicht eindeutig als Netzsperre
erkennbar ist, gilt als `UNAVAILABLE`. Ein fälschlich als `BLOCKED` gemeldeter
Anbieter schickt die Fehlersuche in die falsche Richtung.

Getrennt davon: `configured` und `adapterImplemented`. Ein Anbieter mit
Basis-URL, für den es kein geprüftes Adapter-Modul gibt, ist nicht ansprechbar —
und der Unterschied gehört sichtbar, sonst sucht jemand den Fehler bei den
Zugangsdaten.

## 71. Ein Fallback darf nie stillschweigend Qualität mischen

Die Kette `PRIMARY → SECONDARY → FALLBACK` liefert den Wert des ersten
Anbieters, der antwortet — mit **seiner** Stufe am Datenpunkt. Es wird nichts
gemittelt und nichts ergänzt.

Für zusammengesetzte Datensätze gibt es bewusst **keine** Funktion, die zwei
`Sourced`-Werte zu einem verschmilzt. Wer Felder aus zwei Anbietern kombiniert,
bekommt einen `MultiSourced` mit der **schlechtesten** Stufe und der
**ältesten** Beobachtung aller Beteiligten. Ein Datensatz mit Preis vom
Primär- und Liquidität vom Fallback-Anbieter ist kein Primärdatensatz.

`token_snapshots` trägt das in vier Spalten mit: Anbieter, Stufe, Frische,
Beteiligte. Ohne sie ließe sich später nicht sagen, ob eine Entscheidung auf
Primärdaten beruhte — und dann ist jede Auswertung nach Datenqualität unmöglich.

`NO_SOURCE` ist ein reguläres Ergebnis der Kette, keine Ausnahme. Genau in
diesem Zustand befindet sich das System.

## 72. Der Scheduler ist der Wiederanlaufmechanismus

Kein zentraler Tick, der alles anstößt, und kein `setInterval` je Aufgabe.
Neun Takte mit eigenen Intervallen, und drei Eigenschaften, die den Unterschied
machen:

1. **Ohne Marktdaten läuft fast nichts.** Jeder Takt erklärt, ob er Marktdaten
   braucht. Genau einer läuft weiter: `PROVIDER_HEALTH`. Er ist der Mechanismus,
   mit dem das System von selbst anläuft — es gibt keinen Startknopf.
2. **Kein Nachholsturm.** War der Scheduler eine Stunde weg, feuert ein
   30-Sekunden-Takt einmal und nicht 120-mal. `lastRunAt` wird auf den
   tatsächlichen Zeitpunkt gesetzt, nicht auf den geplanten.
3. **Rate Limits gehen vor.** Ein Takt, dessen geschätzte Anfragen nicht ins
   verbleibende Budget passen, wird **verschoben statt gedrosselt** — und bei
   knappem Budget bekommt die Positionsüberwachung ihre Anfragen, nicht die
   Discovery. Getrennte Timer wüssten nichts voneinander.

Wiederholte Fehlschläge verlangsamen einen Takt exponentiell; ein Erfolg setzt
das zurück.

## 73. Worker-Sicherheit: der Schlüssel kommt aus dem Inhalt

Ein Job kann aus drei normalen Gründen zweimal laufen — doppelt eingeplant,
Absturz vor dem Bestätigen, Wiederholung durch die Queue. Alle drei dürfen
keine zweite Gelegenheit, keinen zweiten Snapshot und keinen zweiten Trade
erzeugen.

Der Idempotenzschlüssel wird deshalb aus dem **fachlichen Inhalt** gebildet,
nicht aus der Job-ID: zwei verschiedene Jobs mit demselben Inhalt sind derselbe
Vorgang, und derselbe Job mit anderem Inhalt ist ein anderer. Die Felder werden
sortiert gehasht — sonst hinge die Idempotenz daran, wie jemand ein
Objektliteral geschrieben hat.

Weitere Festlegungen:

- **Bei einem Fehler wird der Anspruch freigegeben.** Sonst blockiert ein
  abgestürzter Worker den Vorgang dauerhaft, und das ist schlimmer als eine
  Wiederholung: der Vorgang fände nie statt.
- **Eine Netzsperre wird nicht wiederholt.** Sie ändert sich nicht durch Warten.
  Der nächste Versuch gehört dem Scheduler mit seinem langen Takt, nicht der
  Retry-Schleife — sonst ist der „Retry" ein Dauerlauf gegen eine Wand, der
  Rate-Limit-Budget für den Moment verbraucht, in dem der Anbieter wiederkommt.
- **Der Checkpoint ist eine Liste, kein Zähler.** Bei einem Zähler hinge die
  Wiederaufnahme daran, dass die Reihenfolge beim zweiten Lauf dieselbe ist —
  bei einer Discovery-Liste ist sie das nie.
- **`maxUnitsPerRun` deckelt jeden Lauf.** Ohne Deckel kann ein Job beliebig
  viele Anfragen erzeugen.

## 74. Zwei Löcher im Look-Ahead-Schutz, beide gefunden

Der Auftrag war, alle Guards auf die Fehlerklasse des `async`-Befundes zu
prüfen. Dabei kamen zwei Dinge heraus, die beide nichts mit Promises zu tun
hatten und beide schlimmer waren.

**Erstens: `LivePitReader` hatte Default-Argumente für `asOf`.**

`PitReader` hat bewusst keine Methode, die „den aktuellen Stand" liefert — ein
Aufruf ohne Zeitpunkt soll ein Compile-Fehler sein. Ein Default-Argument macht
daraus wieder eine solche Methode; man sieht es dem Aufruf `snapshotAt(id)` nur
nicht an. Die Vorkehrung war damit im Livebetrieb wirkungslos, also genau dort,
wo sie zählt.

Behoben: `asOf` ist überall Pflicht. Wer den aktuellen Stand will, schreibt
`reader.snapshotAt(id, reader.now())` — eine Zeile mehr, an der Aufrufstelle
sichtbar. Ein `@ts-expect-error`-Test hält die Pflichtangabe fest.

**Zweitens: ein Kommentar, der eine Direktive war.**

Beim Schreiben genau dieses Tests umbrach der Fließtext so, dass eine Zeile mit
`// @ts-expect-error` begann — mitten in einer deutschen Erklärung. TypeScript
liest das als Direktive. Hätte sie zufällig auf einer Zeile mit einem echten
Fehler gestanden, wäre der stillschweigend unterdrückt worden.

Gefunden hat es der Compiler selbst („unused directive"), und nur weil an dieser
Stelle kein Fehler stand. Die Lehre ist unangenehm allgemein: **Prosa in
Kommentaren kann Compiler-Direktiven erzeugen.**

## 75. Ohne Daten keine Aussage — als Typ

Jede Dashboard-Kachel ist ein `Panel<T>`, kein `T | null`. Ein `null` wird in
der Anzeige irgendwann zu einer 0, und eine 0 sieht aus wie eine Messung.

```
DATA          es gibt etwas zu zeigen
WAITING       es fehlt die Datenquelle
INSUFFICIENT  es gibt Daten, aber zu wenige für eine Aussage
```

Der dritte Fall ist der wichtigste: „12 Trades, Trefferquote 75 %" ist keine
Aussage, sondern Rauschen mit Nachkommastellen.

Die Kacheln prüfen in der Reihenfolge ihrer Abhängigkeit — Quelle, Snapshots,
Gelegenheiten, Positionen —, damit die Anzeige die **erste** fehlende
Voraussetzung nennt und nicht die letzte. „Zu wenige Trades" ist eine
irreführende Meldung, wenn schon die Datenquelle fehlt.

Die Datenschicht rechnet bewusst keine Trefferquoten: die kommen aus
`@sae/analytics` und sind dort an Mindeststichproben gebunden. Eine zweite
Rechenstelle wäre die erste Gelegenheit, diese Bindung zu verlieren.

## 76. Keine Endpunktpfade in der Konfiguration

`providerEnvSchema` kennt Basis-URLs und Zugangsschlüssel — und keine Pfade.
Einen Pfad zu konfigurieren hieße, ihn zu kennen, und bekannt ist genau einer:
Jupiters, aus seiner eigenen OpenAPI-Spezifikation.

Für alle anderen wäre jeder Pfad hier eine Erfindung — und eine Erfindung, die
konfigurierbar aussieht, ist gefährlicher als eine fehlende Datei: sie erzeugt
Fehlschläge, die wie Anbieterprobleme aussehen, und schickt die Fehlersuche in
die falsche Richtung.

Deshalb gibt es auch keinen Simulator als Provider-Ersatz. Er würde die gesamte
Kette grün färben und nichts beweisen.

## 77. Redis raus — und was dabei fast verlorengegangen wäre

`REDIS_URL` war Pflicht in `baseEnvSchema` und wurde von keiner einzigen
Codezeile gelesen. `ioredis` war nirgends importiert, `bullmq` genau einmal —
als Typ-Import, der wegkompiliert. `apps/worker/src/queues.ts` war vollständig
toter Code: nichts importierte `QUEUES`, `QUEUE_OPTIONS`, `QUEUE_CONCURRENCY`
oder `JobPayloads`.

Der Grund ist Entscheidung 43: die dauerhafte Queue liegt in PostgreSQL, weil
Redis die Zustellgarantie nicht trägt. Die BullMQ-Definitionen stammten aus dem
Entwurf davor und sind beim Umstieg liegengeblieben. Ein Pflichtwert, den
niemand liest, ist keine Kleinigkeit: er kostet auf jeder Plattform einen
Eintrag, und wer ihn vergisst, bekommt einen Startfehler ohne Zusammenhang zur
eigentlichen Ursache.

**Beim Löschen wäre allerdings etwas Echtes mitgegangen.** `queues.ts` trug eine
Retry-Politik je Auftragsart, und die ist im Postgres-Queue **nicht** umgesetzt:

| Auftragsart | Absicht in `queues.ts` | Postgres-Queue heute |
|---|---|---|
| `execution` | **genau 1 Versuch** | `max_attempts` DEFAULT 4 |
| `decision` | 1 Versuch | DEFAULT 4 |
| `reconciler` | 5 Versuche | DEFAULT 4 |
| `alerts` | 4 Versuche | DEFAULT 4 |
| `scoring`, `positions`, `paper` | 2 Versuche | DEFAULT 4 |

Die Begründung im gelöschten Code war präzise und gilt weiter: *„Ein
automatischer Retry auf einer gesendeten Transaktion ist der direkte Weg zur
doppelten Position."*

Heute ist das folgenlos — der Scheduler reiht ausschliesslich datenunabhängige
Takte ein, und einen `EXECUTION`-Auftrag gibt es nicht, weil Live-Handel aus ist
und die `execution`-Rolle ein leerer Platzhalter bleibt. Es ist aber eine
**harte Voraussetzung** für jede spätere Execution-Arbeit:

> Bevor der erste `EXECUTION`-Auftrag eingereiht werden darf, muss
> `max_attempts` je Auftragsart gesetzt werden — für `execution` auf 1. Ein
> globaler Standard von 4 bedeutet dort vier Versuche, eine Transaktion zu
> senden.

Aufgeschrieben statt gelöscht, weil eine Absicht, die nur in totem Code stand,
beim nächsten Aufräumen endgültig verschwunden wäre.


## 78. Eine Datei, die wie eine Migration aussah und nie eine war

`migrations/0001_timescale.sql` lag im Migrationsordner, stand aber nicht in
`meta/_journal.json`. Drizzle liest ausschliesslich das Journal — die Datei
wurde also nie ausgefuehrt, sah aber in jedem Verzeichnislisting wie ein
angewendeter Schritt aus. Zweimal hat das zu der Frage gefuehrt, ob das Schema
vollstaendig ist.

**Sie nachtraeglich ins Journal aufzunehmen waere die schlechtere Loesung
gewesen.** Drizzle wendet eine Migration genau dann an, wenn

    letzte_angewendete.created_at < migration.when

Ein Eintrag mit einem `when` zwischen `0000_init` und `0002_opportunities`
haette auf einer frischen Datenbank mitlaufen muessen und auf einer bereits
migrierten nie — `1788262311821 < 1788132972903` ist falsch. Frische und
bestehende Datenbanken waeren dauerhaft auseinandergelaufen, unbemerkt. Ein
Schema-Unterschied, den niemand sieht, ist schlimmer als ein fehlendes Feature.

Deshalb liegt die Datei jetzt als `packages/db/optional/timescale.sql` neben
einem README, das sagt, wann und wie man sie von Hand anwendet. Sie ist kein
Migrationsschritt, sondern eine Betriebsmassnahme mit einer Voraussetzung
(`CREATE EXTENSION timescaledb`), die auf Neon ohnehin nicht erfuellbar ist.

Der Ordner `migrations/` enthaelt seither genau so viele SQL-Dateien wie das
Journal Eintraege hat. Diese Gleichheit ist pruefbar und wird geprueft.

## 79. Der Gate fragte, woher die Daten kommen — nicht, ob sie da sind

`snapshotSupportsEntry` prüfte zwei Dinge: Qualitätsstufe und Alter. Beides ist
nötig. Beides sagt nichts darüber, ob die Felder, auf denen eine Entscheidung
beruht, überhaupt geliefert wurden.

Ein Snapshot mit `tier = PRIMARY` und acht Sekunden Alter passierte den Gate
auch dann, wenn `liquidity_usd` und `volume_24h_usd` `NULL` waren. Der Anbieter
hatte sie nicht geliefert; niemand sah nach. Aus so einem Snapshot konnte eine
Gelegenheit entstehen, die auf zwei Löchern steht.

Dazu kam ein zweiter Fehler, und der wog schwerer: **die Prüfung galt nur für
Live.** In `planBranches` hing Paper allein an Bereitschaft und Historienlänge.
Fallback-Daten öffneten Auto Paper und Manual Paper, obwohl dieselbe Datenlage
für Live ausdrücklich als zu schwach galt. Paper ist aber die Grundlage der
späteren Statistik — läuft es auf Daten, die für eine Einstiegsentscheidung
nicht gut genug sind, misst diese Statistik die Datenqualität und nicht die
Strategie. Und weil eine Auswertung nicht unterscheiden kann, ob ein Feld
gefehlt hat oder null war, wäre der Fehler später nicht mehr auffindbar
gewesen.

**Beides ist jetzt zusammengelegt.** `packages/pipeline/src/market-data-quality.ts`
prüft die Felder, `entryDataVerdict` in `flow.ts` verbindet Herkunft und Felder
zu einer Antwort, und `planBranches` wendet sie auf **jeden** Strom an — Auto
Paper, Manual Paper, Live. Beobachten und speichern darf man Fallback-Daten
weiterhin; eine Gelegenheit entsteht daraus nicht mehr.

### Fehlend ist nicht null

Das ist die Regel, die die Datei trägt. Ein Token ohne gemeldete Liquidität ist
nicht ein Token mit Liquidität 0 — das eine heißt „wir wissen es nicht", das
andere „es ist nichts da". Deshalb kennt `QualityVerdict` beide Fälle getrennt:

| Urteil | Bedeutung |
|---|---|
| `INCOMPLETE` | Pflichtfeld fehlt. Unbekannt. |
| `BELOW_THRESHOLD` | Wert gemessen, Markt zu klein. |
| `IMPLAUSIBLE` | Negativ, `NaN`, `Infinity` — Anbieterfehler, keine Marktaussage. |
| `STALE` | Zu alt. |
| `UNTRUSTED_SOURCE` | Qualitätsstufe trägt keine Entscheidung. |

Die Reihenfolge der Prüfungen ist Absicht: Quelle, Alter, Vollständigkeit,
Plausibilität, Schwellen. So nennt eine Ablehnung die Ursache und nicht den
Folgefehler — „Daten sind 900 s alt" führt zur Wurzel, „Liquidität zu niedrig"
in die Irre, wenn beides zutrifft.

### Pflicht sind vier Felder, nicht zwölf

`REQUIRED_FOR_ENTRY` enthält `priceUsd`, `liquidityUsd`, `volume24hUsd`,
`marketCapUsd`. Die übrigen acht (Buy/Sell-Zähler, Buy/Sell-Volumen,
Trade-Count, Unique Wallets, FDV, Holder) verbessern eine Entscheidung, tragen
sie aber nicht allein. Sie zur Pflicht zu machen hieße, die **Anbieterwahl zur
Strategieentscheidung** zu machen: wer sie liefert, entschiede damit, was
handelbar ist.

### Der Verzicht ist sichtbar

Ein Test-Fixture behauptet keine Marktlage — er beweist, dass die Verarbeitung
dahinter läuft. Ihn durch die Feldprüfung zu schicken hieße, ihn abzulehnen;
ihm Felder zu erfinden wäre schlimmer. Deshalb ist `DataQualityCheck` eine
unterschiedene Vereinigung mit einem eigenen Zweig `WAIVED_TEST_FIXTURE`, und
der Verzicht steht danach in der Begründung der Verzweigung. Ein ausgesetzter
Gate, der in der Aufzeichnung wie ein bestandener aussieht, wäre die schlechtere
Variante von gar keiner Aufzeichnung.

Das Feld ist **Pflicht**, kein optionaler Schalter. Ein weglassbares Feld wäre
ein Gate, das man durch Vergessen umgeht.

### Die Schwellen sind keine Strategieparameter

`minLiquidityUsd = 5 000`, `minVolume24hUsd = 1 000`, `maxAgeSeconds = 120`.
Bewusst konservativ und ausdrücklich **nicht** kalibriert: sie aus Backtests
abzuleiten wäre Optimierung auf Vergangenheit. Wer sie ändert, ändert eine
Sicherheitsgrenze. `maxAgeSeconds` ist derselbe Wert wie in
`DEFAULT_INGEST_SETTINGS` — dieselbe Frage darf nicht zwei Antworten haben.

## 80. Ein Markt war ein Token — und das ist bei Memecoins falsch

Die Pipeline identifizierte einen Markt durch die **Token-Mint-Adresse und
sonst nichts.** `fetchMarket(mint)` ging hinein, ein Preis kam heraus. Was
dazwischen geschah, wenn ein Token mehrere Pools hat, stand nirgends.

Bei Solana-Memecoins ist das keine Vereinfachung, sondern ein Fehler. Ein Token
hat regelmäßig einen Pool auf Raydium, einen auf Orca und einen Rest aus der
Launch-Phase mit vierstelliger Liquidität. Diese Pools haben **verschiedene
Preise, verschiedene Liquidität und verschiedene Ausstiegskapazität.** Wer den
ersten nimmt, den die Antwort liefert, hat seine wichtigste Kennzahl von der
Sortierreihenfolge eines Anbieters abhängig gemacht — und merkt es nie, weil
das Ergebnis wie eine Messung aussieht.

Zwei Spuren zeigten, dass die Frage einmal gedacht und dann fallengelassen
wurde:

- `token_pools` existiert als Tabelle, mit `address`, `dex`, `base_mint`,
  `quote_mint`, `fee_bps`. **Keine Zeile Code schreibt sie, keine liest sie.**
- `DiscoveredToken.poolAddress` wird von der Discovery gesetzt und danach
  fallengelassen. Es erreicht den Snapshot nicht.

### Die Auswahl ist jetzt eine eigene Stufe

`packages/pipeline/src/market-selection.ts`. Anbieterunabhängig: sie arbeitet
auf `MarketCandidate`, unserem Vokabular, nicht auf der Antwortform eines
Anbieters.

**Erst ausschließen, dann ordnen.** Ein Pool, der eine harte Bedingung
verletzt, wird nicht schlechter bewertet — er fällt raus, mit Grund. Ein
Ausschluss, den eine gute Zahl an anderer Stelle aufwiegt, ist kein Ausschluss.

Die zehn Gründe sind getrennt, weil sie verschiedene Ursachen haben:
`WRONG_BASE_TOKEN`, `UNUSABLE_QUOTE`, `NO_PRICE_REPORTED`,
`NO_LIQUIDITY_REPORTED`, `LIQUIDITY_TOO_LOW`, `POOL_TOO_YOUNG`, `STALE`,
`IMPLAUSIBLE_VALUE`, `TURNOVER_IMPLAUSIBLE`, `ONE_SIDED_FLOW`.

### Liquidität rangiert vor Volumen

Volumen ist die manipulierbarste Zahl in diesem Datensatz — zwei Wallets
erzeugen beliebig viel davon, und bei Memecoins tun sie das auch. Liquidität
muss tatsächlich im Pool liegen.

Wichtiger noch: Liquidität bestimmt den **Ausstieg**. Der teuerste Fehler bei
Memecoins ist nicht ein schlechter Einstieg, sondern eine Position, die der
Markt nicht zurückkauft. Ein Pool mit hohem Volumen und dünner Liquidität ist
genau die Falle, in die eine volumenbasierte Auswahl läuft.

### Die Pool-Adresse ist der letzte Entscheider

Bei exakt gleichen Kennzahlen gewinnt die lexikografisch kleinere Adresse. Das
ist willkürlich — und genau deshalb richtig. Die Alternative wäre die
Reihenfolge der Anbieterantwort: ebenso willkürlich, aber nicht
reproduzierbar. Ein Backtest, der die Marktauswahl nicht nachstellen kann,
misst etwas anderes als der Live-Betrieb.

### Was ausdrücklich nicht eingebaut wurde

Keine „Smart Money"-Aussagen. `TURNOVER_IMPLAUSIBLE` und `ONE_SIDED_FLOW` sind
Befunde aus der Datenlage selbst — kein Urteil über Absichten. Und beide
schweigen, wenn die Zähler fehlen: unbekannt ist kein Befund.

Die Schwellen sind Plausibilitätsgrenzen, keine Strategieparameter. Bei
Memecoins ist das Zehnfache der Liquidität an Tagesumsatz normal; gefangen
werden soll die Größenordnung darüber. Der Wert ist bewusst hoch und
ausdrücklich nicht kalibriert.

## 81. Der Vertrag steht — und die echte Antwort hat drei Annahmen widerlegt

Eine echte Antwort von `GET /tokens/v1/solana/{address}`, abgerufen am
2026-09-03, ersetzt `unverifiedContract` durch ein `zodContract` mit
`verified: true`. Sie liegt wortgleich in
`packages/providers/src/dexscreener/__tests__/real-response.ts` — nicht
gekürzt, nicht begradigt. Eine bereinigte Stichprobe würde ein Antwortformat
behaupten, das es so nie gab.

**Drei Dinge hätte man geraten, und alle drei falsch:**

| Angenommen | Tatsächlich |
|---|---|
| Objekt mit `pairs` darin | **nacktes Array** |
| `priceUsd` ist eine Zahl | **Zeichenkette** `"100.17"` |
| `liquidity` ist eine Zahl | **Objekt** `{usd, base, quote}` |

Jede einzelne davon hätte ein Schema mit `z.number()` dazu gebracht, **jede**
echte Antwort abzulehnen — und der Fehlschlag hätte wie ein Anbieterausfall
ausgesehen, nicht wie unser Fehler. Das ist der Grund, warum `unverifiedContract`
existiert.

### Was fehlt, und warum das zählt

**`fdv` und `marketCap` waren nicht in der Antwort** — obwohl beide in der
Feldliste der Spezifikation V1 stehen. Sie bleiben `null`, und `null` heißt
NOT_AVAILABLE. Aus Preis und einer geschätzten Umlaufmenge eine
Marktkapitalisierung zu rechnen wäre genau die Erfindung, die dieses System
ausschließt.

Das hat eine unmittelbare Folge: `marketCapUsd` steht in `REQUIRED_FOR_ENTRY`.
Solange DexScreener es nicht liefert, besteht **kein** Token den
Qualitätsgate. Ob das für Memecoins auch gilt oder eine Eigenheit von Wrapped
SOL ist, entscheidet eine zweite Stichprobe — nicht eine Annahme.

**Kein Zeitstempel zur Preisangabe.** Bestätigt, was die Provider-Doku
vorhergesagt hatte. `observedAt` ist deshalb im Typ `DexScreenerMarket` das
Literal **`null`**, nicht `Date | null`: so kann niemand hier später den
Empfangszeitpunkt eintragen, ohne den Typ zu ändern und dabei zu merken, was er
tut. Ein erfundener Beobachtungszeitpunkt wäre Look-Ahead mit Wirkung bis in
jeden Backtest.

### `zodContract` nimmt jetzt `unknown` als Eingang

Vorher `z.ZodType<T>` — Eingang gleich Ausgang. Damit war kein
`transform`-Schritt möglich, und die Normalisierung hätte außerhalb der
Validierung stattfinden müssen: an einer Stelle also, die ein **nicht
validiertes** Objekt in der Hand hält. Jetzt ist Validierung und
Normalisierung ein Schritt, und was aus `validate()` herauskommt, kennt
DexScreener nicht mehr.

### Die Tests laufen gegen die echte Antwort

Das frühere `FRAMEWORK_TEST_CONTRACT` ist entfallen. Ein Test gegen ein
selbstgebautes Schema beweist, dass unser Schema zu unserem Schema passt.

## 82. „Alter unbekannt" ist jetzt ein Zustand, keine Null

DexScreener liefert nachweislich **keinen Beobachtungszeitpunkt** zur
Preisangabe — geprüft an einer echten Antwort (§81). Der Einstiegs-Gate prüft
aber Datenalter. Damit gab es genau drei Möglichkeiten, und zwei davon waren
falsch.

Die falsche Bequeme stand bereits im Code. In `smoke/pipeline.ts`:

```ts
observedAt: market.observedAt ?? systemClock.now(),
tier: market.observedAt === null ? "SECONDARY" : "PRIMARY",
freshnessSeconds: 0,   // ← "eine bewusste Einstufung, keine Erfindung"
```

Der Kommentar war gut gemeint und trotzdem unwahr. **Eine 0 ist keine
Einstufung, sie ist eine Messung, die nie stattgefunden hat** — und der Gate
hätte sie geglaubt, weil 0 < 120.

### Zwei Zeitstempel, die man nicht verwechseln darf

| | Bedeutung | Bei DexScreener |
|---|---|---|
| `observedAt` | wann **wir** es wussten — der PIT-Stempel | Abrufzeitpunkt |
| `freshnessSeconds` | wie alt es beim Abruf **war** | **`null`** |

Der Abrufzeitpunkt als PIT-Stempel ist korrekt und erzeugt kein Look-Ahead: wir
wussten es dann, und vorher nachweislich nicht. Es ist nur eine *schwächere*
Aussage. Was daraus nicht folgt, ist eine Aussage über das Alter — und genau
die wurde vorher mitgeliefert.

`sourced()` nimmt deshalb jetzt `providerObservedAt: Date | null` als
**Pflichtfeld**. Wer eine Quelle anbindet, muss sagen, ob sie ein Datenalter
mitliefert. Ein weglassbares Feld wäre ein stiller Weg zurück zur 0.

### Die Historie darf mehr sehen als die Entscheidung

Dieselbe Unterscheidung wie `allowDegraded` in der Anbieterkette:

- **`decideIngest`** nimmt Daten ohne Datenalter auf. Ohne das gäbe es nie eine
  Zeitreihe, und der Snapshot trägt ohnehin einen korrekten PIT-Stempel.
- **`snapshotSupportsEntry`** lehnt sie ab: *„Anbieter liefert kein Datenalter.
  Unbekannt ist nicht frisch."*
- **`assessMarketData`** kennt dafür das eigene Urteil `UNKNOWN_AGE` — getrennt
  von `STALE`, weil „zu alt" und „Alter unbekannt" zwei verschiedene Befunde
  mit zwei verschiedenen Gegenmaßnahmen sind.
- **`selectMarket`** trägt `requireProviderTimestamp`, Vorgabe `true`. Wer die
  Historie füllt, schaltet es ausdrücklich ab — nicht umgekehrt.

`combineSources` gibt `effectiveFreshnessSeconds: null` zurück, sobald **ein**
Beitragender kein Alter mitliefert. `Math.max` mit einem `null` darin hätte
stillschweigend 0 ergeben — ein Datensatz, dessen eine Hälfte beliebig alt sein
könnte, ist nicht so frisch wie seine jüngere Hälfte.

### Was das praktisch heißt

**DexScreener baut Historie auf und erzeugt keine Einstiegsentscheidung.** Das
ist kein Mangel der Implementierung, sondern eine Eigenschaft der Quelle.
Paper Trading bleibt damit bei null Opportunities, bis eine Quelle mit
verifizierbarem Zeitstempel dazukommt — ein Solana-RPC liefert mit
`context.slot` genau das, und zwar kostenlos.

Der Snapshot-Pfad im Smoke-Test wählt seinen Markt jetzt außerdem über
`selectMarket` statt über `markets[0]`.

## 83. Ein Migrationsweg, nicht zwei

`scripts/migrate.sh` spielte die SQL-Dateien in einer Schleife per `psql` ein:

```bash
for file in packages/db/migrations/*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$file"
done
```

Das wendet die Migrationen an — und aktualisiert Drizzles Journal
(`__drizzle_migrations`) nicht. Wer das Skript benutzt hat, hatte danach ein
migriertes Schema, das `drizzle-kit migrate` für vollständig unmigriert hält.
Der nächste Lauf in CI oder über den GitHub-Workflow hätte alles erneut
gefahren.

**Zwei Wege, die dieselbe Datenbank unterschiedlich beurteilen, sind schlimmer
als ein Weg, der fehlt.** Dasselbe Muster wie die Timescale-Datei in
Entscheidung 78: eine Datei im Migrationsordner, die nie im Journal stand, hat
zweimal die Frage ausgelöst, ob das Schema vollständig ist.

Es gibt jetzt genau einen Migrationsweg — `drizzle-kit migrate` —, und alle
drei Aufrufer benutzen ihn:

| Aufrufer | Zweck |
|---|---|
| `scripts/migrate.sh` | lokal, von Hand |
| `docker/docker-compose.yml` | lokaler Stack |
| `.github/workflows/db-migrate.yml` | produktiv, mit Bestätigung |

Das Skript prüft zusätzlich auf `-pooler` im Endpunkt — als **Warnung**, nicht
als Abbruch. Lokal gibt es keinen Pooler, und wer bewusst einen benutzt, soll
es merken statt blockiert zu werden. Der GitHub-Workflow bricht an derselben
Stelle hart ab, und das ist dort richtig: produktives DDL über einen
Transaction-Mode-Pooler ist nicht zuverlässig.

### Ein Folgefehler aus dem eigenen Aufräumen

Beim Entfernen des Redis-Dienstes aus `docker/docker-compose.yml` blieb
`scripts/dev-up.sh` stehen mit:

```bash
docker compose ... up -d postgres redis
```

Der Dienst existierte nicht mehr, das Kommando wäre sofort gescheitert — und
mit ihm das einzige Skript, das die README als lokalen Einstieg nennt. Ein
Aufräumen, das die Aufrufer nicht mitzieht, verschiebt den Fehler nur an eine
Stelle, an der ihn niemand sucht.

## 84. Das System sagte zwei Dinge über sich selbst

Der erste echte Lauf des `provider-health`-Dienstes auf Railway lieferte über
`/api/diagnostics/providers` in **derselben Antwort**:

```json
"headline": "NO PROVIDER CONFIGURED",
"anyProductionVerified": false,
"healthSamples": [{ "providerId": "dexscreener", "status": "CONNECTED",
                    "latencyMsP95": 12, "lastSuccessAt": "..." }]
```

Der Anbieter war nachweislich verbunden — 12 ms Latenz, echter Erfolg — und
die Überschrift meldete, es sei keiner konfiguriert.

**Zwei Tabellen, zwei Wahrheiten:**

| Aussage | Tabelle | Wer schrieb sie |
|---|---|---|
| `CONNECTED` | `provider_status_samples` | der `provider-health`-Dienst |
| `NO PROVIDER CONFIGURED` | `provider_capability_status` | **nur die Smoke-Test-Skripte** |

Die Skripte werden von Hand gestartet. Also nie. Die Bereitschaftstabelle blieb
leer, während die Messreihe im Minutentakt volllief.

Das ist die gefährlichere Sorte Fehler: nichts stürzt ab, nichts ist rot, und
wer aufs Dashboard sieht, sucht einen Konfigurationsfehler, den es nicht gibt.

### Die Messung füllt jetzt beide

`sampleProviderHealth` nimmt optional einen `ProviderReadinessStore` und trägt
einen erfolgreichen Abruf dort ebenfalls ein — `declare` legt die Zeile an,
`recordSmokeTest` verbucht den Lauf.

`schemaVerified: true` ist dabei keine Bequemlichkeit: der Vertrag stammt seit
dem 2026-09-03 aus einer echten Antwort. Ohne ihn wäre `false` richtig und der
Anbieter bliebe unterhalb `CAPABILITY_READY`.

**Ein echter Abruf gegen einen geprüften Vertrag IST der Nachweis, den
`productionVerified` behauptet.** Es gibt keinen Grund, dafür auf ein Skript zu
warten, das jemand von Hand starten muss — und der Zustand, der dabei entsteht,
ist derselbe.

Der Parameter ist optional, damit Tests ohne Datenbank auskommen. Beide echten
Aufrufer — die Rolle und der Job-Handler — übergeben ihn.

## 85. Watchlist ist Konfiguration, nicht Discovery

Der `provider-health`-Dienst erreichte DexScreener nachweislich — und die
Marktdaten-Aufnahme hätte trotzdem dauerhaft `NO_TOKENS` gemeldet. Die
`tokens`-Tabelle war leer, weil die `discovery`-Rolle ein ausdrücklicher
Platzhalter ist:

```
"Rolle gestartet (Phase-1-Platzhalter, keine Logik)"
```

**Ein Bot, der korrekt nichts tut, ist von einem kaputten schwer zu
unterscheiden.** Und ohne einen einzigen Snapshot bleibt alles dahinter leer:
Historie, Features, Paper, Forschung.

Die Watchlist schließt diese Lücke, ohne die Discovery vorwegzunehmen. Der
Unterschied ist inhaltlich:

| | |
|---|---|
| **Discovery** | findet Token, die niemand kannte — braucht eine Quelle, die es noch nicht gibt |
| **Watchlist** | eine Entscheidung, die jemand getroffen und aufgeschrieben hat |

`WATCHLIST_MINTS` ist deshalb eine Umgebungsvariable und kein Provider. Sie
wird beim Start des Schedulers angewendet — dort, weil sie keine Discovery ist
und weil sie so ohne einen vierten Dienst wirksam wird.

### Nichts wird behauptet

Die Token bekommen `state = DISCOVERED`, `discovery_source = WATCHLIST` und
sonst nichts: kein Symbol, kein Preis, keine Bewertung. Ob sie handelbar sind,
entscheidet dieselbe Kette wie für jeden anderen Token.

Ein bereits bekannter Token wird nicht zurückgesetzt (`onConflictDoNothing` auf
`mint`) — findet die Discovery ihn später selbst, behält er seine Herkunft.

Ungültige Adressen werden **gemeldet, nicht geschluckt**: ein Tippfehler soll
beim Start auffallen und nicht dadurch, dass ein Token nie Daten bekommt.

### `tokens.decimals` musste nullable werden

Die Spalte war `NOT NULL` ohne Vorgabewert. Weder Watchlist noch Discovery
kennen die Dezimalstellen — sie stehen im Mint-Account on-chain, nicht in einer
Marktdaten-Antwort oder einer Konfiguration.

Der Zwang zu einem Wert hätte bedeutet, einen zu erfinden. **Eine erfundene
Dezimalstelle ist im Ausführungspfad ein Betragsfehler um Zehnerpotenzen** —
die teuerste Sorte stiller Fehler in diesem System. `null` heißt hier
UNBEKANNT, und keine Zeile Code liest die Spalte heute.

Migration `0011_tokens_decimals_nullable.sql`, verifiziert gegen echtes
PostgreSQL 16: 11 Migrationen von Null angewendet, 61 Tabellen, ein Token ohne
Dezimalstellen einfügbar.

Drizzle hätte die Datei `0010_chief_the_stranger.sql` genannt — numerisch
kollidierend mit `0010_decisions_observations.sql`, weil `0001` seit
Entscheidung 78 fehlt und Drizzle nach Journal-Index nummeriert. Funktional
egal (Drizzle sortiert nach Journal), für einen Menschen aber genau die Frage,
die in Entscheidung 78 schon zweimal Zeit gekostet hat. Deshalb umbenannt, Tag
im Journal mitgezogen.

## 86. Die Discovery-Quelle — das eine fehlende Interface

Sieb, Deduplizierung, Bewertung und Entscheidung waren seit Phase 1 gebaut und
getestet. Es kam nur nie etwas an: `DiscoveryRunInput.sources` blieb leer, weil
niemand `DiscoverySource` implementiert hatte. **Ein Kriterium ist ein Sieb, und
ein Sieb braucht jemanden, der Sand hineinschüttet.**

Drei Endpunkte geprüft (echte Antworten vom 2026-09-06):

| Endpunkt | Wurzel | Marktdaten | Taugt als Quelle |
|---|---|---|---|
| `/token-profiles/latest/v1` | nacktes Array | **keine** | ja, mit Anreicherung |
| `/token-boosts/latest/v1` | nacktes Array | keine | nein — bezahlte Bewerbung |
| `/latest/dex/search?q=` | `{schemaVersion, pairs}` | vollständig | nein — braucht Suchbegriff |

Gewählt: **token-profiles**, in zwei Aufrufen.

1. Der Strom liefert **Adressen** — Kette, Adresse, Bild, Marketingtext. Kein
   Preis, keine Liquidität, kein Alter.
2. Die Marktdaten kommen aus dem bereits geprüften
   `/tokens/v1/solana/{adressen}`, in Bündeln zu 30.

Der erste Aufruf allein wäre wertlos und gefährlich zugleich: **ein Bot, der nur
Schritt 1 kennt, handelt Werbetexte.**

`token-boosts` wurde bewusst verworfen. „Boost" heißt, jemand hat für Sichtbarkeit
bezahlt. Das als Signal zu lesen wäre adverse Selektion mit zusätzlichen Schritten.

### Zwei Befunde, die frühere Schlüsse korrigieren

**`marketCap` und `fdv` existieren.** Ihr Fehlen in der Wrapped-SOL-Stichprobe
(§81) war ein Sonderfall dieses Tokens, keine Eigenschaft der API.
`REQUIRED_FOR_ENTRY` bleibt unverändert.

**Weiterhin kein Beobachtungszeitpunkt**, in keinem der drei Formate. Zum
dritten Mal bestätigt.

### `since` wird nicht als Filter benutzt

Der Strom trägt keinen Zeitstempel je Eintrag. Nach `since` zu filtern hieße,
eine Zeitangabe zu erfinden, die es nicht gibt. Die Deduplizierung der Engine
erledigt, was `since` erledigen sollte — sie kennt bereits gesehene Adressen.

### Der Ausfall ist ein eigener Zustand

Antwortet der Strom nicht, liefert die Quelle `Missing` mit Grund aus dem Kern
(`PARSE_FAILED`, `PROVIDER_RATE_LIMITED`, `PROVIDER_DOWN`) — **nicht** eine
leere Liste. Die Engine kann ihn dann als ausgefallene Quelle benennen, statt
die Abdeckung stillschweigend für vollständig zu halten.

### Was die Stichprobe über die Notwendigkeit des Siebs sagt

In der Suchantwort standen mehrere Token namens „Solana"/„SOL" mit
**2,1 Mrd. USD gemeldeter Liquidität und 17 USD Tagesumsatz**. Das ist keine
dünne Datenlage, das ist eine Attrappe. Solche Einträge kommen durch die
Discovery durch — und fallen im Vorsieb und in `selectMarket`
(`TURNOVER_IMPLAUSIBLE`, `LIQUIDITY_TOO_LOW`).

### Die eigene Lint-Regel hat mitgelesen

Der erste Entwurf der Anreicherung verglich Pools mit
`(previous ?? 0) >= (candidate ?? 0)`. Damit hätte ein Pool mit **unbekannter**
Liquidität gegen jeden bekannten verloren, als wäre sein Wert 0.
`sae/no-numeric-fallback` hat es abgefangen. Derselbe Fehler wie überall sonst,
nur an einer unscheinbaren Stelle — und genau dafür gibt es die Regel.

## §87 — Die Discovery ist verdrahtet: der Bot findet jetzt selbst Token

Bis hierher war die Kette an ihrem **Anfang** unterbrochen, und zwar an einer
unauffälligen Stelle. Quelle, Vorsieb, Deduplizierung und Zustandspflege
existierten einzeln und getestet — nur rief sie niemand zusammen auf:

```
DISCOVER_TOKENS: market("Token-Entdeckung"),
```

Der Auftrag lief in denselben generischen Handler wie jede andere
Marktdatenarbeit. Der suchte einen Mint im Auftrag, fand keinen — der
Discovery-Auftrag trägt keinen, er ist der, der Mints **erzeugt** — und meldete
`NO_SOURCE`. Korrekt und nutzlos zugleich. Dahinter stand die Folgekette:
`tokens` blieb leer, `refreshMarketData` meldete dauerhaft `NO_TOKENS`, keine
Snapshots, keine Historie, keine Features, kein Paper Trading.

### Der Weg, den ein Token jetzt nimmt

```
scheduler → Takt FAST_DISCOVERY (30 s) → Auftrag DISCOVER_TOKENS
          → job_queue → consumer → runTokenDiscovery
          → DexScreener token-profiles + tokens/v1 → cheapScreen → tokens
```

Bewusst **über die Queue** und nicht als eigener Dienst. Die Rolle
`WORKER_ROLE=discovery` bleibt leer und sagt das beim Start auch. Liefe die
Discovery zusätzlich dort, gäbe es zwei Takte für dieselbe Arbeit: doppelte
Anbieteranfragen, und zwei Prozesse, die gleichzeitig dieselben Zeilen anlegen
wollen. Der Unique-Index auf `mint` fängt das ab — die Anfragen wären dann aber
schon verbraucht.

### Die Zeile entsteht vor dem Sieb, nicht danach

`TokenSeenStore.add` schreibt in `tokens`, **bevor** `cheapScreen` urteilt. Das
ist Absicht: was das System gesehen hat, soll es auch dann noch wissen, wenn es
den Token gleich darauf verwirft — sonst fände es ihn beim nächsten Takt erneut,
fragte erneut Marktdaten ab und verwürfe erneut. Der Zustand der Zeile sagt
anschließend, was das Sieb entschieden hat:

| Ergebnis | Zustand | Warum nicht anders |
|---|---|---|
| durch das Vorsieb | `SCREENING` | **nicht** `CANDIDATE` — das Vorsieb bewertet ausdrücklich nicht. Ein Token, das es passiert, ist nur nicht offensichtlich ungeeignet. |
| vorerst gescheitert | `WATCHLIST` | Diese Gruppe ist später die Kontrollgruppe. Ohne sie beruht jede Faktoranalyse ausschließlich auf dem, was wir gehandelt haben. |
| endgültig gescheitert | `REJECTED` | Bliebe die Zeile auf `DISCOVERED`, sähe sie aus wie ein Token, den noch niemand geprüft hat. |

Das Zustandsschreiben greift nur bei `state = 'DISCOVERED'`. Ein Watchlist-Token,
der schon `SCORED` ist und den die Discovery ein zweites Mal meldet, darf nicht
auf `SCREENING` zurückfallen — er würde die Kette von vorn durchlaufen und dabei
seine Bewertung verlieren.

### Die Lücke, die dieser Lauf offenlegt

`cheapScreen` prüft Mint- und Freeze-Authority. Beide stehen im Mint-Account
on-chain, und dafür gibt es **kein geprüftes Lesemodul**. Sie sind also
UNBEKANNT — und `cheapScreen` lehnt bei Unbekanntem nicht ab:

```ts
if (isPresent(input.mintAuthorityActive) && input.mintAuthorityActive.value)
```

**Das ist eine echte Abschwächung des Siebs.** Ein Token mit aktiver
Mint-Authority — also beliebig nachprägbar — kommt hier durch. Das wird nicht
weggeschrieben, sondern gezählt (`withoutAuthorityCheck`) und einmal je Lauf als
Warnung geloggt.

Was ihn **nicht** durchlässt, ist die Einstiegsentscheidung: `securityScore`
gibt ohne Mint-Authority, Freeze-Authority und Top-10-Anteil `notComputable`
zurück, die Datenvollständigkeit fällt unter `minDataCompleteness`, und das harte
Gate lehnt mit `DATA_INCOMPLETE` ab. Die Sicherheit hängt also nicht am Vorsieb.
`DiscoveryRunDeps.checkAuthorities` ist die ausgewiesene Naht, an der das
RPC-Lesemodul später hängt.

Der Fehlgrund ist `NOT_YET_COLLECTED` und ausdrücklich **nicht**
`NOT_SUPPORTED_BY_PROVIDER`: die Angabe ist abrufbar, sie wurde nur nicht
abgerufen. Der Unterschied entscheidet später, ob jemand nach einem anderen
Anbieter sucht oder das fehlende Modul baut.

### Zwei Folgen, die man leicht übersieht

**Die Tokenauswahl von `market-refresh` musste gefiltert werden.** Solange die
Tabelle klein war, war ein ungefiltertes `SELECT … LIMIT 500` unschädlich. Mit
laufender Discovery ist es das nicht mehr: jeder Durchlauf legt Zeilen an, die
das Vorsieb im selben Durchlauf verworfen hat. Sie weiter abzufragen kostet
Anbieterbudget für Tokens, gegen die sich das System bereits entschieden hat.
`selectTrackedTokens` schließt gesperrte und `REJECTED`-Tokens aus und ordnet
nach `first_seen_at DESC` — ohne Ordnung entscheidet PostgreSQL, welche Zeilen
der Deckel abschneidet, und das untergräbt den Wiederaufnahme-Checkpoint.
`WATCHLIST` bleibt ausdrücklich drin.

**Die Log-Allowlist hatte eine Lücke, und zwar eine ältere.** `added` und `known`
aus der Watchlist (§86) standen nie darauf; die Startmeldung lautete
entsprechend `Watchlist angewendet added: [redacted]`. Gefunden nicht durch
Hinsehen, sondern mit einem Skript, das alle `logger.*({…})`-Aufrufe gegen die
Liste hält. Dritter Durchgang, dritte Lücke — deshalb diesmal maschinell.

### Was der Lauf ausdrücklich nicht tut

Er schreibt Zeilen in `tokens` und sonst nichts. Keine Handelsentscheidung,
keine Gelegenheit, keine Position. Eine Discovery-Quelle sagt „diesen Token gibt
es und er ist mir aufgefallen", nicht „er ist gut" — die Vermischung beider
Rollen ist der Grund, warum viele Bots handeln, was gerade auf einer Liste steht.

## §88 — 9424 offene Aufträge: warum der erste Consumer sie nicht abarbeiten darf

Der Infrastruktur-Check nach der Migration meldete beiläufig: **Queue 9424 offen
/ 0 Dead Letter.** Das ist kein Fehler, sondern die Buchführung von rund neun
Stunden, in denen der Scheduler einreihte und kein Consumer lief — der
`consumer`-Dienst existiert auf Railway noch nicht.

Rechnet man die Takte zusammen (10 s bis 6 h, in Summe ~1100 Aufträge je
Stunde), passt die Zahl auf die Stunde genau. Darunter rund **1030
`DISCOVER_TOKENS`**.

### Warum das ein Problem ist

Seit §87 macht jeder dieser Aufträge zwei echte DexScreener-Anfragen. Der erste
Consumer hätte sie **älteste zuerst** abgearbeitet — `claim` ordnet nach
`priority, run_after` — und dabei in wenigen Minuten rund **zweitausend
Anfragen** abgesetzt. DexScreener drosselt bei deutlich weniger. Der erste echte
Lauf des Systems hätte wie ein Defekt ausgesehen.

Schlimmer als die Drosselung ist aber, was diese Aufträge überhaupt getan
hätten: **nichts Neues.** Ein Discovery-Takt für das Zeitfenster „gestern 14:30"
holt keine Daten von gestern. Er holt die von jetzt — genau wie die 1029 anderen
direkt davor und danach.

### Die Regel

Periodische Aufträge sind Momentaufnahmen. Liegen fünf gleiche offen, ist der
älteste nicht vier Arbeitsschritte wert.

> **Existiert ein neuerer offener Auftrag derselben Art mit derselben Nutzlast,
> ist der ältere überholt.** Genau einer je (Art, Nutzlast) bleibt stehen — der
> neueste.

Ausdrücklich **keine** Zeitschwelle. Eine müsste je Takt anders sein (zehn
Sekunden bis sechs Stunden) und wäre damit eine zweite Stelle, an der
Taktintervalle gepflegt werden — und die erste, die beim nächsten neuen Takt
vergessen wird.

Die **Nutzlast** gehört in den Vergleich: bei tokenbezogenen Aufträgen
(`SCORE_TOKEN` mit einem Mint) wären sonst zwei verschiedene Tokens „dieselbe
Arbeit", und einer fiele still weg. `jsonb` vergleicht
schlüsselordnungsunabhängig.

`retireSuperseded` läuft im Consumer-Zyklus **vor** dem Ziehen. Danach wäre es
sinnlos: der Zyklus hätte sich gerade die ältesten und damit überholten
Aufträge geholt.

### `DONE`, nicht `DEAD`

Hier ist nichts fehlgeschlagen. Das Dead Letter mit tausenden Nicht-Fehlern zu
füllen würde die echten darin unsichtbar machen — und das Dead Letter ist die
Stelle, an der man nachsieht, wenn etwas kaputt ist.

Verschwinden tut trotzdem nichts: der Zustand ist `DONE`, im `result` steht
`{"status":"SUPERSEDED"}` mit Begründung, und der Fensterschlüssel wandert in
`job_queue_history` — sonst könnte derselbe Takt erneut eingereiht werden und
der Rückzug hätte nur den nächsten Durchlauf verschoben.

### Was beim ersten Start passiert

Ein Statement, ein Durchlauf: aus 9424 offenen Aufträgen werden etwa neun — je
Auftragsart der neueste. Keine Anbieteranfrage dafür, kein Dead Letter, und die
9415 zurückgezogenen bleiben mit Begründung nachlesbar.

## §89 — Der Torwächter war richtig gebaut. Er bekam nur nie ein `null` zu sehen.

Gefunden beim Nachsehen, warum im Log des ersten laufenden Consumers keine
Zeile zu den Marktdaten stand. Der Fehler daneben war der ernstere.

`market-refresh.ts` berechnete die Frische eines Snapshots so:

```ts
freshnessSeconds:
  (input.provenance.sourceTimestamp.getTime() -
   input.provenance.dataTimestamp.getTime()) / 1_000,
```

Beide Werte sind im Live-Pfad **unsere eigene Uhr**. `dataTimestamp` ist
`Sourced.observedAt` — und das ist ausdrücklich „UNSERE Kenntniszeit", nicht
der Messzeitpunkt des Anbieters. `sourceTimestamp` ist `clock.now()` im selben
Abruf. Die Differenz war deshalb immer ~0.

**Jeder Snapshot von DexScreener wurde als „null Sekunden alt" gespeichert.**
Für eine Quelle, die überhaupt keinen Zeitstempel liefert.

### Warum das die gefährlichste Stelle war

Der Torwächter `snapshotSupportsEntry` ist seit jeher richtig gebaut und trägt
den Kommentar:

> „Der Fall, den DexScreener erzwingt: die Quelle liefert keinen
> Beobachtungszeitpunkt, also ist das Alter unbekannt. Unbekannt ist nicht
> frisch. **Hier 0 anzunehmen hiesse, die Pruefung abzuschaffen und sie
> gleichzeitig bestanden zu melden.**"

Genau das ist passiert — nur nicht im Torwächter, sondern zwei Schichten davor.
Er prüfte korrekt auf `null`, bekam aber immer eine 0.

Damit war die Freshness-Prüfung für Einstiegsentscheidungen **faktisch
abgeschaltet**, und zwar unsichtbar: kein Fehler, kein Log, kein Test schlug an.
Die Ablehnung, mit der ich gerechnet hatte („kein Paper Trading, weil
UNKNOWN_AGE"), wäre nie gekommen.

### Warum keine Lint-Regel das fangen konnte

`sae/no-numeric-fallback` sucht `?? 0`. Hier stand kein Ersatzwert, sondern eine
Subtraktion zweier Daten — syntaktisch unauffällig. Der Fehler saß nicht im
Ausdruck, sondern in der **Bedeutung der beiden Operanden**, und die stand nur
im Kommentar an `Sourced.observedAt`.

Die Lehre ist nicht „mehr Regeln", sondern: an einer Grenze, die einen Wert
nicht durchreicht, wird er irgendwann neu erfunden. `MarketInputResult` trug
`sourceTimestamp` und `dataTimestamp`, aber nicht das echte `freshnessSeconds`
aus `Sourced`. Wer es brauchte, musste es sich bauen.

### Die Korrektur

`MarketInputResult` trägt jetzt `freshnessSeconds: number | null` und reicht
den Wert **unverändert** aus `Sourced` durch. `market-refresh` rechnet nicht
mehr, sondern übernimmt.

Beim Test-Fixture bleibt die Differenz stehen und ist dort auch richtig: `asOf`
ist ein angegebener Datenzeitpunkt und nicht unsere Abrufzeit.

Festgenagelt in `freshness-honesty.test.ts`, drei Zusicherungen: die Kette
meldet `null`, der Torwächter lehnt bei `null` ab und würde bei `0` freigeben,
und in der Spalte `source_freshness_seconds` steht `NULL`. Gegengeprüft — mit
der alten Zeile schlägt der dritte Test mit `expected +0 to be null` fehl.

### Was in der Datenbank steht

Alle Snapshots, die zwischen dem Start des ersten Consumers und diesem Commit
geschrieben wurden, tragen `source_freshness_seconds = 0`. Das sind echte
Marktdaten mit einer erfundenen Altersangabe. Sie zu korrigieren ist ein
`UPDATE … SET source_freshness_seconds = NULL` auf genau diese Zeilen — eine
Entscheidung des Betreibers, keine, die dieser Commit trifft.

### Dieselbe Zeile stand zweimal da

Nach dem Fund in `market-refresh` habe ich nach dem Muster gesucht statt es
für einen Einzelfall zu halten. `opportunity-pipeline.ts` rechnete genauso —
und dort wiegt es schwerer: der Wert geht direkt in `planBranches` und damit in
die Entscheidung, ob eine Position eröffnet wird.

Beide Stellen reichen jetzt durch. Eine Suche nach `sourceTimestamp.getTime() -`
findet keine weitere.

Dass beide Stellen unabhängig voneinander dieselbe falsche Rechnung erfanden,
ist der eigentliche Befund: die Grenze lud dazu ein. Sie tut es nicht mehr.

### Nebenbefund: die Zeile stand auf `debug`

`„Marktdaten aufgefrischt"` wurde mit `logger.debug` geschrieben und war im
Betrieb damit unsichtbar — ausgerechnet die Meldung, an der man abliest, ob
Snapshots entstehen. Sie steht jetzt auf `info`, sobald der Lauf Tokens
angefasst hat, und bleibt sonst leise.

## §90 — `noSource: 9` sagt DASS, nicht WARUM

Der erste Auffrischungslauf mit echten Tokens meldete:

```
Marktdaten aufgefrischt   processed: 11  ingested: 2  noSource: 9
```

Neun von elf Token lieferten keine Marktdaten — und das Log verschwieg, warum.
Dabei ist der Grund im System vorhanden und präzise: `selectMarket` gibt zu
jedem verworfenen Pool eine `MarketRejection` zurück (`POOL_TOO_YOUNG`,
`TURNOVER_IMPLAUSIBLE`, `UNUSABLE_QUOTE`, `LIQUIDITY_TOO_LOW`, …).

Er wurde an **drei** Stellen hintereinander weggeworfen:

1. Der Adapter kann nur `null` zurückgeben — `MarketDataAdapter.fetchMarket`
   hat keinen Platz für eine Begründung.
2. Die Kette macht daraus `NO_DATA`.
3. `refreshMarketData` zählt `noSource += 1`.

Ohne diese Auskunft ist die wichtigste Betriebsfrage nicht beantwortbar:
**Ist 2 von 11 das gewollte Verhalten eines strengen Filters — oder ein
Fehler?** Beides sieht im Log identisch aus, und die Antwort entscheidet, ob
der Bot je handeln kann.

### Warum keine Vertragsänderung

`MarketDataAdapter` gilt für **alle** Anbieter. Eine Auswahlbegründung ist eine
Eigenheit genau eines von ihnen; sie in den gemeinsamen Vertrag zu heben würde
jeden künftigen Adapter zwingen, ein Feld zu füllen, das ihn nichts angeht.

Statt dessen eine **Ablage, die der Aufrufer besitzt**: der Consumer legt sie
an, gibt sie dem Adapterbau mit, und `refreshMarketData` leert sie nach jedem
Lauf in eine Log-Zeile. Der Adapter trägt ein, wenn er nichts wählen konnte.
Fehlt die Ablage, fällt nur die Begründung weg — nichts am Verhalten.

Kein gemeinsam genutzter Zustand über Prozessgrenzen: die Aufträge laufen im
Consumer-Zyklus nacheinander (`for (const job of claimed)`), es kann sich also
nichts vermischen. Das Leeren beim Auslesen ist getestet — ohne es summierte
sich der Zähler über alle Läufe auf und jede Zeile meldete die Gründe von
gestern mit.

### „Kein Pool" ist nicht „abgelehnter Pool"

Meldet DexScreener zu einem Token gar keinen Pool, steht `NO_POOL_REPORTED`
statt einer Ablehnung. Beides als „kein Markt" zu zählen wäre richtig, aber
nicht auskunftsfähig: das eine heißt „unser Filter war streng", das andere
„der Anbieter kennt den Token nicht".

### Was die Zahlen noch nicht sagen

Zum Zeitpunkt dieses Commits ist **nicht bekannt**, welche Gründe die neun
Ablehnungen tragen. Die Vermutung liegt bei `POOL_TOO_YOUNG` (die Auswahl
verlangt 15 Minuten, das Vorsieb der Discovery nur 5) und
`TURNOVER_IMPLAUSIBLE` (Volumen über dem 50-fachen der Liquidität — bei
frischen Memecoins keine Seltenheit). Das ist eine Hypothese und steht hier
ausdrücklich als solche. Der nächste Lauf beantwortet es mit Zahlen.

## §91 — Die Allowlist frisst die Zahlen einer Auszählung

Der erste Lauf mit der neuen Begründung (§90) meldete:

```
noSourceReasons: NO_LIQUIDITY_REPORTED, POOL_TOO_YOUNG, UNUSABLE_QUOTE,
                 LIQUIDITY_TOO_LOW, NO_POOL_REPORTED
```

Fünf Gründe — und **keine einzige Zahl**. Also genau die Hälfte der Auskunft,
um die es ging: „welcher Grund trifft wie oft zu" bleibt unbeantwortet.

Nachgestellt und bestätigt:

```
redact({ noSourceReasons: { POOL_TOO_YOUNG: 4 } })
→ { noSourceReasons: { POOL_TOO_YOUNG: "[redacted]" } }
```

`redact` prüft **jeden** Schlüssel gegen die Allowlist, auch die in
verschachtelten Objekten. Das ist richtig so und der Grund, warum die
Allowlist funktioniert. Nur: bei einem Histogramm sind die Schlüssel **Daten**
und keine Feldnamen.

### Warum die Gründe nicht auf die Allowlist gehören

Naheliegend wäre, `POOL_TOO_YOUNG` und die anderen aufzunehmen. Das wäre
falsch: es sind **offene Wertemengen** — Ablehnungsgründe, Fehlerklassen,
Anbieternamen, Auftragsarten. Die Liste wäre beim nächsten neuen Grund wieder
unvollständig, und die Lücke fiele wieder erst im Betrieb auf. Das ist
derselbe Fehler wie in §87, nur eine Ebene tiefer.

Die richtige Form ist ein **String unter einem erlaubten Feldnamen**:

```
noSourceReasons: "UNUSABLE_QUOTE=7 NO_POOL_REPORTED=4 POOL_TOO_YOUNG=4"
```

`tally()` in `@sae/observability` macht das, sortiert nach Häufigkeit und bei
Gleichstand alphabetisch — damit dieselbe Auszählung immer gleich aussieht und
zwei Zeilen vergleichbar sind. Verwendet an beiden Stellen, die auszählen:
Marktauffrischung und Discovery-Lauf.

### Was die Gründe schon jetzt sagen

Meine Vermutung aus §90 war **falsch**. `TURNOVER_IMPLAUSIBLE` kommt gar nicht
vor. Tatsächlich aufgetreten sind:

| Grund | Bedeutung |
|---|---|
| `UNUSABLE_QUOTE` | Pool handelt nicht gegen SOL/USDC/USDT — kein verankerter USD-Preis |
| `POOL_TOO_YOUNG` | Jünger als 15 Minuten |
| `LIQUIDITY_TOO_LOW` / `NO_LIQUIDITY_REPORTED` | Zu dünn oder ohne Angabe |
| `NO_POOL_REPORTED` | DexScreener kennt zum Token gar kein Paar |

Alle vier sind **gewollte Ausschlüsse**, keine Fehler. Dass die Vermutung
danebenlag, ist der Beleg dafür, dass die Messung nötig war und nicht die
Schätzung.

## §92 — `UNUSABLE_QUOTE=10`: der Grund allein entscheidet nichts

Mit den Zahlen aus §91 sieht der erste vollständige Befund so aus:

```
processed: 25   ingested: 6   noSource: 19
noSourceReasons: UNUSABLE_QUOTE=10 NO_LIQUIDITY_REPORTED=6 NO_POOL_REPORTED=…
```

`UNUSABLE_QUOTE` ist der größte Einzelposten. Zuerst geprüft und
**ausgeschlossen**: vertauschte Handelspaare. `selectMarket` testet
`WRONG_BASE_TOKEN` **vor** `UNUSABLE_QUOTE`, und `WRONG_BASE_TOKEN` kommt in
der Auszählung nicht vor. Die zehn Pools handeln also tatsächlich mit unserem
Token als Basis gegen eine Gegenwährung, die nicht SOL, USDC oder USDT ist.

### Warum das noch keine Antwort ist

Zwei völlig verschiedene Welten erzeugen dieselbe Zahl:

- **Zehn Pools gegen EINE Gegenwährung.** Dann fehlt uns womöglich ein
  legitimer Anker, und ein einziger Eintrag in `USD_ANCHOR_QUOTE_MINTS` würde
  die nutzbare Datenmenge deutlich erhöhen.
- **Zehn Pools gegen ZEHN verschiedene Memecoins.** Dann hat der Filter recht,
  es gibt nichts zu tun, und jede Lockerung würde Preise hereinlassen, die an
  der Bewertung der Gegenseite hängen.

Ohne Auszählung sehen beide identisch aus. Also wird ausgezählt, statt geraten
— dieselbe Lehre wie in §90, wo die Vermutung (`TURNOVER_IMPLAUSIBLE`) sich
als schlicht falsch herausstellte.

`unusableQuotes` steht jetzt neben `noSourceReasons` und nennt die
Gegenwährung: das Symbol aus der Anbieterantwort, ersatzweise die Adresse.

### Symbole sind fremder Text

Das Symbol wählt der Token-Ersteller. Ein Zeilenumbruch darin zerlegt eine
Log-Zeile in zwei, und die zweite sieht aus wie ein eigenständiger Eintrag —
die billigste Art, eine Aufzeichnung unglaubwürdig zu machen. `safeLabel`
lässt nur Buchstaben, Ziffern, Punkt, Bindestrich und Unterstrich durch und
kürzt auf 16 Zeichen. Ein Test füttert bewusst ein Symbol, das eine gefälschte
Erfolgsmeldung enthält.

### Was das Feld NICHT tut

Es lockert nichts. Die Entscheidung, ob ein weiterer Anker zugelassen wird,
bleibt eine bewusste Änderung an `USD_ANCHOR_QUOTE_MINTS` — mit der Begründung
in dieser Datei. Ein Messwert ist keine Erlaubnis.

## §93 — Die Messung ist eindeutig: der Filter bleibt, wie er ist

Antwort auf die offene Frage aus §92:

```
processed: 25   ingested: 7   noSource: 18
noSourceReasons: UNUSABLE_QUOTE=7 LIQUIDITY_TOO_LOW=5 NO_LIQUIDITY_REP…
unusableQuotes:  ANTHROPIC=1 ARB=1 BRK.Bx=1 HOODx=1 NVDAx=1 PLTRx=1 ZE…
```

**Jede Gegenwährung kommt genau einmal vor.** Von den beiden Welten aus §92 ist
es damit belegt die zweite: sieben Pools gegen sieben verschiedene
Gegenseiten, kein wiederkehrender Anker, den wir übersehen hätten.

**Entscheidung: `USD_ANCHOR_QUOTE_MINTS` bleibt unverändert.** Ein Eintrag
mehr würde hier genau einen Pool zusätzlich zulassen und dafür die Zusicherung
aufgeben, dass jeder Preis an einem stabilen Anker hängt.

### Was in den Namen steckt

`NVDAx`, `PLTRx`, `HOODx`, `BRK.Bx` sind tokenisierte Aktien. Ein Memecoin,
dessen einziger Pool gegen eine tokenisierte NVIDIA-Aktie handelt, hat keinen
USD-Preis — er hat einen NVIDIA-Preis, multipliziert mit dem, was der Markt
gerade für die Tokenisierung hält. Genau dafür gibt es die Ankerliste, und
genau diesen Fall hätte eine Lockerung hereingelassen.

Damit ist auch die Reihe der Vermutungen abgeschlossen, die diese Untersuchung
begleitet hat: `TURNOVER_IMPLAUSIBLE` (§90, falsch), „ein fehlender Anker"
(§92, falsch). Beide Male hätte die Schätzung zu einer Änderung geführt, die
die Messung nicht trägt.

### Der eigentliche Engpass steht daneben

Die Filter arbeiten korrekt. Was die Ausbeute begrenzt, ist die **Quelle**:

```
Discovery: seen: 9   fresh: 0   duplicates: 9
```

`/token-profiles/latest/v1` liefert neun bis dreizehn Solana-Einträge, fast
immer dieselben, und darunter tokenisierte Aktien und Fremdketten-Token statt
frischer Memecoin-Starts. Von 25 beobachteten Token tragen 7 verwertbare
Marktdaten — nicht weil zu streng gefiltert wird, sondern weil oben zu wenig
und zu wahllos hineinkommt.

Das ist der nächste Hebel, und er liegt nicht bei den Schwellenwerten.

## §94 — Korrektur: ein RPC-Zugriff schließt EINE Lücke, nicht zwei

Ich hatte dem Betreiber gesagt, ein Solana-RPC-Zugriff räume beide offenen
Lücken ab — das unbekannte Datenalter (§89) und die fehlende
Autoritätsprüfung (§87). **Das war falsch, und zwar in der gefährlichen
Richtung.**

Ein RPC-Aufruf sagt, was **jetzt** on-chain steht. Er sagt nichts darüber, wann
DexScreener seinen Preis gemessen hat. Diesen Zeitstempel an fremde Marktdaten
zu heften wäre exakt die Erfindung, die §89 aus der Frische-Berechnung entfernt
hat — nur mit mehr Aufwand und einem seriöseren Anstrich.

Sauber trennen:

| Lücke | Wodurch sie schließt |
|---|---|
| Mint-/Freeze-Authority unbekannt | **Ein** `getAccountInfo` auf den Mint. Wir lesen selbst, der Wert trägt unseren eigenen Slot. |
| Datenalter der Marktdaten unbekannt | Entweder ein Anbieter, der seine Messzeit mitliefert — oder wir lesen die **Pool-Reserven selbst** und rechnen den Preis daraus. |

Das Zweite ist ein eigenes, deutlich größeres Stück (Kontenlayouts je DEX) und
ausdrücklich nicht Teil dieses Commits.

### Der Adapter ist fertig, der Vertrag ist es nicht

`SolanaMintAdapter` liest den Mint-Account vollständig: Anfrage, Zeitlimit,
Fehlerklassifikation, Latenzmessung. Sein Vertrag ist `unverifiedContract()`,
weil aus dieser Arbeitsumgebung **kein** Solana-RPC erreichbar ist — drei
Endpunkte getestet, alle gesperrt. Jede Antwort wird mit `SCHEMA_UNVERIFIED`
abgelehnt.

Das ist kein halber Zustand, sondern der vorgesehene: der Adapter läuft
messbar, behauptet aber nichts. Der Weg zum scharfen Modul ist der
dokumentierte Einzeiler — `unverifiedContract()` gegen
`zodContract({verified: true})` — sobald eine echte Antwort vorliegt.

Im Betrieb ändert sich dadurch **nichts**: `checkAuthorities` liefert weiter
`Missing`, `cheapScreen` lehnt bei Unbekanntem weiter nicht ab, und
`withoutAuthorityCheck` zählt weiter mit.

### Drei Fallstricke, die im Code stehen

1. **Ein JSON-RPC-Fehler kommt mit HTTP 200.** Wer nur `response.ok` prüft,
   hält „Account not found" für einen Erfolg und liest `result` von
   `undefined`. Der Fehlerast wird deshalb vor der Vertragsprüfung behandelt.
2. **Ein Token-Account sieht aus wie ein Mint.** Gleiche äußere Form, andere
   Bedeutung. `parsed.type === "mint"` und die Programm-Adresse (Token oder
   Token-2022) sind beide Pflicht — ihn als Mint zu lesen ergäbe Autoritäten,
   die es nicht gibt.
3. **`supply` ist Text, nicht Zahl.** u64 passt nicht verlustfrei in eine
   JSON-Zahl. Er wird als Text geführt.

`encoding: "jsonParsed"` statt base64 ist bewusst gewählt: base64 hieße, das
Mint-Layout selbst aus Bytes zu lesen, und ein Versatzfehler dabei ergäbe eine
falsche Autorität — also eine falsche Sicherheitsaussage, die teuerste Sorte
Fehler an dieser Stelle.

### `timedOut` statt Textraten

`FailureClass` kennt keinen Timeout, und aus der Fehlermeldung darauf zu
schließen wäre Textvergleich über Laufzeitgrenzen hinweg. Der Adapter hält den
`AbortController` selbst — er weiß es sicher und sagt es als eigenes Feld.

## §95 — Der Worker belegt seinen Vertrag selbst

Der Mint-Leser aus §94 braucht eine echte Antwort, um vom ungeprüften zum
geprüften Vertrag zu werden. Aus der Entwicklungsumgebung ist kein Solana-RPC
erreichbar; der Betreiber hat — nachvollziehbar — abgelehnt, dafür einen Befehl
auszuführen.

Damit blieb eine Beobachtung übrig, die vorher niemand ausgenutzt hatte: **der
laufende Worker kann es.** Er hat Netzzugang und `SOLANA_RPC_URL`, er läuft im
Minutentakt, und seine Logs liest der Betreiber ohnehin.

Also fragt `probeMintContract` im `provider-health`-Takt selbst und schreibt
die **Form** der Antwort ins Log:

```
mintShape: result.context.slot:number
           result.value.data.parsed.info.decimals:number
           result.value.data.parsed.info.mintAuthority:null
           result.value.data.parsed.type:string
           result.value.owner:string …
```

Schlüsselpfade und Typen — **keine Werte**. Für ein Schema braucht man genau
das; die Werte braucht man nicht, und sie mitzuloggen würde die Allowlist
umgehen, sobald ein Anbieter irgendwo eine Kennung mitschickt.

`null` wird als eigener Typ geführt und nicht mit „fehlt" verwechselt: bei
einem Mint-Account ist `mintAuthority: null` die Aussage „niemand kann
nachprägen" — die wichtigste Information überhaupt.

### Zwei Selbstbegrenzungen

1. Die Sonde läuft **nur, solange der Vertrag ungeprüft ist**. Sobald aus
   `unverifiedContract()` ein `zodContract({verified: true})` wird, hört das
   Loggen von selbst auf. Niemand muss daran denken, es wieder auszubauen.
2. Ohne `SOLANA_RPC_URL` passiert nichts.

### Der Nebeneffekt ist der eigentliche Gewinn

`SCHEMA_REJECTED` trägt jetzt die Form der abgelehnten Antwort — für **jeden**
Anbieter, nicht nur für diesen. Eine Ablehnung, die nicht sagt, was stattdessen
kam, zwingt jeden dazu, den Anbieter selbst aufzurufen. Genau das ist nicht
immer möglich, und genau daran hing dieser Vertrag.

Sondenadresse ist der USDC-Mint: öffentlich, unveränderlich, und mit
abgegebener Freeze-Authority ein Fall, in dem sich `null` und „fehlt"
unterscheiden müssen.

## §96 — Der Weg zum Datenalter führt über einen Quote, nicht über Kontenlayouts

Auftrag war, das fehlende Datenalter anzugehen — die letzte Lücke vor
Einstiegsentscheidungen. Der naheliegende Weg wäre, die Pool-Reserven selbst
von der Kette zu lesen. **Er ist der teuerste und der riskanteste.**

Jeder Handelsplatz legt seinen Pool-Zustand anders ab. Die Vault-Adressen
stehen an programmspezifischen Byte-Offsets, und aus dieser Umgebung ist kein
Solana-RPC erreichbar, gegen das sich ein Offset prüfen ließe. Ein Versatz um
acht Byte ergäbe keinen Fehler, sondern **einen falschen Preis** — plausibel
aussehend und um Zehnerpotenzen daneben. Bei konzentrierter Liquidität
(CLMM, Whirlpool, DLMM) ist das Verhältnis der Vaults ohnehin nicht der Preis.

### Der billigere Weg war schon halb gebaut

Ein Router-Quote löst zwei Probleme auf einmal:

- Er nennt mit **`contextSlot`** den Slot, zu dem er aus dem Kettenzustand
  gerechnet wurde. Über `getBlockTime(slot)` wird daraus eine echte Uhrzeit —
  von der Kette abgelesen, nicht geschätzt.
- Er ist der Preis, zu dem **tatsächlich getauscht würde**, inklusive Route und
  Preiseinfluss. Für eine Einstiegsentscheidung ist das die richtigere Zahl als
  ein Pool-Mittelpreis.

`JupiterRouterProvider` existiert seit Langem, `/quote` ist implementiert, und
`contextSlot` steht als `optional()` im Schema — **niemand hat je geprüft, ob
es tatsächlich kommt.** Genau daran hängt jetzt alles.

### Was dieser Commit liefert

Den **Rechenkern**, vollständig prüfbar ohne Netz:

- `quoteUnitPrice` rechnet über verschiedene Dezimalstellen hinweg, ganzzahlig
  bis zur letzten Division. Hier wohnen die gefährlichen Fehler — eine
  vertauschte Dezimalstelle verschiebt einen Preis um Zehnerpotenzen und sieht
  dabei plausibel aus. Getestet gegen von Hand nachgerechnete Werte, inklusive
  Beträgen jenseits von 2^53.
- `quoteAge` unterscheidet vier Fälle statt zwei: bekannt, kein `contextSlot`,
  keine Slot-Uhrzeit, **Uhrenversatz**. Der letzte wird ausdrücklich **nicht**
  auf null gekappt — gekappt sähe eine falsch gehende Uhr wie „taufrisch" aus,
  also wie das beste denkbare Ergebnis.

### Und die Sonden, die den Rest belegen

Nach dem Muster aus §95 misst der `provider-health`-Takt jetzt auch die
Antwortform von `getSlot` und von Jupiters `/quote`. Damit beantwortet **eine
einzige Log-Zeile** die Frage, an der der ganze Weg hängt: steht `contextSlot`
in der Antwort?

Die Quote-Parameter stammen aus der Spezifikation
(`docs/providers/jupiter.md`), nicht aus einer Vermutung. Die Sonde ist
ausdrücklich kein Adapter: sie liefert keinen Wert, färbt keinen Status und
trägt keine Entscheidung.

### Was noch fehlt

`JUPITER_BASE_URL` ist auf keinem Dienst gesetzt. Ohne sie schweigt die Sonde
— korrekt, aber es passiert auch nichts. Das ist der nächste Handgriff, und es
ist ein Eintrag in den Variablen, kein Befehl.

## §97 — Die Naht ist gebaut, und sie brauchte keine neue Schnittstelle

Nach dem Rechenkern (§96) das Bindeglied: aus einem Quote plus Slot-Uhrzeit
wird ein Marktdatensatz mit **gemessenem** Alter.

Bemerkenswert ist, was dafür **nicht** nötig war. `MarketDataAdapter.fetchMarket`
gibt seit jeher `{ value, observedAt: Date | null }` zurück, und `observedAt`
ist ausdrücklich dokumentiert als „der Zeitstempel des ANBIETERS … DexScreener
liefert nachweislich keinen". Ein Quote kann ihn liefern.

Es ändert sich also keine Schnittstelle. Es wird eine ausgefüllt, die die
ganze Zeit da war und für die es bisher keinen Anbieter gab. Der Rest der Kette
— `sourced()` rechnet `freshnessSeconds`, der Snapshot trägt es,
`snapshotSupportsEntry` prüft es — funktioniert unverändert weiter.

### `getBlockTime`: fragen statt rechnen

Solana zielt auf 400 ms je Slot, und daraus ließe sich ein Alter schätzen.
Genau das wird **nicht** getan. Slots fallen aus, die Netzlast schwankt, und
die Abweichung wächst mit dem Abstand. Ein geschätztes Alter, das in die
Frischeprüfung geht, ist ein erfundener Wert mit besserer Tarnung — dieselbe
Klasse Fehler wie in §89, nur schwerer zu erkennen.

Die Einheit steht im Code ausgeschrieben: Unix-**Sekunden**, nicht
Millisekunden. Faktor 1000 daneben ergäbe ein Datum in 1970 oder 56000 und
fiele auf; gefährlicher wäre ein Alter, das um Faktor 1000 danebenliegt und
plausibel aussieht.

### Fünf Fälle statt „geht nicht"

`quoteToMarket` unterscheidet: kein Quote, kein Preis, kein `contextSlot`,
keine Slot-Uhrzeit, Uhrenversatz. Das ist kein Selbstzweck — die ersten beiden
sind Aussagen über den **Token** („nicht handelbar"), die letzten drei über
unsere **Infrastruktur** („uns fehlt eine Zeitquelle"). Sie zu vermengen hieße,
ein Betriebsproblem als Marktbefund zu lesen und den falschen Hebel zu suchen.

### Der Test, um den es geht

`quote-market.test.ts` führt das Ergebnis durch **denselben** Torwächter, der
DexScreener-Daten seit jeher ablehnt:

| Quelle | `freshnessSeconds` | `snapshotSupportsEntry` |
|---|---|---|
| DexScreener | `null` | abgelehnt — „Unbekannt ist nicht frisch" |
| Quote + Slot-Uhrzeit | `4` | **zugelassen** |
| Quote, 15 Minuten alt | `900` | abgelehnt — zu alt |

Die dritte Zeile ist so wichtig wie die zweite: ein gemessenes Alter heißt
**bekannt**, nicht **erlaubt**. Die Frischegrenze bleibt, was sie war.

### Was noch aussteht

Beide Verträge — Jupiters `/quote` und `getBlockTime` — sind weiter
ungeprüft, und `JUPITER_BASE_URL` ist auf keinem Dienst gesetzt. Der
Rechenweg steht vollständig und ist geprüft; was fehlt, ist der Beleg, dass
die Anbieter so antworten wie angenommen. Die Sonden aus §95/§96 messen das,
sobald die Variable gesetzt ist.

## §98 — Alles gebaut, was ohne den Beleg baubar ist

Zwei Arbeiten, für die niemand gebraucht wurde. Der Jupiter-Weg aus §96/§97
bleibt unverändert; er wird nur zu Ende gebaut.

### Der Quote-Abruf, getrennt vom Ausführungspfad

`JupiterQuoteAdapter` steht neben `JupiterRouterProvider`, nicht in ihm. Der
Router ist der **Ausführungs**pfad und trägt Health-Tracker, Circuit-Breaker
und Budget, weil an ihm echte Transaktionen hängen. Hier geht es um eine
**Messung** — dieselbe Antwort, andere Frage.

Geteilt wird, worauf es ankommt: `quoteResponseSchema`. Zwei Definitionen
derselben Antwortform laufen irgendwann auseinander, und dann stimmt eine von
beiden nicht mehr.

### Der Adapter, der `observedAt` endlich füllt

`quoteMarketAdapter` implementiert `MarketDataAdapter` und setzt `observedAt`
auf den Zeitpunkt, zu dem der **Anbieter** gerechnet hat. Alles dahinter läuft
unverändert: `sourced()` rechnet daraus `freshnessSeconds`, der Snapshot trägt
es, der Torwächter prüft es.

Die Abrufe sind **eingespeist** und nicht eingebaut. Damit lässt sich der ganze
Weg — Quote, Slot, Uhrzeit, Preis, Alter, Torwächter — ohne Netz prüfen, und
genau dort wohnen die Fehler, die im Betrieb niemand sieht. Der Test führt das
Ergebnis durch `sourced()` und bekommt `freshnessSeconds: 2`; dieselbe Zahl
war bisher immer `null` und einmal fälschlich `0` (§89).

Zwei Verweigerungen sind ausdrücklich getestet: **ohne Dezimalstellen** kein
Preis (eine geratene Dezimalstelle ist ein Betragsfehler um Zehnerpotenzen),
und **ohne `contextSlot`** kein Ergebnis — die Slot-Uhrzeit wird dann gar
nicht erst abgefragt, weil ihr Ergebnis feststeht.

Er ersetzt DexScreener **nicht**. Liquidität, Marktkapitalisierung und Volumen
kommen weiter von dort und werden nur durchgereicht; ein Quote sagt darüber
nichts. Beigesteuert wird der Preis und dessen Alter.

### Corepack: „behoben" gegen „sieht behoben aus"

Bei jedem Containerstart stand im Log:

```
! Corepack is about to download …/pnpm-10.33.0.tgz
```

Der Start hing damit an registry.npmjs.org, obwohl alles Nötige im Image liegt.
`corepack prepare --activate` im Laufzeit-Abbild legt pnpm hinein — ohne
Versionsangabe, damit `packageManager` aus der package.json die einzige Stelle
bleibt, an der die Version steht.

Der Teil, der leicht falsch geht: **dieser Schritt läuft als root, der
Container läuft als `worker`.** Ohne festes `COREPACK_HOME` landete die Ablage
in `/root/.cache`, wo `worker` sie nicht findet — und corepack lädt beim Start
doch wieder. Deshalb `ENV COREPACK_HOME=/opt/corepack` und die Ablage im
`chown` mit übertragen; corepack schreibt beim Start eine
`lastKnownGood.json`, und ein Schreibfehler wäre derselbe Startabbruch wie ein
fehlender Download.

Lokal belegt ist der Mechanismus: `corepack prepare --activate` füllt
`$COREPACK_HOME/v1/pnpm/10.33.0`. **Nicht** belegt ist der vollständige
Docker-Bau — dafür gibt es in dieser Umgebung keinen Daemon. Schlägt er fehl,
behält Railway die laufende Fassung und zeigt den Fehler im Build-Log.

## §99 — Der Weg vom Snapshot zur Entscheidung ist angeschlossen

Auf die Frage „bleibt sonst nichts übrig" hatte ich zu schnell „nein" gesagt.
Nachgesehen statt erinnert, und §98 in der Worker-Matrix korrigiert. Hier die
Behebung.

`EVALUATE_OPPORTUNITY` ruft jetzt `runOpportunityPipeline` auf. Vorher zeigte
die Auftragsart auf den allgemeinen Marktdaten-Handler, der Daten holte und das
Ergebnis wegwarf.

### Zwei Dinge, die dabei zum Vorschein kamen

**Es gab keine Strategieversion.** `decisions` und `opportunities` verweisen per
Fremdschlüssel darauf, und der Verweis ist Pflicht. Die Tests legen sich eine
an, der Betrieb nie — die erste echte Entscheidung wäre an einem
Fremdschlüssel gescheitert, und der Fehler hätte nach einem Datenbankproblem
ausgesehen statt nach einer fehlenden Einrichtung.

`ensureActiveStrategyVersion` legt sie an, idempotent. Ihr `reason` sagt
ausdrücklich, was sie ist: *„Startparameter. Ausdrücklich nicht validiert und
nicht als profitabel behauptet — sie halten fest, womit gerechnet wird."*
Ein Neustart darf keine zweite anlegen, sonst zerfällt die Statistik in
Versionen, die sich in nichts unterscheiden.

**Der Test-Aufbau hätte nicht in den Betrieb gedurft.** In `harness.ts` stehen
`eur(100)` als Positionsgröße und ein fest hingeschriebenes EV-Objekt. Für
einen Test ist das richtig. Im Betrieb wäre es Erfindung. Beide kommen deshalb
aus den **echten** Rechnern:

- `computePositionSize` aus `@sae/risk`
- `estimateEv` aus `@sae/decision` — ohne abgeschlossene Trades liefert er von
  sich aus `UNKNOWN / INSUFFICIENT_SAMPLE`. Dieselbe Auskunft, aber gerechnet
  statt hingeschrieben.

Ausdrücklich **keine** Messung, sondern eine Festlegung der Simulation, ist
`PAPER_PORTFOLIO` — es gibt kein Konto, das man abfragen könnte. Der Wert steht
sichtbar neben `PAPER_NOTIONAL`, das dieselbe Rolle schon hatte.

### `UnavailableQuoteSource`

Der simulierte Ausführer braucht eine Kursquelle, um überhaupt gebaut werden zu
können. Solange kein Router-Vertrag belegt ist, gibt es keinen Kurs — und dann
wird auch keiner geschätzt. Ein Ausführer mit erfundenem Kurs erzeugte
Paper-Positionen mit erfundenen Einstiegen, und die spätere Statistik hätte
keine Chance, das noch zu bemerken.

### Was der Lauf heute tut

Er endet mit `NO_SOURCE` — kein Anbieter mit geprüftem Vertrag ist erreichbar.
**Das ist der Gewinn, nicht der Mangel:** vorher passierte nichts und niemand
erfuhr warum; jetzt steht der Grund im Log, und er zeigt auf die richtige
Stelle. Sobald ein Preis ein bekanntes Alter trägt, wandert derselbe Lauf zum
nächsten Tor weiter, statt dass die Suche bei Jupiter anfängt, wo nichts kaputt
ist.

Der Test prüft deshalb nicht, dass eine Position entsteht — sie entsteht zu
Recht nicht. Er prüft, dass die Kette **läuft** und dass am Ende ein benannter
Grund steht statt Schweigen. Und dass dabei weder eine Gelegenheit noch eine
Position angelegt wird.

### Noch nicht verdrahtet

`SCORE_TOKEN`, `MONITOR_PAPER_POSITION`, `RECONCILE`, `STRATEGY_HEALTH` und
`RESEARCH_BATCH` zeigen weiterhin auf den allgemeinen Handler. Sie stehen
hinter dem Datentor, das heute ohnehin schließt — die Reihenfolge ist damit
richtig, aber die Lücke bleibt und ist hier benannt statt vergessen.

## §100 — Der Status wird abgeleitet, nicht aufgeschrieben

Auf die Frage, was jetzt am wenigsten Verwirrung stiftet, ist die Antwort
nicht „die restlichen fünf Auftragsarten verdrahten". Die stehen alle **hinter**
dem Datentor, das heute ohnehin schließt. Sie jetzt anzuschließen hieße, Code
hinzuzufügen, den niemand laufen sehen kann — und dessen Richtigkeit sich
folglich nicht zeigen lässt.

Die Verwirrung sitzt woanders, und ich bin ihr selbst zweimal aufgesessen:
**welche Teile arbeiten tatsächlich?**

In der Worker-Matrix stand bei vier Rollen `READY — WAITING FOR DATA`. Das las
sich wie „fertig, wartet nur auf Daten". Tatsächlich zeigten ihre Auftragsarten
auf den allgemeinen Marktdaten-Handler, der Daten holt und das Ergebnis
wegwirft. Ich habe diese Angabe selbst geschrieben und ihr später geglaubt.

### Die Lehre ist nicht „sorgfältiger schreiben"

Eine von Hand gepflegte Statusangabe driftet. Immer. Deshalb steht die
Einstufung jetzt **an der Klasse, die die Arbeit tut oder eben nicht**:

```ts
class EvaluateOpportunityHandler implements JobHandler {
  readonly wiring = "DEDICATED" as const;
```

```ts
class MarketDataHandler implements JobHandler {
  readonly wiring = "MARKET_DATA_ONLY" as const;
```

`describeWiring()` leitet daraus die Übersicht ab, und der Consumer schreibt
sie beim Start ins Log. Wer eine Auftragsart verdrahtet, ändert die Einstufung
in derselben Datei, in der er den Handler schreibt — vergessen kann man es
kaum, und ein Test hält die Liste der offenen fest.

Ein Handler **ohne** Angabe gilt als `MARKET_DATA_ONLY`. Die pessimistische
Vorgabe ist Absicht: ein vergessenes Feld darf nicht wie eine Fertigmeldung
aussehen.

### Stand, abgeleitet statt behauptet

| Auftragsart | |
|---|---|
| `SAMPLE_PROVIDER_HEALTH` | DEDICATED |
| `EXPIRE_OPPORTUNITIES` | DEDICATED |
| `REFRESH_MARKET_DATA` | DEDICATED |
| `DISCOVER_TOKENS` | DEDICATED |
| `EVALUATE_OPPORTUNITY` | DEDICATED |
| `SCORE_TOKEN` | MARKET_DATA_ONLY |
| `MONITOR_PAPER_POSITION` | MARKET_DATA_ONLY |
| `RECONCILE` | MARKET_DATA_ONLY |
| `STRATEGY_HEALTH` | MARKET_DATA_ONLY |
| `RESEARCH_BATCH` | MARKET_DATA_ONLY |

Diese Tabelle darf veralten — die im Log nicht.

## §101 — Das Datenkontingent war aufgebraucht, und der Leerlauf war schuld

Der Worker kam nicht mehr hoch:

```
PostgresError: Your project has exceeded the data transfer quota.
code: '53000'
```

Danach Neustart im Sekundentakt, jeder mit demselben Fehler.

### Die Ursache lag nicht in der Arbeit, sondern im Nichtstun

Der Consumer-Zyklus lief mit **einer Sekunde** Taktung, und in jedem Durchlauf
standen **drei** Datenbankabfragen:

```
reclaimExpired    ← jede Sekunde
retireSuperseded  ← jede Sekunde
claim             ← jede Sekunde
```

Über 250.000 Rundreisen am Tag, ohne dass etwas zu tun war. Auf einer nach
Datenmenge abgerechneten Datenbank ist das kein Schönheitsfehler, sondern die
Rechnung.

**Zwei der drei waren nicht einmal sachlich begründet.** Fristen laufen 60
Sekunden — sie sekündlich zu suchen kann nichts finden, was 30 Sekunden später
nicht auch noch da wäre. Und `retireSuperseded` ist Aufräumarbeit; sie stand
seit §88 im Sekundentakt, weil ich sie in den Zyklus geschrieben habe, ohne zu
fragen, wie oft der läuft. Das ist meine Ursache, und sie hat die Rechnung
verdreifacht.

### Die Korrektur

| | vorher | jetzt | Abfragen/Tag |
|---|---|---|---|
| `claim` | 1 s | **5 s** | 86.400 → 17.280 |
| `reclaimExpired` | 1 s | **30 s** | 86.400 → 2.880 |
| `retireSuperseded` | 1 s | **60 s** | 86.400 → 1.440 |
| Anbieterzustand | 30 s | **60 s** | 2.880 → 1.440 |

Zusammen von rund **262.000 auf 23.000** am Tag — Faktor 11.

Fünf Sekunden Taktung kosten im schlechtesten Fall fünf Sekunden Verzögerung
bei einem Auftrag. Der schnellste Takt des Schedulers liegt bei zehn Sekunden;
häufiger zu fragen, als eingereiht wird, bringt nichts.

Die Wartung läuft beim **ersten** Durchlauf trotzdem sofort: nach einem
Neustart können Aufträge eines abgestürzten Vorgängers liegen, und die sollen
nicht eine halbe Minute warten.

### Was die Tests festhalten

Sie zählen Aufrufe, nicht Zeit: bei zehn Durchläufen wird zehnmal nach Arbeit
gefragt, aber deutlich seltener aufgeräumt. Und bei stehender Uhr wird kein
zweites Mal aufgeräumt — sonst hinge die Sparsamkeit daran, dass die Uhr
weiterläuft.

### Was Code nicht behebt

Das Kontingent selbst. Es setzt sich mit dem Abrechnungszeitraum zurück oder
wird mit einem größeren Tarif angehoben — beides eine Entscheidung des
Betreibers. Bis dahin bleiben die Dienste unten; sie im Neustart-Kreis laufen
zu lassen, verbraucht nur weiter.

## §102 — Zwei Drittel der Last bewachten ein leeres Lager

Nach §101 die Rechnung, ob die Sparmassnahme reicht. Sie reicht nicht.

Gemessen: **6,1 GB in rund drei Tagen** — etwa 2.033 MB am Tag. Erlaubt sind
5 GB im Monat, also **167 MB am Tag**. Der Faktor-11-Fix aus §101 landet bei
rund 185 MB am Tag: immer noch darüber.

### Der zweite Hebel lag offen

| Takt | alle | Aufträge/Std | überwacht |
|---|---|---|---|
| POSITION_MONITOR | 10 s | 360 | **nichts** |
| PAPER_MONITOR | 15 s | 240 | **nichts** |
| OPPORTUNITY_EXPIRY | 30 s | 120 | **nichts** |

**17.280 von 26.308 Aufträgen am Tag — zwei Drittel — fragten „hat sich an
nichts etwas geändert?"** Es gibt keine Position, keine Paper-Position, keine
Gelegenheit; es kann sie auch nicht geben, solange das Datentor schließt.

Das ist nicht nur teuer, es ist falsch herum gedacht: ein Wächter, der über
ein leeres Lager geht, meldet nicht Sicherheit — er verbraucht Schichten.

### Die Korrektur ist kein Sparzwang

`Cadence.requiresOpenWork` markiert die drei Takte, `planTick` überspringt sie
mit der eigenen Entscheidung `NOTHING_TO_WATCH`, und der Scheduler stellt die
Frage mit **einer** Abfrage auf dem Takt, den er ohnehin hat — eine zweite
Schleife wäre genau die Sorte Zusatzverkehr, die hier abgestellt werden soll.
`EXISTS` statt `COUNT`: die Zahl interessiert niemanden.

Ohne Angabe wird **nichts** abgeschaltet. Wer die Lage nicht kennt, darf sie
nicht als leer behaupten — sonst legt ein vergessener Parameter still die
Positionsüberwachung lahm, und das fällt erst auf, wenn Geld darin liegt.

### Und trotzdem: es reicht immer noch nicht

Beide Maßnahmen zusammen — Leerlauf 11× dünner, Aufträge 2,9× weniger —
landen je nach Aufteilung bei **340 bis 540 MB am Tag**. Erlaubt sind 167.

Die Schätzung ist grob; die Aufteilung zwischen Leerlaufabfragen und
Auftragsarbeit ist nicht gemessen. Aber selbst die günstigste Annahme liegt um
den Faktor zwei darüber.

**Der Befund ist damit kein Optimierungsproblem mehr, sondern eine
Werkzeugfrage.** Ein Dienst, der rund um die Uhr alle paar Sekunden mit einer
Datenbank spricht, passt nicht in ein Kontingent von 5 GB im Monat. Weiter zu
optimieren hiesse, die Taktung so weit zu strecken, dass das System seinen
Zweck verliert — und wäre am Ende immer noch knapp.

Die Entscheidung darüber trifft der Betreiber, nicht dieser Commit. Beide
Änderungen bleiben richtig, unabhängig davon: sie waren schon vorher zu teuer
für das, was sie leisten.

### Nicht gepusht

Ein Push auf `main` löst bei allen drei Railway-Diensten sofort ein
Deployment aus. Solange das Kontingent aufgebraucht ist, liefen sie unmittelbar
wieder in die Absturzschleife. Der Commit liegt deshalb lokal und wartet auf
das Signal des Betreibers.

## §103 — `contextSlot` ist da. Und die Messung hat einen Fehler gefunden.

Die Frage, an der seit §96 alles hing, ist beantwortet. Der laufende Worker hat
gemessen, was Jupiter tatsächlich zurückgibt:

```
mintShape: contextSlot:number inAmount:string inputMint:string … outAmount:string …
```

**`contextSlot` ist enthalten.** Damit trägt ein Quote einen Messzeitpunkt, aus
dem über `getBlockTime` eine echte Uhrzeit wird — und ein Preis bekommt zum
ersten Mal ein bekanntes Alter.

### Die Messung hat sich sofort bezahlt gemacht

Sie deckte einen Fehler auf, der **jede** Quote-Antwort abgelehnt hätte:

```ts
bps: z.number().int().optional()     // erlaubt ein FEHLENDES Feld
```

Die echte Antwort liefert `routePlan[].bps: null`. `optional()` erlaubt
`undefined`, nicht `null`. Der Vertrag hätte alles als `INVALID` verworfen,
und der Fehler hätte wie ein Anbieterproblem ausgesehen — gesucht hätte man
bei Jupiter, wo nichts kaputt war.

Genau dafür gibt es die Regel, gegen echte Antworten zu bauen. Aus der
Spezifikation abgeschrieben wäre das Schema durchgegangen und im Betrieb
gescheitert.

### Beide Verträge sind jetzt belegt

| Vertrag | Stand |
|---|---|
| `getAccountInfo` (Mint) | `verified: true`, Messung 2026-09-10 |
| Jupiter `/quote` | `verified: true`, Messung 2026-09-10 |
| `getBlockTime` | weiterhin ungeprüft — siehe unten |

Beim Mint-Vertrag ist außerdem die Adresse aus dem Vertrag geflogen:
`getAccountInfo` liefert den Kontoinhalt, nicht die abgefragte Adresse. Sie
mit einem Platzhalter zu füllen und später zu überschreiben wäre ein leerer
Wert, der eine Weile mitläuft — genau die Sorte, die irgendwann nicht
überschrieben wird. Der Aufrufer setzt sie ein, weil nur er weiß, wonach er
gefragt hat.

### Eine eigene Behauptung berichtigt

Im Code stand, USDC habe seine Freeze-Authority abgegeben, und die Sonde prüfe
damit den `null`-Fall. Die Messung zeigt das Gegenteil: `mintAuthority` **und**
`freezeAuthority` sind beide gesetzt — Circle behält beide.

Für die Erreichbarkeitssonde ist das ohne Belang. Für die Vertragsprüfung
nicht: dass `null` richtig gelesen wird, belegt kein Anbieter, sondern der
Test. Die Begründung im Code ist entsprechend berichtigt.

### `getSlot` ist nicht `getBlockTime`

Gemessen wurde `getSlot` — das bestätigt den JSON-RPC-Umschlag
(`{id, jsonrpc, result}`), aber nicht die Methode, auf die es ankommt. Das als
Beleg zu nehmen wäre derselbe Kurzschluss wie „aus der Doku abgeschrieben".

Die Sonde fragt deshalb jetzt in zwei Schritten: `getSlot` liefert einen Slot,
den es sicher gibt, `getBlockTime` macht daraus die Uhrzeit. Ein geratener
Slot wäre entweder zu alt oder zu neu, beide antworten `null` — und das sähe
wie ein Vertragsproblem aus, obwohl nur die Frage falsch war.

### Nebenbei belegt

Im Log steht **kein** `Corepack is about to download` mehr. Der Dockerfile-Fix
aus §98, den ich hier ohne Docker-Daemon nicht testen konnte, greift.

## §104 — Der letzte Vertrag steht, und die Kette ist verdrahtet

Datum: 2026-09-10

Die Sonde im `provider-health`-Takt hat `getBlockTime` gemessen:

```
provider: solana-rpc:getBlockTime
mintShape: id:number jsonrpc:string result:number
```

Drei Felder, `result` eine Zahl in der Größenordnung der Unix-Sekunden. Genau
die Form, die `blockTimeResultSchema` beschreibt. `SOLANA_BLOCK_TIME_CONTRACT`
ist damit `zodContract({verified: true})` — der letzte ungeprüfte Vertrag im
System ist weg.

Damit steht die vollständige Kette zum Datenalter:

| Schritt | Vertrag | Belegt |
|---|---|---|
| Preis + `contextSlot` | Jupiter `/quote` | 2026-09-10 |
| Slot → Uhrzeit | `getBlockTime` | 2026-09-10 |
| Dezimalstellen | `getAccountInfo` | 2026-09-10 |

### Was verdrahtet wurde

Bis hierher war `quoteMarketAdapter` gebaut und ohne Aufrufstelle — dieselbe
Lücke wie bei `runOpportunityPipeline` in §99, und dieselbe Sorte, die man
später für ein Datenproblem hält. Jetzt hängt sie in der Kette:

- **`jupiter-quote` ist eine eigene Anbieterkennung**, nicht ein zweites
  `kind` am Router-Eintrag. Router und Marktquelle teilen einen Host und sonst
  nichts: der Ausführungspfad kann ausfallen, während sich Preise weiterhin
  einwandfrei ablesen lassen. Eine gemeinsame Kennung würde beide Befunde in
  eine Zeile werfen — in der Provider-Health, im Dashboard und in der Herkunft
  jedes Snapshots.
- **Sie steht vor DexScreener.** Der Erste, der liefert, gewinnt, und nur diese
  Quelle nennt einen Messzeitpunkt. Stünde DexScreener vorn, trüge kein
  Snapshot je ein Alter, und die ganze Verdrahtung wäre wirkungslos.
- **`configured` verlangt BEIDE Adressen**, `JUPITER_BASE_URL` und
  `SOLANA_RPC_URL`. Der Quote allein ergibt keinen Preis: Dezimalstellen und
  Slot-Uhrzeit kommen vom Knoten. `configured: true` mit nur einer Adresse wäre
  eine Zusage, die der Adapter nicht halten kann.
- **DexScreener bleibt** — als `companion` für Liquidität, Volumen und
  Marktkapitalisierung, die ein Quote nicht kennt, und als Fallback, wenn der
  Router keinen Weg findet.

### Ein Fehler, der ohne die Verdrahtung nie aufgefallen wäre

`resolveFromChain` überspringt jedes Mitglied, dessen Status nicht `CONNECTED`
oder `DEGRADED` ist. `PROBES` kannte nur DexScreener, also wäre `jupiter-quote`
dauerhaft `UNAVAILABLE` geblieben und bei **jedem** Abruf mit `SKIPPED_STATUS`
ausgeschieden — verdrahtet und trotzdem still wirkungslos.

Die Sonde prüft deshalb nicht „antwortet Jupiter?", sondern den ganzen Weg: ein
Quote **mit** `contextSlot`, dessen Slot sich in eine Uhrzeit auflösen lässt.
Eine Sonde, die weniger prüft, meldete `CONNECTED` für eine Quelle, die
anschließend bei jedem Token an `NO_CONTEXT_SLOT` scheitert — und dann sucht
jemand den Fehler in der Kette statt beim Anbieter.

### Die Probemenge wechselt die Seite

Ursprünglich fragte der Adapter von der Token-Seite: „was bekomme ich für
diese Rohmenge Token?" Das ist nicht haltbar. Eine feste Rohmenge bedeutet bei
6 Dezimalstellen etwas völlig anderes als bei 9, und ohne den Preis — den wir
gerade erst suchen — lässt sie sich nicht sinnvoll wählen. Für den einen Token
wäre eine Staubmenge herausgekommen, für den nächsten ein Auftrag, der den Pool
leerräumt. Beide Preise echt gemessen, beide nicht vergleichbar.

Gefragt wird jetzt mit dem **Anker**: „was bekomme ich für 100 USDC?" Dieselbe
reale Summe für jeden Token, bekannte Dezimalstellen auf der Eingabeseite, und
nebenbei die Kaufseite — also genau die Richtung, die eine
Einstiegsentscheidung angeht.

Gelesen wird die Messung trotzdem von der Token-Seite (`quoteUnitPrice` mit
Eingabe = Token, Ausgabe = Anker). Andersherum käme heraus, wie viele Token ein
Dollar kauft: dieselbe Zahl auf dem Kopf, als Preis geführt um Größenordnungen
falsch, und nichts daran sähe kaputt aus. Ein Test nagelt die Richtung fest.

Auch die Dezimalstellen des Ankers werden **gelesen** und nicht hingeschrieben.
Dass USDC sechs hat, ist bekannt — aber eine bekannte Zahl abzuschreiben ist
die Sorte Annahme, die dieses System nicht trifft, solange die Zahl ablesbar
ist. Die Probemenge wird daraus ganzzahlig gerechnet.

### Drei erfundene Kennzahlen entfernt

`JupiterQuoteAdapter` und `SolanaBlockTimeAdapter` gaben `latencyMs: 0` zurück
— fest, ohne Messung. Beide hätten sich in der Provider-Health als die
schnellsten Abrufe im System ausgewiesen. Dieselbe Klasse Fehler wie das
erfundene Datenalter in §89, nur an einer Stelle, die niemand liest, bis sie
zählt. Beide messen jetzt gegen die injizierte Uhr, auch auf dem Fehlerast:
ein Zeitlimit nach acht Sekunden ist ein anderer Befund als eine sofortige
Abweisung.

Dazu ist `NO_ROUTE` aus `QuoteFetchOutcome` verschwunden. Die Variante stand im
Typ und wurde nie erzeugt — ein Quote ohne Weg kommt als HTTP-Fehler. Ein
Variantentyp, den der Code nie herstellt, ist eine Zusage über Verhalten, das
es nicht gibt; ein Aufrufer hätte einen Zweig dafür geschrieben, der nie läuft.

### Die Sonden schweigen jetzt von selbst

`probeFreshnessContracts` läuft nur, solange ihr Ziel unbelegt ist. Beide
Ziele sind belegt, also schweigt sie vollständig — drei Abrufe je Minute, die
niemand mehr liest, sind genau der Leerlauf aus §101. Die Funktion bleibt
stehen: sie ist der Weg, auf dem die Belege entstanden sind.

### Was noch fehlt, und es ist eine Zeile Konfiguration

Ein Snapshot trägt jetzt ein echtes Alter — der Torwächter lässt ihn trotzdem
nicht durch, solange die Quelle auf `FALLBACK` steht. Und dort steht sie,
solange `MARKET_DATA_PRIORITY` sie nicht nennt. Das ist eine bewusste Vorgabe
und kein Versehen: was entscheidungstragend sein darf, wird benannt, nicht
erraten.

Für den Betrieb heißt das:

```
MARKET_DATA_PRIORITY=jupiter-quote,dexscreener
```

Ohne diese Zeile entstehen Snapshots mit echtem Alter und trotzdem niemals eine
Gelegenheit. Ein Test hält das fest, damit es nicht als „der Bot handelt nicht"
wieder auftaucht.

## §105 — „2 von 3 verbunden" beantwortet die falsche Frage

Datum: 2026-09-10

Nach der Umstellung meldete `provider-health`:

```
written: 6  marketDataConnected: true
summary: 2 von 3 Marktdatenquellen verbunden.
```

Daraus ließ sich ableiten, dass die neue Quelle greift — `written` war von 5
auf 6 gestiegen, die Zusammenfassung von „1 von 2" auf „2 von 3". Das ist ein
Beleg durch **Differenzbildung über zwei Log-Zeilen hinweg**, und zwei Fragen
blieben trotzdem offen:

1. Welche der drei Quellen ist nicht verbunden?
2. Greift `MARKET_DATA_PRIORITY` überhaupt — und in welcher Reihenfolge wird
   gefragt?

Auf beide gab das Log keine Antwort. Eine Zusammenfassung, die **zählt statt zu
benennen**, lässt genau die Frage offen, für die man sie liest. Und eine
Konfiguration, deren Wirkung man aus einer Zahl erraten muss, ist eine, die
irgendwann falsch steht und es niemandem sagt.

### Zwei Zeilen, die es beantworten

`providers` nennt jeden Anbieter mit seinem Zustand:

```
providers: birdeye=NOT_CONFIGURED dexscreener=CONNECTED helius=NOT_CONFIGURED
           jupiter=UNAVAILABLE jupiter-quote=CONNECTED rugcheck=NOT_CONFIGURED
```

`chain` nennt die Reihenfolge, in der gefragt wird — beim Start des Consumers,
aus derselben Konfiguration, die auch der Auftrag benutzt:

```
chain: 2 Kettenmitglied(er): jupiter-quote=PRIMARY, dexscreener=SECONDARY.
```

Bewusst nur Mitgliedschaft und Stufe, nicht der Zustand: der wird je Auftrag
frisch gelesen und wäre beim Start eine Momentaufnahme, die sofort veraltet.

### Der Fallstrick, der beides fast unlesbar gemacht hätte

Die Redaction-Allowlist prüft **jeden** Schlüssel, auch die in verschachtelten
Objekten. Als Objekt geloggt wären die Anbieternamen Schlüssel — und damit
`[redacted]`. Genau derselbe Fehler wie beim Histogramm der Ablehnungsgründe
(§100), nur mit Zuständen statt Zahlen.

`pairs()` macht daraus einen einzigen Wert, sortiert nach Namen. Nach Namen und
nicht nach Zustand, damit eine Statusänderung nicht die ganze Zeile umstellt:
ein Unterschied im Log soll ein Unterschied in der Sache sein und keine
Umsortierung.

### Nachgereicht: der Befund selbst

Ein Test hält jetzt fest, was in der Produktion zu sehen war — sechs Anbieter,
drei davon mit `TOKEN_MARKET`, und `birdeye` als die nie konfigurierte dritte.
Vorher war das eine plausible Vermutung. Plausible Vermutungen haben in diesem
Projekt schon zweimal danebengelegen (§103).

## §106 — `ingested` sagt nicht, ob die Daten etwas wert sind

Datum: 2026-09-10

### Eine Berichtigung zuerst

Zur Meldung `written: 6 · 2 von 3 Marktdatenquellen verbunden` wurde gesagt,
daran sehe man „indirekt, dass `MARKET_DATA_PRIORITY` greift". Das stimmt
nicht, und der Irrtum ist lehrreich.

Beide Zahlen sind **vollständig durch das Deployment erklärt**: der neue Code
fügt einen sechsten Anbietereintrag hinzu (`written` 5 → 6) und einen dritten
mit `TOKEN_MARKET` (`von 2` → `von 3`). Dass zwei davon verbunden sind, sagt,
dass die Sonde für `jupiter-quote` durchlief — sie braucht `JUPITER_BASE_URL`,
und die stand bei `provider-health` schon vorher.

`MARKET_DATA_PRIORITY` kommt in dieser Rechnung **an keiner Stelle vor**. Die
Zeile hätte exakt so ausgesehen, wenn die Variable nirgends gesetzt wäre.

Das ist die Sorte Schluss, gegen die dieses Projekt seine Instrumente baut: ein
Beleg durch Differenzbildung, der eine andere Ursache hat als die vermutete.
Zweimal vorher danebengelegen (§103), hier fast ein drittes Mal.

### Die Zahl, die es beantwortet

`ingested` sagt, dass Snapshots ankommen. Es sagt nichts darüber, ob einer
davon je eine Entscheidung tragen könnte — und genau das war ein Jahr lang die
ganze Geschichte dieses Projekts: die Kette lief, schrieb Snapshots, und keiner
kam am Torwächter vorbei. Sichtbar wurde das nirgends.

Der Auffrischungslauf zählt jetzt mit:

```
ingested: 11  entryReady: 11
ingested: 11  entryReady: 0   entryBlocked: FALLBACK_TIER=11
```

Die zweite Zeile ist der heutige Zustand, solange `MARKET_DATA_PRIORITY` nicht
steht. Sie sagt in einem Blick, was vorher nur eine Vermutung war.

Gezählt wird vom **Torwächter selbst**, nicht von einer nachgebauten Prüfung.
Dafür gibt `snapshotSupportsEntry` jetzt zusätzlich einen `code` zurück:
`reason` ist ein Satz für Menschen und enthält Zahlen („Daten 47 s alt"), taugt
also nicht als Schlüssel einer Auszählung — jede Ablehnung ergäbe eine eigene
Zeile. Eine zweite Stelle, die dieselben Bedingungen prüft, würde driften, und
zwar ausgerechnet an dem Tor, an dem die teuersten Fehler dieses Systems
entstehen.

### Zwei Tests, ein Unterschied

Derselbe Lauf, einmal ohne und einmal mit benannter Priorität:

| | `ingested` | `entryReady` | `entryBlocked` | `source_tier` |
|---|---|---|---|---|
| ohne | 1 | 0 | `FALLBACK_TIER=1` | FALLBACK |
| mit | 1 | 1 | — | PRIMARY |

Der Unterschied ist eine Umgebungsvariable. Er ist auch der Unterschied
zwischen „Daten kommen an" und „Daten sind etwas wert".

## §107 — Der Papierhandel bekommt einen Einstiegskurs

Datum: 2026-09-10

`runDecision` bekam `quotes: new UnavailableQuoteSource()` — eine Kursquelle,
die ehrlich `MISSING(NOT_YET_COLLECTED)` zurückgibt. Selbst wenn eine
Entscheidung bis zu einer Gelegenheit gekommen wäre, hätte der Simulator keine
Position eröffnen können: kein Einstiegskurs.

Das war richtig, solange kein Router-Vertrag belegt war. Seit §104 ist er
belegt, also gibt es jetzt `JupiterQuoteSource`.

### Warum ein Router-Quote und nicht der Snapshot-Preis

Der Snapshot sagt, was ein Token **wert** ist. Der Quote sagt, was man
tatsächlich **bekommt** — einschließlich Route, Preiseinfluss und der Menge,
um die es geht. Für eine simulierte Ausführung ist nur das Zweite richtig: eine
Papier-Position, die zum Mittelpreis eines Pools eröffnet, hat einen Einstieg,
den es nie gegeben hätte, und jede spätere Statistik rechnet damit weiter, ohne
dass irgendwo etwas kaputt aussieht.

Die Slippage kommt aus dem **Plan**, nicht aus einer Konstante: ein Quote mit
fremder Toleranz beantwortet eine andere Frage.

### Kein Ausführungspfad

Diese Quelle führt nichts aus. Sie signiert nichts, sendet nichts, berührt
keinen Schlüssel. Ein Quote ist eine Frage, keine Transaktion. Live-Handel
bleibt vollständig abgeschaltet.

### Jeder Fehlschlag endet in MISSING

Neun von zehn Tests prüfen nicht den Erfolgsfall, sondern dass nirgends ein
Ersatzwert entsteht — Drosselung, Sperre, unlesbare Antwort, `outAmount: 0`,
Netzfehler. Der letzte Fall ist der unauffälligste und der wichtigste: eine
geworfene Ausnahme hier bräche den ganzen Entscheidungslauf ab und damit auch
die Token, die mit dem Fehler nichts zu tun haben.

`outAmount: "0"` ist der zweite: eine Ausgabe von null ist kein Kurs.
Durchgelassen ergäbe sie eine Position mit unendlichem Einstiegspreis.

### Eine offene Ungenauigkeit, ausgeschrieben

`BAD_REQUEST` wird auf `NO_DATA_FOR_TOKEN` abgebildet. Ein 4xx auf eine
wohlgeformte Anfrage heißt bei einem Router am ehesten „für dieses Paar in
dieser Größe gibt es keinen Weg" — **sicher ist das nicht**, gemessen wurde
bisher nur der Erfolgsfall. Für die Folge macht es keinen Unterschied (es wird
nicht ausgeführt), für die spätere Auswertung schon. Sobald ein solcher Fall
im Log auftaucht, lässt er sich nachprüfen; bis dahin steht die Unsicherheit
im Code statt in niemandes Kopf.

### Was danach noch fehlt

`MONITOR_PAPER_POSITION` zeigt weiterhin auf den generischen
Marktdaten-Handler. Eine eröffnete Papier-Position wird also nie überwacht und
nie geschlossen. Das ist der nächste Schritt.

## §108 — Der erste Einstieg ist möglich, und 80 % gehen trotzdem verloren

Datum: 2026-09-10

Erster Lauf mit gesetzter Priorität, aus dem Betrieb:

```
chain: 2 Kettenmitglied(er): jupiter-quote=PRIMARY, dexscreener=SECONDARY.

processed: 25  ingested: 10  noSource: 15
entryReady: 5  entryBlocked: AGE_UNKNOWN=5
noSourceReasons: NO_QUOTE=20 UNUSABLE_QUOTE=7 NO_LIQUIDITY_REPORTED=5 LIQUIDITY_TOO_LOW=3
```

**`entryReady: 5`.** Zum ersten Mal ungleich null. Der Weg von einem Token bis
zu einer Zahl, auf der entschieden werden darf, ist damit im Betrieb belegt und
nicht nur im Test.

### Die Zahlen gehen exakt auf

Das ist bemerkenswert genug, um es festzuhalten — es heißt, dass die
Instrumente stimmen:

| | |
|---|---|
| 25 Token geprüft, Router auf allen | |
| davon 5 mit Kurs | → `entryReady: 5` |
| 20 ohne Kurs | → `NO_QUOTE: 20` |
| von diesen 20 rettet DexScreener 5 | → `ingested: 10`, davon 5 `AGE_UNKNOWN` |
| 15 bleiben übrig | → `noSource: 15` = 7 + 5 + 3 |

`AGE_UNKNOWN=5` ist dabei **kein Fehler, sondern der Entwurf**: für diese
Token fiel die Kette auf DexScreener zurück, und DexScreener nennt keinen
Messzeitpunkt. Der Snapshot wird für die Historie geschrieben und für einen
Einstieg abgelehnt. Genau so war es gedacht.

### Der Befund, der jetzt zählt

Von 25 Token liefert der Router für **20 keinen Kurs**. Vier von fünf. Im Log
stand dazu genau ein Wort: `NO_QUOTE=20`.

Das ist zu wenig, um irgendetwas zu tun. Drei völlig verschiedene Ursachen
sehen darin gleich aus, und jede hat eine andere Gegenmaßnahme:

| Ursache | Gegenmaßnahme |
|---|---|
| Router drosselt uns (25 Token alle 20 s = 75 Anfragen/Minute) | Takt oder Tokenzahl senken |
| Kein Weg für dieses Paar in dieser Größe | Probesumme senken |
| Anbieter sperrt oder antwortet nicht | Anbieter prüfen |

Ich hätte raten können. In diesem Projekt haben zwei Vermutungen an genau
dieser Stelle schon danebengelegen (§103), also wird gemessen: `fetchQuote`
gibt keinen nackten `null` mehr zurück, sondern den Grund des Anbieters —
`QUOTE_RATE_LIMITED`, `QUOTE_BAD_REQUEST`, `QUOTE_BLOCKED`,
`QUOTE_UNAVAILABLE`, `QUOTE_SCHEMA_REJECTED`, `QUOTE_BAD_AMOUNT`. Der Grund
wandert unverändert in `noSourceReasons`; das generische `NO_QUOTE` entsteht
auf diesem Weg gar nicht mehr.

Dieselbe Lehre wie bei `noSourceReasons` selbst (§100), eine Ebene tiefer: eine
Sammelkategorie beantwortet die Frage nicht, für die man sie liest.

### Nebenbefund, ausgeschrieben statt stillschweigend

`RejectionCounts.tokens` hieß „wie viele Token ohne Markt blieben". Seit die
Kette zwei Mitglieder hat, kann derselbe Token zweimal zählen — einmal für den
Router, einmal für die Marktdatenquelle. Die Zahl ist dadurch nicht falsch,
aber sie heißt etwas anderes: „wie viele Abrufe ohne Markt endeten". Genau die
Sorte Drift, die eine Zahl still falsch macht, deshalb steht sie jetzt im Code.

## §109 — Der Entscheidungspfad hatte eine leere Kette

Datum: 2026-09-10

Auf dem Weg zu `MONITOR_PAPER_POSITION` — Punkt 3 der Liste — stand in
`runDecision`:

```ts
const result = await runOpportunityPipeline(
  {
    kind: "LIVE",
    adapters: new Map(),
    statusOf: () => "UNAVAILABLE",
    ...
```

Fest verdrahtet. `runOpportunityPipeline` beginnt mit `resolveMarketInput`, und
bei `NO_SOURCE` bricht der Durchlauf sofort ab. Der Entscheidungslauf konnte
damit **niemals** an Marktdaten kommen — unabhängig davon, wie viele Snapshots
in der Datenbank stehen und wie gut `entryReady` aussieht.

Die ganze Arbeit an der Datenqualität wäre also am nächsten Tor verpufft. Der
Auftrag `EVALUATE_OPPORTUNITY` lief, meldete `NO_SOURCE`, und das sah im Log
exakt aus wie ein echter Anbieterausfall.

Dieselbe Lücke wie in §87 und §99, zum dritten Mal: gebaut, getestet, nicht
angeschlossen. Sie ist deshalb so zäh, weil ihr Symptom ein *reguläres
Ergebnis* ist.

### Warum der bestehende Test sie nicht gefunden hat

`decision-wiring.test.ts` prüfte:

```ts
expect(result.outcomes["NO_SOURCE"]).toBe(1);
```

Und war grün. Zu Recht — denn der Test selbst stellte die Bedingung her, unter
der der Fehler unsichtbar ist: keine Adapter, jeder Anbieter `UNAVAILABLE`.
Unter diesen Voraussetzungen ist `NO_SOURCE` die richtige Antwort, und sie
blieb richtig, als `runDecision` intern dieselbe Leere fest verdrahtete.

**Ein Test, der die Bedingung mitliefert, unter der ein Fehler unsichtbar ist,
prüft nichts.** Das ist die eigentliche Lehre, und sie ist allgemeiner als
dieser eine Fall: die pessimistische Vorgabe (`?? "UNAVAILABLE"`,
`?? new Map()`) ist überall im System richtig — aber ein Test, der sie
übernimmt, kann eine fehlende Verdrahtung nicht von einer korrekten Ablehnung
unterscheiden.

Der neue Test gibt der Kette eine **arbeitende** Quelle und verlangt, dass sie
am Marktdaten-Tor vorbeikommt. Gegen den alten Code schlägt er fehl
(`expected 1 to be undefined` — `NO_SOURCE` war 1); das wurde vor dem Einchecken
durch Zurückdrehen der Korrektur nachgewiesen, statt es anzunehmen.

Er kommt jetzt bis `BLOCKED / NO_FEATURE_VECTOR` — der nächste ehrliche Halt:
Marktdaten sind da, der Feature-Vektor braucht Historie.

### Punkt 3 verschiebt sich

`MONITOR_PAPER_POSITION` zu verdrahten, während keine Position entstehen kann,
wäre Arbeit an einem Ende, das nie erreicht wird. Erst der Einstieg, dann die
Überwachung.

## §110 — Der Feature-Vektor stand als `features: null` im Code

Datum: 2026-09-10

Vierte Lücke derselben Bauart. Auf dem Live-Pfad von `resolveMarketInput`
stand:

```ts
return { kind: "OK", market: result.data.value, features: null, ... }
```

Ein Literal. Daneben, in `runOpportunityPipeline`, ein Kommentar, der genau
beschrieb, wie der Vektor entsteht — „aus der Historie über den PitReader" —
und niemand tat es. Der Durchlauf endete deshalb bei **jedem** Token mit
`BLOCKED / NO_FEATURE_VECTOR`, unabhängig von der Datenlage.

`buildFeatureVector` baut ihn jetzt.

### Ausschließlich aus dem PitReader

Es wäre naheliegend gewesen, den gerade frisch abgerufenen Preis zu nehmen — er
ist jünger als der letzte Snapshot. Genau das wäre falsch: eine Preisänderung
über fünf Minuten vergleicht zwei Messungen, und stammt die eine vom Router und
die andere aus der Snapshot-Historie, misst die Differenz auch den Unterschied
zwischen den Anbietern. **Eine Reihe muss aus einer Reihe kommen.**

Der PitReader ist außerdem die Vorkehrung gegen Look-Ahead: jede Methode
verlangt `asOf`, es gibt keine für „den aktuellen Stand".

Die Herkunft überlebt bis ins einzelne Feld: `PitSnapshot` trägt jetzt
`sourceProviderId`, und jedes `observed()` nennt den Anbieter, der diesen
Datenpunkt geliefert hat. Ohne das wäre nach der Aggregation nicht mehr sagbar,
worauf eine Entscheidung beruhte.

### Ein Fehler, den nur der Test finden konnte

`snapshotsBetween` ist halboffen (`from` exklusiv). Die Historie wurde exakt bis
`asOf - 1h` geladen — ein Snapshot, der genau eine Stunde alt war, fiel damit
per Definition heraus, und `priceChange1h` wäre **dauerhaft** `Missing`
gewesen.

Im Betrieb wäre das nie aufgefallen: `Missing` ist ein reguläres Ergebnis, und
ein fehlendes Stundenmomentum sieht aus wie zu wenig Historie. Die geladene
Spanne ist jetzt breiter als das längste Fenster — die Toleranz braucht Daten
auf **beiden** Seiten ihres Zielpunkts.

### Was NICHT genähert wird

`volumeAcceleration` verlangt „Volumen der letzten 5 Minuten im Verhältnis zum
Durchschnitt". Aus zwei Ständen eines rollenden 24-Stunden-Volumens ließe sich
ein Zufluss schätzen — aber das ist eine andere Größe, und sie sähe der
richtigen zum Verwechseln ähnlich. Also `Missing`.

Ebenso `security.*`: ohne Befund steht dort `NOT_YET_COLLECTED` und
ausdrücklich nicht `false`. „Wir wissen es nicht" ist etwas anderes als „die
Autorität ist abgegeben"; ein `false` wäre eine Sicherheitsaussage, die niemand
geprüft hat.

### Die Messung — und der Befund, der eine Entscheidung verlangt

Mit einem Vektor aus allem, was dieses System **heute tatsächlich erhebt**:

```
dataCompleteness: 0.310   Schwelle: 0.7
weightCoverage:   0.250   Mindestens: 0.6   ->  finalScore: null
notComputable: security, momentum, execution, smartMoney, social, dev, narrative
```

Zwei Tore, nicht eins. Die Score-Engine bildet nicht einmal einen Endscore,
weil die Gewichtsabdeckung unter `MIN_WEIGHT_COVERAGE` liegt.

Von 29 Feldern sind 9 belegt. Was die übrigen 20 bräuchten:

| Gruppe | Felder | Woher |
|---|---|---|
| security | 6 | 2 aus dem Mint-Lesen, das die Discovery **bereits macht und wegwirft**; 4 aus RugCheck/Helius |
| momentum | 3 | `buys/sells` liefert DexScreener und wir verwerfen sie; `volumeAcceleration` braucht ein echtes 5-Minuten-Volumen |
| holder | 2 | Helius |
| execution | 3 | aus einem Jupiter-Quote berechenbar — den gibt es jetzt |
| pending | 6 | Anbieter, die es nicht gibt (Smart Money, Social, Dev, Narrative) |

Ohne einen einzigen neuen Anbieter erreichbar: 5 weitere Felder (Autoritäten +
Execution) → rund **0.48**. Die 6 `pending`-Felder sind laut ihrer eigenen
Dokumentation „Kategorien, die erst in späteren Phasen befüllt werden" — sie
zählen aber im Nenner mit. Das deckelt `dataCompleteness` bei 23/29 = **0.79**,
selbst wenn alles andere perfekt wäre.

**Damit ist die Lage entschieden, aber die Entscheidung nicht meine.** Der Bot
kann mit den heute verfügbaren Anbietern keine Position eröffnen. Drei Wege,
und sie sind unterschiedlich teuer:

1. **Anbieter ergänzen** (RugCheck für Sicherheit, Helius für Holder). Echte
   Arbeit, echte Zugangsdaten, und jeder braucht einen gemessenen Vertrag.
2. **Die Schwellen senken** (`minDataCompleteness`, `MIN_WEIGHT_COVERAGE`). Das
   schwächt ein Sicherheitstor und ist eine Strategieentscheidung, keine
   technische.
3. **Die `pending`-Felder aus dem Nenner nehmen**, weil sie planmäßig noch
   nicht existieren. Sachlich am ehesten vertretbar — ändert aber die Bedeutung
   einer Kennzahl, die bereits in Snapshots geschrieben wurde.

Ich habe keinen davon eingeschlagen. Schwellen zu senken, damit ein Tor aufgeht,
ist genau die Bewegung, gegen die dieses ganze System gebaut ist.

## §111 — Schritt A: fünf Felder, die längst bezahlt waren

Datum: 2026-09-10

Nach der Wegentscheidung (§110) zuerst das, was ohne einen einzigen neuen
Anbieter geht. Die Prüfung vorher hat die Lage präzisiert, und zwar zu unseren
Gunsten: das bindende Tor ist nicht `dataCompleteness`, sondern
**`weightCoverage`** — und das hängt nicht an der Zahl der Felder, sondern
daran, welche *Teilscores rechenbar* werden. Jeder verlangt nur wenige
Pflichtfelder.

| Teilscore | Gewicht | Pflichtfeld, das fehlte |
|---|---|---|
| Momentum | 0.15 | `volumeAcceleration` |
| Ausführung | 0.10 | `expectedCostBps` |
| Sicherheit | 0.20 | `top10HolderSharePct` (extern) |

### Momentum: die Daten lagen seit jeher in der Antwort

DexScreener liefert `volume.m5`, `volume.h24` und `txns.m5` in **jeder**
Antwort — die gemessene Fixture vom 2026-09-03 zeigt sie ausgeschrieben.
`MarketFields` kannte nur das Tagesvolumen, also wurden sie beim Übergang von
der Anbieterantwort in die Kette verworfen.

`volumeAcceleration` ist damit eine **Messung**, keine Schätzung: `volume.m5`
gegen `volume.h24 / 288` (288 Fünf-Minuten-Fenster je Tag). Beide Zahlen
stammen aus derselben Antwort und beziehen sich auf denselben Augenblick.

Die verworfene Alternative war, die Differenz zweier Stände des rollenden
24-Stunden-Volumens als Zufluss zu lesen. Das hätte bei jedem Takt eine Zahl
geliefert — aber eine andere Größe gemessen, die der richtigen zum Verwechseln
ähnlich sieht.

### Ausführung: der Preiseinfluss kommt aus dem Quote

`priceImpactPct` steht in jeder Jupiter-Antwort und wurde ebenfalls verworfen.
Er ist der **einzige gemessene** Eingang der Kostenrechnung; alles andere
(Gebühren, Latenz, SOL-Preis, Einsatz) sind erklärte Annahmen und stehen als
Konstanten an einer Stelle.

Gerechnet wird mit `estimateExecutionCosts` — demselben Modell, das der
simulierte Ausführer benutzt. Eine zweite Formel hier wäre die teuerste Sorte
Abweichung: der Score bewertete dann eine Ausführung, die anders abgerechnet
wird als sie stattfindet.

Ohne gemessenen Preiseinfluss gibt es **keine** Kostenschätzung. Die Annahmen
allein ergäben für jeden Token dieselbe Zahl, und eine Konstante als Feature
ist keine Information.

### Sicherheit: gelesen, benutzt, weggeworfen

Die Discovery liest für jeden Kandidaten Mint- und Freeze-Autorität und
benutzt sie für das Vorsieb. Danach war das Ergebnis weg — `token_security`
wurde von niemandem befüllt, obwohl die Abfrage längst bezahlt war.

Sie wird jetzt fortgeschrieben, **aber nur bei Änderung**. Bei jedem Takt zu
schreiben ergäbe 2.880 identische Zeilen je Token und Tag — derselbe Leerlauf
wie §101, nur in Schreibrichtung. Eine Änderung dagegen ist ein Ereignis: wer
eine Mint-Autorität wieder aktiviert, hat gerade die Voraussetzung für
beliebiges Nachprägen geschaffen.

### Gemessen, nicht gerechnet

| Stand | `weightCoverage` | `dataCompleteness` | `finalScore` |
|---|---|---|---|
| vorher | 0.250 | 0.310 | — |
| + Momentum | 0.400 | 0.414 | — |
| + Ausführung | **0.500** | **0.483** | — |
| + ein Sicherheitsbefund | **0.700** ✓ | 0.586 | **59** |

Die letzte Zeile ist der Beleg für die Wegentscheidung: **ein einziges Feld von
außen** — `top10HolderSharePct` — hebt die Gewichtsabdeckung über die Schwelle,
und die Engine bildet zum ersten Mal einen Endscore.

`dataCompleteness` bleibt mit 0.586 unter 0.7. Ein vollständiger
Sicherheitsbefund (dazu `lpBurnedOrLocked`, `riskLevel`, `topHolderSharePct`)
brächte 21/29 = **0.724** — beide Tore offen, mit einem Anbieter.

### Migration

Zwei Spalten in `token_snapshots`: `volume_5m_usd` und `price_impact_bps`.
Beide nullable, beide additiv; alte Zeilen tragen sie nicht und liefern dann
ehrlich `Missing` statt einer nachgerechneten Zahl.

## §112 — Die Konzentration steht vielleicht schon in der Kette

Datum: 2026-09-10

Der Plan für Schritt B war: ein externer Sicherheitsanbieter liefert
`top10HolderSharePct`, das eine Pflichtfeld, an dem der Sicherheits-Teilscore
hängt (Gewicht 0.20, §111).

Diese Annahme ist möglicherweise falsch — zu unseren Gunsten. Solana kennt die
größten Token-Konten eines Mint, und die Gesamtmenge lesen wir aus dem
Mint-Konto **ohnehin schon**. Der Anteil ist damit eine Division, kein
Anbieter.

Ob der konfigurierte Endpunkt das liefert, wird **gemessen** — die Sonde im
provider-health-Takt schreibt die Antwortform ins Log, genau wie bei
`getAccountInfo`, `getBlockTime` und dem Jupiter-Quote. Der Vertrag ist bis
dahin `unverified` und lehnt jede Antwort ab.

### Was diese Zahl ist — und was nicht

Sie misst die Konzentration über **Token-Konten**, nicht über Besitzer. Das
wird hier nicht weggeredet, weil beide Abweichungen in verschiedene Richtungen
zeigen und sich nicht aufheben:

- Ein Besitzer kann mehrere Konten halten → die echte Konzentration ist
  **höher** als gemessen.
- Unter den größten Konten stehen regelmäßig Liquiditätspools und
  Börsen-Wallets → die echte Konzentration ist **niedriger** als gemessen.

Wer die Zahl als „Anteil der zehn größten Halter" liest, liest sie falsch. Ein
Anbieter wie RugCheck oder Helius kann Konten Besitzern zuordnen und Pools
erkennen; das bleibt der bessere Wert. Dieser hier ist der, den es ohne einen
weiteren Anbieter gibt — und „besser als kein Maß" ist bei einem Tor, das
sonst dauerhaft zu bleibt, das Argument.

### Die Rechnung, nicht der Abruf, ist die gefährliche Stelle

`concentrationOf` liefert `null` statt einer Zahl, wenn die Gesamtmenge 0 ist
oder die Summe der Konten sie übersteigt. Das Zweite kann nur heißen, dass
Mengen und Gesamtmenge nicht zusammengehören — und ein Prozentwert daraus wäre
schlimmer als keiner, weil er plausibel aussieht.

Gerechnet wird ganzzahlig bis zur letzten Division. Token-Mengen erreichen
Größenordnungen jenseits von `Number.MAX_SAFE_INTEGER`; über `number` gerechnet
wäre der Anteil stillschweigend gerundet.

### Nebenbei: ein Schlüssel im Klartext

In diesem Zusammenhang wurde ein RPC-Zugang als Bildschirmfoto geteilt, mit dem
API-Schlüssel im Klartext und zusätzlich in der URL. Er ist nirgends in dieses
Repository gelangt — nicht in Code, nicht in Logs, nicht in die Dokumentation.
Festgehalten wird nur die Regel, die daraus folgt: Zugangsdaten werden direkt
beim Anbieter kopiert und direkt in Railway eingesetzt, ohne Zwischenstation.

## §113 — 95,7 % oder 55,7 %: dieselbe Antwort, zwei Wahrheiten

Datum: 2026-09-10

Zwei echte RugCheck-Antworten liegen vor (USDC und ein Memecoin), der Vertrag
ist damit gegen die Bytes geschrieben und `verified`. Der Befund darin ist
wichtiger als der Vertrag.

### Die naive Zahl ist doppelt falsch

Roh gerechnet halten die zehn größten **Konten** des gemessenen Memecoins
95,70 %, das größte allein 41,92 %. Beides führt in die Irre:

1. Das größte Konto gehört `7ZYnU2wr…`, und der steht in `knownAccounts` als
   **„Pump Fun AMM"** — der Liquiditätspool. Er hält nichts, er *ist* der
   Markt.
2. Konto 2 und Konto 3 haben denselben `owner` (`DZAvUwwv…`). Als zwei Halter
   gezählt sind das 17,5 % und 11,4 %; als **ein Akteur** sind es 28,9 %.

Nach Besitzern zusammengefasst und ohne Pool: **55,7 % statt 95,7 %**, größter
Akteur **28,9 % statt 41,9 %**.

Beide Korrekturen zeigen in **verschiedene** Richtungen — der Pool macht die
Zahl zu hoch, die Mehrfachkonten machen sie zu niedrig. Sie heben sich nicht
auf, und keine von beiden ist eine Kleinigkeit.

### Damit ist §112 beantwortet

Der Kettenweg (`getTokenLargestAccounts`) liefert weder `owner` noch eine
Liste bekannter Pools. Er kann diese Korrektur **prinzipiell nicht** machen.
Der Mehrwert von RugCheck ist also nicht die Prozentzahl, sondern die
Zuordnung, die sie erst richtig macht.

Der Kettenweg bleibt als Rückfall bestehen — falls Railway `api.rugcheck.xyz`
nicht erreicht —, aber sein Typ heißt jetzt `AccountConcentration` statt
`HolderConcentration`. Der Name sagt, was gemessen wurde; wer die Zahl als
Halterkonzentration führt, führt sie falsch.

### Der Ersteller wird NICHT herausgerechnet

`knownAccounts` kennt den Typ `CREATOR`, und es wäre naheliegend gewesen, ihn
wie `AMM` und `LOCKER` auszuschließen. Das wäre der teuerste Fehler dieser
Datei: der Ersteller ist der risikoreichste Halter, nicht ein
Infrastrukturkonto. Wer ihn ausblendet, blendet genau den aus, dessen Verkauf
den Kurs zerlegt. Ausgeschlossen wird nur, was niemandem gehört.

### Die Falle im Schema

`mintAuthority` gibt es **zweimal**: unter `token` als Adresse oder `null`, auf
oberster Ebene bei USDC als ganzes Konto-Objekt. Wer die obere Ebene als
Wahrheitswert liest, hält USDC für sicher und den Memecoin für gefährlich —
also genau verkehrt herum. Ein Test nagelt das fest.

### Ein leerer Token ist der Normalfall

Bei USDC sind `topHolders` und `markets` `null`, `totalHolders` ist `0`,
`risks` ist leer. Ein etablierter, unbedenklicher Token liefert **nichts**.
`holderConcentration` gibt dort `null` zurück und ausdrücklich nicht 0 % —
daraus „keine Konzentration" zu machen wäre eine Sicherheitsaussage, die
niemand geprüft hat, ausgerechnet für den unbedenklichsten Token.

### Das Rate-Limit ändert die Architektur

Gemessene Header: `x-rate-limit-limit: 15`, Fenster unbekannt. Der
Marktdaten-Takt fragt 25 Token alle 20 Sekunden — 75 Anfragen je Minute.

RugCheck gehört damit **nicht** in `REFRESH_MARKET_DATA`, sondern in einen
eigenen, langsamen Anreicherungstakt mit Zwischenspeicher. Sicherheitsdaten
ändern sich in Stunden, nicht in Sekunden. Das ist keine Optimierung, sondern
die Bedingung, unter der der Anbieter überhaupt nutzbar ist.
