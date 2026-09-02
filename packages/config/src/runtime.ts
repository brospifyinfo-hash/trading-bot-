/**
 * Wo darf dieser Prozess laufen?
 *
 * Zwei Komponenten dieses Systems gehoeren ausdruecklich NICHT auf eine
 * Serverless-Plattform, und bei einer davon ist es eine Sicherheitsgrenze und
 * keine Betriebsvorliebe:
 *
 * - **Der Signer** haelt den privaten Schluessel und spricht ausschliesslich
 *   ueber mTLS im internen Netz. Auf einer oeffentlich erreichbaren
 *   Serverless-Plattform ist beides nicht herstellbar.
 * - **Der Worker** braucht Takt, gehaltene Fristen und einen Verbindungspool,
 *   der laenger lebt als eine Anfrage.
 *
 * Warum diese Pruefung ueberhaupt existiert: ein Deployment aus Versehen ist
 * leicht. Ein Klick im Vercel-Dashboard genuegt, und die Plattform baut, was
 * sie findet. Ohne diese Pruefung scheitert der Signer dort zwar auch — aber
 * mit der Meldung „SIGNER_KEY_FILE: Required", und die liest sich wie eine
 * Aufforderung, die Variablen nachzutragen. Genau das waere die gefaehrlichste
 * moegliche Reaktion.
 *
 * Die Pruefung ersetzt keine Plattformkonfiguration. Sie sorgt dafuer, dass ein
 * falsches Deployment eine richtige Fehlermeldung erzeugt.
 */

/** Die erkannte Plattform, oder `null` fuer „gewoehnlicher Prozess". */
export function detectServerlessPlatform(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  // Vercel setzt VERCEL=1 in Build und Laufzeit.
  if (env["VERCEL"] !== undefined && env["VERCEL"] !== "") return "Vercel";
  if (env["VERCEL_ENV"] !== undefined && env["VERCEL_ENV"] !== "") return "Vercel";
  // Vercel-Functions laufen auf Lambda; andere Lambda-Deployments faenden wir
  // hier ebenfalls, und auch die waeren falsch.
  if (env["AWS_LAMBDA_FUNCTION_NAME"] !== undefined) return "AWS Lambda";
  if (env["NETLIFY"] !== undefined && env["NETLIFY"] !== "") return "Netlify";
  return null;
}

/**
 * Bricht ab, wenn dieser Prozess auf einer Serverless-Plattform startet.
 *
 * Muss VOR der Env-Validierung laufen. Sonst gewinnt die Meldung ueber fehlende
 * Variablen, und die zeigt in die falsche Richtung.
 */
export function assertNotServerless(input: {
  readonly component: string;
  readonly reason: string;
  readonly belongsOn: string;
  readonly env?: NodeJS.ProcessEnv;
}): void {
  const platform = detectServerlessPlatform(input.env ?? process.env);
  if (platform === null) return;

  throw new Error(
    [
      "",
      `${input.component} darf nicht auf ${platform} laufen.`,
      "",
      input.reason,
      "",
      "Das ist KEINE fehlende Konfiguration. Fehlende Umgebungsvariablen hier",
      "nachzutragen behebt nichts, sondern verlegt eine Grenze, die absichtlich",
      "dort liegt, wo sie liegt.",
      "",
      `Richtig ist: dieses ${platform}-Projekt entfernen. ${input.component} gehoert auf ${input.belongsOn}.`,
      "",
      "Siehe docs/DEPLOYMENT.md, Abschnitt 2, und docs/INFRASTRUCTURE.md.",
      "",
    ].join("\n"),
  );
}
