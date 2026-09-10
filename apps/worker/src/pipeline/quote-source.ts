import {
  missing,
  observed,
  providerId,
  systemClock,
  type Bps,
  type Clock,
  type Maybe,
  type MissingReason,
} from "@sae/core";
import type { ProviderEnv } from "@sae/config";
import type { ExecutionPlan, QuoteSource } from "@sae/trading";
import { decimalFractionToBps, JupiterQuoteAdapter, type FailureClass } from "@sae/providers";

/**
 * Eine Kursquelle, die ehrlich nichts weiss.
 *
 * Der simulierte Ausfuehrer braucht eine Quelle, um ueberhaupt gebaut werden
 * zu koennen. Solange kein Router-Vertrag belegt ist, gibt es keinen Kurs —
 * und dann wird auch keiner geschaetzt.
 *
 * Das ist wichtiger, als es aussieht: ein Ausfuehrer mit einem erfundenen Kurs
 * wuerde Paper-Positionen mit erfundenen Einstiegen erzeugen, und die
 * spaetere Statistik haette keine Chance, das noch zu bemerken.
 */
export class UnavailableQuoteSource implements QuoteSource {
  async quote(plan: ExecutionPlan): Promise<Maybe<{ outAmount: bigint; priceImpactBps: Bps }>> {
    void plan;
    return missing("NOT_YET_COLLECTED", new Date(0), null);
  }
}

/** Der Anbieter dieses Pfads: der ROUTER, nicht die Marktdatenquelle. */
const ROUTER_PROVIDER = providerId("jupiter");

/**
 * Der Kurs, zu dem tatsaechlich getauscht wuerde.
 *
 * Das Gegenstueck zu `UnavailableQuoteSource` — und der Grund, warum die
 * ueberhaupt existierte: sie war die ehrliche Antwort, solange kein
 * Router-Vertrag belegt war. Seit dem 2026-09-10 ist er belegt
 * (DECISIONS §104), also gibt es hier einen echten Kurs statt einer Auskunft
 * ueber seine Abwesenheit.
 *
 * ### Warum ein Router-Quote und kein Snapshot-Preis
 *
 * Der Snapshot sagt, was ein Token WERT ist. Der Quote sagt, was man
 * tatsaechlich BEKOMMT — einschliesslich Route, Preiseinfluss und der Menge,
 * um die es geht. Fuer eine simulierte Ausfuehrung ist nur das Zweite richtig:
 * eine Papier-Position, die zum Mittelpreis eines Pools eroeffnet, hat einen
 * Einstieg, den es nie gegeben haette — und die spaetere Statistik haette
 * keine Chance, das noch zu bemerken.
 *
 * ### Was sie ausdruecklich NICHT tut
 *
 * Sie fuehrt nichts aus. Sie signiert nichts, sendet nichts und beruehrt
 * keinen Schluessel. Ein Quote ist eine Frage, keine Transaktion — der
 * Live-Handel bleibt vollstaendig abgeschaltet.
 */
export class JupiterQuoteSource implements QuoteSource {
  readonly #adapter: JupiterQuoteAdapter;
  readonly #clock: Clock;

  constructor(deps: { readonly adapter: JupiterQuoteAdapter; readonly clock: Clock }) {
    this.#adapter = deps.adapter;
    this.#clock = deps.clock;
  }

  async quote(plan: ExecutionPlan): Promise<Maybe<{ outAmount: bigint; priceImpactBps: Bps }>> {
    const now = this.#clock.now();

    const outcome = await this.#adapter.fetchQuote({
      inputMint: plan.inputMint,
      outputMint: plan.outputMint,
      amountRaw: plan.inAmount,
      // Die Toleranz des PLANS, nicht eine Konstante. Sie gehoert zur Frage:
      // ein Quote mit fremder Slippage beantwortet eine andere.
      slippageBps: plan.maxSlippageBps,
    });

    if (outcome.kind === "FAILED") {
      return missing(reasonOf(outcome.failure), now, ROUTER_PROVIDER);
    }
    if (outcome.kind === "SCHEMA_REJECTED") {
      // Der Anbieter hat geantwortet, wir konnten es nicht lesen. Das ist ein
      // anderer Befund als „kein Kurs" und gehoert getrennt gefuehrt.
      return missing("PARSE_FAILED", now, ROUTER_PROVIDER);
    }

    const outAmount = toBigInt(outcome.quote.outAmount);
    if (outAmount === null) return missing("PARSE_FAILED", now, ROUTER_PROVIDER);

    return observed(
      { outAmount, priceImpactBps: decimalFractionToBps(outcome.quote.priceImpactPct) },
      ROUTER_PROVIDER,
      now,
      // Der Anbieter nennt mit `contextSlot` zwar einen Messzeitpunkt, aber
      // als Slot-Nummer. Ihn hier aufzuloesen kostete eine zusaetzliche
      // RPC-Anfrage je Kurs fuer ein Feld, das auf diesem Pfad niemand liest.
      // `null` heisst: nicht erhoben — nicht „gleich jetzt".
      { sourceTs: null },
    );
  }
}

/**
 * Fehlschlag zu Grund.
 *
 * `BAD_REQUEST` ist der unsichere Fall und deshalb hier ausgeschrieben: ein
 * 4xx auf eine wohlgeformte Anfrage heisst bei einem Router am ehesten „fuer
 * dieses Paar in dieser Groesse gibt es keinen Weg". Sicher ist das nicht —
 * gemessen wurde bisher nur der Erfolgsfall. Fuer die Folge macht es keinen
 * Unterschied (es wird nicht ausgefuehrt), fuer die spaetere Auswertung schon,
 * und sobald ein solcher Fall im Log auftaucht, laesst er sich nachpruefen.
 */
function reasonOf(failure: FailureClass): MissingReason {
  switch (failure) {
    case "RATE_LIMITED":
      return "PROVIDER_RATE_LIMITED";
    case "BAD_REQUEST":
      return "NO_DATA_FOR_TOKEN";
    case "BLOCKED":
    case "UNAVAILABLE":
    case "UNKNOWN":
      return "PROVIDER_DOWN";
  }
}

/**
 * Die Kursquelle, die zur Konfiguration passt.
 *
 * Ohne `JUPITER_BASE_URL` bleibt es bei der Quelle, die nichts weiss — und
 * das ist die richtige Antwort, nicht ein Notbehelf. Ein geschaetzter
 * Einstiegskurs erzeugte Papier-Positionen mit erfundenen Einstiegen.
 */
export function buildQuoteSource(env: ProviderEnv, clock: Clock = systemClock): QuoteSource {
  const baseUrl = env.JUPITER_BASE_URL;
  if (baseUrl === undefined) return new UnavailableQuoteSource();
  return new JupiterQuoteSource({ adapter: new JupiterQuoteAdapter({ clock, baseUrl }), clock });
}

/** `null` statt einer Ausnahme oder einer stillen 0. */
function toBigInt(raw: string): bigint | null {
  if (!/^\d+$/.test(raw)) return null;
  try {
    const value = BigInt(raw);
    return value > 0n ? value : null;
  } catch {
    return null;
  }
}
