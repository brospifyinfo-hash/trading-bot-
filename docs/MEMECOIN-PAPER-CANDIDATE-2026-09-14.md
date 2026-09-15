# Ausgewaehlter Papier-Testkandidat

Stand 14.09.2026. Implementiert, nicht aktiviert. Profitabilitaet unbekannt.

## Was ich uebernehme

- [BONKbot Limit Sell](https://docs.bonkbot.io/bonkbot/advanced-trading/limit-orders/limit-sell): getrennte Gewinnmitnahmen und Verlustausstiege.
- [BONKbot Trailing Stop](https://docs.bonkbot.io/bonkbot/advanced-trading/limit-orders/trailing-stop-loss): Stop folgt guenstigen Kursbewegungen.
- [Warp](https://github.com/warp-id/solana-trading-bot): Kaufbetrag getrennt von Gewinn-/Verlustgrenzen, Slippage und Zeitlimit.
- [Hummingbot PositionExecutor](https://hummingbot.org/strategies/v2-strategies/executors/positionexecutor/): Positionsverwaltung mit TP, Stop, Trailing und Zeitlimit.

Diese Dokumentationen belegen Funktionen, keine langfristigen Nettoertraege. Die
folgenden Zahlen sind meine Auswahl fuer ein kontrolliertes Experiment, nicht
kopierte oder nachgewiesen optimale Einstellungen anderer Bots.

## Gewaehlte Einstellungen

| Einstellung | Testwert | Begruendung |
|---|---|---|
| Geplantes Stop-Risiko vor Kosten | 0,5 % des Papierdepotwertes | Verluste einer Einzelposition begrenzen; Konfidenz reduziert weiter |
| Einsatz pro Coin | variabel, maximal 3 % | begrenzt Konzentration auch bei Versagen des Stops |
| Gesamtes Exposure | maximal 10 % | Kapitalreserve; keine Annahme unabhaengiger Memecoins |
| Tagesverlust / Verlustserie | 3 % / 3 Verluste | Kandidat soll pausieren; Anschluss an echte Buchhaltung erforderlich |
| Offene Positionen | maximal 4 | konzentrierte Ueberwachung |
| Stop | 20 % unter Einstieg | bestehender Abstand bleibt Vergleichsbasis, keine Verkaufsgarantie |
| Erste Gewinnmitnahme | bei +25 %: 40 % verkaufen | frueher einen groesseren Anteil realisieren |
| Zweite Gewinnmitnahme | bei +50 %: 30 % verkaufen | weitere Reduzierung des eingesetzten Kapitals |
| Dritte Gewinnmitnahme | bei +100 %: 20 % verkaufen | noch 10 % fuer weitere Kursgewinne lassen |
| Basis-Trailing | 15 % unter Hoch | bestehender Manager kann durch Risikosignale frueher aussteigen |
| Zeitlimit | 6 Stunden | keine unbegrenzt gebundenen Positionen |
| Modellierte Gesamtkosten | hoechstens 2 % des Einsatzes | Kauf plus alle vorgesehenen Teilverkaeufe, keine pauschale Null |

Alle Verkaufsanteile beziehen sich auf die Ursprungsposition. Kursziele sind
Bruttokursbewegungen, kein Nettogewinn. Bei +25 % und 40 % Verkauf sind erst
10 % der urspruenglichen Positionssumme als Bruttokursgewinn realisiert; der
Rest kann weiter verlieren. Gaps, fehlende Liquiditaet und Ausfuehrungsfehler
koennen einen Stop wirkungslos machen. Ein Coin kann den gesamten Einsatz kosten.

Bei 3.000 EUR Testkapital, 20 % Stop und ohne weitere Begrenzung ergeben sich
75 EUR vor Konfidenzabschlag, bei Konfidenz 0 dagegen 18,75 EUR. Beispielhafte
0,30 EUR Gesamtkosten entspraechen 1,6 % dieses Einsatzes. Das ist lediglich
ein Rechenbeispiel, keine gemessene Gebuehr. Kosten von 0,38 EUR wuerden bereits
das 2-%-Budget ueberschreiten; der Rechner vergroessert deshalb nicht den Einsatz.

## Implementierung und Grenze

`MEMECOIN_PAPER_CANDIDATE` ist ein separat versionierbares Profil.
`sizeCostAwarePaper` berechnet den begrenzten Einsatz mit expliziten Eingaben.
Die Opportunity-Pipeline nimmt einen bewerteten `riskBasedEntry` entgegen und
speichert ihn als RISK_BASED. Sie blockiert abweichende Auftragsgroessen.

Seit §134 kann der Worker den Kandidaten ausdruecklich ueber
`PAPER_STRATEGY=memecoin-risk-managed-v1` auswaehlen. Kontorechnung,
Budgetbegrenzung, mengenabhaengige Kauf-/Ausstiegsquotes und Verlustsperren sind
angeschlossen. Der lokale Fixture-Zyklus prueft Kauf, Teilverkauf und Endausstieg.
Der Schalter wurde nicht in der Zielumgebung gesetzt; ein dortiger vollstaendiger
Papierzyklus mit externen Kursen ist noch nicht nachgewiesen. Ablauf und
Sperrgruende stehen in [PAPER-TESTSTART.md](PAPER-TESTSTART.md).

## Wann der Ansatz als brauchbar gelten kann

Den Kandidaten gegen die bisherige Leiter auf denselben Eintrittsgelegenheiten
vergleichen. Chronologisch getrennte Testdaten verwenden, inklusive abgelehnter
und gescheiterter Ausfuehrungen; keine Auswahl nur ueberlebender Tokens.
Mindestens die bestehenden 100 abgeschlossenen Papier-Trades pro Version und
die Out-of-Sample-Pruefung bleiben erforderlich. Ein positives Gesamtergebnis
muss nach Kosten bestehen und darf nicht nur von einem einzelnen Glueckstreffer
abhaengen. Drawdown, Netto-Erwartungswert, Verlustserien und Ergebnis bei hoeheren
Kosten/Verzoegerungen gemeinsam pruefen. 100 Trades allein beweisen keinen
langfristigen Vorteil. Ohne diesen Nachweis gibt es keine Renditebehauptung.
