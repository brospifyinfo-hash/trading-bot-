import { anmelden, schutzAktiv, sitzungAktiv } from "@/app/actions";
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

  if (!(await schutzAktiv())) {
    return (
      <main className="workspace">
        <section className="panel">
          <h2>Keine Anmeldung noetig</h2>
          <p>
            Es ist kein Passwort hinterlegt. Die Einstellungen stehen offen —{" "}
            <a href="/">zurueck zum Dashboard</a>, dort laesst sich die Schwelle direkt
            setzen.
          </p>
          <h3>Falls Sie das aendern wollen</h3>
          <p>
            Vercel, Projekt <code>trading-bot-web</code> → <em>Settings</em> →{" "}
            <em>Environment Variables</em>. Variable <code>DASHBOARD_PASSWORD</code> anlegen,
            mindestens 16 Zeichen, danach neu bereitstellen. Ab dann verlangt diese Seite
            das Passwort, bevor sich etwas aendern laesst. Es braucht dafuer keine
            Codeaenderung.
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
