import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Funnel, RefreshCcw, Search, Workflow } from "lucide-react";
import { startTransition } from "react";
import {
  WorkflowEmptyState,
  WorkflowLiveBadge,
  WorkflowMetricCard,
  WorkflowRouteErrorPanel,
  WorkflowStatusBadge,
  formatRelativeTime,
  formatTimestamp,
  shortRunId,
} from "#/components/workflows";
import { useWorkflowLiveUpdates } from "#/hooks/useWorkflowLiveUpdates";
import { getWorkflowsDashboardPage } from "#/lib/workflows.functions";
import type { WorkflowDashboardQuery, WorkflowStatus } from "#/lib/workflows.shared";

type WorkflowsSearch = {
  q?: string;
  status?: WorkflowStatus | "all";
  moduleId?: string;
  role?: string;
  window?: "24h" | "7d" | "30d" | "90d" | "all";
  active?: "1";
};

function normalizeSearch(search: Record<string, unknown>): WorkflowsSearch {
  return {
    q: typeof search.q === "string" && search.q.trim() ? search.q.trim() : undefined,
    status:
      typeof search.status === "string" && search.status.trim()
        ? (search.status as WorkflowsSearch["status"])
        : undefined,
    moduleId:
      typeof search.moduleId === "string" && search.moduleId.trim()
        ? search.moduleId.trim()
        : undefined,
    role: typeof search.role === "string" && search.role.trim() ? search.role.trim() : undefined,
    window:
      typeof search.window === "string" && search.window.trim()
        ? (search.window as WorkflowsSearch["window"])
        : undefined,
    active: search.active === "1" ? "1" : undefined,
  };
}

export const Route = createFileRoute("/workflows")({
  validateSearch: normalizeSearch,
  loaderDeps: ({ search }) => search,
  loader: ({ deps }) =>
    getWorkflowsDashboardPage({
      data: {
        q: deps.q,
        status: deps.status,
        moduleId: deps.moduleId,
        role: deps.role,
        window: deps.window,
        activeOnly: deps.active === "1",
      } satisfies Partial<WorkflowDashboardQuery>,
    }),
  errorComponent: (props) => {
    const message = props.error instanceof Error ? props.error.message : "Unbekannter Fehler";
    if (message === "UNAUTHORIZED") {
      return (
        <WorkflowRouteErrorPanel
          title="Workflow-Dashboard gesperrt"
          body="Die read-only Workflow-Ansichten sind an die bestehende Web-Session gebunden."
          unauthorized
        />
      );
    }
    return (
      <WorkflowRouteErrorPanel
        title="Workflow-Dashboard konnte nicht geladen werden"
        body={message}
      />
    );
  },
  component: WorkflowsPage,
});

function WorkflowsPage() {
  const router = useRouter();
  const data = Route.useLoaderData();
  const search = Route.useSearch();

  const live = useWorkflowLiveUpdates({
    onWorkflowChange: () => {
      startTransition(() => {
        void router.invalidate();
      });
    },
  });

  function updateSearch(next: Partial<WorkflowsSearch>) {
    startTransition(() => {
      void router.navigate({
        to: "/workflows",
        replace: true,
        search: (prev) => ({
          ...prev,
          ...next,
        }),
      });
    });
  }

  return (
    <main className="page-wrap px-4 pb-16 pt-12 sm:pt-14">
      <section className="island-shell overflow-hidden rounded-[2.2rem] px-6 py-8 sm:px-10 sm:py-10">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-4xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--sea-ink)]">
              <Workflow className="h-4 w-4" />
              Workflows
            </div>
            <h1 className="display-title mt-4 text-4xl leading-[0.98] font-bold text-[var(--sea-ink)] sm:text-6xl">
              Read-only Ueberblick ueber Workflow-Runs, Trace-Signale und Artefakte.
            </h1>
            <p className="mt-4 max-w-3xl text-base leading-7 text-[var(--sea-ink-soft)] sm:text-lg">
              Die Listenansicht liest kompakte Run- und Trace-Summaries. Vollstaendiger Progress,
              Timeline und Artefakt-Preview bleiben im Drilldown auf einem einzelnen Run.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <WorkflowLiveBadge connected={live.connected} lastEventAt={live.lastEventAt} />
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-4 py-2 text-sm font-semibold text-[var(--sea-ink)]"
              onClick={() => {
                startTransition(() => {
                  void router.invalidate();
                });
              }}
            >
              <RefreshCcw className="h-4 w-4" />
              Neu laden
            </button>
          </div>
        </div>
      </section>

      <section className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <WorkflowMetricCard label="Aktiv" value={data.stats.active} />
        <WorkflowMetricCard label="Blocked" value={data.stats.blocked} tone="warning" />
        <WorkflowMetricCard label="Failed" value={data.stats.failed} tone="danger" />
        <WorkflowMetricCard label="Done" value={data.stats.done} tone="success" />
        <WorkflowMetricCard label="Abort angefragt" value={data.stats.abortRequested} />
      </section>

      <section className="mt-8 island-shell rounded-[2rem] px-6 py-6 sm:px-8">
        <div className="mb-5 flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
          <Funnel className="h-4 w-4" />
          Filter
        </div>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_repeat(4,minmax(0,0.7fr))]">
          <label className="space-y-2 text-sm font-medium text-[var(--sea-ink)]">
            <span>Suche</span>
            <div className="flex items-center gap-2 rounded-[1.2rem] border border-[var(--line)] bg-[var(--surface-strong)] px-4 py-3">
              <Search className="h-4 w-4 text-[var(--sea-ink-soft)]" />
              <input
                value={search.q ?? ""}
                onChange={(event) => updateSearch({ q: event.currentTarget.value || undefined })}
                placeholder="Run, Modul, Task, Session"
                className="w-full border-0 bg-transparent p-0 text-sm text-[var(--sea-ink)] outline-none placeholder:text-[var(--sea-ink-soft)]"
              />
            </div>
          </label>

          <label className="space-y-2 text-sm font-medium text-[var(--sea-ink)]">
            <span>Status</span>
            <select
              value={search.status ?? "all"}
              onChange={(event) =>
                updateSearch({
                  status:
                    event.currentTarget.value === "all"
                      ? undefined
                      : (event.currentTarget.value as WorkflowsSearch["status"]),
                })
              }
              className="w-full rounded-[1.2rem] border border-[var(--line)] bg-[var(--surface-strong)] px-4 py-3 text-sm text-[var(--sea-ink)]"
            >
              <option value="all">Alle</option>
              <option value="pending">Pending</option>
              <option value="running">Running</option>
              <option value="done">Done</option>
              <option value="planning_done">Planning Done</option>
              <option value="blocked">Blocked</option>
              <option value="failed">Failed</option>
              <option value="aborted">Aborted</option>
              <option value="max_rounds_reached">Max Rounds</option>
            </select>
          </label>

          <label className="space-y-2 text-sm font-medium text-[var(--sea-ink)]">
            <span>Modul</span>
            <select
              value={search.moduleId ?? ""}
              onChange={(event) =>
                updateSearch({ moduleId: event.currentTarget.value || undefined })
              }
              className="w-full rounded-[1.2rem] border border-[var(--line)] bg-[var(--surface-strong)] px-4 py-3 text-sm text-[var(--sea-ink)]"
            >
              <option value="">Alle</option>
              {data.modules.map((module) => (
                <option key={module.moduleId} value={module.moduleId}>
                  {module.displayName}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-2 text-sm font-medium text-[var(--sea-ink)]">
            <span>Rolle</span>
            <select
              value={search.role ?? ""}
              onChange={(event) => updateSearch({ role: event.currentTarget.value || undefined })}
              className="w-full rounded-[1.2rem] border border-[var(--line)] bg-[var(--surface-strong)] px-4 py-3 text-sm text-[var(--sea-ink)]"
            >
              <option value="">Alle</option>
              {data.roles.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-2 text-sm font-medium text-[var(--sea-ink)]">
            <span>Zeitfenster</span>
            <select
              value={search.window ?? "7d"}
              onChange={(event) =>
                updateSearch({
                  window:
                    event.currentTarget.value === "7d"
                      ? undefined
                      : (event.currentTarget.value as WorkflowsSearch["window"]),
                })
              }
              className="w-full rounded-[1.2rem] border border-[var(--line)] bg-[var(--surface-strong)] px-4 py-3 text-sm text-[var(--sea-ink)]"
            >
              <option value="24h">24h</option>
              <option value="7d">7d</option>
              <option value="30d">30d</option>
              <option value="90d">90d</option>
              <option value="all">Alle</option>
            </select>
          </label>
        </div>

        <label className="mt-4 inline-flex items-center gap-3 text-sm font-medium text-[var(--sea-ink)]">
          <input
            type="checkbox"
            checked={search.active === "1"}
            onChange={(event) =>
              updateSearch({ active: event.currentTarget.checked ? "1" : undefined })
            }
            className="h-4 w-4 rounded border-[var(--line)]"
          />
          Nur aktive Runs anzeigen
        </label>
      </section>

      <section className="mt-8 space-y-4">
        {data.runs.length === 0 ? (
          <WorkflowEmptyState
            title="Keine Runs fuer diese Filter"
            body="Die aktuelle Kombination aus Suche, Status, Modul, Rolle und Zeitfenster liefert keine Treffer."
          />
        ) : (
          data.runs.map((run) => (
            <Link
              key={run.runId}
              to="/workflows/$runId"
              params={{ runId: run.runId }}
              className="group block rounded-[2rem] border border-[var(--line)] bg-[linear-gradient(165deg,var(--surface-strong),var(--surface))] px-6 py-6 text-inherit no-underline shadow-[0_18px_40px_rgba(20,56,61,0.07)] transition hover:-translate-y-0.5 hover:border-[var(--lagoon-deep)]"
            >
              <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
                <div className="min-w-0 flex-1 space-y-4">
                  <div className="flex flex-wrap items-center gap-3">
                    <WorkflowStatusBadge status={run.status} />
                    <span className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--sea-ink)]">
                      {run.moduleDisplayName}
                    </span>
                    <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
                      {shortRunId(run.runId)}
                    </span>
                    {run.abortRequested ? (
                      <span className="rounded-full border border-[rgba(224,164,88,0.22)] bg-[rgba(224,164,88,0.10)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-[#976228]">
                        abort angefragt
                      </span>
                    ) : null}
                  </div>

                  <div>
                    <h2 className="mb-2 text-2xl font-semibold text-[var(--sea-ink)]">
                      {run.taskSnippet || "Workflow-Run ohne Task-Snippet"}
                    </h2>
                    <p className="m-0 text-sm leading-7 text-[var(--sea-ink-soft)]">
                      Runde {run.currentRound}
                      {run.maxRounds ? ` / ${run.maxRounds}` : ""} · aktualisiert{" "}
                      {formatRelativeTime(run.updatedAt)} · {formatTimestamp(run.updatedAt)}
                    </p>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <div className="rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] px-4 py-3">
                      <p className="mb-1 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
                        Trace
                      </p>
                      <p className="m-0 text-sm text-[var(--sea-ink)]">
                        {run.trace.eventCount} Events · {run.trace.artifactCount} Artefakte
                      </p>
                    </div>
                    <div className="rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] px-4 py-3">
                      <p className="mb-1 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
                        Rollen
                      </p>
                      <p className="m-0 text-sm text-[var(--sea-ink)]">
                        {run.trace.rolesSeen.length ? run.trace.rolesSeen.join(", ") : "—"}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] px-4 py-3">
                      <p className="mb-1 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
                        Letztes Event
                      </p>
                      <p className="m-0 text-sm text-[var(--sea-ink)]">
                        {run.trace.lastEventKind ?? "—"}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-[var(--line)] bg-[var(--surface-strong)] px-4 py-3">
                      <p className="mb-1 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
                        Trace-Summary
                      </p>
                      <p className="m-0 text-sm text-[var(--sea-ink)]">
                        {run.trace.summaryAvailable ? "Dateibasiert" : "aus Run-Record abgeleitet"}
                      </p>
                    </div>
                  </div>

                  {run.terminalReason ? (
                    <div className="rounded-[1.4rem] border border-[var(--line)] bg-[var(--surface-strong)] px-4 py-3 text-sm leading-7 text-[var(--sea-ink)]">
                      <span className="font-semibold text-[var(--sea-ink-soft)]">
                        Terminal Reason:
                      </span>{" "}
                      {run.terminalReason}
                    </div>
                  ) : null}

                  {run.trace.hasMeaningfulError && run.trace.errorSummary ? (
                    <div className="rounded-[1.4rem] border border-[rgba(180,67,45,0.16)] bg-[rgba(180,67,45,0.06)] px-4 py-3 text-sm leading-7 text-[var(--danger)]">
                      Trace-Hinweis: {run.trace.errorSummary}
                    </div>
                  ) : null}
                </div>
              </div>
            </Link>
          ))
        )}
      </section>
    </main>
  );
}
