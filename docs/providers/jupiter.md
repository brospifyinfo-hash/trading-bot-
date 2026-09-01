# Jupiter — Swap API

**Status:** **LEGACY / VERIFIED** — Swap v1, aus der Hersteller-OpenAPI geprueft.
Bleibt bestehen und wird nicht geloescht.

**Zielarchitektur:** **TARGET / NOT YET VERIFIED** — Swap v2 bzw. die aktuelle
Order-&-Execute-Architektur. `IMPLEMENTATION_CONFIDENCE = SHAPE_ONLY`,
`PRODUCTION_VERIFIED = false`. Der Vertrag ist aus dieser Umgebung nicht
lesbar; bis zur Verifikation wird dafuer kein Adapter gebaut.

Unterschied, der zaehlt: bei Swap v1 signieren und senden **wir**, im
Zielmodell sendet der Anbieter. Das verschiebt die Signer-Grenze — und die
bleibt unveraendert, solange der Vertrag nicht verifiziert ist.

Siehe [`../PROVIDER-INTEGRATION-PLAN.md`](../PROVIDER-INTEGRATION-PLAN.md),
Abschnitt „Jupiter: LEGACY / VERIFIED gegen TARGET / NOT YET VERIFIED".

Unten steht ausschliesslich das aus Swap **v1** Verifizierte.
**Quelle:** `https://raw.githubusercontent.com/jup-ag/jupiter-quote-api-node/main/swagger.yaml`
— OpenAPI 3.0.2, `info.title: "Swap API"`, `info.version: 1.0.0`, Hersteller-eigenes Repository
**Geprüft am:** 2026-08-30
**Nicht geprüft:** `dev.jup.ag` (Egress-Policy, 403) — dort stehen Rate Limits und Tarife

---

## Verifiziert

### Base-URL
```
https://api.jup.ag/swap/v1
```
Steht als einziger Eintrag unter `servers` in der Spezifikation.

### Endpunkte
| Methode | Pfad | Zweck |
|---|---|---|
| `GET` | `/quote` | Quote für einen Swap |
| `POST` | `/swap` | Unsignierte Transaktion (base64) aus einem Quote |
| `POST` | `/swap-instructions` | Einzelinstruktionen statt fertiger Transaktion |
| `GET` | `/program-id-to-label` | Programm-ID → Label, zur Fehlerzuordnung |

### `GET /quote` — Parameter
`inputMint`, `outputMint`, `amount`, `slippageBps`, `swapMode`, `dexes`,
`excludeDexes`, `restrictIntermediateTokens`, `onlyDirectRoutes`,
`asLegacyTransaction`, `platformFeeBps`, `maxAccounts`, `instructionVersion`,
`dynamicSlippage`

### `QuoteResponse` — Pflichtfelder
`inputMint`, `outputMint`, `inAmount`, `outAmount`, `otherAmountThreshold`,
`swapMode`, `slippageBps`, `priceImpactPct`, `routePlan`

Optional: `platformFee`, `contextSlot`, `timeTaken`, `instructionVersion` (`V1` | `V2`, nullable)

**Typen, die zählen:**
- `inAmount`, `outAmount`, `otherAmountThreshold` sind **Strings**, nicht Zahlen — u64-Werte überschreiten die sichere Double-Präzision. Passt zur bigint-Arithmetik in `@sae/core`.
- `priceImpactPct` ist ebenfalls ein **String** und ein Dezimalbruch (`"0.0012"` = 0,12 %), keine Basispunkte.
- `slippageBps` ist ein Integer (uint16).

### `POST /swap`
Request: `userPublicKey` und `quoteResponse` sind Pflicht; dazu u. a. `payer`,
`wrapAndUnwrapSol` (Default `true`), `useSharedAccounts`.
Response: `swapTransaction` (base64, Pflicht), `lastValidBlockHeight` (Pflicht),
`prioritizationFeeLamports` (optional).

---

## Der wichtigste Befund

Die Spezifikation sagt zu `otherAmountThreshold` wörtlich:

> *Calculated minimum output amount after accounting for `slippageBps` on the
> `outAmount` value.* **Not used by `/swap` endpoint to build transaction.**

Das heißt: **die im Quote genannte Mindestausgabemenge ist nicht die, die
on-chain gilt.** Die tatsächlich durchgesetzte Untergrenze steckt in der von
`/swap` gebauten Transaktion.

**Folge für die Signer-Policy:** Die Prüfung `minOut != null && minOut > 0` darf
ihren Wert **nicht** aus dem Quote nehmen, sondern muss ihn aus der dekodierten
Transaktion lesen. Genau deshalb arbeitet `SignerPolicy` auf einer
normalisierten `DecodedTransaction` und nicht auf dem Quote-Objekt — der
Dekodier-Adapter in Phase 12 muss den Wert aus der Instruktion ziehen.

Zweite Folge: Quote-`otherAmountThreshold` und tatsächliche Untergrenze können
auseinanderlaufen, besonders bei `dynamicSlippage`. Die Differenz ist beim
Kalibrieren des Kostenmodells zu messen, nicht anzunehmen.

---

## Offen

| Frage | Warum sie zählt |
|---|---|
| Rate Limits je Tarif | Bestimmt den Takt der Discovery- und Scoring-Schleife |
| Existiert `lite-api.jup.ag` weiterhin als freier Tarif? | Suchergebnisse legen es nahe, die Spezifikation nennt ihn **nicht**. Ungeprüft. |
| API-Key: Header-Name und Pflicht ab welchem Tarif | Auth-Implementierung |
| Verhalten bei Rate Limit (Status, `Retry-After`) | Backoff-Strategie |
| Verhalten bei nicht routbarem Token | Muss zu `Missing`, nicht zu einer Ausnahme führen |
| Semantik von `dynamicSlippage` | Beeinflusst direkt die durchgesetzte Untergrenze |

Bis diese Punkte geklärt sind, läuft der Adapter mit konservativen Annahmen:
niedrige Anfragerate, jede unbekannte Antwortform wird als `PARSE_FAILED`
behandelt statt interpretiert.
