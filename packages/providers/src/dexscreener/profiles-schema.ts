import { z } from "zod";

/**
 * Das Antwortformat von `GET /token-profiles/latest/v1`.
 *
 * Abgeleitet aus einer echten Antwort vom 2026-09-06. Der einzige Strom bei
 * DexScreener, der von sich aus etwas Neues meldet — und damit die Grundlage
 * der Discovery.
 *
 * ### Was er liefert: Adressen. Sonst nichts.
 *
 * Kein Preis, keine Liquiditaet, kein Volumen, kein Entstehungszeitpunkt. Nur
 * Kette, Adresse, ein Bild und Marketingtext. Das ist wichtig genug, um es hier
 * festzuhalten: **aus dieser Antwort allein laesst sich kein Token bewerten.**
 * Wer es versucht, hat einen Bot, der Werbetexte handelt.
 *
 * Die Bewertung kommt aus einem zweiten Aufruf gegen den bereits geprueften
 * `/tokens/v1/{chainId}/{addresses}` — der nimmt mehrere Adressen auf einmal,
 * die Anreicherung kostet also einen Aufruf je Buendel und nicht je Token.
 *
 * ### Mehrere Ketten in einer Antwort
 *
 * Die Stichprobe enthielt `solana`, `bsc`, `base`, `robinhood` und `hyperevm`
 * gemischt. Ohne Filter auf `chainId` landen Adressen fremder Ketten im
 * System — und eine EVM-Adresse besteht die Base58-Pruefung nicht, faellt
 * also spaeter als „ungueltig" auf, obwohl sie nur von der falschen Kette
 * kommt. Der Filter gehoert deshalb hierher, nicht in die Fehlerbehandlung.
 */

/**
 * Ein Eintrag im Profil-Strom.
 *
 * `passthrough()` wie ueberall: DexScreener ergaenzt Felder, und ein strenges
 * Schema wuerde die Discovery bei der naechsten Erweiterung anhalten.
 *
 * Fast alles ist optional, weil die Stichprobe es so zeigte: Eintraege ohne
 * `description`, ohne `links`, ohne `header`. Verlangt werden nur die beiden
 * Felder, ohne die der Eintrag wertlos waere.
 */
export const dexScreenerProfileSchema = z
  .object({
    chainId: z.string().min(1),
    tokenAddress: z.string().min(1),
    url: z.string().optional(),
    icon: z.string().optional(),
    header: z.string().optional(),
    description: z.string().optional(),
    links: z
      .array(z.object({ type: z.string().optional(), label: z.string().optional(), url: z.string() }).passthrough())
      .optional(),
    /** „Community Takeover". In der Stichprobe durchgehend `false`. */
    cto: z.boolean().optional(),
  })
  .passthrough();

/** Die Wurzel: ein nacktes Array, wie bei `/tokens/v1/`. */
export const dexScreenerProfilesResponseSchema = z.array(dexScreenerProfileSchema);

export type DexScreenerProfileRaw = z.infer<typeof dexScreenerProfileSchema>;

/** Die Kette, um die es geht. Alles andere wird verworfen. */
export const SOLANA_CHAIN_ID = "solana";
