import { providerId, systemClock, type Clock } from "@sae/core";
import {
  loadEnv,
  providerEnvSchema,
  readProviderConfig,
  type KnownProviderId,
  type ProviderEnv,
} from "@sae/config";
import { summarizeFleet, type ProviderStatus, type ProviderStatusReport } from "@sae/providers";
import {
  DexScreenerMarketAdapter,
  JupiterQuoteAdapter,
  JUPITER_QUOTE_CONTRACT,
  SOLANA_BLOCK_TIME_CONTRACT,
  SolanaBlockTimeAdapter,
  SolanaMintAdapter,
} from "@sae/providers";
import { describeShape, pairs, type Logger } from "@sae/observability";
import { createDatabase, ProviderHealthStore, ProviderReadinessStore } from "@sae/db";

import type { RoleContext, RoleHandler } from "../role";

/**
 * Die Adresse, mit der die Erreichbarkeit geprueft wird.
 *
 * Wrapped SOL: existiert seit 2020, wird auf jedem Solana-DEX gehandelt und
 * ist damit die Adresse, bei der ein leeres Ergebnis tatsaechlich etwas ueber
 * den ANBIETER aussagt und nicht ueber den Token. Ein Memecoin waere als Sonde
 * untauglich — verschwindet er, sieht ein gesunder Anbieter krank aus.
 *
 * Diese Anfrage ist eine Lebendpruefung, keine Marktdatenerhebung: ihr
 * Ergebnis wird nicht als Snapshot gespeichert und traegt keine Entscheidung.
 */
const PROBE_MINT = "So11111111111111111111111111111111111111112";

/**
 * Rolle: provider-health.
 *
 * Der einzige Takt, der auch ohne Marktdaten laeuft — und damit der
 * Mechanismus, mit dem das System von selbst wieder anlaeuft. Er beantwortet
 * genau eine Frage: **gibt es eine erreichbare Quelle?**
 *
 * Zwei Dinge, die dieser Worker ausdruecklich NICHT tut:
 *
 * - Einen Anbieter abfragen, fuer den es kein gegen seine Spezifikation
 *   geprueftes Adapter-Modul gibt. Ein erfundener Pfad wuerde einen Fehlschlag
 *   erzeugen, der wie ein Anbieterproblem aussieht.
 * - Einen Erfolg behaupten, den es nicht gab. Ohne Abfrage bleiben letzter
 *   Erfolg, Latenz und Frische `null` — und ausdruecklich nicht 0.
 *
 * Das Ergebnis wird PERSISTIERT. Worker und Dashboard reden nicht miteinander;
 * ein Status im Speicher des Workers ist fuer die Anzeige nicht da.
 */
/**
 * Das Ergebnis einer echten Abfrage als Zustand.
 *
 * Die Zuordnung ist die eigentliche Aussage dieses Dienstes, deshalb steht sie
 * hier ausgeschrieben und nicht als Kette von Bedingungen im Aufrufer:
 *
 * | Ergebnis            | Zustand      | Begruendung                                  |
 * |---------------------|--------------|----------------------------------------------|
 * | OK                  | CONNECTED    | geantwortet und lesbar                       |
 * | NO_DATA             | CONNECTED    | geantwortet; der Anbieter kennt den Token nur nicht |
 * | FAILED/BLOCKED      | BLOCKED      | jemand laesst uns nicht durch                |
 * | FAILED/RATE_LIMITED | DEGRADED     | erreichbar, aber gedrosselt — kommt wieder   |
 * | FAILED/sonst        | UNAVAILABLE  | keine Antwort                                |
 * | SCHEMA_REJECTED     | UNAVAILABLE  | erreichbar und unbrauchbar                   |
 *
 * Der letzte Fall ist der, bei dem man in Versuchung geraet, DEGRADED zu
 * nehmen: der Anbieter lebt ja. Aber DEGRADED laesst die Kette ihn weiter
 * fragen, und jede Antwort waere wieder unlesbar. Unbrauchbar ist naeher an
 * nicht erreichbar als an eingeschraenkt.
 */
export interface ProbeResult {
  readonly status: ProviderStatus;
  readonly detail: string;
  readonly latencyMs: number;
  readonly ok: boolean;
  /** Fuer die Bereitschaftstabelle. `null`, wenn die Anfrage nie ankam. */
  readonly httpStatus: number | null;
}

async function probeDexScreener(env: ProviderEnv): Promise<ProbeResult> {
  const baseUrl = env.DEXSCREENER_BASE_URL;
  const adapter = new DexScreenerMarketAdapter({
    clock: systemClock,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
  });
  const outcome = await adapter.fetchMarkets([PROBE_MINT]);

  switch (outcome.kind) {
    case "OK":
      return {
        status: "CONNECTED",
        detail: `${String(outcome.markets.length)} Datensatz/-saetze, Schema ${adapter.schemaVersion}.`,
        latencyMs: outcome.latencyMs,
        ok: true,
        httpStatus: outcome.httpStatus,
      };
    case "NO_DATA":
      return {
        status: "CONNECTED",
        detail: "Geantwortet, kennt die Sondenadresse aber nicht.",
        latencyMs: outcome.latencyMs,
        ok: true,
        httpStatus: outcome.httpStatus,
      };
    case "SCHEMA_REJECTED":
      return {
        status: "UNAVAILABLE",
        detail: `Antwort nicht lesbar: ${outcome.reason}`,
        latencyMs: outcome.latencyMs,
        ok: false,
        httpStatus: outcome.httpStatus,
      };
    case "FAILED":
      return {
        status:
          outcome.failure === "BLOCKED"
            ? "BLOCKED"
            : outcome.failure === "RATE_LIMITED"
              ? "DEGRADED"
              : "UNAVAILABLE",
        detail: `${outcome.failure}: ${outcome.reason}`,
        latencyMs: outcome.latencyMs,
        ok: false,
        httpStatus: outcome.httpStatus,
      };
  }
}

/**
 * Die Quote-Marktquelle, gemessen auf ihrem ganzen Weg.
 *
 * Nicht nur „antwortet Jupiter?": geprueft wird genau das, was die Quelle im
 * Betrieb leisten muss — ein Quote MIT `contextSlot`, dessen Slot sich in eine
 * Uhrzeit aufloesen laesst. Eine Sonde, die weniger prueft, meldete
 * `CONNECTED` fuer eine Quelle, die anschliessend bei jedem Token an
 * `NO_CONTEXT_SLOT` oder `NO_SLOT_TIME` scheitert — und dann suchte jemand
 * den Fehler in der Kette statt beim Anbieter.
 *
 * Das ist kein Luxus, sondern der Unterschied zwischen verdrahtet und
 * arbeitend: ohne CONNECTED ueberspringt `resolveFromChain` das Mitglied
 * (`SKIPPED_STATUS`), und die ganze Verkabelung waere still wirkungslos.
 */
async function probeQuoteMarket(env: ProviderEnv): Promise<ProbeResult> {
  const baseUrl = env.JUPITER_BASE_URL;
  const rpcUrl = env.SOLANA_RPC_URL;
  if (baseUrl === undefined || rpcUrl === undefined) {
    return {
      status: "NOT_CONFIGURED",
      detail: "JUPITER_BASE_URL oder SOLANA_RPC_URL fehlt.",
      latencyMs: 0,
      ok: false,
      httpStatus: null,
    };
  }

  // Dasselbe Paar wie die Formsonde: WSOL gegen USDC, 0,01 SOL. Die Richtung
  // ist hier bewusst eine andere als im Betrieb (dort wird mit dem Anker
  // gefragt) — fuer die drei Fragen dieser Sonde spielt sie keine Rolle:
  // antwortet der Anbieter, nennt er einen Slot, und laesst der sich in eine
  // Uhrzeit aufloesen. Ein eigenes Paar hier haette nur eine zweite Menge in
  // einer zweiten Einheit bedeutet, die niemand mitpflegt.
  const quotes = new JupiterQuoteAdapter({ clock: systemClock, baseUrl });
  const outcome = await quotes.fetchQuote({
    inputMint: PROBE_INPUT_MINT,
    outputMint: CONTRACT_PROBE_MINT,
    amountRaw: BigInt(PROBE_AMOUNT_LAMPORTS),
    slippageBps: 50,
  });

  if (outcome.kind === "FAILED") {
    return {
      status:
        outcome.failure === "BLOCKED"
          ? "BLOCKED"
          : outcome.failure === "RATE_LIMITED"
            ? "DEGRADED"
            : "UNAVAILABLE",
      detail: `${outcome.failure}: ${outcome.reason}`,
      latencyMs: outcome.latencyMs,
      ok: false,
      httpStatus: outcome.httpStatus,
    };
  }
  if (outcome.kind === "SCHEMA_REJECTED") {
    // Erreichbar und unlesbar ist naeher an nicht erreichbar als an
    // eingeschraenkt — dieselbe Begruendung wie in der Tabelle oben.
    return {
      status: "UNAVAILABLE",
      detail: `Antwort nicht lesbar: ${outcome.reason}`,
      latencyMs: outcome.latencyMs,
      ok: false,
      httpStatus: outcome.httpStatus,
    };
  }

  const slot = outcome.quote.contextSlot;
  if (slot === undefined) {
    // Ein Preis ohne Slot traegt keine Einstiegsentscheidung. Die Quelle lebt,
    // taugt aber nicht fuer ihren Zweck — DEGRADED sagt genau das.
    return {
      status: "DEGRADED",
      detail: "Quote ohne contextSlot: kein Messzeitpunkt, also kein Datenalter.",
      latencyMs: outcome.latencyMs,
      ok: false,
      httpStatus: outcome.httpStatus,
    };
  }

  const blockTime = new SolanaBlockTimeAdapter({ clock: systemClock, rpcUrl });
  const at = await blockTime.fetchBlockTime(slot);
  if (at.kind !== "OK" || at.at === null) {
    return {
      status: "DEGRADED",
      detail: `Slot ${String(slot)} ohne abrufbare Uhrzeit (${at.kind}).`,
      latencyMs: outcome.latencyMs + (at.kind === "OK" ? at.latencyMs : 0),
      ok: false,
      httpStatus: outcome.httpStatus,
    };
  }

  const alterSekunden = Math.round((systemClock.now().getTime() - at.at.getTime()) / 1_000);
  return {
    status: "CONNECTED",
    detail: `Quote mit Slot ${String(slot)}, Alter ${String(alterSekunden)}s.`,
    latencyMs: outcome.latencyMs + at.latencyMs,
    ok: true,
    httpStatus: outcome.httpStatus,
  };
}

/** Anbieter, die tatsaechlich gemessen werden koennen. */
const PROBES: Partial<Record<KnownProviderId, (env: ProviderEnv) => Promise<ProbeResult>>> = {
  dexscreener: probeDexScreener,
  "jupiter-quote": probeQuoteMarket,
};

export function buildStatusReports(env: NodeJS.ProcessEnv): readonly ProviderStatusReport[] {
  const providerEnv = loadEnv(providerEnvSchema, env);
  const entries = readProviderConfig(providerEnv);

  return entries.map((entry): ProviderStatusReport => {
    const status = !entry.configured
      ? "NOT_CONFIGURED"
      : entry.adapterImplemented
        ? "UNAVAILABLE"
        : "NOT_CONFIGURED";

    const detail = !entry.configured
      ? entry.requiresApiKey && !entry.apiKeyPresent
        ? "Basis-URL oder Zugangsschluessel fehlt."
        : "Keine Basis-URL hinterlegt."
      : entry.adapterImplemented
        ? "Konfiguriert, aber noch nicht abgefragt."
        : "Konfiguriert, aber kein geprueftes Adapter-Modul vorhanden.";

    return {
      providerId: providerId(entry.id),
      kind: entry.kind,
      status,
      capabilities: entry.capabilities as ProviderStatusReport["capabilities"],
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureReason: null,
      latencyMsP50: null,
      latencyMsP95: null,
      rateLimit: null,
      dataFreshnessSeconds: null,
      detail,
    };
  });
}

/** Ein Messdurchlauf: Zustand ermitteln und festschreiben. */
export async function sampleProviderHealth(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly store: ProviderHealthStore;
  /**
   * Die Bereitschaftstabelle — optional, weil Tests sie nicht brauchen.
   *
   * Ohne sie sagt das System zwei verschiedene Dinge ueber sich selbst. Genau
   * das war der Fall: `/api/diagnostics/providers` meldete
   * `dexscreener: CONNECTED` UND `headline: "NO PROVIDER CONFIGURED"` in
   * derselben Antwort. Die Messreihe lag in `provider_status_samples`, die
   * Ueberschrift kam aus `provider_capability_status` — und in die schrieben
   * bis hierher nur die Smoke-Test-Skripte, die niemand ausfuehrt.
   *
   * Eine Messung, die zwei Tabellen kennt und nur eine fuellt, laesst die
   * andere veralten. Beim naechsten Blick aufs Dashboard sucht dann jemand
   * einen Konfigurationsfehler, den es nicht gibt.
   */
  readonly readiness?: ProviderReadinessStore;
  readonly at?: Date;
}): Promise<{
  readonly written: number;
  readonly marketDataConnected: boolean;
  readonly summary: string;
  /**
   * Jeder Anbieter mit seinem Zustand.
   *
   * Die Zusammenfassung sagt „2 von 3 Marktdatenquellen verbunden" und laesst
   * offen, welche die dritte ist — also genau die Frage offen, fuer die man
   * die Zeile liest. Hier steht sie beantwortet.
   */
  readonly states: Readonly<Record<string, string>>;
}> {
  const at = input.at ?? systemClock.now();
  const providerEnv = loadEnv(providerEnvSchema, input.env);

  // Der Konfigurationsbefund ist der Ausgangspunkt: er sagt, wer ueberhaupt
  // ansprechbar waere. Gemessen wird danach nur, wer einen geprueften Adapter
  // hat — eine Abfrage ueber einen geratenen Pfad wuerde einen Fehlschlag
  // erzeugen, der wie ein Anbieterproblem aussieht.
  const base = buildStatusReports(input.env);

  // HTTP-Status je Anbieter, damit die Bereitschaftstabelle unten denselben
  // Lauf verbucht und nicht ein zweites Mal anfragt.
  const probeStatus = new Map<KnownProviderId, number>();

  const reports = await Promise.all(
    base.map(async (report): Promise<ProviderStatusReport> => {
      const id = String(report.providerId) as KnownProviderId;
      const probe = PROBES[id];
      // NOT_CONFIGURED bleibt NOT_CONFIGURED: wer keine Basis-URL hat, wird
      // nicht gefragt, und das Ergebnis waere ohnehin nur eine Aussage ueber
      // die fehlende Konfiguration.
      if (probe === undefined || report.status === "NOT_CONFIGURED") return report;

      const result = await probe(providerEnv);
      if (result.httpStatus !== null) probeStatus.set(id, result.httpStatus);
      return {
        ...report,
        status: result.status,
        detail: result.detail,
        // Latenz und Zeitpunkte stammen jetzt aus einer echten Anfrage. Vorher
        // waren sie null, weil nichts abgefragt wurde — und null war die
        // richtige Antwort darauf.
        latencyMsP50: result.latencyMs,
        latencyMsP95: result.latencyMs,
        lastSuccessAt: result.ok ? at : null,
        lastFailureAt: result.ok ? null : at,
        lastFailureReason: result.ok ? null : result.detail,
      };
    }),
  );

  const fleet = summarizeFleet(reports);
  const written = await input.store.record(reports, at);

  // Dieselbe Messung auch in die Bereitschaftstabelle. Ein echter Abruf gegen
  // einen geprueften Vertrag IST der Nachweis, den `productionVerified`
  // behauptet — es gibt keinen Grund, dafuer auf ein Skript zu warten, das von
  // Hand gestartet werden muss.
  if (input.readiness !== undefined) {
    for (const report of reports) {
      const id = String(report.providerId) as KnownProviderId;
      const probe = PROBES[id];
      if (probe === undefined || report.status === "NOT_CONFIGURED") continue;
      const httpStatus = probeStatus.get(id);
      if (httpStatus === undefined) continue;

      await input.readiness.declare({
        providerId: id,
        capability: "TOKEN_MARKET",
        implementationConfidence: "SCHEMA_VERIFIED",
      });
      await input.readiness.recordSmokeTest({
        providerId: id,
        capability: "TOKEN_MARKET",
        at,
        httpStatus,
        detail: report.detail ?? "",
        // Der Vertrag stammt aus einer echten Antwort. Ohne ihn waere hier
        // `false` richtig und der Anbieter bliebe unterhalb CAPABILITY_READY.
        schemaVerified: true,
      });
    }
  }

  return {
    written,
    marketDataConnected: fleet.anyMarketDataConnected,
    summary: fleet.summary,
    states: Object.fromEntries(reports.map((r) => [String(r.providerId), r.status])),
  };
}

/**
 * Wie oft gemessen wird.
 *
 * Eine Minute ist ein Kompromiss: haeufig genug, dass eine wiederkehrende
 * Quelle nicht lange unbemerkt bleibt, selten genug, dass der Verlauf nicht
 * ins Unermessliche waechst. Der Wert ist eine Festlegung, keine Messung — mit
 * echten Anbietern gehoert er ueberprueft.
 */
const SAMPLE_INTERVAL_MS = 60_000;

let sampleTimer: ReturnType<typeof setInterval> | null = null;

export const providerHealthRole: RoleHandler = {
  name: "provider-health",
  async start(ctx: RoleContext): Promise<void> {
    const url = process.env["DATABASE_URL"];
    if (url === undefined || url.length === 0) {
      // Eine Messung, die nur im Log steht, beantwortet die Frage des
      // Dashboards nicht. Ohne Datenbank hat dieser Takt keinen Zweck.
      throw new Error("provider-health benoetigt DATABASE_URL");
    }
    const db = createDatabase(url);
    const store = new ProviderHealthStore(db);
    const readiness = new ProviderReadinessStore(db);

    const runOnce = async (): Promise<void> => {
      const result = await sampleProviderHealth({ env: process.env, store, readiness });
      ctx.logger.info(
        {
          role: "provider-health",
          written: result.written,
          marketDataConnected: result.marketDataConnected,
          summary: result.summary,
          // Als EIN Wert und nicht als Objekt: die Allowlist prueft jeden
          // Schluessel, und die Schluessel sind hier Anbieternamen — also
          // Daten. Dieselbe Begruendung wie bei `tally` (DECISIONS §100).
          providers: pairs(result.states),
        },
        "Provider-Status gemessen",
      );

      // Solange der Mint-Leser keinen geprueften Vertrag hat, misst dieser
      // Takt nebenbei die Antwortform. Sobald der Vertrag steht, hoert das von
      // selbst auf — die Funktion prueft es selbst.
      await probeMintContract({ env: process.env, logger: ctx.logger });
      await probeFreshnessContracts({ env: process.env, logger: ctx.logger });
    };

    // Sofort einmal messen, damit der Scheduler nicht bis zum ersten Takt
    // wartet, um zu erfahren, ob es Daten gibt.
    await runOnce();
    sampleTimer = setInterval(() => {
      void runOnce().catch((error: unknown) => {
        ctx.logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          "Provider-Messung fehlgeschlagen",
        );
      });
    }, SAMPLE_INTERVAL_MS);
  },
  async stop(): Promise<void> {
    if (sampleTimer !== null) clearInterval(sampleTimer);
    sampleTimer = null;
  },
};

/**
 * Belegt den Vertrag des Mint-Lesers — ohne dass jemand etwas abtippt.
 *
 * Das Problem, das diese Funktion loest, ist ein Umgebungsproblem: aus der
 * Entwicklungsumgebung ist kein Solana-RPC erreichbar (drei Endpunkte
 * getestet, alle gesperrt), aus dem laufenden Worker sehr wohl. Ein Schema
 * gegen eine vermutete Antwortform zu schreiben ist ausgeschlossen; jemanden
 * einen curl-Befehl ausfuehren zu lassen ist eine Zumutung, die man sich
 * sparen kann, wenn ein Dienst laeuft, der es ohnehin koennte.
 *
 * Also fragt der Worker selbst und schreibt die **Form** der Antwort ins Log:
 * Schluesselpfade und Typen, keine Werte. Daraus laesst sich das Schema
 * schreiben.
 *
 * Zwei Selbstbegrenzungen, damit daraus kein Dauerzustand wird:
 *
 * 1. Sie laeuft nur, solange der Vertrag **ungeprueft** ist. Sobald aus
 *    `unverifiedContract()` ein `zodContract({verified: true})` wird, hoert
 *    das Loggen von selbst auf — niemand muss daran denken.
 * 2. Ohne `SOLANA_RPC_URL` passiert nichts.
 *
 * Die Sondenadresse ist der USDC-Mint: oeffentlich, unveraenderlich, und mit
 * abgegebener Freeze-Authority ein Fall, bei dem `null` und „fehlt" sich
 * unterscheiden muessen.
 */
export async function probeMintContract(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly logger: Logger;
  readonly clock?: Clock;
}): Promise<void> {
  const rpcUrl = input.env["SOLANA_RPC_URL"];
  if (rpcUrl === undefined || rpcUrl.trim() === "") return;

  const clock = input.clock ?? systemClock;
  const adapter = new SolanaMintAdapter({ clock, rpcUrl });
  if (adapter.contractVerified) return;

  const outcome = await adapter.fetchMint(CONTRACT_PROBE_MINT);

  if (outcome.kind === "SCHEMA_REJECTED" && outcome.shape !== "") {
    input.logger.info(
      { provider: "solana-rpc", mintShape: outcome.shape },
      "Antwortform des Mint-Lesers gemessen — Grundlage fuer den geprueften Vertrag",
    );
    return;
  }

  // Kein Erfolgsfall moeglich, solange der Vertrag ungeprueft ist: jede
  // gueltige Antwort landet ebenfalls in SCHEMA_REJECTED. Alles andere ist ein
  // echter Ausfall und wird als solcher gemeldet.
  input.logger.warn(
    { provider: "solana-rpc", kind: outcome.kind },
    "Antwortform des Mint-Lesers nicht messbar",
  );
}

/**
 * Die Sondenadresse: USDC.
 *
 * Oeffentlich, unveraenderlich, auf jedem Endpunkt vorhanden — als
 * Erreichbarkeitssonde also richtig gewaehlt.
 *
 * BERICHTIGUNG zur urspruenglichen Begruendung: hier stand, USDC habe seine
 * Freeze-Authority abgegeben, und die Sonde pruefe damit den `null`-Fall. Die
 * Messung vom 2026-09-10 zeigt das Gegenteil — `mintAuthority` UND
 * `freezeAuthority` sind beide gesetzt (Circle behaelt beide). Die Sonde
 * beruehrt den `null`-Fall also gar nicht.
 *
 * Fuer die Erreichbarkeit ist das ohne Belang, fuer die Vertragspruefung
 * nicht: dass `null` richtig gelesen wird, belegt kein Anbieter, sondern der
 * Test in `authorities.test.ts`.
 */
export const CONTRACT_PROBE_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** Wrapped SOL — die Eingabeseite der Quote-Sonde. */
const PROBE_INPUT_MINT = "So11111111111111111111111111111111111111112";

/** 0,01 SOL. Klein genug, um jede Route zu finden, gross genug fuer einen Preis. */
const PROBE_AMOUNT_LAMPORTS = "10000000";

/**
 * Holt eine Antwort und beschreibt ihre FORM.
 *
 * Bewusst ein roher Aufruf und kein Adapter: eine Sonde ist kein Anbieter. Sie
 * liefert keinen Wert, den irgendwer benutzt, sie faerbt keinen Status und
 * traegt keine Entscheidung — sie beantwortet genau eine Frage, naemlich wie
 * die Antwort aufgebaut ist. Dafuer einen vollstaendigen Adapter zu bauen
 * hiesse, drei Klassen zu pflegen, deren einziger Zweck es ist, wieder zu
 * verschwinden.
 */
async function shapeOf(
  url: string,
  init?: RequestInit,
): Promise<{ readonly shape: string } | { readonly failure: string }> {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const body = await response.text();
    if (!response.ok) return { failure: `HTTP ${String(response.status)}` };
    return { shape: describeShape(JSON.parse(body) as unknown) };
  } catch (error: unknown) {
    return { failure: error instanceof Error ? error.name : "UNKNOWN" };
  }
}

const PROBE_TIMEOUT_MS = 8_000;

/**
 * Misst die Antwortform der beiden Vertraege, die zum Datenalter fuehren.
 *
 * `getBlockTime` macht aus dem `contextSlot` eines Quotes eine echte Uhrzeit —
 * abgelesen, nicht geschaetzt. Erst damit hat ein Preis ein bekanntes Alter,
 * und erst dann laesst der Torwaechter eine Einstiegsentscheidung zu.
 *
 * **Stand 2026-09-10 sind beide Vertraege belegt, also schweigt diese
 * Funktion vollstaendig.** Sie bleibt trotzdem stehen, und zwar aus zwei
 * Gruenden: sie ist der Weg, auf dem die Belege entstanden sind, und der
 * naechste unbekannte Endpunkt bekommt hier seine Sonde, statt dass jemand
 * dieselbe Mechanik ein zweites Mal baut.
 *
 * Jede Sonde laeuft nur, solange ihr Ziel unbelegt ist, und schweigt ohne
 * Konfiguration. Die Selbstbegrenzung ist nicht Kosmetik: drei Abrufe je
 * Minute, die niemand mehr liest, sind genau die Art Leerlauf, die im
 * September das Datenkontingent aufgebraucht hat (DECISIONS §101).
 */
export async function probeFreshnessContracts(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly logger: Logger;
}): Promise<void> {
  const rpcUrl = input.env["SOLANA_RPC_URL"];
  if (!SOLANA_BLOCK_TIME_CONTRACT.verified && rpcUrl !== undefined && rpcUrl.trim() !== "") {
    // Zwei Anfragen, und die zweite ist die eigentliche: `getSlot` liefert
    // einen Slot, den es sicher gibt, und `getBlockTime` macht daraus die
    // Uhrzeit.
    const slot = await currentSlot(rpcUrl);
    if (slot === null) {
      input.logger.warn({ provider: "solana-rpc:getSlot" }, "Antwortform nicht messbar");
    } else {
      const result = await shapeOf(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBlockTime", params: [slot] }),
      });
      logShape(input.logger, "solana-rpc:getBlockTime", result);
    }
  }

  const jupiterUrl = input.env["JUPITER_BASE_URL"];
  if (!JUPITER_QUOTE_CONTRACT.verified && jupiterUrl !== undefined && jupiterUrl.trim() !== "") {
    // Parameter aus der Spezifikation, siehe docs/providers/jupiter.md.
    const query = new URLSearchParams({
      inputMint: PROBE_INPUT_MINT,
      outputMint: CONTRACT_PROBE_MINT,
      amount: PROBE_AMOUNT_LAMPORTS,
      slippageBps: "50",
    });
    const result = await shapeOf(`${jupiterUrl.replace(/\/$/, "")}/quote?${query.toString()}`);
    logShape(input.logger, "jupiter:quote", result);
  }
}

/**
 * Der zuletzt bestaetigte Slot.
 *
 * `getBlockTime` braucht ein Argument, und ein geratener Slot waere entweder
 * zu alt (der Knoten hat ihn nicht mehr) oder zu neu (es gibt ihn noch nicht).
 * Beide Faelle antworten mit `null` und saehen dann wie ein Vertragsproblem
 * aus, obwohl nur die Frage falsch war.
 */
async function currentSlot(rpcUrl: string): Promise<number | null> {
  try {
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot", params: [] }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const parsed: unknown = JSON.parse(await response.text());
    const result = (parsed as { result?: unknown }).result;
    return typeof result === "number" ? result : null;
  } catch {
    return null;
  }
}

function logShape(
  logger: Logger,
  provider: string,
  result: { readonly shape: string } | { readonly failure: string },
): void {
  if ("shape" in result) {
    logger.info({ provider, mintShape: result.shape }, "Antwortform gemessen");
    return;
  }
  logger.warn({ provider, kind: result.failure }, "Antwortform nicht messbar");
}
