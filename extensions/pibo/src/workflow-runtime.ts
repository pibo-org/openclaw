import { readFileSync } from "node:fs";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

type WorkflowManifest = Awaited<
  ReturnType<OpenClawPluginApi["runtime"]["piboWorkflows"]["list"]>
>[number];
type WorkflowRunRecord = Awaited<
  ReturnType<OpenClawPluginApi["runtime"]["piboWorkflows"]["status"]>
>;

type WorkflowCommandResult = {
  data: unknown;
  text: string;
};

function hasFlag(args: string[], flag: string) {
  return args.includes(flag);
}

function readOptionValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function readJsonArg(raw?: string): unknown {
  if (!raw) {
    return {};
  }
  if (raw.startsWith("@")) {
    return JSON.parse(readFileSync(raw.slice(1), "utf8"));
  }
  return JSON.parse(raw);
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
    case "start": {
      const moduleId = args[1]?.trim();
      if (!moduleId) {
        throw new Error("Workflow moduleId required");
      }
      const input = readJsonArg(readOptionValue(args, "--json"));
      const rawMaxRounds = readOptionValue(args, "--max-rounds");
      const parsedMaxRounds = rawMaxRounds === undefined ? undefined : Number(rawMaxRounds);
      const maxRounds =
        parsedMaxRounds !== undefined && Number.isFinite(parsedMaxRounds) && parsedMaxRounds > 0
          ? parsedMaxRounds
          : undefined;
      const result = await api.runtime.piboWorkflows.start(moduleId, {
        input,
        maxRounds,
      });
      return {
        data: result,
        text: [
          `Run gestartet: ${result.runId}`,
          `Module: ${result.moduleId}`,
          `Status: ${result.status}`,
          ...(result.terminalReason ? [`Reason: ${result.terminalReason}`] : []),
        ].join("\n"),
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
    default:
      throw new Error(`Unknown workflow command: ${command}`);
  }
}

export async function runPiboWorkflows(api: OpenClawPluginApi, args: string[]): Promise<string> {
  const result = await executeWorkflowCommand(api, args);
  if (hasFlag(args, "--json") && args[0] !== "start") {
    return JSON.stringify(result.data, null, 2);
  }
  if (hasFlag(args, "--output-json")) {
    return JSON.stringify(result.data, null, 2);
  }
  return result.text;
}

export async function runPiboWorkflowsJson(
  api: OpenClawPluginApi,
  args: string[],
): Promise<unknown> {
  const result = await executeWorkflowCommand(api, args);
  return result.data;
}
