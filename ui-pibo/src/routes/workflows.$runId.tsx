import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import {
  ArrowLeft,
  Clock3,
  FileText,
  RefreshCcw,
  ScrollText,
  Search,
  Waypoints,
} from "lucide-react";
import { startTransition } from "react";
import {
  WorkflowEmptyState,
  WorkflowLiveBadge,
  WorkflowMetaItem,
  WorkflowRouteErrorPanel,
  WorkflowStatusBadge,
  formatBytes,
  formatDurationMs,
  formatTimestamp,
  shortRunId,
} from "#/components/workflows";
import { useWorkflowLiveUpdates } from "#/hooks/useWorkflowLiveUpdates";
import { getWorkflowRunDetailPage } from "#/lib/workflows.functions";
import type { WorkflowDetailQuery, WorkflowTraceEventKind } from "#/lib/workflows.shared";

type WorkflowDetailSearch = {
  kind?: WorkflowTraceEventKind;
  role?: string;
  q?: string;
  afterSeq?: string;
  eventLimit?: string;
  artifact?: string;
  artifactMode?: "head" | "tail";
  artifactLines?: string;
};

function normalizeSearch(search: Record<string, unknown>): WorkflowDetailSearch {
  return {
    kind:
      typeof search.kind === "string" && search.kind.trim()
        ? (search.kind as WorkflowTraceEventKind)
        : undefined,
    role: typeof search.role === "string" && search.role.trim() ? search.role.trim() : undefined,
    q: typeof search.q === "string" && search.q.trim() ? search.q.trim() : undefined,
    afterSeq:
      typeof search.afterSeq === "string" && search.afterSeq.trim()
        ? search.afterSeq.trim()
        : undefined,
    eventLimit:
      typeof search.eventLimit === "string" && search.eventLimit.trim()
        ? search.eventLimit.trim()
        : undefined,
    artifact:
      typeof search.artifact === "string" && search.artifact.trim()
        ? search.artifact.trim()
        : undefined,
    artifactMode:
      search.artifactMode === "head" || search.artifactMode === "tail"
        ? search.artifactMode
        : undefined,
    artifactLines:
      typeof search.artifactLines === "string" && search.artifactLines.trim()
        ? search.artifactLines.trim()
        : undefined,
  };
}

export const Route = createFileRoute("/workflows/$runId")({
  validateSearch: normalizeSearch,
  loaderDeps: ({ params, search }) => ({
    runId: params.runId,
    ...search,
  }),
  loader: ({ deps }) =>
    getWorkflowRunDetailPage({
      data: {
        runId: deps.runId,
        query: {
          kind: deps.kind,
          role: deps.role,
          q: deps.q,
          afterSeq: deps.afterSeq,
          eventLimit: deps.eventLimit,
          artifact: deps.artifact,
          artifactMode: deps.artifactMode,
          artifactLines: deps.artifactLines,
        } satisfies Partial<WorkflowDetailQuery>,
      },
    }),
  errorComponent: (props) => {
    const message = props.error instanceof Error ? props.error.message : "Unbekannter Fehler";
    if (message === "UNAUTHORIZED") {
      return (
        <WorkflowRouteErrorPanel
          title="Workflow-Detail gesperrt"
          body="Die Run-Details sind an die bestehende Web-Session gebunden."
          unauthorized
        />
      );
    }
    return (
      <WorkflowRouteErrorPanel title="Workflow-Detail konnte nicht geladen werden" body={message} />
    );
  },
  component: WorkflowDetailPage,
});

function WorkflowDetailPage() {
  const router = useRouter();
  const data = Route.useLoaderData();
  const params = Route.useParams();
  const search = Route.useSearch();

  const live = useWorkflowLiveUpdates({
    runId: params.runId,
    onWorkflowChange: () => {
      startTransition(() => {
        void router.invalidate();
      });
    },
  });

  function updateSearch(next: Partial<WorkflowDetailSearch>) {
    startTransition(() => {
      void router.navigate({
        to: "/workflows/$runId",
        params,
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
            <Link
              to="/workflows"
              className="inline-flex items-center gap-2 rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--sea-ink)] no-underline"
            >
              <ArrowLeft className="h-4 w-4" />
              Zur Uebersicht
            </Link>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <WorkflowStatusBadge status={data.run.status} />
              <span className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--sea-ink)]">
                {data.module.displayName}
              </span>
              <span className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
                {shortRunId(data.run.runId)}
              </span>
            </div>
            <h1 className="display-title mt-4 text-4xl leading-[0.98] font-bold text-[var(--sea-ink)] sm:text-6xl">
              {data.run.currentTask ?? data.run.originalTask ?? "Workflow-Run"}
            </h1>
            <p className="mt-4 max-w-3xl text-base leading-7 text-[var(--sea-ink-soft)] sm:text-lg">
              {data.progress.humanSummary}
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

      <section className="mt-8 grid gap-4 xl:grid-cols-4">
        <WorkflowMetaItem label="Run ID" value={<code>{data.run.runId}</code>} />
        <WorkflowMetaItem
          label="Modul"
          value={`${data.module.displayName} (${data.module.moduleId})`}
        />
        <WorkflowMetaItem
          label="Runden"
          value={`${data.run.currentRound}${data.run.maxRounds ? ` / ${data.run.maxRounds}` : ""}`}
        />
        <WorkflowMetaItem label="Aktualisiert" value={formatTimestamp(data.run.updatedAt)} />
      </section>

      <section className="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        <div className="space-y-6">
          <section className="rounded-[2rem] border border-[var(--line)] bg-[var(--surface-strong)] px-6 py-6 shadow-[0_18px_40px_rgba(20,56,61,0.07)]">
            <div className="mb-4 flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
              <Clock3 className="h-4 w-4" />
              Ueberblick
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <WorkflowMetaItem label="Created" value={formatTimestamp(data.run.createdAt)} />
              <WorkflowMetaItem label="Updated" value={formatTimestamp(data.run.updatedAt)} />
              <WorkflowMetaItem label="Status Phase" value={data.progress.statusPhase ?? "—"} />
              <WorkflowMetaItem label="Terminal Reason" value={data.run.terminalReason ?? "—"} />
              <WorkflowMetaItem label="Aktive Rolle" value={data.progress.activeRole ?? "—"} />
              <WorkflowMetaItem
                label="Letzte Rolle"
                value={data.progress.lastCompletedRole ?? "—"}
              />
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <WorkflowMetaItem
                label="Origin"
                value={
                  data.run.origin ? (
                    <div className="space-y-1">
                      <div>
                        {data.run.origin.channel ?? "—"} → {data.run.origin.to ?? "—"}
                      </div>
                      <div className="text-xs text-[var(--sea-ink-soft)]">
                        Session: {data.run.origin.ownerSessionKey}
                      </div>
                    </div>
                  ) : (
                    "—"
                  )
                }
              />
              <WorkflowMetaItem
                label="Sessions"
                value={
                  <div className="space-y-1">
                    <div>orchestrator: {data.run.sessions.orchestrator ?? "—"}</div>
                    <div>worker: {data.run.sessions.worker ?? "—"}</div>
                    <div>critic: {data.run.sessions.critic ?? "—"}</div>
                  </div>
                }
              />
            </div>
          </section>

          <section className="rounded-[2rem] border border-[var(--line)] bg-[var(--surface-strong)] px-6 py-6 shadow-[0_18px_40px_rgba(20,56,61,0.07)]">
            <div className="mb-4 flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
              <Waypoints className="h-4 w-4" />
              Progress und Trace-Summary
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <WorkflowMetaItem label="Events" value={data.progress.eventCount} />
              <WorkflowMetaItem label="Artefakte" value={data.progress.artifactCount} />
              <WorkflowMetaItem
                label="Dauer"
                value={formatDurationMs(data.traceSummary.durationMs)}
              />
              <WorkflowMetaItem label="Letztes Event" value={data.progress.lastEventKind ?? "—"} />
              <WorkflowMetaItem
                label="Letzte Event-Zeit"
                value={formatTimestamp(data.progress.lastEventAt)}
              />
              <WorkflowMetaItem label="Trace-Level" value={data.traceSummary.traceLevel} />
            </div>

            <div className="mt-4 rounded-[1.5rem] border border-[var(--line)] bg-[var(--surface)] px-4 py-4 text-sm leading-7 text-[var(--sea-ink)]">
              <div>
                <span className="font-semibold text-[var(--sea-ink-soft)]">Summary-Quelle:</span>{" "}
                {data.traceSummary.summaryAvailable
                  ? "trace.summary.json"
                  : "aus Run-Record abgeleitet"}
              </div>
              <div>
                <span className="font-semibold text-[var(--sea-ink-soft)]">Rollen:</span>{" "}
                {data.traceSummary.rolesSeen.length ? data.traceSummary.rolesSeen.join(", ") : "—"}
              </div>
              {data.traceSummary.hasMeaningfulError && data.traceSummary.errorSummary ? (
                <div className="mt-3 rounded-[1.1rem] border border-[rgba(180,67,45,0.16)] bg-[rgba(180,67,45,0.06)] px-3 py-2 text-[var(--danger)]">
                  {data.traceSummary.errorSummary}
                </div>
              ) : data.traceSummary.errorSummary ? (
                <div className="mt-3 rounded-[1.1rem] border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-2 text-[var(--sea-ink-soft)]">
                  Reporting-Hinweis: {data.traceSummary.errorSummary}
                </div>
              ) : null}
            </div>
          </section>
        </div>

        <section className="rounded-[2rem] border border-[var(--line)] bg-[var(--surface-strong)] px-6 py-6 shadow-[0_18px_40px_rgba(20,56,61,0.07)]">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
            <FileText className="h-4 w-4" />
            Artefakte
          </div>

          {data.artifacts.length === 0 ? (
            <WorkflowEmptyState
              title="Noch keine Artefakte"
              body="Fuer diesen Run wurden bisher keine Artefaktdateien gefunden."
            />
          ) : (
            <div className="space-y-4">
              <div className="grid gap-2">
                {data.artifacts.map((artifact) => (
                  <button
                    key={artifact.name}
                    type="button"
                    onClick={() => updateSearch({ artifact: artifact.name })}
                    className={`rounded-[1.4rem] border px-4 py-3 text-left transition ${
                      data.query.artifact === artifact.name
                        ? "border-[var(--lagoon-deep)] bg-[rgba(77,136,240,0.08)]"
                        : "border-[var(--line)] bg-[var(--surface)]"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-[var(--sea-ink)]">
                          {artifact.name}
                        </div>
                        <div className="text-xs text-[var(--sea-ink-soft)]">
                          {formatBytes(artifact.sizeBytes)} · {formatTimestamp(artifact.updatedAt)}
                        </div>
                      </div>
                      <div className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
                        {artifact.previewable ? "text" : "bin"}
                      </div>
                    </div>
                  </button>
                ))}
              </div>

              {data.artifactPreview ? (
                <div className="rounded-[1.6rem] border border-[var(--line)] bg-[var(--surface)] p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-[var(--sea-ink)]">
                        Preview: {data.artifactPreview.artifactName}
                      </div>
                      <div className="text-xs text-[var(--sea-ink-soft)]">
                        {data.artifactPreview.totalLines
                          ? `${data.artifactPreview.totalLines} Zeilen`
                          : "Preview ohne Zeilenzaehlung"}
                        {data.artifactPreview.truncated ? " · gekuerzt" : ""}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => updateSearch({ artifactMode: "head" })}
                        className={`rounded-full border px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] ${
                          data.query.artifactMode === "head"
                            ? "border-[var(--lagoon-deep)] bg-[rgba(77,136,240,0.08)] text-[var(--lagoon-deep)]"
                            : "border-[var(--line)] bg-[var(--surface-strong)] text-[var(--sea-ink-soft)]"
                        }`}
                      >
                        Head
                      </button>
                      <button
                        type="button"
                        onClick={() => updateSearch({ artifactMode: "tail" })}
                        className={`rounded-full border px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] ${
                          data.query.artifactMode === "tail"
                            ? "border-[var(--lagoon-deep)] bg-[rgba(77,136,240,0.08)] text-[var(--lagoon-deep)]"
                            : "border-[var(--line)] bg-[var(--surface-strong)] text-[var(--sea-ink-soft)]"
                        }`}
                      >
                        Tail
                      </button>
                    </div>
                  </div>

                  {data.artifactPreview.unsupportedReason ? (
                    <div className="rounded-[1.2rem] border border-[var(--line)] bg-[var(--surface-strong)] px-4 py-3 text-sm leading-7 text-[var(--sea-ink-soft)]">
                      {data.artifactPreview.unsupportedReason}
                    </div>
                  ) : (
                    <pre className="overflow-x-auto rounded-[1.2rem] border border-[var(--line)] bg-[rgba(14,18,25,0.92)] p-4 text-sm leading-6 text-[#f5f7fb]">
                      <code>{data.artifactPreview.content}</code>
                    </pre>
                  )}
                </div>
              ) : null}
            </div>
          )}
        </section>
      </section>

      <section className="mt-8 rounded-[2rem] border border-[var(--line)] bg-[var(--surface-strong)] px-6 py-6 shadow-[0_18px_40px_rgba(20,56,61,0.07)]">
        <div className="mb-5 flex items-center gap-2 text-sm font-semibold uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
          <ScrollText className="h-4 w-4" />
          Trace Timeline
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_repeat(4,minmax(0,0.7fr))]">
          <label className="space-y-2 text-sm font-medium text-[var(--sea-ink)]">
            <span>Suche</span>
            <div className="flex items-center gap-2 rounded-[1.2rem] border border-[var(--line)] bg-[var(--surface)] px-4 py-3">
              <Search className="h-4 w-4 text-[var(--sea-ink-soft)]" />
              <input
                value={search.q ?? ""}
                onChange={(event) => updateSearch({ q: event.currentTarget.value || undefined })}
                placeholder="summary, payload, artifact"
                className="w-full border-0 bg-transparent p-0 text-sm text-[var(--sea-ink)] outline-none placeholder:text-[var(--sea-ink-soft)]"
              />
            </div>
          </label>

          <label className="space-y-2 text-sm font-medium text-[var(--sea-ink)]">
            <span>Kind</span>
            <select
              value={search.kind ?? ""}
              onChange={(event) =>
                updateSearch({
                  kind: (event.currentTarget.value || undefined) as
                    | WorkflowTraceEventKind
                    | undefined,
                })
              }
              className="w-full rounded-[1.2rem] border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--sea-ink)]"
            >
              <option value="">Alle</option>
              {data.availableKinds.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-2 text-sm font-medium text-[var(--sea-ink)]">
            <span>Rolle</span>
            <select
              value={search.role ?? ""}
              onChange={(event) => updateSearch({ role: event.currentTarget.value || undefined })}
              className="w-full rounded-[1.2rem] border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--sea-ink)]"
            >
              <option value="">Alle</option>
              {data.availableRoles.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-2 text-sm font-medium text-[var(--sea-ink)]">
            <span>After Seq</span>
            <input
              value={search.afterSeq ?? ""}
              onChange={(event) =>
                updateSearch({ afterSeq: event.currentTarget.value || undefined })
              }
              placeholder="z. B. 120"
              className="w-full rounded-[1.2rem] border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--sea-ink)]"
            />
          </label>

          <label className="space-y-2 text-sm font-medium text-[var(--sea-ink)]">
            <span>Limit</span>
            <select
              value={search.eventLimit ?? String(data.query.eventLimit)}
              onChange={(event) => updateSearch({ eventLimit: event.currentTarget.value })}
              className="w-full rounded-[1.2rem] border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--sea-ink)]"
            >
              <option value="40">40</option>
              <option value="80">80</option>
              <option value="120">120</option>
              <option value="200">200</option>
            </select>
          </label>
        </div>

        <div className="mt-6 space-y-3">
          {data.events.length === 0 ? (
            <WorkflowEmptyState
              title="Keine Trace-Events fuer diese Filter"
              body="Die aktuelle Event-Filterung liefert keinen passenden Timeline-Ausschnitt."
            />
          ) : (
            data.events.map((event) => (
              <div
                key={event.eventId}
                className="rounded-[1.6rem] border border-[var(--line)] bg-[var(--surface)] px-4 py-4"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--sea-ink)]">
                        seq {event.seq}
                      </span>
                      <span className="rounded-full border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
                        {event.kind}
                      </span>
                      {event.role ? (
                        <span className="rounded-full border border-[var(--line)] bg-[var(--surface-strong)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--sea-ink-soft)]">
                          {event.role}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-3 text-sm leading-7 text-[var(--sea-ink)]">
                      {event.summary ?? "—"}
                    </div>
                    {event.payloadText ? (
                      <pre className="mt-3 overflow-x-auto rounded-[1.1rem] border border-[var(--line)] bg-[var(--surface-strong)] p-3 text-xs leading-6 text-[var(--sea-ink-soft)]">
                        <code>{event.payloadText}</code>
                      </pre>
                    ) : null}
                  </div>
                  <div className="min-w-[220px] rounded-[1.4rem] border border-[var(--line)] bg-[var(--surface-strong)] px-4 py-3 text-xs leading-6 text-[var(--sea-ink-soft)]">
                    <div>{formatTimestamp(event.ts)}</div>
                    <div>step: {event.stepId ?? "—"}</div>
                    <div>round: {event.round ?? "—"}</div>
                    <div>status: {event.status ?? "—"}</div>
                    <div>artifact: {event.artifactPath ?? "—"}</div>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </section>
    </main>
  );
}
