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
