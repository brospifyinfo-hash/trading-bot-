import pino, { type Logger } from "pino";
import { redact } from "./redaction";

export type { Logger };

/**
 * Strukturiertes JSON-Logging.
 *
 * Jeder Datensatz laeuft durch die Allowlist-Redaction. Das kostet etwas
 * Leistung und ist es wert: ein einziger versehentlich geloggter Schluessel ist
 * ein Totalverlust, eine langsamere Logzeile nicht.
 */
export function createLogger(options: {
  readonly service: string;
  readonly level?: string;
  readonly pretty?: boolean;
}): Logger {
  return pino({
    name: options.service,
    level: options.level ?? "info",
    base: { service: options.service },
    formatters: {
      log: (object) => redact(object) as Record<string, unknown>,
    },
    ...(options.pretty ? { transport: { target: "pino-pretty" } } : {}),
  });
}
