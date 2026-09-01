import { emailHtml, emailSubject, emailText, type OpportunityEmail } from "./email-template";

/**
 * Resend-Adapter.
 *
 * Vier Festlegungen, die alle denselben Grund haben — eine Mail ueber Geld darf
 * nicht versehentlich rausgehen:
 *
 * 1. **Kein Schluessel im Code.** Er kommt aus `RESEND_API_KEY` und wird
 *    nirgends geloggt. Fehlt er, ist der Adapter `NOT_CONFIGURED` und sendet
 *    nichts — statt mit einem leeren Header zu scheitern.
 * 2. **Keine Produktionsmail ohne echte Gelegenheit.** Eine Mail mit Herkunft
 *    TEST_FIXTURE geht nur, wenn der Aufrufer den Testmodus ausdruecklich
 *    einschaltet, und traegt dann sichtbar [TEST] im Betreff.
 * 3. **Ein Versand je Gelegenheit.** Der Idempotenzschluessel geht an Resend
 *    mit; ein zweiter Aufruf erzeugt keine zweite Mail.
 * 4. **Zeitdeckel.** Ein haengender Aufruf blockiert sonst den Worker.
 */

export const RESEND_ENDPOINT = "https://api.resend.com/emails";

export type SendResult =
  | { readonly kind: "SENT"; readonly messageId: string }
  /** Kein Schluessel oder keine Adressen hinterlegt. Kein Fehler, ein Zustand. */
  | { readonly kind: "NOT_CONFIGURED"; readonly reason: string }
  /** Der Adapter hat den Versand verweigert, bevor er stattfand. */
  | { readonly kind: "REFUSED"; readonly reason: string }
  | { readonly kind: "FAILED"; readonly status: number | null; readonly reason: string };

export interface ResendConfig {
  readonly apiKey: string | undefined;
  readonly from: string | undefined;
  readonly to: string | undefined;
  /** Erlaubt den Versand von Mails, die nicht aus echten Marktdaten stammen. */
  readonly allowTestEmails: boolean;
  readonly timeoutMs?: number;
}

/** Injizierbar, damit Tests keinen Netzzugang brauchen. */
export type FetchLike = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: string;
    readonly signal?: AbortSignal;
  },
) => Promise<{ readonly ok: boolean; readonly status: number; text(): Promise<string> }>;

const DEFAULT_TIMEOUT_MS = 10_000;

export class ResendAdapter {
  constructor(
    private readonly config: ResendConfig,
    private readonly fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  ) {}

  /** Ob ueberhaupt versendet werden kann. Fuer die Anzeige im Dashboard. */
  get configured(): boolean {
    return (
      this.config.apiKey !== undefined &&
      this.config.apiKey.length > 0 &&
      this.config.from !== undefined &&
      this.config.to !== undefined
    );
  }

  async send(mail: OpportunityEmail): Promise<SendResult> {
    const { apiKey, from, to } = this.config;

    if (apiKey === undefined || apiKey.length === 0) {
      return { kind: "NOT_CONFIGURED", reason: "RESEND_API_KEY fehlt." };
    }
    if (from === undefined || to === undefined) {
      return { kind: "NOT_CONFIGURED", reason: "ALERT_FROM_EMAIL oder ALERT_TO_EMAIL fehlt." };
    }

    // Die wichtigste Zeile dieser Datei: eine Mail ueber eine Gelegenheit, die
    // es nicht wirklich gibt, geht nur auf ausdrueckliche Anforderung raus.
    if (mail.sourceType !== "LIVE" && !this.config.allowTestEmails) {
      return {
        kind: "REFUSED",
        reason: `Herkunft ${mail.sourceType}: keine Produktionsmail ohne echte Gelegenheit.`,
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    try {
      const response = await this.fetchImpl(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          // Der Schluessel steht ausschliesslich hier, in diesem Header. Er
          // wandert in keine Log-Zeile und in keine Fehlermeldung.
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          // Ein zweiter Aufruf zu derselben Gelegenheit erzeugt keine zweite
          // Mail — Resend entscheidet das, nicht unsere Sorgfalt.
          "idempotency-key": `opportunity:${mail.opportunityId}`,
        },
        body: JSON.stringify({
          from,
          to: [to],
          subject: emailSubject(mail),
          html: emailHtml(mail),
          text: emailText(mail),
        }),
        signal: controller.signal,
      });

      const body = await response.text();
      if (!response.ok) {
        return {
          kind: "FAILED",
          status: response.status,
          // Der Antworttext kann alles Moegliche enthalten; gekuerzt, damit er
          // ein Log nicht flutet.
          reason: body.slice(0, 300),
        };
      }

      const parsed = JSON.parse(body) as { id?: unknown };
      const id = typeof parsed.id === "string" ? parsed.id : null;
      if (id === null) {
        return { kind: "FAILED", status: response.status, reason: "Antwort ohne Nachrichten-ID." };
      }
      return { kind: "SENT", messageId: id };
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      return { kind: "FAILED", status: null, reason };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Baut den Adapter aus der Umgebung. Liest nur, gibt nichts weiter. */
export function resendFromEnv(
  env: NodeJS.ProcessEnv,
  options: { readonly allowTestEmails?: boolean } = {},
): ResendAdapter {
  return new ResendAdapter({
    apiKey: env["RESEND_API_KEY"],
    from: env["ALERT_FROM_EMAIL"],
    to: env["ALERT_TO_EMAIL"],
    allowTestEmails: options.allowTestEmails ?? env["ALERT_ALLOW_TEST_EMAILS"] === "true",
  });
}
