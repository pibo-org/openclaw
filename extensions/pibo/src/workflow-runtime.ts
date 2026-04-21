import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

type WorkflowManifest = Awaited<
  ReturnType<OpenClawPluginApi["runtime"]["piboWorkflows"]["list"]>
>[number];
type WorkflowRunRecord = Awaited<
  ReturnType<OpenClawPluginApi["runtime"]["piboWorkflows"]["status"]>
>;
type WorkflowProgressSnapshot = Awaited<
  ReturnType<OpenClawPluginApi["runtime"]["piboWorkflows"]["progress"]>
>;
type WorkflowWaitResult = Awaited<
  ReturnType<OpenClawPluginApi["runtime"]["piboWorkflows"]["wait"]>
>;
type WorkflowTraceSummary = Awaited<
  ReturnType<OpenClawPluginApi["runtime"]["piboWorkflows"]["traceSummary"]>
>;
type WorkflowTraceEvent = Awaited<
  ReturnType<OpenClawPluginApi["runtime"]["piboWorkflows"]["traceEvents"]>
>[number];
type WorkflowArtifactInfo = Awaited<
  ReturnType<OpenClawPluginApi["runtime"]["piboWorkflows"]["artifacts"]>
>[number];
type WorkflowArtifactContent = Awaited<
  ReturnType<OpenClawPluginApi["runtime"]["piboWorkflows"]["readArtifact"]>
>;

type WorkflowCommandResult = {
  data: unknown;
  text: string;
};

function hasFlag(args: string[], flag: string) {
  return args.includes(flag);
}

function wantsJsonOutput(args: string[]) {
  return hasFlag(args, "--output-json") || hasFlag(args, "--json");
}

function readOptionValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function terminalStatesText(states: WorkflowManifest["terminalStates"]) {
  return states.join(", ");
}

function formatModuleSummary(modules: WorkflowManifest[]) {
  if (modules.length === 0) {
    return "Keine Workflow-Module registriert.";
  }
  return modules.map((module) => `- ${module.moduleId}: ${module.description}`).join("\n");
}

function formatManifestText(manifest: WorkflowManifest) {
  return [
    `Module: ${manifest.moduleId}`,
    `Name: ${manifest.displayName}`,
    `Beschreibung: ${manifest.description}`,
    `Kind: ${manifest.kind}`,
    `Version: ${manifest.version}`,
    `Required agents: ${
      manifest.requiredAgents.length ? manifest.requiredAgents.join(", ") : "none"
    }`,
    `Supports abort: ${manifest.supportsAbort ? "yes" : "no"}`,
    `Terminal states: ${terminalStatesText(manifest.terminalStates)}`,
    "Input schema summary:",
    ...manifest.inputSchemaSummary.map((line) => `- ${line}`),
    "Artifact contract:",
    ...manifest.artifactContract.map((line) => `- ${line}`),
  ].join("\n");
}

function formatStatusText(record: WorkflowRunRecord) {
  const sessionLines = Object.entries(record.sessions)
    .filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0,
    )
    .map(([key, value]) => `- ${key}: ${value}`);
  return [
    `Run: ${record.runId}`,
    `Module: ${record.moduleId}`,
    `Status: ${record.status}`,
    `Created: ${record.createdAt}`,
    `Updated: ${record.updatedAt}`,
    `Current round: ${record.currentRound}`,
    `Max rounds: ${record.maxRounds ?? "n/a"}`,
    `Terminal reason: ${record.terminalReason ?? "n/a"}`,
    `Artifacts: ${record.artifacts.length}`,
    ...(record.originalTask ? [`Original task: ${record.originalTask}`] : []),
    ...(record.currentTask ? [`Current task: ${record.currentTask}`] : []),
    ...(sessionLines.length > 0 ? ["Sessions:", ...sessionLines] : ["Sessions: none"]),
  ].join("\n");
}

function formatProgressText(progress: WorkflowProgressSnapshot) {
  return [
    `Run: ${progress.runId}`,
    `Module: ${progress.moduleId}`,
    `Status: ${progress.status}`,
    `Terminal: ${progress.isTerminal ? "yes" : "no"}`,
    `Current round: ${progress.currentRound}`,
    `Max rounds: ${progress.maxRounds ?? "n/a"}`,
    `Trace level: ${progress.traceLevel}`,
    `Events: ${progress.eventCount}`,
    `Artifacts: ${progress.artifactCount}`,
    `Active role: ${progress.activeRole ?? "none"}`,
    `Last completed role: ${progress.lastCompletedRole ?? "n/a"}`,
    `Last artifact: ${progress.lastArtifactName ?? "n/a"}`,
    `Last event: ${progress.lastEventKind ?? "n/a"}`,
    `Last event at: ${progress.lastEventAt ?? "n/a"}`,
    ...(progress.lastEventSummary ? [`Last event summary: ${progress.lastEventSummary}`] : []),
    ...(progress.terminalReason ? [`Terminal reason: ${progress.terminalReason}`] : []),
    `Summary: ${progress.humanSummary}`,
  ].join("\n");
}

function formatTraceSummaryText(summary: WorkflowTraceSummary) {
  return [
    `Run: ${summary.runId}`,
    `Module: ${summary.moduleId}`,
    `Trace level: ${summary.traceLevel}`,
    `Status: ${summary.status ?? "n/a"}`,
    `Events: ${summary.eventCount}`,
    `Steps: ${summary.stepCount}`,
    `Rounds: ${summary.roundCount}`,
    `Artifacts: ${summary.artifactCount}`,
    `Roles: ${summary.rolesSeen.length ? summary.rolesSeen.join(", ") : "none"}`,
    `Started: ${summary.startedAt ?? "n/a"}`,
    `Ended: ${summary.endedAt ?? "n/a"}`,
    `Last event: ${summary.lastEventKind ?? "n/a"}`,
    ...(summary.errorSummary ? [`Error summary: ${summary.errorSummary}`] : []),
  ].join("\n");
}

function formatTraceEventsText(events: WorkflowTraceEvent[]) {
  if (events.length === 0) {
    return "Keine Trace-Events fuer diesen Run vorhanden.";
  }
  return events
    .flatMap((event) => {
      const lines = [
        [
          `#${event.seq}`,
          event.ts,
          event.kind,
          ...(event.stepId ? [`step=${event.stepId}`] : []),
          ...(typeof event.round === "number" ? [`round=${event.round}`] : []),
          ...(event.role ? [`role=${event.role}`] : []),
          ...(event.status ? [`status=${event.status}`] : []),
        ].join("  "),
      ];
      if (event.summary) {
        lines.push(`  ${event.summary}`);
      }
      if (event.artifactPath) {
        lines.push(`  artifact: ${event.artifactPath}`);
      }
      return lines;
    })
    .join("\n");
}

function formatArtifactsText(artifacts: WorkflowArtifactInfo[]) {
  if (artifacts.length === 0) {
    return "Keine Artefakte fuer diesen Run vorhanden.";
  }
  return artifacts
    .map(
      (artifact) =>
        `- ${artifact.name}  ${artifact.sizeBytes} bytes  ${artifact.updatedAt}  ${artifact.path}`,
    )
    .join("\n");
}

function formatArtifactContentText(artifact: WorkflowArtifactContent) {
  return [
    `Artifact: ${artifact.name}`,
    `Path: ${artifact.path}`,
    `Size: ${artifact.sizeBytes} bytes`,
    `Updated: ${artifact.updatedAt}`,
    `Mode: ${artifact.mode}`,
    `Lines: ${artifact.totalLines}`,
    `Truncated: ${artifact.truncated ? "yes" : "no"}`,
    artifact.content.trim() ? "" : undefined,
    artifact.content.trim() ? artifact.content : undefined,
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n");
}

async function executeWorkflowCommand(
  api: OpenClawPluginApi,
  args: string[],
): Promise<WorkflowCommandResult> {
  const command = args[0];
  if (!command) {
    throw new Error("Workflow command required");
  }

  switch (command) {
    case "list": {
      const modules = await api.runtime.piboWorkflows.list();
      return {
        data: { modules },
        text: formatModuleSummary(modules),
      };
    }
    case "describe": {
      const moduleId = args[1]?.trim();
      if (!moduleId) {
        throw new Error("Workflow moduleId required");
      }
      const manifest = await api.runtime.piboWorkflows.describe(moduleId);
      return {
        data: manifest,
        text: formatManifestText(manifest),
      };
    }
    case "wait": {
      const runId = args[1]?.trim();
      if (!runId) {
        throw new Error("Workflow runId required");
      }
      const rawTimeout = readOptionValue(args, "--timeout-ms");
      const parsedTimeout = rawTimeout === undefined ? undefined : Number(rawTimeout);
      const result = await api.runtime.piboWorkflows.wait(
        runId,
        Number.isFinite(parsedTimeout) && parsedTimeout && parsedTimeout > 0
          ? parsedTimeout
          : undefined,
      );
      return {
        data: result,
        text: formatWaitText(result),
      };
    }
    case "status": {
      const runId = args[1]?.trim();
      if (!runId) {
        throw new Error("Workflow runId required");
      }
      const result = await api.runtime.piboWorkflows.status(runId);
      return {
        data: result,
        text: formatStatusText(result),
      };
    }
    case "progress": {
      const runId = args[1]?.trim();
      if (!runId) {
        throw new Error("Workflow runId required");
      }
      const result = await api.runtime.piboWorkflows.progress(runId);
      return {
        data: result,
        text: formatProgressText(result),
      };
    }
    case "abort": {
      const runId = args[1]?.trim();
      if (!runId) {
        throw new Error("Workflow runId required");
      }
      const result = await api.runtime.piboWorkflows.abort(runId);
      return {
        data: result,
        text:
          result.status === "aborted"
            ? [`Run abgebrochen: ${result.runId}`, `Status: ${result.status}`].join("\n")
            : `Run bereits terminal: ${result.runId} (${result.status})`,
      };
    }
    case "runs": {
      const rawLimit = readOptionValue(args, "--limit");
      const parsedLimit = rawLimit === undefined ? undefined : Number(rawLimit);
      const runs = await api.runtime.piboWorkflows.runs(
        Number.isFinite(parsedLimit) && parsedLimit && parsedLimit > 0 ? parsedLimit : undefined,
      );
      return {
        data: { runs },
        text:
          runs.length > 0
            ? runs
                .map((run) => `- ${run.runId} ${run.moduleId} ${run.status} ${run.updatedAt}`)
                .join("\n")
            : "Keine Workflow-Runs gefunden.",
      };
    }
    case "trace-summary":
    case "trace": {
      const subcommand = command === "trace" ? args[1]?.trim() : "summary";
      const runId = command === "trace" ? args[2]?.trim() : args[1]?.trim();
      if (!subcommand || !runId) {
        throw new Error("Workflow trace subcommand and runId required");
      }
      if (subcommand === "summary") {
        const result = await api.runtime.piboWorkflows.traceSummary(runId);
        return {
          data: result,
          text: formatTraceSummaryText(result),
        };
      }
      if (subcommand === "events") {
        const rawLimit = readOptionValue(args, "--limit");
        const parsedLimit = rawLimit === undefined ? undefined : Number(rawLimit);
        const rawSinceSeq = readOptionValue(args, "--since-seq");
        const parsedSinceSeq = rawSinceSeq === undefined ? undefined : Number(rawSinceSeq);
        const result = await api.runtime.piboWorkflows.traceEvents(runId, {
          limit:
            parsedLimit !== undefined && Number.isFinite(parsedLimit) && parsedLimit > 0
              ? Math.floor(parsedLimit)
              : undefined,
          sinceSeq:
            parsedSinceSeq !== undefined && Number.isFinite(parsedSinceSeq) && parsedSinceSeq >= 0
              ? Math.floor(parsedSinceSeq)
              : undefined,
          role: readOptionValue(args, "--role"),
          kind: readOptionValue(args, "--kind") as WorkflowTraceEvent["kind"] | undefined,
        });
        return {
          data: { events: result },
          text: formatTraceEventsText(result),
        };
      }
      throw new Error(`Unknown workflow trace command: ${subcommand}`);
    }
    case "trace-events": {
      const runId = args[1]?.trim();
      if (!runId) {
        throw new Error("Workflow runId required");
      }
      const rawLimit = readOptionValue(args, "--limit");
      const parsedLimit = rawLimit === undefined ? undefined : Number(rawLimit);
      const rawSinceSeq = readOptionValue(args, "--since-seq");
      const parsedSinceSeq = rawSinceSeq === undefined ? undefined : Number(rawSinceSeq);
      const result = await api.runtime.piboWorkflows.traceEvents(runId, {
        limit:
          parsedLimit !== undefined && Number.isFinite(parsedLimit) && parsedLimit > 0
            ? Math.floor(parsedLimit)
            : undefined,
        sinceSeq:
          parsedSinceSeq !== undefined && Number.isFinite(parsedSinceSeq) && parsedSinceSeq >= 0
            ? Math.floor(parsedSinceSeq)
            : undefined,
        role: readOptionValue(args, "--role"),
        kind: readOptionValue(args, "--kind") as WorkflowTraceEvent["kind"] | undefined,
      });
      return {
        data: { events: result },
        text: formatTraceEventsText(result),
      };
    }
    case "artifacts": {
      const runId = args[1]?.trim();
      if (!runId) {
        throw new Error("Workflow runId required");
      }
      const result = await api.runtime.piboWorkflows.artifacts(runId);
      return {
        data: { artifacts: result },
        text: formatArtifactsText(result),
      };
    }
    case "artifact": {
      const runId = args[1]?.trim();
      const name = args[2]?.trim();
      if (!runId || !name) {
        throw new Error("Workflow runId and artifact name required");
      }
      const rawHead = readOptionValue(args, "--head-lines");
      const parsedHead = rawHead === undefined ? undefined : Number(rawHead);
      const rawTail = readOptionValue(args, "--tail-lines");
      const parsedTail = rawTail === undefined ? undefined : Number(rawTail);
      const result = await api.runtime.piboWorkflows.readArtifact(runId, name, {
        headLines:
          parsedHead !== undefined && Number.isFinite(parsedHead) && parsedHead > 0
            ? Math.floor(parsedHead)
            : undefined,
        tailLines:
          parsedTail !== undefined && Number.isFinite(parsedTail) && parsedTail > 0
            ? Math.floor(parsedTail)
            : undefined,
      });
      return {
        data: result,
        text: formatArtifactContentText(result),
      };
    }
    default:
      throw new Error(`Unknown workflow command: ${command}`);
  }
}

function formatWaitText(result: WorkflowWaitResult) {
  if (result.status === "ok" && result.run) {
    return formatStatusText(result.run);
  }
  if (result.status === "timeout") {
    return "Workflow wait timed out.";
  }
  return `Workflow wait failed: ${result.error ?? "unknown error"}`;
}

export async function runPiboWorkflows(api: OpenClawPluginApi, args: string[]): Promise<string> {
  const result = await executeWorkflowCommand(api, args);
  if (wantsJsonOutput(args)) {
    return JSON.stringify(result.data, null, 2);
  }
  return result.text;
}
