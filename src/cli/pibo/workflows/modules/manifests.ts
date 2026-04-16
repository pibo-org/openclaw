import type { WorkflowModuleManifest } from "../types.js";

const DEFAULT_CONTROLLER_PROMPT_PATH =
  "/home/pibo/.openclaw/workspace/prompts/coding-controller-prompt.md";
const DEFAULT_WORKER_COMPACTION_AFTER_ROUND = 3;

export const noopWorkflowModuleManifest = {
  moduleId: "noop",
  displayName: "Noop Reference Workflow",
  description: "Minimal referenzierbares Workflow-Modul zum Testen von start/status/describe/runs.",
  kind: "maintenance_workflow",
  version: "1.1.0",
  requiredAgents: [],
  terminalStates: ["done", "aborted", "failed"],
  supportsAbort: true,
  inputSchemaSummary: [
    "beliebiges JSON-Objekt oder String",
    "wird nur als Referenzinput gespeichert",
  ],
  artifactContract: ["keine Artefakte", "latestWorkerOutput enthält nur ein Input-Echo"],
} satisfies WorkflowModuleManifest;

export const langgraphWorkerCriticModuleManifest = {
  moduleId: "langgraph_worker_critic",
  displayName: "LangGraph Worker/Critic",
  description:
    "Führt einen expliziten Worker/Critic-Loop mit `langgraph` als Worker und `critic` als Review-Agent aus.",
  kind: "agent_workflow",
  version: "2.0.0",
  requiredAgents: ["langgraph", "critic"],
  terminalStates: ["done", "blocked", "failed", "aborted", "max_rounds_reached"],
  supportsAbort: false,
  inputSchemaSummary: [
    "task: string (pflichtig)",
    "successCriteria: string[] (mindestens ein Eintrag)",
    "optional: contextNotes, deliverables, workerAgentId, criticAgentId",
    "optional: workerModel, criticModel (als provider/model)",
    "optional: criticPromptAddendum (wird additiv an den Critic-Prompt angehängt)",
  ],
  artifactContract: [
    "input.json",
    "worker/critic prompt- und output-Dateien pro Runde unter ~/.local/state/pibo-workflows/artifacts/<runId>/",
    "Workflow-Run speichert zusätzlich die Worker-/Critic-Session-Keys im Run-Record",
  ],
} satisfies WorkflowModuleManifest;

export const codexControllerWorkflowModuleManifest = {
  moduleId: "codex_controller",
  displayName: "Codex Controller",
  description:
    "Runs a persistent Codex ACP worker under a controller loop that keeps going, finishes cleanly, or escalates real blockers.",
  kind: "agent_workflow",
  version: "0.2.2",
  requiredAgents: ["codex", "codex-controller"],
  terminalStates: ["done", "blocked", "aborted", "max_rounds_reached", "failed"],
  supportsAbort: false,
  inputSchemaSummary: [
    "task (string, required): original coding task passed directly to Codex.",
    "workingDirectory (string, required): absolute project/worktree path used as the persistent Codex ACP worker cwd.",
    "repoRoot (string, optional): repo-root-first closeout path used for final read-only git/worktree/integration assessment; defaults to workingDirectory for backward compatibility.",
    "agentId (string, optional): agent workspace used for bootstrap/context/system-prompt resolution; does not change workingDirectory or worker cwd.",
    "maxRetries|maxRounds (number, optional): controller loop budget; defaults to 10.",
    "successCriteria (string[], optional): additional completion criteria.",
    "constraints (string[], optional): extra constraints to keep in every turn.",
    `controllerPromptPath (string, optional): defaults to ${DEFAULT_CONTROLLER_PROMPT_PATH}.`,
    'workerCompactionMode ("off"|"acp_control_command", optional): semantic ACP-thread compaction strategy; defaults to off. Use acp_control_command only as an explicit debugging or specialized exception path.',
    `workerCompactionAfterRound (number, optional): first round that may trigger manual ACP-thread compaction when workerCompactionMode is set to acp_control_command; defaults to ${DEFAULT_WORKER_COMPACTION_AFTER_ROUND}.`,
  ],
  artifactContract: [
    "round-<n>-codex.txt: raw Codex worker output per round.",
    "round-<n>-controller.txt: raw controller output per round, including normalized decision block.",
    "closeout-assessment.json: machine-readable read-only closeout assessment written on the DONE path.",
    "run-summary.txt: terminal summary with final status, reason, sessions, and closeout context.",
  ],
} satisfies WorkflowModuleManifest;

const workflowModuleManifestMap = new Map(
  [
    noopWorkflowModuleManifest,
    langgraphWorkerCriticModuleManifest,
    codexControllerWorkflowModuleManifest,
  ].map((manifest) => [manifest.moduleId, manifest] as const),
);

export function listWorkflowModuleManifests(): WorkflowModuleManifest[] {
  return [...workflowModuleManifestMap.values()].toSorted((left, right) =>
    left.moduleId.localeCompare(right.moduleId),
  );
}

export function getWorkflowModuleManifest(moduleId: string): WorkflowModuleManifest | undefined {
  return workflowModuleManifestMap.get(moduleId);
}
