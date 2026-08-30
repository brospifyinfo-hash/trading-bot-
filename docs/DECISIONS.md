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
