# Papierkandidat testen

Der Code muss aus dem PR `codex/paper-readiness-risk-candidate` stammen,
einschliesslich DECISIONS §134. Ein altes Worker-Deployment kennt den Schalter
nicht. Der lokale Testzyklus verwendet ausschliesslich isolierte Fixtures.

## Lokale Mechanikpruefung

Mit den installierten Projektabhaengigkeiten:

```sh
pnpm exec vitest run apps/worker/src/pipeline/__tests__/candidate-preflight-wiring.test.ts apps/worker/src/pipeline/__tests__/prepare-paper-entry.test.ts apps/worker/src/pipeline/__tests__/paper-buy-account.test.ts
```

Geprueft werden Kauf, Teilverkauf, Endausstieg, Kosten, doppelte Versuche,
Budgetbegrenzung und Verlustsperren. Das ist kein Backtest einer realen Rendite.

## Worker mit aktuellen Marktdaten

1. Den geprueften PR-Stand auf dem Worker bereitstellen.
2. In der Worker-Umgebung setzen und den Worker neu starten:

   ```text
   PAPER_STRATEGY=memecoin-risk-managed-v1
   ```

3. Der vorhandene Datenbank-/Providerzugang bleibt notwendig. Der Worker muss
   zusaetzlich die oeffentlichen Coinbase-Referenzpaare USDC/EUR und SOL/EUR
   erreichen koennen. Diese Referenzabfragen verwenden keinen Coinbase-Schluessel.
4. Im Bewertungslauf die Ergebnisse pruefen. `NO_VALUATION` bedeutet fehlenden
   Fiatreferenzkurs, `NO_EXECUTABLE_BUY_QUOTE` fehlenden/ungeeigneten Kaufquote,
   `NO_EXECUTABLE_EXIT_LADDER` oder `INSUFFICIENT_EXIT_CAPACITY` fehlende
   Ausfuehrbarkeit, `COSTS_EXCEED_LIMIT` zu hohe modellierte Gesamtkosten.
   Fehlende Marktdaten oder niedrige Scores bleiben normale Einstiegssperren.
5. Erst eine gespeicherte RISK_BASED-Position und ihre anschliessenden
   Verkaufs-/Kosteneintraege belegen einen echten Papierlauf. Ein gesunder
   Prozess oder ein bestandener Test ist dafuer nicht ausreichend.

Das virtuelle Anfangsguthaben betraegt 3000 EUR je Strategiefamilie. Der erste
Einsatz liegt ohne belastbare Historie hoechstens bei 18,75 EUR vor weiteren
Kapazitaets-/Kostenpruefungen. Veraltete Groessen werden unter der Datenbanksperre
abgewiesen, statt heimlich groesser ausgefuehrt zu werden.

`PAPER_STRATEGY=legacy` beendet neue Kandidaten-Einstiege; vorhandene Positionen
werden weiter nach ihrer gespeicherten Strategieversion verwaltet. Die
Ruecksetzung einer Serienverlustsperre ist kein automatischer Neustartschritt,
sondern verlangt eine gesonderte Pruefung. Live-Trading wird durch diesen
Schalter nicht aktiviert.
