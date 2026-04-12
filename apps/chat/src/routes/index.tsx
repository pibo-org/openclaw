import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { LogOutIcon, ShieldCheckIcon } from 'lucide-react'
import { ChatAppClient } from '#/components/ChatAppClient'
import { getChatBootstrap, loginWithCredentials, logout } from '#/lib/app.functions'

export const Route = createFileRoute('/')({
  loader: () => getChatBootstrap(),
  component: ChatIndexPage,
})

function ChatIndexPage() {
  const initialData = Route.useLoaderData()
  const [appState, setAppState] = useState(initialData)
  const [authError, setAuthError] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<'login' | 'logout' | null>(null)
  const login = useServerFn(loginWithCredentials)
  const runLogout = useServerFn(logout)

  async function handleLogin(formData: FormData) {
    const username = formData.get('username')
    const password = formData.get('password')
    if (typeof username !== 'string' || typeof password !== 'string') {
      return
    }

    setBusyAction('login')
    setAuthError(null)

    try {
      const nextState = await login({
        data: { username, password },
      })
      setAppState(nextState)
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Login fehlgeschlagen')
    } finally {
      setBusyAction(null)
    }
  }

  async function handleLogout() {
    setBusyAction('logout')
    try {
      const nextState = await runLogout()
      setAppState(nextState)
    } finally {
      setBusyAction(null)
    }
  }

  if (!appState.authenticated) {
    return (
      <main className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(27,92,255,0.22),_transparent_24%),linear-gradient(180deg,_#07101d_0%,_#03060a_100%)] px-4 py-10 text-foreground">
        <div className="mx-auto grid min-h-[calc(100vh-5rem)] max-w-6xl items-center gap-8 lg:grid-cols-[1.05fr_0.95fr]">
          <section className="space-y-6">
            <p className="text-xs uppercase tracking-[0.28em] text-cyan-200/75">PIBo Chat</p>
            <h1 className="max-w-3xl text-4xl leading-[0.95] font-semibold text-white sm:text-6xl">
              Ein Login fuer Workspace und OpenClaw-Chat.
            </h1>
            <p className="max-w-2xl text-base leading-7 text-slate-300 sm:text-lg">
              Diese App sitzt im OpenClaw-Monorepo, nutzt denselben Shared-Auth-Kern wie die Web-App
              und spricht ueber den bestehenden Gateway-Web-Vertrag direkt mit OpenClaw.
            </p>
            <div className="grid gap-3 text-sm text-slate-300 sm:grid-cols-3">
              <div className="rounded-[1.6rem] border border-white/10 bg-white/5 p-4">
                Ein gemeinsames Cookie auf derselben Domain-Familie.
              </div>
              <div className="rounded-[1.6rem] border border-white/10 bg-white/5 p-4">
                Gateway-Zugriff bleibt separat ueber Device Identity und Pairing gesichert.
              </div>
              <div className="rounded-[1.6rem] border border-white/10 bg-white/5 p-4">
                Der Mini-PC bleibt privat; Browser spricht nur mit der Web-Oberflaeche.
              </div>
            </div>
          </section>

          <section className="rounded-[2rem] border border-white/10 bg-slate-950/70 p-6 shadow-[0_30px_90px_rgba(0,0,0,0.4)] backdrop-blur">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1.5 text-xs uppercase tracking-[0.18em] text-cyan-100">
              <ShieldCheckIcon className="size-4" />
              Shared Auth
            </div>
            <h2 className="text-2xl font-semibold text-white">Anmelden</h2>
            <p className="mt-2 text-sm leading-6 text-slate-400">
              Nutzt denselben Credentials-Login wie das Dokumentenwesen. Wenn du dort schon eingeloggt
              bist, springt diese Seite spaeter direkt in den Chat.
            </p>

            <form
              className="mt-8 grid gap-4"
              onSubmit={(event) => {
                event.preventDefault()
                void handleLogin(new FormData(event.currentTarget))
              }}
            >
              <label className="grid gap-2 text-sm text-slate-300">
                <span>Benutzername</span>
                <input
                  autoComplete="username"
                  className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-cyan-300/60"
                  name="username"
                  placeholder="Benutzername"
                />
              </label>

              <label className="grid gap-2 text-sm text-slate-300">
                <span>Passwort</span>
                <input
                  autoComplete="current-password"
                  className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-white outline-none transition focus:border-cyan-300/60"
                  name="password"
                  placeholder="Passwort"
                  type="password"
                />
              </label>

              {authError ? (
                <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">
                  {authError}
                </div>
              ) : null}

              <button
                className="mt-2 rounded-2xl bg-cyan-300 px-4 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-70"
                disabled={busyAction === 'login'}
                type="submit"
              >
                {busyAction === 'login' ? 'Pruefe Zugang...' : 'Einloggen'}
              </button>
            </form>
          </section>
        </div>
      </main>
    )
  }

  const gatewayBootstrapScript = appState.gatewayToken
    ? `window.__OPENCLAW_BOOTSTRAP_GATEWAY_TOKEN__ = ${JSON.stringify(appState.gatewayToken)};`
    : ''

  return (
    <div className="relative">
      <div className="pointer-events-none fixed inset-x-0 top-0 z-50 px-3 pt-3">
        <div className="mx-auto flex max-w-[1680px] items-center justify-between gap-3 rounded-2xl border border-white/10 bg-slate-950/82 px-4 py-3 text-sm text-slate-200 shadow-[0_20px_60px_rgba(0,0,0,0.35)] backdrop-blur">
          <div className="pointer-events-auto min-w-0">
            <p className="text-[11px] uppercase tracking-[0.2em] text-slate-500">PIBo Chat</p>
            <p className="truncate">
              Eingeloggt als <span className="font-medium text-white">{appState.username}</span>
            </p>
          </div>
          <button
            className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/6 px-3 py-2 text-sm text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-70"
            disabled={busyAction === 'logout'}
            onClick={() => void handleLogout()}
            type="button"
          >
            <LogOutIcon className="size-4" />
            {busyAction === 'logout' ? 'Melde ab...' : 'Logout'}
          </button>
        </div>
      </div>
      {gatewayBootstrapScript ? (
        <script
          dangerouslySetInnerHTML={{
            __html: gatewayBootstrapScript,
          }}
        />
      ) : null}
      <ChatAppClient gatewayToken={appState.gatewayToken} />
    </div>
  )
}
