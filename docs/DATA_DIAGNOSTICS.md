## §139 — Produktionsdiagnose und tatsächlich erhobene Holder-Daten (2026-09-28)

Der Live-Lauf zeigte Score 76 bei DATA_INCOMPLETE: sieben fehlende Felder
unter 23, also 69,565 % bei 70 % Mindestabdeckung. Ganze Prozentwerte
verschleierten den Unterschied. Die Diagnose zeigt jetzt pro Coin und Konto
Score, Abdeckung, fehlende Felder und Gründe; Kaufquoten erhalten ihren
Missing-Grund. Nicht implementierte pending-Felder bleiben sichtbar.

RugCheck totalHolders war in token_security.findings gespeichert, wurde aber
vom PIT-Reader nicht weitergegeben. Der Feature-Bau verwendet nun diese
validierte Anzahl, wenn der Marktsnapshot keine enthält. Der originale
Beobachtungszeitpunkt bleibt erhalten; Berichte nach dem Snapshot oder älter
als das bestehende sechs Stunden Sicherheitsintervall werden nicht verwendet.
Holder-Wachstum wird daraus nicht erfunden. Die zwei nirgends erhobenen
Clustering-Felder zählen nicht mehr zur collectible completeness, bleiben
aber als fehlend sichtbar. Score-Engine-Version steigt deshalb auf 1.2.0.
Score-Gewichte, Mindestabdeckung, Sicherheits- und Ausführungsgrenzen bleiben
unverändert. Prozentwerte zeigen eine Nachkommastelle.

Validierung: 107 Scoring-/Decision-/Konten-Tests, 13 Feature-Bau-Tests,
11 Diagnose-/Preflight-Tests sowie Worker/Web-Typprüfung bestanden.
Das ist keine Bestätigung profitabler oder bereits ausgeführter Trades.
