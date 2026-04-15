import { createFileRoute, redirect } from "@tanstack/react-router";
import { ArrowRight, LayoutGrid, Sparkles } from "lucide-react";
import { PIBO_MODULES } from "#/lib/modules";

type IndexSearch = {
  doc?: string;
};

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): IndexSearch => ({
    doc: typeof search.doc === "string" ? search.doc : undefined,
  }),
  beforeLoad: ({ search }) => {
    if (search.doc) {
      throw redirect({
        search: {
          doc: search.doc,
        },
        to: "/editor",
      });
    }
  },
  component: ModuleMenuPage,
});

function ModuleMenuPage() {
  return (
    <main className="page-wrap px-4 pb-16 pt-12 sm:pt-14">
      <section className="island-shell rise-in overflow-hidden rounded-[2.2rem] px-6 py-10 sm:px-10 sm:py-14">
        <div className="grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-end">
          <div className="space-y-6">
            <div className="inline-flex items-center gap-2 rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-[var(--sea-ink)]">
              <LayoutGrid className="h-4 w-4" />
              PIBo Module
            </div>
            <div className="space-y-4">
              <h1 className="display-title max-w-4xl text-4xl leading-[0.96] font-bold tracking-tight text-[var(--sea-ink)] sm:text-6xl">
                Ein Einstiegspunkt fuer Editor und Chat auf derselben Hauptdomain.
              </h1>
              <p className="max-w-3xl text-base leading-7 text-[var(--sea-ink-soft)] sm:text-lg">
                `ui-pibo` bleibt fuer Root und `/editor` verantwortlich, `apps/chat` laeuft weiter
                als eigene Runtime unter `/chat`. Nginx verteilt nur ueber saubere Subpaths.
              </p>
            </div>
          </div>

          <div className="rounded-[1.8rem] border border-[var(--line)] bg-[rgba(255,255,255,0.55)] p-6 shadow-[0_24px_80px_rgba(18,63,52,0.10)] backdrop-blur">
            <p className="island-kicker mb-3">Architektur</p>
            <div className="grid gap-3 text-sm leading-6 text-[var(--sea-ink-soft)]">
              <div className="rounded-2xl border border-[var(--line)] bg-[var(--card)] px-4 py-3">
                Root-Menue und Editor bleiben auf `127.0.0.1:3000`.
              </div>
              <div className="rounded-2xl border border-[var(--line)] bg-[var(--card)] px-4 py-3">
                Chat bleibt getrennt auf `127.0.0.1:3010` mit Gateway unter
                `/chat/__openclaw/gateway`.
              </div>
              <div className="rounded-2xl border border-[var(--line)] bg-[var(--card)] px-4 py-3">
                Weitere Module koennen spaeter nur ueber neue Subpaths ergaenzt werden.
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="mt-8 grid gap-5 md:grid-cols-2">
        {PIBO_MODULES.map((module) => (
          <a
            key={module.id}
            href={module.href}
            className="group island-shell flex h-full flex-col gap-4 rounded-[2rem] border border-[var(--line)] px-6 py-6 text-inherit no-underline transition hover:-translate-y-0.5 hover:border-[var(--sea-ink)] hover:shadow-[0_26px_70px_rgba(27,76,62,0.12)]"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="island-kicker mb-2">{module.runtime}</p>
                <h2 className="text-2xl leading-tight font-semibold text-[var(--sea-ink)]">
                  {module.title}
                </h2>
              </div>
              <span className="inline-flex items-center rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--sea-ink)]">
                {module.status}
              </span>
            </div>
            <p className="m-0 text-base leading-7 text-[var(--sea-ink-soft)]">
              {module.description}
            </p>
            <div className="mt-auto inline-flex items-center gap-2 text-sm font-semibold text-[var(--sea-ink)]">
              Modul oeffnen
              <ArrowRight className="h-4 w-4 transition group-hover:translate-x-0.5" />
            </div>
          </a>
        ))}
      </section>

      <section className="mt-8 rounded-[2rem] border border-[var(--line)] bg-[linear-gradient(135deg,rgba(240,252,246,0.95),rgba(255,255,255,0.85))] px-6 py-6 shadow-[0_18px_50px_rgba(26,72,58,0.08)]">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="island-kicker mb-2">Kompatibilitaet</p>
            <p className="m-0 max-w-3xl text-sm leading-6 text-[var(--sea-ink-soft)]">
              Alte Editor-Bookmarks mit `?doc=...` werden serverseitig nach `/editor?doc=...`
              weitergeleitet, damit bestehende Deep Links nicht still auf dem Menue landen.
            </p>
          </div>
          <div className="inline-flex items-center gap-2 rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-4 py-2 text-sm font-medium text-[var(--sea-ink)]">
            <Sparkles className="h-4 w-4" />
            Root bleibt nur das Menue
          </div>
        </div>
      </section>
    </main>
  );
}
