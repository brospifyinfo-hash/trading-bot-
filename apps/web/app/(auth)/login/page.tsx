/**
 * Anmeldung per Magic Link.
 *
 * Der Versand laeuft in Phase 13 ueber Resend. Phase 1 liefert die Route und das
 * Formular; es gibt bewusst noch keinen Weg, sich tatsaechlich anzumelden —
 * eine halbfertige Authentifizierung ist schlimmer als gar keine.
 */
export default function LoginPage() {
  return (
    <main className="panel" style={{ maxWidth: 420, margin: "80px auto" }}>
      <h2>Anmelden</h2>
      <p className="placeholder">
        Magic-Link-Anmeldung mit anschliessender TOTP-Bestaetigung. Noch nicht aktiv.
      </p>
    </main>
  );
}
