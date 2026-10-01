import { anmelden, anmeldungMoeglich, sitzungAktiv } from "@/app/actions";
import { LoginForm } from "@/components/LoginForm";

/**
 * Anmeldung mit einem Passwort.
 *
 * Hier stand bis hierher ein Platzhalter mit dem Hinweis, eine halbfertige
 * Authentifizierung sei schlimmer als gar keine. Das stimmte, solange es
 * nichts zu schuetzen gab. Jetzt gibt es eine Einstellung, die den Handel
 * beeinflusst — und genau eine Person, die sie setzen darf.
 *
 * Was hier NICHT steht, steht in `lib/session.ts` ausgeschrieben: kein Magic
 * Link, kein TOTP, kein Step-up. Das ist der Endausbau fuer Live-Handel, und
 * den gibt es nicht.
 */
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await sitzungAktiv()) {
    return (
      <main className="workspace">
        <section className="panel">
          <h2>Angemeldet</h2>
          <p>Sie sind angemeldet. <a href="/">Zurueck zum Dashboard</a>.</p>
        </section>
      </main>
    );
  }

  if (!(await anmeldungMoeglich())) {
    return (
      <main className="workspace">
        <section className="panel" data-tone="alarm">
          <h2>Anmeldung nicht eingerichtet</h2>
          <p className="placeholder">
            <strong>KEIN PASSWORT HINTERLEGT</strong>
            <br />
            Ohne <code>DASHBOARD_PASSWORD</code> gibt es keine Anmeldung — und ausdruecklich
            keine, die immer gelingt.
          </p>
          <p>
            Vercel, Projekt <code>trading-bot-web</code> → <em>Settings</em> →{" "}
            <em>Environment Variables</em>. Variable <code>DASHBOARD_PASSWORD</code> anlegen,
            mindestens 16 Zeichen, danach neu bereitstellen.
          </p>
          <p>
            Die Anzeige laeuft auch ohne weiter. Nur aendern laesst sich dann nichts.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="workspace">
      <LoginForm action={anmelden} />
    </main>
  );
}
