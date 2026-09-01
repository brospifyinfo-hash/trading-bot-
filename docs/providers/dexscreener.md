# DexScreener

**Status:** `CONFIGURED` — kein Adapter, kein Parser
**`IMPLEMENTATION_CONFIDENCE`:** `SCHEMA_KNOWN` (Feldnamen aus Spezifikation V1, Stufe S)
**`PRODUCTION_VERIFIED`:** `false`
**Freigegeben als:** erster Live-Data-Provider für `TOKEN_MARKET`

---

## Warum kein Adapter existiert

Ein Parser braucht die **Struktur** der Antwort, nicht nur die Feldnamen.
Bekannt sind aus Spezifikation V1 (Stufe S):

```
priceNative · priceUsd · txns · volume · priceChange · liquidity
fdv · marketCap · pairCreatedAt · websites · socials · boosts
```

Unbekannt ist alles darüber, wie sie verschachtelt sind: Kommt eine nackte
Liste zurück oder ein Objekt mit `pairs`? Ist `liquidity` eine Zahl oder ein
Objekt mit `usd` / `base` / `quote`? Hat `volume` Unterfelder je Zeitfenster?
Jede dieser Fragen entscheidet, ob der Parser funktioniert.

**Gesucht wurde nach einer belastbaren Quelle, gefunden wurde keine:**

| Quelle | Ergebnis |
|---|---|
| `docs.dexscreener.com` | Egress blockiert |
| `api.dexscreener.com` | `403 Host not in allowlist` |
| GitHub-Organisation `dexscreener` | über die API dieser Sitzung nicht erreichbar |
| npm | zwölf Treffer, **alle von Dritten**; der beste ist von 2022 |

Eine Fremdbibliothek ist kein Anbietervertrag, und eine vier Jahre alte erst
recht nicht. Ein Parser auf geratenem Nesting hätte zwei Wirkungen: er
scheitert beim ersten echten Kontakt, und die dazugehörigen Test-Fixtures
würden eine Antwortform behaupten, die es möglicherweise nie gab.

---

## Smoke-Test — durchgeführt, nicht simuliert

```
GET https://api.dexscreener.com/tokens/v1/solana/So111...112
```

| | |
|---|---|
| Ausgeführt am | 2026-09-01 |
| Erreichbar | ja, aber nicht der Anbieter |
| HTTP-Status | **403** |
| Latenz | 120 ms |
| Antwort | `Host not in allowlist: api.dexscreener.com. Add this host to your network egress settings to allow access.` |

Der 403 kommt vom **Egress-Proxy dieser Umgebung**, nicht von DexScreener. Wir
haben den Anbieter nie erreicht.

Deshalb setzt `recordSmokeTest` in diesem Fall **nichts** — weder
`PRODUCTION_VERIFIED` noch den Zustand `CONNECTED`. Einen 403 als „verbunden"
zu verbuchen wäre eine Behauptung über eine Verbindung, die es nicht gab.

---

## Was den Adapter freischaltet

Genau zwei Dinge, beide auf deiner Seite:

**1. Egress freigeben.** Die Fehlermeldung nennt den Weg selbst:
`api.dexscreener.com` in die Netzwerk-Egress-Einstellungen der Umgebung
aufnehmen. Danach läuft der Smoke-Test durch und liefert eine echte Antwort.

**2. Eine echte Antwort beschaffen.** Falls die Freigabe nicht möglich ist,
genügt ein Aufruf von deiner Maschine:

```bash
curl -s "https://api.dexscreener.com/tokens/v1/solana/So11111111111111111111111111111111111111112" \
  | head -c 4000
```

Die Ausgabe ist der Vertrag. Damit steht `IMPLEMENTATION_CONFIDENCE` auf
`SCHEMA_VERIFIED`, und der Adapter ist in einem Zug baubar: Zod-Schema,
Normalisierung, Fehlerabbildung, Contract-Tests.

---

## Datenqualität — vorab bekannt

Auch mit verifiziertem Schema bleibt eine Einschränkung, und sie ist wichtig
genug, sie vor dem Bauen festzuhalten.

DexScreener liefert laut Spezifikation V1 **keinen Beobachtungszeitpunkt für
den Preis**. `pairCreatedAt` gehört zum Handelspaar, nicht zur Preisangabe.

Daraus folgt, durchgesetzt von der Datenbank:

| Feature | `decision_safety` | Begründung |
|---|---|---|
| `market.price_usd` | **RESEARCH_ONLY** | kein Anbieterzeitpunkt |
| `market.liquidity_usd` | **RESEARCH_ONLY** | dito |
| `market.market_cap_usd` | **RESEARCH_ONLY** | dito |
| `market.volume_*` | **RESEARCH_ONLY** | dito |
| `token.pair_created_at` | **DECISION_SAFE** | eigener, echter Zeitstempel |

`observed_at` bleibt **NULL**. Es wird kein Ersatz konstruiert — weder aus
`pairCreatedAt` noch aus dem Empfangszeitpunkt. Die CHECK-Constraint
`feature_obs_safety_needs_timestamp` erzwingt, dass ein Feature ohne
Beobachtungszeitpunkt nur `RESEARCH_ONLY` sein kann.

**Was das praktisch heißt:**

- **Erlaubt:** Snapshot-Historie aufbauen, Momentum über die eigene Zeitreihe
  ableiten, Coverage und Latenz messen, Anbieter vergleichen.
- **Nicht erlaubt:** ein Live-Einstiegssignal. Der Tier ist `SECONDARY`, und
  `snapshotSupportsEntry` lässt eine Einstiegsentscheidung darauf nicht zu.

Das ist kein Mangel dieses Adapters, sondern eine Eigenschaft der Quelle — und
der Grund, warum DexScreener der **erste** Provider ist und nicht der
**primäre**.

---

## Request-Ökonomie

Der Endpunkt nimmt laut Spezifikation V1 mehrere Adressen (`tokenAddresses`).
Damit gilt die Regel aus dem Integrationsplan: **Bulk vor Einzelabruf.**

| Weg | Aufrufe für 300 Tokens | bei 300 RPM |
|---|---|---|
| Einzeln | 300 | 1 Minute Volllast |
| Bulk zu je 30 | 10 | 2 Sekunden |

`provider_requests.tokens_covered` hält fest, wie viele Tokens ein Aufruf
abgedeckt hat — daraus lässt sich später die tatsächliche Ersparnis messen
statt sie zu schätzen.

Die genaue Obergrenze je Aufruf ist **UNVERIFIED** und gehört zu den Fragen,
die die echte Antwort beantwortet.
