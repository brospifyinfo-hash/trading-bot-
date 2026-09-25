# Zwei Paper-Konten

Der vorhandene Worker-Schalter `PAPER_STRATEGY=memecoin-risk-managed-v1`
initialisiert und bewertet jetzt beide Profile. Kein neuer API-Schlüssel und
keine neue Worker-Variable sind dafür erforderlich.

| Regel | Standard | Offensiv |
| --- | --- | --- |
| Strategiefamilie | memecoin-risk-managed | memecoin-active-paper |
| Version | 1.0.0 (unverändert) | 1.1.0 |
| Virtuelles Startkapital je Familie | 3.000 EUR | 3.000 EUR |
| Mindestscore | 75 | 50 |
| Mindestmomentum | 60 | 50 |
| Maximale Marktkapitalisierung | 5 Mio. USD | 20 Mio. USD |
| Risikobudget pro Trade | 0,5 % | 1 % |
| Maximale Positionsgröße | 3 % | 5 % |
| Maximale Gesamtexposition | 10 % | 20 % |
| Tagesverlustgrenze | 3 % | 5 % |
| Offene Positionen maximal | 4 | 6 |
| Verlustserie bis Pause | 3 | 4 |

Das Standard-Konto übernimmt seine bestehende Historie; es wird nicht auf
3.000 EUR zurückgesetzt. Das offensive Konto hat eine eigene Strategiefamilie
und daher eigene Buchungen, Verlustgrenzen und Positionen. Kein Geldtransfer
zwischen Konten. Beide bleiben experimentell; eine Anzahl täglicher Trades
oder ein positiver Erwartungswert sind nicht nachgewiesen. Fehlende Pflichtdaten
und unzureichende Ausführbarkeit blockieren auch Offensiv. Stops, Teilverkäufe,
Trailing-Stop, Kosten-, Liquiditäts- und Sicherheitsprüfungen bleiben bestehen.

Die aktive Marktliste priorisiert bis zu 20 Coins mit brauchbaren aktuellen
Daten. Weitere Coins werden rotierend untersucht. Das ist keine vollständige
Abdeckung aller Solana-Märkte. Offene Positionen bleiben auch bei verschlechterten
Marktdaten in der schnellen Überwachung.

## Veröffentlichung / Datenbank

Diese Änderung benötigt Migration `0014_paper_account_opportunities`. Sie
ändert den Eindeutigkeitsschlüssel der Gelegenheiten um die Strategieversion.
Bestehende Zeilen bleiben erhalten. Entscheidungsschlüssel enthalten ebenfalls
die Strategieversion. Ohne beides könnten Profile dieselben Entscheidungen teilen.

Koordinierte Veröffentlichung erforderlich, kein bloßes Web-Deployment:

1. Consumer während des Übergangs pausieren und laufende Aufträge abschließen lassen.
2. Aus dem neuen Commit mit der bereits sicher hinterlegten direkten Datenbank-URL
   `pnpm db:deploy` ausführen (`DATABASE_URL_DIRECT` muss gesetzt sein).
3. Consumer mit dem neuen Commit starten; Dashboard ebenfalls veröffentlichen.
4. Im Dashboard beide Konten und in der Betriebsdiagnose zwei separate
   Bewertungsergebnisse prüfen. Ein gestarteter Worker ist kein Beleg für Käufe.

Der alte Worker erwartet den alten Unique-Index und darf nach der Migration
nicht weiterlaufen. Nicht einfach den alten Worker zurückrollen: erst einen
zum neuen Index kompatiblen Fix ausrollen. Die Datenbankmigration wird nicht
rückwärts ausgeführt. Ohne Zugriff auf Deployment und direkte DB-Verbindung
kann dieser Produktionsschritt nicht aus dem Repository heraus bestätigt werden.

## Quellen

DexScreener liefert Marktdaten/Discovery, Jupiter liefert Quotes und der
Solana-RPC deren notwendige Metadaten. Sicherheitsdaten müssen ebenfalls
vorliegen. `jupiter-quote` und `jupiter` sind getrennte Provider-Rollen; ein
ungeprüfter Router-Health-Eintrag allein beweist keinen Ausfall der Quote-Quelle.
Birdeye und Helius haben aktuell keinen implementierten Adapter. Schlüssel
allein binden sie nicht an. Geheimnisse ausschließlich im Hosting hinterlegen,
nicht in Git oder Chat. Fehlende Werte werden nicht ersetzt oder als gültig markiert.
