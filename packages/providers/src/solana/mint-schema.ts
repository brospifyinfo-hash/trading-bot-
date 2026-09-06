import { z } from "zod";

/**
 * Die Antwortform von `getAccountInfo` fuer einen SPL-Mint-Account.
 *
 * ### Warum dieses Schema NOCH NICHT geprueft ist
 *
 * Es ist aus der offiziellen JSON-RPC-Dokumentation abgeleitet, **nicht** aus
 * einer echten Antwort — aus dieser Arbeitsumgebung ist kein Solana-RPC
 * erreichbar (drei Endpunkte getestet, alle gesperrt). Der Vertrag traegt
 * deshalb `unverifiedContract()`: der Adapter laeuft vollstaendig, misst
 * Latenz, klassifiziert Fehler und schreibt Provider-Health — er liefert nur
 * niemals einen Wert, weil die Validierung mit `SCHEMA_UNVERIFIED` ablehnt.
 *
 * Das ist Absicht und kein halber Zustand: ein Adapter, der gegen eine
 * vermutete Antwortform Autoritaeten meldet, waere genau die Sorte Behauptung,
 * die dieses System nirgends machen darf. Sobald eine echte Antwort vorliegt,
 * wird aus `unverifiedContract()` ein `zodContract({verified: true})` — und
 * sonst aendert sich nichts.
 *
 * ### Zwei Fallstricke, die im Schema stehen muessen
 *
 * 1. **Ein JSON-RPC-Fehler kommt mit HTTP 200.** Wer nur auf `response.ok`
 *    prueft, haelt „Account not found" fuer eine erfolgreiche Antwort. Das
 *    Schema kennt deshalb beide Aeste.
 * 2. **`value` ist `null`, wenn es den Account nicht gibt.** Das ist kein
 *    Fehler, sondern die Auskunft „diese Adresse ist kein Mint".
 */

/** Was `jsonParsed` fuer einen Mint-Account in `info` legt. */
const mintInfoSchema = z
  .object({
    decimals: z.number().int().min(0).max(255),
    // u64 als String — JSON-Zahlen wuerden bei grossen Supplies an Genauigkeit
    // verlieren, deshalb liefert das RPC hier bewusst Text.
    supply: z.string(),
    isInitialized: z.boolean(),
    /** `null` heisst: niemand kann nachpraegen. Das ist die gute Nachricht. */
    mintAuthority: z.string().nullable(),
    /** `null` heisst: niemand kann Konten einfrieren. */
    freezeAuthority: z.string().nullable(),
  })
  .passthrough();

const parsedSchema = z
  .object({
    // "mint" grenzt gegen einen Token-Account ab, der dieselbe Huelle hat.
    type: z.string(),
    info: mintInfoSchema,
  })
  .passthrough();

const accountValueSchema = z
  .object({
    data: z
      .object({
        program: z.string(),
        parsed: parsedSchema,
      })
      .passthrough(),
    owner: z.string(),
    executable: z.boolean(),
  })
  .passthrough();

const contextSchema = z.object({ slot: z.number().int().nonnegative() }).passthrough();

/** Der Erfolgsast. `value: null` = die Adresse traegt keinen Account. */
export const solanaAccountInfoResultSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    result: z
      .object({
        context: contextSchema,
        value: accountValueSchema.nullable(),
      })
      .passthrough(),
  })
  .passthrough();

/** Der Fehlerast — kommt mit HTTP 200 und ist deshalb leicht zu uebersehen. */
export const solanaRpcErrorSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    error: z
      .object({
        code: z.number().int(),
        message: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

export const solanaAccountInfoResponseSchema = z.union([
  solanaAccountInfoResultSchema,
  solanaRpcErrorSchema,
]);

/** Programm-Adressen, die einen gueltigen SPL-Mint besitzen duerfen. */
export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SPL_TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export const MINT_ACCOUNT_TYPE = "mint";
