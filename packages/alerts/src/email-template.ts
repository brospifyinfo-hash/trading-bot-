import type { SourceType } from "@sae/core";

/**
 * Der Inhalt einer Gelegenheits-Mail.
 *
 * Jedes Feld ist Pflicht und `| null` erlaubt, wo es fehlen darf. Kein
 * optionales Feld mit stillem Standardwert: eine Mail, in der „EV: 0" steht,
 * weil der Wert fehlte, ist schlimmer als eine, in der „EV: nicht berechenbar"
 * steht. Der Nutzer entscheidet auf dieser Grundlage ueber Geld.
 */
export interface OpportunityEmail {
  readonly opportunityId: string;
  readonly tokenSymbol: string;
  readonly mint: string;
  readonly score: number | null;
  /** Konfidenz der Bewertung, 0..1. */
  readonly confidence: number | null;
  /** Erwartungswert als Anteil, z. B. 0.12 = +12 %. `null` = nicht berechenbar. */
  readonly expectedValue: number | null;
  readonly liquidityUsd: number | null;
  readonly riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | null;
  readonly suggestedEntryUsd: number | null;
  readonly stopUsd: number | null;
  readonly takeProfits: readonly { readonly index: 1 | 2 | 3; readonly targetUsd: number | null }[];
  readonly strategyVersion: string;
  readonly expiresAt: Date;
  /** Vollstaendige URL des Bestaetigungs-Flows, inklusive Einmal-Token. */
  readonly confirmUrl: string;
  /** Herkunft. Eine Fixture-Mail wird sichtbar als solche gekennzeichnet. */
  readonly sourceType: SourceType;
}

const NA = "nicht berechenbar";

const usd = (v: number | null): string =>
  v === null ? NA : `$${v < 0.01 ? v.toPrecision(3) : v.toFixed(2)}`;
const pct = (v: number | null): string => (v === null ? NA : `${(v * 100).toFixed(1)} %`);
const num = (v: number | null): string => (v === null ? NA : String(v));

/** Kennzeichnung fuer Mails, die nicht aus echten Marktdaten stammen. */
export const TEST_SUBJECT_PREFIX = "[TEST] ";

export function emailSubject(mail: OpportunityEmail): string {
  const prefix = mail.sourceType === "LIVE" ? "" : TEST_SUBJECT_PREFIX;
  const score = mail.score === null ? "?" : String(mail.score);
  return `${prefix}${mail.tokenSymbol} — Score ${score}`;
}

/** Reintext, damit die Mail auch ohne HTML lesbar ist. */
export function emailText(mail: OpportunityEmail): string {
  const lines: string[] = [];
  if (mail.sourceType !== "LIVE") {
    lines.push(
      "*** TEST — diese Mail stammt aus einem Test-Fixture. Keine echte",
      "*** Gelegenheit, keine Marktdaten, keine Handelsempfehlung.",
      "",
    );
  }
  lines.push(
    `Token: ${mail.tokenSymbol}`,
    `Mint: ${mail.mint}`,
    "",
    `Score: ${num(mail.score)}`,
    `Konfidenz: ${pct(mail.confidence)}`,
    `Erwartungswert: ${pct(mail.expectedValue)}`,
    `Liquiditaet: ${mail.liquidityUsd === null ? NA : `$${mail.liquidityUsd.toLocaleString("de-DE")}`}`,
    `Risiko: ${mail.riskLevel ?? NA}`,
    "",
    `Vorgeschlagener Einstieg: ${usd(mail.suggestedEntryUsd)}`,
    `Stop: ${usd(mail.stopUsd)}`,
  );
  for (const tp of mail.takeProfits) {
    lines.push(`TP${tp.index}: ${usd(tp.targetUsd)}`);
  }
  lines.push(
    "",
    `Strategie-Version: ${mail.strategyVersion}`,
    `Laeuft ab: ${mail.expiresAt.toISOString()}`,
    "",
    "INVEST NOW:",
    mail.confirmUrl,
    "",
    "Der Preis in dieser Mail ist NICHT der Einstiegspreis. Beim Klick werden",
    "Preis, Liquiditaet, Sicherheit und Erwartungswert neu geprueft; bei zu",
    "grosser Abweichung wird der Trade blockiert.",
  );
  return lines.join("\n");
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function emailHtml(mail: OpportunityEmail): string {
  const row = (label: string, value: string): string =>
    `<tr><td style="padding:6px 12px 6px 0;color:#666">${esc(label)}</td>` +
    `<td style="padding:6px 0;font-weight:600">${esc(value)}</td></tr>`;

  const testBanner =
    mail.sourceType === "LIVE"
      ? ""
      : `<p style="background:#fde68a;border:1px solid #d97706;padding:12px;border-radius:6px">
           <strong>TEST</strong> — diese Mail stammt aus einem Test-Fixture.
           Keine echte Gelegenheit, keine Marktdaten, keine Handelsempfehlung.
         </p>`;

  const tps = mail.takeProfits
    .map((tp) => row(`TP${String(tp.index)}`, usd(tp.targetUsd)))
    .join("");

  return `<!-- Bewusst Inline-Styles: E-Mail-Clients werfen <style>-Bloecke weg. -->
<div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;color:#111">
  ${testBanner}
  <h1 style="font-size:20px;margin:0 0 4px">${esc(mail.tokenSymbol)}</h1>
  <p style="font-family:ui-monospace,monospace;font-size:12px;color:#666;margin:0 0 20px">${esc(mail.mint)}</p>

  <table style="border-collapse:collapse;width:100%;font-size:14px">
    ${row("Score", num(mail.score))}
    ${row("Konfidenz", pct(mail.confidence))}
    ${row("Erwartungswert", pct(mail.expectedValue))}
    ${row("Liquiditaet", mail.liquidityUsd === null ? NA : `$${mail.liquidityUsd.toLocaleString("de-DE")}`)}
    ${row("Risiko", mail.riskLevel ?? NA)}
    ${row("Vorgeschlagener Einstieg", usd(mail.suggestedEntryUsd))}
    ${row("Stop", usd(mail.stopUsd))}
    ${tps}
    ${row("Strategie-Version", mail.strategyVersion)}
    ${row("Laeuft ab", mail.expiresAt.toISOString())}
  </table>

  <p style="margin:24px 0">
    <a href="${esc(mail.confirmUrl)}"
       style="display:inline-block;background:#111;color:#fff;text-decoration:none;
              padding:12px 28px;border-radius:6px;font-weight:600">INVEST NOW</a>
  </p>

  <p style="font-size:12px;color:#666;line-height:1.5;border-top:1px solid #eee;padding-top:12px">
    Der Preis in dieser Mail ist <strong>nicht</strong> der Einstiegspreis. Beim Klick
    werden Preis, Liquiditaet, Sicherheit und Erwartungswert neu erhoben; weicht
    etwas zu stark ab, wird der Trade blockiert.
  </p>
</div>`;
}
