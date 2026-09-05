# DexScreener

**Status:** `CONNECTED`-fähig — Adapter verdrahtet, Vertrag geprüft
**`IMPLEMENTATION_CONFIDENCE`:** `SCHEMA_VERIFIED` (echte API-Antwort, 2026-09-03)
**`PRODUCTION_VERIFIED`:** wird vom `provider-health`-Dienst gesetzt, sobald er misst
**Rolle:** erster Live-Data-Provider für `TOKEN_MARKET` — Historie, **keine Einstiegsentscheidung**

---

## Der geprüfte Endpunkt

```
GET https://api.dexscreener.com/tokens/v1/{chainId}/{tokenAddresses}
```

Mehrere Adressen kommagetrennt. Kein API-Schlüssel, keine Kosten.

Das Schema steht in `packages/providers/src/dexscreener/schema.ts`, die
Normalisierung in `normalize.ts`. Die Antwort, aus der beides abgeleitet wurde,
liegt **wortgleich** als Fixture in `__tests__/real-response.ts` — nicht
gekürzt, nicht begradigt. Die Vertragstests laufen dagegen.

### Drei Annahmen, die die echte Antwort widerlegt hat

| Vermutet | Tatsächlich |
|---|---|
| Objekt mit `pairs` darin | **nacktes Array** |
| `priceUsd` ist eine Zahl | **Zeichenkette** `"100.17"` |
| `liquidity` ist eine Zahl | **Objekt** `{usd, base, quote}` |

Jede einzelne hätte ein Schema mit `z.number()` dazu gebracht, **jede** echte
Antwort abzulehnen — und der Fehlschlag hätte wie ein Anbieterausfall
ausgesehen statt wie unser Fehler. Das ist der Grund, warum
`unverifiedContract` existiert und ein Adapter ohne Primärquelle nichts
produziert.

### Gelieferte Felder

```
chainId · dexId · pairAddress · url
baseToken {address, name, symbol} · quoteToken {address, name, symbol}
priceUsd · priceNative                       (Zeichenketten)
liquidity {usd, base, quote}
txns    {m5, h1, h6, h24} je {buys, sells}
volume  {m5, h1, h6, h24}
priceChange {m5, h1, h6, h24}                (darf negativ sein)
pairCreatedAt                                (Epoch-Millisekunden)
info {imageUrl, header, openGraph, websites[], socials[]}
```

Das Schema ist `passthrough()`, nicht `strict()`: DexScreener ergänzt jederzeit
Felder, und ein strenges Schema würde bei der nächsten Erweiterung die gesamte
Datenaufnahme anhalten — ein Ausfall aus reiner Formstrenge.

### Was in der Stichprobe FEHLTE

**`fdv` und `marketCap`** waren nicht enthalten, obwohl beide in der Feldliste
der Spezifikation V1 stehen. Sie bleiben `null` — NOT_AVAILABLE, nicht 0. Aus
Preis und geschätzter Umlaufmenge eine Marktkapitalisierung zu rechnen wäre die
Erfindung, die dieses System ausschließt.

Das hat eine Folge: `marketCapUsd` steht in `REQUIRED_FOR_ENTRY`. Solange
DexScreener es nicht liefert, besteht kein Token den Qualitätsgate. Ob das
allgemein gilt oder eine Eigenheit von Wrapped SOL ist (Wrapper ohne feste
Supply), entscheidet eine zweite Stichprobe mit einem echten Memecoin — nicht
eine Annahme.

---

## Kein Beobachtungszeitpunkt — und was daraus folgt

Bestätigt an der echten Antwort: **es gibt keinen Zeitstempel zur
Preisangabe.** `pairCreatedAt` gehört zum Handelspaar, nicht zum Preis.

`DexScreenerMarket.observedAt` ist deshalb im Typ das Literal **`null`**, nicht
`Date | null`. Niemand kann dort später den Empfangszeitpunkt eintragen, ohne
den Typ zu ändern und dabei zu merken, was er tut. Ein erfundener
Beobachtungszeitpunkt wäre Look-Ahead mit Wirkung bis in jeden Backtest.

Durchgereicht wird das als `freshnessSeconds: null` — **unbekannt, nicht 0**.
Daraus folgt, durchgesetzt vom Code:

| | erlaubt |
|---|---|
| Snapshot-Historie aufbauen | **ja** — `decideIngest` nimmt auf |
| Momentum über die eigene Zeitreihe | **ja** |
| Anbieter vergleichen, Coverage messen | **ja** |
| Live-Einstiegssignal | **nein** — `snapshotSupportsEntry` lehnt ab: „Anbieter liefert kein Datenalter. Unbekannt ist nicht frisch." |

Das ist kein Mangel dieser Implementierung, sondern eine Eigenschaft der
Quelle. Für Einstiegsentscheidungen braucht es eine Quelle mit
verifizierbarem Zeitstempel — ein Jupiter-Quote trägt `contextSlot`, und ein
Solana-RPC liefert die Slot-Zeit dazu. Beides kostenlos.

---

## Mehrere Pools je Token

Ein Token hat selten einen Pool. Die Antwort enthält alle, und sie ist **keine
Rangfolge**. Welcher Markt die Analyse trägt, entscheidet `selectMarket`
(`packages/pipeline/src/market-selection.ts`) — nach Liquidität, nicht nach
Volumen, und mit zehn getrennten Ausschlussgründen. Der Übergang steht in
`apps/worker/src/pipeline/market-adapters.ts`.

Adressen aus der Antwort werden vor der Auswahl gegen Base58 geprüft. Eine
unbrauchbare Pool- oder Mint-Adresse ist ein Anbieterfehler oder etwas
Schlimmeres; in beiden Fällen hat sie in einer Auswahl nichts verloren.

---

## Request-Ökonomie

Der Endpunkt nimmt mehrere Adressen. **Bulk vor Einzelabruf:**

| Weg | Aufrufe für 300 Tokens | bei 300 RPM |
|---|---|---|
| Einzeln | 300 | 1 Minute Volllast |
| Bündel zu 30 | 10 | 2 Sekunden |

`provider_requests.tokens_covered` hält fest, wie viele Tokens ein Aufruf
abgedeckt hat — daraus lässt sich die Ersparnis messen statt schätzen.

**UNVERIFIED:** die Obergrenze der Adressen je Aufruf (angenommen 30) und das
Rate Limit von 300 RPM stammen aus Spezifikation V1, nicht aus einer
Primärquelle. Beide gehören überprüft, sobald der Betrieb genug Aufrufe
gesehen hat.

---

## Konfiguration

| Variable | Wert |
|---|---|
| `DEXSCREENER_BASE_URL` | `https://api.dexscreener.com` |

Ohne sie gilt der Anbieter als `NOT_CONFIGURED` und wird weder gemessen noch
gefragt. Die Basis-URL steht bewusst nicht im Code: ein Anbieterwechsel soll
keine Codeänderung sein.

Kein Schlüssel, keine Kosten.
