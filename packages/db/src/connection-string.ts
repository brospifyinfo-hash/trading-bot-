/**
 * Verbindungsparameter, die `postgres-js` an den Server durchreicht, obwohl
 * PostgreSQL sie nicht kennt.
 *
 * Der Hintergrund ist ein echter Ausfall, kein theoretisches Risiko.
 * `postgres-js` sammelt alle Query-Parameter der URL ein, behandelt die ihm
 * bekannten (`sslmode` wird zu `ssl`) und legt **alle uebrigen** in
 * `connection` — von dort gehen sie als Startup-Parameter an den Server. Fuer
 * eine libpq-Client-Option wie `channel_binding` antwortet PostgreSQL dann:
 *
 *     unrecognized configuration parameter "channel_binding"
 *
 * Die Verbindung kommt gar nicht erst zustande. Neon haengt genau diesen
 * Parameter standardmaessig an seine Verbindungszeichenfolgen, und die
 * Neon-Vercel-Integration traegt sie unveraendert ein — der Fehler kommt also
 * bei jeder Neuprovisionierung zurueck, wenn man ihn nur in der Plattform
 * wegloescht.
 *
 * Alle hier gelisteten Namen sind libpq-**Client**-Optionen: sie steuern, wie
 * der Client sich verbindet, und haben serverseitig keine Bedeutung. Sie zu
 * entfernen aendert nichts an der Sicherheit der Verbindung — `sslmode` bleibt
 * unangetastet und wird von `postgres-js` korrekt in TLS uebersetzt.
 */
const LIBPQ_CLIENT_ONLY_PARAMS: readonly string[] = [
  "channel_binding",
  "gssencmode",
  "sslcert",
  "sslkey",
  "sslcrl",
  "sslcompression",
  "krbsrvname",
  "passfile",
  "service",
];

/**
 * Entfernt Parameter, die sonst als unbekannte Startup-Parameter beim Server
 * landen.
 *
 * Faellt bei einer unparsbaren Zeichenfolge auf das Original zurueck: eine
 * kaputte URL soll den bestehenden Fehler zeigen und nicht einen neuen aus
 * dieser Funktion.
 */
export function sanitizeConnectionString(connectionString: string): string {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return connectionString;
  }

  let changed = false;
  for (const name of LIBPQ_CLIENT_ONLY_PARAMS) {
    if (url.searchParams.has(name)) {
      url.searchParams.delete(name);
      changed = true;
    }
  }
  if (!changed) return connectionString;

  // `toString()` normalisiert sonst auch das Passwort (Prozentkodierung), was
  // eine funktionierende Verbindung zerstoeren koennte. Deshalb nur den
  // Query-Teil ersetzen und den Rest der Zeichenfolge unangetastet lassen.
  const query = url.searchParams.toString();
  const [head] = connectionString.split("?", 1);
  return query.length > 0 ? `${head}?${query}` : (head ?? connectionString);
}
