# Birdeye — nicht geprüft, kein Adapter

**Status:** Verifikation blockiert
**`IMPLEMENTATION_CONFIDENCE`:** `UNVERIFIED`
**`PRODUCTION_VERIFIED`:** `false`
**Letzter Versuch:** 2026-09-03

---

## Was am 2026-09-03 tatsächlich passiert ist

Jeder Birdeye-Host ist aus dieser Umgebung nicht erreichbar. Der `403` kommt vom
**Egress-Gateway dieser Umgebung**, nicht von Birdeye — wir haben den Anbieter
nie erreicht.

| Host | Ergebnis |
|---|---|
| `docs.birdeye.so:443` | `403` auf CONNECT (Policy-Ablehnung) |
| `public-api.birdeye.so:443` | `403` auf CONNECT |
| `birdeye.so:443` | `403` auf CONNECT |
| `beta-bds.birdeye.so:443` | nicht erreichbar |
| `medium.com` (Birdeye-Blog) | Egress blockiert |
| `blog.sui.io` | nicht erreichbar |

Protokolliert vom Proxy selbst als
`connect_rejected — gateway answered 403 to CONNECT (policy denial or upstream failure)`.

Erreichbar war ausschließlich die Websuche. Sie liefert **Trefferlisten und
Zusammenfassungen, keine Spezifikation** — und eine Zusammenfassung ist kein
Anbietervertrag.

---

## Warum trotzdem kein Adapter entstanden ist

Ein Parser braucht die **Struktur** der Antwort, nicht ihren Namen. Bekannt ist
aus der Suche nur, dass Pfade dieser Form existieren. Unbekannt ist alles, was
über „es gibt sie" hinausgeht:

- Wie heißen die Felder im Antwortkörper, und wie sind sie verschachtelt?
- Steckt die Nutzlast unter `data`, und liegt daneben ein `success`-Flag?
- Ist `liquidity` eine Zahl oder ein Objekt?
- Welchen **Beobachtungszeitpunkt** liefert der Anbieter mit? Ohne ihn bleibt
  `observed_at` `NULL`, und dann kann das Feature nur `RESEARCH_ONLY` sein —
  dieselbe Einschränkung wie bei DexScreener, durchgesetzt von der
  CHECK-Constraint `feature_obs_safety_needs_timestamp`.
- Was passiert bei unbekanntem Token: leeres Ergebnis oder Fehler?
- Was steht bei Rate Limit im Statuscode und in `Retry-After`?

Ein Adapter auf erinnerten oder aus Suchtreffern geratenen Feldern wäre genau
der Fehler, den `ARCHITECTURE.md` §13 ausschließt: er liefert im Betrieb still
falsche oder gar keine Daten, und das Ergebnis ist von echten Daten nicht zu
unterscheiden.

---

## UNVERIFIED — Spuren aus der Websuche, nicht aus der Dokumentation

**Diese Zeilen sind keine Spezifikation.** Sie stammen aus Suchtreffer-Titeln
und -Zusammenfassungen und stehen hier ausschließlich, damit die Prüfung unten
gezielt laufen kann. Nichts davon geht in dieser Form in Code.

| Zweck laut Suchtreffer | Pfad laut Suchtreffer | Zustand |
|---|---|---|
| Token Market Data (Single) | `/defi/v3/token/market-data` | UNVERIFIED |
| Token List (V3) | `/defi/v3/token/list` | UNVERIFIED |
| Search — Token, Market Data | `/defi/v3/search` | UNVERIFIED |
| Token Holder | `/defi/v3/token/holder` | UNVERIFIED |
| Price | `/defi/price` | UNVERIFIED |

Base-URL laut Suchtreffer: `https://public-api.birdeye.so`.
Header laut Suchtreffer: ein API-Key-Header und ein Chain-Header.
**Die genauen Header-Namen sind UNVERIFIED** und werden nicht geraten.

### Tarif und Preis: aus dieser Umgebung nicht beantwortbar

Die Preisseite (`birdeye.so/data-api/pricing`, `docs.birdeye.so/docs/pricing`)
ist blockiert. Die Suchtreffer widersprechen sich in den Zahlen und mischen
zusätzlich ein **gleichnamiges, aber völlig anderes Produkt** (Birdeye als
Reputationsmanagement-SaaS unter `birdeye.com`) unter dieselben Suchbegriffe.

Daraus einen Tarif abzuleiten hieße, eine Kaufempfehlung auf verwechselte
Quellen zu stützen. Die Frage „welcher Tarif reicht" wird deshalb hier **nicht**
beantwortet, sondern nach der Prüfung unten — dann mit der echten Preisseite und
den echten Compute-Kosten der tatsächlich benötigten Endpunkte.

---

## Was den Adapter freischaltet

Genau eines von beidem genügt.

**Weg A — Egress freigeben.** `docs.birdeye.so` und `public-api.birdeye.so` in
die Netzwerk-Egress-Einstellungen der Umgebung aufnehmen. Danach lese ich die
Dokumentation selbst und baue Zod-Schema, Normalisierung, Fehlerabbildung und
Contract-Tests in einem Zug.

**Weg B — eine echte Antwort beschaffen.** Ein Aufruf von einer Maschine mit
freiem Netzzugang. Der API-Key gehört **nicht** in den Chat und **nicht** ins
Repository:

```bash
# Key nur in die lokale Shell, nicht in eine Datei im Repo
set BIRDEYE_KEY=...            # Windows CMD
# export BIRDEYE_KEY=...       # macOS/Linux

curl -s "https://public-api.birdeye.so/defi/v3/token/market-data?address=So11111111111111111111111111111111111111112" ^
  -H "X-API-KEY: %BIRDEYE_KEY%" -H "x-chain: solana" -i | more
```

Gebraucht werden **die vollständigen Antwort-Header und der vollständige
Antwortkörper** — Header wegen Rate-Limit-Angaben, Körper wegen der Struktur.
Der Key selbst wird nicht gebraucht und soll nicht mitgeschickt werden.

Sobald diese Antwort vorliegt, steht `IMPLEMENTATION_CONFIDENCE` auf
`SCHEMA_VERIFIED` und der Adapter ist baubar.

---

## Was unabhängig davon schon steht

Die Schicht, in die der Adapter eingehängt wird, ist fertig und geprüft:

| Baustein | Ort | Zustand |
|---|---|---|
| Adapter-Schnittstelle | `MarketDataAdapter` in `packages/pipeline/src/provider-chain.ts` | fertig |
| Kette aus Konfiguration | `buildMarketDataChain` | fertig, `MARKET_DATA_PRIORITY` steuert die Stufen |
| Konfigurationseintrag | `BIRDEYE_BASE_URL`, `BIRDEYE_API_KEY` in `packages/config/src/providers.ts` | vorhanden, `adapterImplemented: false` |
| Fünf Anbieterzustände | `packages/providers/src/health.ts` | fertig |
| Rate Limit, Budget, Circuit Breaker | `packages/providers/src/` | fertig |
| Qualitätsprüfung der Felder | `packages/pipeline/src/market-data-quality.ts` | fertig, anbieterunabhängig |

Der Adapter ist damit das einzige fehlende Stück — und er ist bewusst das
Stück, das ohne geprüfte Dokumentation nicht entsteht.
