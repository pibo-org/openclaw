import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/about")({
  component: About,
});

function About() {
  return (
    <main className="page-wrap px-4 pb-8 pt-14">
      <section className="island-shell rounded-[2rem] px-6 py-10 sm:px-10 sm:py-14">
        <p className="island-kicker mb-3">Info</p>
        <h1 className="display-title mb-5 text-4xl leading-[1.02] font-bold tracking-tight text-[var(--sea-ink)] sm:text-5xl">
          Aktueller Stand der App.
        </h1>
        <div className="max-w-3xl space-y-4 text-base text-[var(--sea-ink-soft)] sm:text-lg">
          <p>
            Die Hauptdomain ist jetzt als PIBo-Moduloberflaeche aufgeteilt: Root zeigt das Menue,
            `/editor` den privaten Markdown-Editor und `/chat` den getrennt betriebenen
            OpenClaw-Chat.
          </p>
          <p>
            Authentifizierung erfolgt per Benutzername und Passwort aus der Env-Datei. Nach
            erfolgreichem Login wird ein signiertes JWT als `HttpOnly`-Cookie mit 30 Tagen Laufzeit
            gesetzt.
          </p>
          <p>
            Inhalte des Editors liegen weiter unter <code>{`$PIBO_STORAGE_DIR/docs`}</code>,
            Bild-Uploads unter <code>{`$PIBO_STORAGE_DIR/uploads`}</code>. Der Chat bleibt eine
            eigene Runtime mit eigenem Gateway-Namespace unter `/chat/__openclaw/gateway`.
          </p>
        </div>
      </section>
    </main>
  );
}
