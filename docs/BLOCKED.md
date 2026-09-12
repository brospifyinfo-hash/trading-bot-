# Was blockiert ist — und woran genau

Stand: 2026-09-12, nach §117–§124. Diese Datei ist bewusst kurz und konkret.
Sie beantwortet eine Frage: **was fehlt, damit dieses System tut, wofür es
gebaut ist?**

> **Zur Vorgeschichte.** Bis zum 2026-09-01 stand hier als „die eine Ursache"
> der Egress dieses Entwicklungscontainers: kein Anbieter war erreichbar, alle
> antworteten mit `403 CONNECT`. Das gilt **für diese Umgebung weiterhin** — und
> es war nie eine Eigenschaft des Systems. Von Railway aus sind die Anbieter
> erreichbar, gemessen und verifiziert. Eine Umgebungseigenschaft als
> Systemzustand zu führen war der Fehler, den dieser Abschnitt korrigiert.

---

## Gemessener Stand

Aus `/api/diagnostics/providers`, nicht aus dieser Datei abgeschrieben:

```
headline: PROVIDER VERIFIED
```

| Anbieter | Zustand | Wofür |
|---|---|---|
| `dexscreener` | CAPABILITY_READY, Smoke 200 | Discovery, Liquidität, Volumen, Marktkapitalisierung |
| `jupiter-quote` | CAPABILITY_READY, Smoke 200 | Preis **mit Zeitstempel**, Preiseinfluss, Ausstiegsfähigkeit |
| `rugcheck` | CAPABILITY_READY, Smoke 200 | Mint-/Freeze-Autorität, Holder-Konzentration |
| `birdeye`, `helius` | NOT_CONFIGURED | nicht hinterlegt |
| `jupiter` (Router) | UNAVAILABLE | Ausführungspfad — siehe unten |

Die Kette läuft damit von der Entdeckung bis zur Einstiegsentscheidung.

---

## Was jetzt blockiert

### 1. Migration 0013 ist nicht gefahren

`token_snapshots.exit_capacity_ratio` fehlt in der Produktionsdatenbank.
**Solange sie fehlt, scheitert jeder Snapshot-Schreibvorgang** — Postgres lehnt
das INSERT vollständig ab, der Bot sammelt nichts.

Behoben durch einen Lauf der GitHub-Action „Datenbank migrieren"
(Bestätigungswort `MIGRATE`). Railway führt Migrationen ausdrücklich nicht aus.

### 2. Die Einstiegsschwelle ist noch nicht erreicht

Gemessen: Endscore **70**, Schwelle **75**. Das ist kein Defekt, sondern die
Strategie — sie darf und soll ablehnen. Der Bot meldet `WATCH`, also „noch
nicht gut genug", und beobachtet weiter.

Fünf Punkte fehlen. Ob ein Token sie erreicht, ist eine empirische Frage und
wird gemessen, nicht behauptet.

### 3. Vier fehlende Datenquellen deckeln den Score strukturell

`smartMoney` (0.12), `dev` (0.07), `social` (0.06), `narrative` (0.05) haben
keine Quelle. Zusammen 0.30 Gewicht, die dauerhaft fehlen: `weightCoverage`
liegt deshalb bei 0.70 — bestanden, aber am Anschlag.

Seit §121 zählt `dataCompleteness` diese Felder nicht mehr mit; die
strukturelle Lücke steht am dafür vorgesehenen Instrument statt doppelt.

### 4. Der Ausführungspfad ist nicht erreichbar

`jupiter` (Router) meldet UNAVAILABLE, während `jupiter-quote` (Marktdaten)
arbeitet. Die beiden teilen sich einen Host und sonst nichts. Für die erste
Papier-Position wird der Router gebraucht — ohne ihn gibt es keinen Fill.

Noch nicht untersucht, weil vor der Migration keine Entscheidung ein `ENTER`
erreicht hat.

---

## Gebaut, getestet, nie benutzt

Die unangenehmste Kategorie: nichts davon sieht kaputt aus.

| Was | Zustand |
|---|---|
| **Benachrichtigungen** (Resend-Adapter, E-Mail-Vorlage, INVEST-NOW-Prüfkette mit 12 Blockiergründen) | Von **nirgendwo** aufgerufen. Kein Verweis im Worker oder in der Web-App. Es gibt keinen Weg, informiert zu werden. |
| `SCORE_TOKEN`, `RECONCILE`, `STRATEGY_HEALTH`, `RESEARCH_BATCH` | Zeigen auf den allgemeinen Marktdaten-Handler: holen Daten, werfen sie weg. Keine berührt offenen Bestand. |
| **Anmeldung** | Formular vorhanden, Magic Link nicht aktiv. Kein Zugangsschutz vor dem Dashboard — wer die URL kennt, sieht es. |

Der Wächter `laesst keinen verdrahteten Handler ohne Takt, der ihn ruft`
(§118) hält die zweite Zeile automatisch aktuell. Die erste und dritte sind
von Hand gepflegt und driften entsprechend.

---

## Bewusst nicht gebaut

| Was | Warum nicht |
|---|---|
| Live-Handel | Es gibt keinen Live-Executor. `packages/trading` enthält genau eine Klasse: `PaperExecutor`. |
| Signieren | `apps/signer` hält Transport, mTLS und Policy vollständig und antwortet auf eine echte Signieranfrage mit **501**. Bewusst kein halbfertiges Signieren. |
| Snipen | `minTokenAgeSeconds: 300` schließt Token unter fünf Minuten aus. Die Entdeckung läuft über einen Profil-Feed, nicht über einen Start-Strom. Beides ist eine Entscheidung, keine Lücke. |
| Adapter mit erfundenen Endpunktpfaden | Ein ungeprüfter Pfad erzeugt Fehlschläge, die wie Anbieterprobleme aussehen. |
| Beispiel- oder Demodaten im Dashboard | Eine Oberfläche mit erfundenen Zahlen gewöhnt einen daran, ihnen zu glauben. |
| Ein Simulator als Provider-Ersatz | Er würde die gesamte Kette grün färben und nichts beweisen. |

---

## Offene Altlast

Historische Snapshots tragen `source_freshness_seconds = 0` — ein erfundener
Wert aus der Zeit vor §89. Sie sind nicht angefasst worden, weil das Ändern
bestehender Daten eine Entscheidung des Betreibers ist und keine technische.

---

## Wo die Wahrheit steht

Diese Datei ist von Hand gepflegt und driftet deshalb — sie hat es zwischen
dem 2026-09-01 und heute getan, und das war der Anlass, sie neu zu schreiben.
Abgeleitet und damit verlässlich sind:

| Frage | Wo sie beantwortet wird |
|---|---|
| Kommt das System an Daten? | `/api/diagnostics/providers` |
| Läuft der Prozess? | `/api/health` |
| Was tut jede Auftragsart wirklich? | `describeWiring` + die Wächter in `scheduler-dispatch.test.ts` |
| Warum kauft der Bot nicht? | Panel „Entscheidungen" im Dashboard, und die Log-Zeile `Gelegenheiten geprueft` |
| Warum wurde etwas so gebaut? | `DECISIONS.md` |
