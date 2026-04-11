import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ShieldCheck } from "lucide-react";
import { useCallback, useState } from "react";
import { WorkspaceShell } from "#/components/WorkspaceShell";
import { getAppBootstrap, loginWithCredentials } from "#/lib/app.functions";

type IndexSearch = {
  doc?: string;
};

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): IndexSearch => ({
    doc: typeof search.doc === "string" ? search.doc : undefined,
  }),
  loaderDeps: ({ search }) => ({
    doc: search.doc ?? null,
  }),
  loader: ({ deps }) =>
    getAppBootstrap({
      data: {
        documentPath: deps.doc,
      },
    }),
  component: HomePage,
});

function HomePage() {
  const initialData = Route.useLoaderData();
  const navigate = Route.useNavigate();
  const [appState, setAppState] = useState(initialData);
  const [authError, setAuthError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<"login" | null>(null);

  const login = useServerFn(loginWithCredentials);
  const handleDocumentPathChange = useCallback(
    (documentPath: string | null) => {
      void navigate({
        search: (prev) => ({
          ...prev,
          doc: documentPath ?? undefined,
        }),
        replace: true,
      });
    },
    [navigate],
  );

  async function handleLogin(formData: FormData) {
    const username = formData.get("username");
    const password = formData.get("password");

    if (typeof username !== "string" || typeof password !== "string") {
      return;
    }

    setBusyAction("login");
    setAuthError(null);

    try {
      const nextState = await login({
        data: { username, password },
      });
      setAppState(nextState);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Login fehlgeschlagen");
    } finally {
      setBusyAction(null);
    }
  }

  if (!appState.authenticated) {
    return (
      <main className="page-wrap px-4 pb-20 pt-14">
        <section className="auth-shell rise-in overflow-hidden rounded-[2rem] border border-[var(--line)]">
          <div className="auth-copy">
            <p className="island-kicker mb-3">Markdown Workspace</p>
            <h1 className="display-title mb-4 text-4xl leading-[0.98] font-bold text-[var(--paper-ink)] sm:text-6xl">
              Ein privater Editor mit Dateisystem-Storage.
            </h1>
            <p className="m-0 max-w-xl text-base text-[var(--paper-muted)] sm:text-lg">
              Credentials-Login, 30-Tage-JWT, mehrere Geräte und ein hierarchischer Dokumentbaum in
              einer Oberfläche.
            </p>
          </div>

          <div className="auth-panel">
            <div className="auth-badge">
              <ShieldCheck className="h-4 w-4" />
              Login
            </div>

            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void handleLogin(new FormData(event.currentTarget));
              }}
            >
              <label className="space-y-2 text-sm font-medium text-[var(--paper-ink)]">
                <span>Benutzername</span>
                <input
                  name="username"
                  className="auth-input"
                  autoComplete="username"
                  placeholder="Benutzername"
                />
              </label>

              <label className="space-y-2 text-sm font-medium text-[var(--paper-ink)]">
                <span>Passwort</span>
                <input
                  name="password"
                  type="password"
                  className="auth-input"
                  autoComplete="current-password"
                  placeholder="Passwort"
                />
              </label>

              {authError ? <p className="auth-error">{authError}</p> : null}

              <button
                type="submit"
                className="primary-button w-full"
                disabled={busyAction === "login"}
              >
                {busyAction === "login" ? "Prüfe Zugang..." : "Einloggen"}
              </button>
            </form>
          </div>
        </section>
      </main>
    );
  }

  return (
    <WorkspaceShell
      initialData={appState}
      onLoggedOut={(nextState) => {
        setAppState(nextState);
      }}
      onDocumentPathChange={handleDocumentPathChange}
    />
  );
}
