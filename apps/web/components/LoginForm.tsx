"use client";

import { useActionState } from "react";

/**
 * Das Anmeldeformular.
 *
 * Client-Komponente ausschliesslich wegen `useActionState` — die Rueckmeldung
 * („Passwort falsch") soll ohne vollen Seitenwechsel ankommen. Das Passwort
 * selbst wird nirgends im Browser gehalten; es geht als Formularfeld an den
 * Server und wird dort in konstanter Zeit verglichen.
 */
export function LoginForm({
  action,
}: {
  readonly action: (zustand: string | null, formData: FormData) => Promise<string>;
}) {
  const [meldung, formAction, laeuft] = useActionState(action, null);

  return (
    <section className="panel" style={{ maxWidth: 440, margin: "60px auto" }}>
      <h2>Anmelden</h2>
      <p>Die Anzeige ist offen. Fuer Aenderungen an den Einstellungen braucht es das Passwort.</p>
      <form action={formAction} className="form">
        <label className="field">
          <span>Passwort</span>
          <input
            type="password"
            name="passwort"
            autoComplete="current-password"
            required
            autoFocus
          />
        </label>
        <button type="submit" disabled={laeuft}>
          {laeuft ? "Prüfe…" : "Anmelden"}
        </button>
      </form>
      {meldung !== null && (
        <p className="placeholder" role="status">
          <strong>HINWEIS</strong>
          <br />
          {meldung}
        </p>
      )}
    </section>
  );
}
