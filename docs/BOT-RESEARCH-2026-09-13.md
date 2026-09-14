# Positionsgroesse, Gewinnmitnahme und Betriebsnachweis

Stand: 2026-09-13. Recherche und Vorschlag; keine freigegebene Strategieaenderung.
Live-Ausfuehrung bleibt aus. Keine Fremdsoftware wurde ausgefuehrt.

## Was andere Bots tatsaechlich beschreiben

| Primaerquelle | Nachvollziehbares Muster | Grenze der Aussage |
|---|---|---|
| [Warp Solana Trading Bot](https://github.com/warp-id/solana-trading-bot) | Konfigurierbarer Kaufbetrag (`QUOTE_AMOUNT`), getrennte Gewinn-/Verlustgrenzen, Slippage, Zeitlimit, Pool- und Autoritaetsfilter. | Die Einstellungen liefern keinen statistischen Nachweis eines Gewinns. Ein hoeheres Gewinnziel ist keine hoehere Trefferwahrscheinlichkeit. |
| [SolTrade](https://github.com/etcherfx/sol-trade) | Dokumentiert variable Groessen anhand mehrerer Signale, persistierte Positionen und Wiederaufnahme ihrer Ueberwachung; Tokens mit offenen Positionen duerfen nicht aus der Verwaltung entfernt werden. | Die beschriebene Signalgewichtung ist keine fuer unsere Daten validierte Strategie. |
| [Hummingbot PositionExecutor](https://hummingbot.org/strategies/v2-strategies/executors/positionexecutor/) | Eigener Positions-Lebenszyklus mit Stop, Gewinnmitnahme, Zeitlimit und Trailing Stop. | Architekturvorbild, kein Nachweis einer Memecoin-Rendite. |
| [Hummingbot Gateway Architecture](https://hummingbot.org/blog/hummingbot-gateway-architecture---part-1/) | Wiederholte Abfragen cachen, API-Aufrufe zaehlen, Fehlerszenarien und normale Nutzerablaeufe gemeinsam pruefen. | Das Dokument beschreibt ein Betriebsmuster; keine numerischen Strategieparameter uebernehmen. |

## Was die 3 Prozent im eigenen Code bedeuten

`maxPositionPct: 3` begrenzt den Einsatz relativ zum Papierdepot. Es ist keine
Gewinnobergrenze. Die aktuelle Gewinnleiter beginnt bei +25 Prozent und hat
weitere Stufen bei +50, +100 und +200 Prozent. Diese Zahlen sind Startparameter,
nicht empirisch bestaetigt. Trailing Stop, Verluste, Kosten und Restpositionen
bestimmen, was am Ende tatsaechlich uebrigbleibt.

Der aktuelle Groessenrechner bekommt 3.000 EUR virtuelles Depot, 1 Prozent
Risikobudget, 20 Prozent Stopabstand, EV-Konfidenz 0 und 100 EUR Minimum:

- Risikobudget 30 EUR / 0,20 = 150 EUR Einsatz vor weiteren Begrenzungen.
- Positionsdeckel 3 Prozent von 3.000 EUR = 90 EUR.
- Konfidenzfaktor 0,25 mal 150 EUR = 37,50 EUR.
- Hoechstens 37,50 EUR liegen unter dem Mindestbetrag von 100 EUR.

Nur den Positionsdeckel anzuheben wuerde den Widerspruch nicht loesen.
Zusaetzlich fuehrt der Ausfuehrungspfad aktuell einen festen 100-USDC-Kauf aus
und verbucht 100 EUR, statt den berechneten Betrag konsistent durchzureichen.
Der Worker gibt dem EV-Rechner dauerhaft eine leere Stichprobe und der
Risikopruefung feste leere Exposure-/Breaker-Listen. Das muss vor einer
belastbaren dynamischen Depotbewertung angeschlossen werden.

## Vorschlag zur Entscheidung

Empfohlenes Ziel ist eine variable Groesse, begrenzt durch Verlustbudget,
gemessene Verkaufbarkeit und das verbleibende Portfolio-Limit. Die Formel
existiert bereits; ihre Eingaben, Ausfuehrungsmenge und Buchhaltung muessen
zusammenpassen. Eine feste Anhebung etwa von 3 auf 10 Prozent allein wuerde
weder den Konfidenzdeckel noch den fehlenden Gewinnnachweis beheben.

Vor einer Parameteraenderung muss der Betreiber das Papier-Testkapital und das
Verlustbudget je Position festlegen. Die Hoechstsumme in einem Coin ist zudem
das moegliche Verlustausmass bei Totalverlust; ein Stop garantiert bei einem
Rug Pull keinen Verkauf. Fuer die technische Variante stehen zur Wahl:

1. Variable, risikobasierte Groesse; Kosten-/Mindestbetrag aus explizitem Modell
   und spaeter gemessenen Kosten. Empfehlung, benoetigt konsistente
   Waehrungs-/Mengendurchleitung und eine neue Strategieversion.
2. Festbetrag je Trade als getrenntes Vergleichsexperiment. Die bestehende
   Kategorie FIXED_100 bleibt dann sauber von risikobasierter Performance
   getrennt. Kein Umetikettieren historischer Trades.

Keine der Varianten rechtfertigt eine Profitabilitaetsaussage vor eigener
Stichprobe. Geschaetzte Slippage, feste SOL-/Wechselkurse und echte Messwerte
muessen getrennt ausgewiesen werden. Papierausfuehrung kann ohne echte Trades
keine real gemessene Transaktionsausfallrate erzeugen.

## Anbieterbudget: neue offizielle Information

Jupiters [Rate-Limit-Dokumentation](https://dev.jup.ag/docs/portal/rate-limits)
nennt fuer den aktuellen API-Zugang 30 Requests/Minute ohne Key und 60 mit
kostenlosem Key, ein gleitendes 60-Sekunden-Fenster und organisationsweite
Limits; zusaetzliche Firewall-Limits sind moeglich. Die [Migration](https://developers.jup.ag/docs/portal/migration)
beschreibt die schrittweise Drosselung und Abloesung des Lite-Hosts.
Die Aussage in §117, 15 Tokens/Minute seien eine universelle kostenlose
Anbietergrenze, ist damit nicht belastbar. Tokenzahl und Requestzahl sind
ausserdem verschiedene Groessen.

Im derzeitigen Code: 15 Marktauffrischungen und 5 Bewertungen je Minute,
bei Erfolg jeweils Kaufquote plus Exit-Sonde: bereits 40 Jupiter-Requests,
bevor Health, Ein-/Ausstiege oder Retries hinzukommen. Bei einem Abstand von
vier Sekunden beanspruchen allein diese 40 Anfragen 160 Sekunden Serialzeit
pro Minute. Geplante Takte sind daher keine gemessene Durchsatzgarantie.

Eine tragfaehige Planung muss das tatsaechliche Endpoint-/Key-Budget messen,
alle Verbraucher zaehlen und offene Positionen bei der Auffrischung zuerst
bedienen. Ein kleiner aktiver Satz kann haeufig gemessen werden; eine grosse
Recherchemenge braucht getrennte, ehrlich ausgewiesene Aktualitaet. Die
Auswahl darf nicht durch Loeschen der Kontrollgruppe erkauft werden.

## Verifikation dieses Aenderungssatzes

Die Betriebsdiagnose verwendet vorhandene Auftragsergebnisse, nicht erfundene
Gelegenheiten. Ein Integrationstest fuehrt die echte Handler-Ausgabe durch
die Datenbank zur Dashboard-Abfrage. Fehlende Felder alter Laeufe bleiben
unbekannt. SUPERSEDED-Aufraeumlaeufe gelten nicht als Bewertungen.
Die Aenderungen sind erst nach einem Deployment im laufenden Dashboard sichtbar.
Produktions-Commit, Hoster-Zugangsschutz und direkte DB-/Railway-Logs bleiben
separat zu verifizieren.
