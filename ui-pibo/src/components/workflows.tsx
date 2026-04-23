import { Link } from "@tanstack/react-router";
import { AlertCircle, Activity, Clock3, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import type { WorkflowStatus } from "#/lib/workflows.shared";

type StatusTone = {
  chip: string;
  dot: string;
  label: string;
};

function getWorkflowStatusTone(status: WorkflowStatus): StatusTone {
  if (status === "running" || status === "pending") {
    return {
      chip: "border-[rgba(77,136,240,0.18)] bg-[rgba(77,136,240,0.10)] text-[var(--lagoon-deep)]",
      dot: "bg-[var(--lagoon-deep)]",
      label: status === "pending" ? "pending" : "running",
    };
  }
  if (status === "done" || status === "planning_done") {
    return {
      chip: "border-[rgba(69,138,92,0.18)] bg-[rgba(69,138,92,0.10)] text-[#2f7a45]",
      dot: "bg-[#2f7a45]",
      label: status === "planning_done" ? "planning done" : "done",
    };
  }
  if (status === "blocked" || status === "max_rounds_reached") {
    return {
      chip: "border-[rgba(224,164,88,0.22)] bg-[rgba(224,164,88,0.12)] text-[#976228]",
      dot: "bg-[#c48439]",
      label: status === "max_rounds_reached" ? "max rounds" : "blocked",
    };
  }
  return {
    chip: "border-[rgba(180,67,45,0.20)] bg-[rgba(180,67,45,0.11)] text-[var(--danger)]",
    dot: "bg-[var(--danger)]",
    label: status,
  };
}

export function WorkflowStatusBadge({ status }: { status: WorkflowStatus }) {
  const tone = getWorkflowStatusTone(status);
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] ${tone.chip}`}
    >
      <span className={`h-2 w-2 rounded-full ${tone.dot}`} />
      {tone.label}
    </span>
  );
}

export function WorkflowLiveBadge(props: { connected: boolean; lastEventAt: number | null }) {
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] ${
        props.connected
          ? "border-[rgba(69,138,92,0.18)] bg-[rgba(69,138,92,0.10)] text-[#2f7a45]"
          : "border-[rgba(180,67,45,0.18)] bg-[rgba(180,67,45,0.08)] text-[var(--danger)]"
      }`}
    >
      <Activity className="h-3.5 w-3.5" />
      {props.connected ? "live" : "offline"}
      {props.lastEventAt ? (
        <span className="normal-case tracking-normal">
          · {formatRelativeTime(props.lastEventAt)}
        </span>
      ) : null}
    </span>
  );
}

export function WorkflowMetricCard(props: {
  label: string;
  value: number;
  tone?: "default" | "danger" | "success" | "warning";
}) {
  const toneClass =
    props.tone === "danger"
      ? "text-[var(--danger)]"
      : props.tone === "success"
        ? "text-[#2f7a45]"
        : props.tone === "warning"
          ? "text-[#976228]"
          : "text-[var(--sea-ink)]";
  return (
    <div className="rounded-[1.6rem] border border-[var(--line)] bg-[var(--surface-strong)] px-4 py-4 shadow-[0_12px_30px_rgba(20,56,61,0.06)]">
      <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--sea-ink-soft)]">
        {props.label}
      </p>
      <p className={`m-0 text-3xl font-semibold ${toneClass}`}>{props.value}</p>
    </div>
  );
}

export function WorkflowMetaItem(props: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-2xl border border-[var(--line)] bg-[var(--surface)] px-4 py-3">
      <p className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--sea-ink-soft)]">
        {props.label}
      </p>
      <div className="text-sm leading-6 text-[var(--sea-ink)]">{props.value}</div>
    </div>
  );
}

export function WorkflowEmptyState(props: { title: string; body: string; action?: ReactNode }) {
  return (
    <section className="island-shell rounded-[2rem] px-6 py-10 text-center sm:px-10">
      <AlertCircle className="mx-auto mb-4 h-9 w-9 text-[var(--sea-ink-soft)]" />
      <h2 className="mb-2 text-2xl font-semibold text-[var(--sea-ink)]">{props.title}</h2>
      <p className="mx-auto max-w-2xl text-sm leading-7 text-[var(--sea-ink-soft)]">{props.body}</p>
      {props.action ? <div className="mt-5">{props.action}</div> : null}
    </section>
  );
}

export function WorkflowRouteErrorPanel(props: {
  title: string;
  body: string;
  unauthorized?: boolean;
}) {
  return (
    <main className="page-wrap px-4 pb-16 pt-12 sm:pt-14">
      <section className="island-shell overflow-hidden rounded-[2rem] px-6 py-10 sm:px-10">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-3xl">
            <p className="island-kicker mb-3">{props.unauthorized ? "Zugriff" : "Fehler"}</p>
            <h1 className="display-title mb-4 text-4xl leading-[1.02] font-bold text-[var(--sea-ink)] sm:text-5xl">
              {props.title}
            </h1>
            <p className="text-base leading-7 text-[var(--sea-ink-soft)]">{props.body}</p>
          </div>
          <div className="rounded-[1.6rem] border border-[var(--line)] bg-[var(--surface-strong)] p-5 text-sm text-[var(--sea-ink-soft)]">
            {props.unauthorized ? (
              <div className="space-y-3">
                <div className="inline-flex items-center gap-2 rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--sea-ink)]">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Login erforderlich
                </div>
                <p className="m-0 max-w-sm leading-6">
                  Die Workflow-Ansichten nutzen denselben Web-Login wie der Editor.
                </p>
                <Link
                  to="/editor"
                  className="inline-flex items-center gap-2 rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-4 py-2 text-sm font-semibold text-[var(--sea-ink)] no-underline"
                >
                  Zum Editor-Login
                </Link>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Clock3 className="h-4 w-4" />
                Bitte Meldung pruefen und Route neu laden.
              </div>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}

export function formatTimestamp(value: string | null | undefined) {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function formatRelativeTime(value: number | string | null | undefined) {
  if (!value) {
    return "—";
  }
  const timestamp = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return typeof value === "string" ? value : "—";
  }
  const diffMs = timestamp - Date.now();
  const diffMinutes = Math.round(diffMs / 60_000);
  const formatter = new Intl.RelativeTimeFormat("de-DE", { numeric: "auto" });
  if (Math.abs(diffMinutes) < 60) {
    return formatter.format(diffMinutes, "minute");
  }
  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 48) {
    return formatter.format(diffHours, "hour");
  }
  const diffDays = Math.round(diffHours / 24);
  return formatter.format(diffDays, "day");
}

export function formatDurationMs(value: number | null | undefined) {
  if (!value || value < 1000) {
    return value === 0 ? "0s" : "—";
  }
  const seconds = Math.floor(value / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}

export function formatBytes(sizeBytes: number) {
  if (sizeBytes < 1024) {
    return `${sizeBytes} B`;
  }
  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function shortRunId(runId: string) {
  return runId.length > 12 ? `${runId.slice(0, 8)}…${runId.slice(-4)}` : runId;
}
