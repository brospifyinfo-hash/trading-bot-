import { z } from "zod";

/**
 * Das Antwortformat von `GET /tokens/v1/{chainId}/{tokenAddresses}`.
 *
 * Abgeleitet aus einer **echten Antwort** der API vom 2026-09-03, nicht aus
 * Erinnerung und nicht aus der Dokumentation (deren Host aus der
 * Entwicklungsumgebung nicht erreichbar ist). Eine echte Antwort ist die
 * bessere Primaerquelle: sie zeigt, was der Anbieter tatsaechlich sendet, nicht
 * was er zu senden meint.
 *
 * Drei Eigenschaften der Antwort, die man ohne sie geraten haette — und alle
 * drei haette man falsch geraten:
 *
 * 1. **Die Wurzel ist ein nacktes Array.** Kein Objekt mit `pairs` darin.
 * 2. **`priceUsd` und `priceNative` sind Zeichenketten**, keine Zahlen. Ein
 *    Schema mit `z.number()` haette jede Antwort abgelehnt.
 * 3. **`liquidity` ist ein Objekt** `{usd, base, quote}`, keine Zahl.
 *
 * ### Was in der Stichprobe FEHLTE
 *
 * `fdv` und `marketCap` waren in der geprueften Antwort **nicht enthalten** —
 * obwohl beide in der Feldliste der Spezifikation V1 stehen. Sie sind hier
 * deshalb optional, und das ist keine Vorsichtsmassnahme, sondern eine
 * Beobachtung. Ebenso fehlt **jeder Zeitstempel zur Preisangabe**;
 * `pairCreatedAt` gehoert zum Handelspaar, nicht zum Preis.
 *
 * Die Stichprobe ist eine einzige Antwort zu einem einzigen Token. Was hier
 * `optional()` ist, ist es aus Vorsicht; was hier verlangt wird, war
 * tatsaechlich da. Ein zu strenges Schema lehnt Antworten ab und faellt sofort
 * auf; ein zu grosszuegiges laesst Unsinn durch und faellt nie auf. Deshalb
 * diese Richtung.
 */

/**
 * DexScreener liefert Preise als Zeichenkette.
 *
 * `Number("")` ist 0 und `Number("abc")` ist NaN — beides wuerde ohne diese
 * Pruefung als Preis durchgehen. Eine 0 als Preis waere der teuerste stille
 * Fehler in diesem System: sie sieht aus wie eine Messung.
 */
const numericText = z.string().transform((raw, ctx): number => {
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Zahl erwartet, erhalten: ${JSON.stringify(raw)}`,
    });
    return z.NEVER;
  }
  return value;
});

const tokenRefSchema = z
  .object({
    address: z.string().min(1),
    name: z.string().optional(),
    symbol: z.string().optional(),
  })
  .passthrough();

const txnWindowSchema = z
  .object({
    buys: z.number().finite().nonnegative(),
    sells: z.number().finite().nonnegative(),
  })
  .passthrough();

/**
 * Die vier Zeitfenster, in denen DexScreener aggregiert.
 *
 * Jedes einzeln optional: ein Pool, der seit Stunden nicht gehandelt wurde,
 * liefert plausibel kein `m5`. Ein fehlendes Fenster ist dann UNBEKANNT und
 * nicht null — die Unterscheidung wird in der Normalisierung durchgehalten.
 */
const windowsOf = <T extends z.ZodTypeAny>(inner: T) =>
  z
    .object({
      m5: inner.optional(),
      h1: inner.optional(),
      h6: inner.optional(),
      h24: inner.optional(),
    })
    .passthrough();

/**
 * Ein Handelspaar.
 *
 * `passthrough()` und nicht `strict()`: DexScreener liefert `url`, `info`,
 * `labels`, `boosts` und faengt jederzeit mit weiteren Feldern an. Ein
 * strenges Schema wuerde bei der naechsten Erweiterung des Anbieters die
 * gesamte Datenaufnahme anhalten — ein Ausfall aus reiner Formstrenge.
 */
export const dexScreenerPairSchema = z
  .object({
    chainId: z.string().min(1),
    dexId: z.string().min(1),
    pairAddress: z.string().min(1),
    baseToken: tokenRefSchema,
    quoteToken: tokenRefSchema,

    priceUsd: numericText.optional(),
    priceNative: numericText.optional(),

    txns: windowsOf(txnWindowSchema).optional(),
    volume: windowsOf(z.number().finite().nonnegative()).optional(),
    // Preisaenderungen duerfen negativ sein — hier waere `nonnegative()` ein Fehler.
    priceChange: windowsOf(z.number().finite()).optional(),

    liquidity: z
      .object({
        usd: z.number().finite().nonnegative().optional(),
        base: z.number().finite().nonnegative().optional(),
        quote: z.number().finite().nonnegative().optional(),
      })
      .passthrough()
      .optional(),

    // In der geprueften Antwort NICHT enthalten. Siehe Kopfkommentar.
    fdv: z.number().finite().nonnegative().optional(),
    marketCap: z.number().finite().nonnegative().optional(),

    /** Epoch-Millisekunden. In der Stichprobe 1669602450000 = 2022-11-28. */
    pairCreatedAt: z.number().int().positive().optional(),
  })
  .passthrough();

/** Die Wurzel: ein nacktes Array. */
export const dexScreenerResponseSchema = z.array(dexScreenerPairSchema);

export type DexScreenerPairRaw = z.infer<typeof dexScreenerPairSchema>;
