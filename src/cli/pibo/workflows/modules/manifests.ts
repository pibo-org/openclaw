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
  supportsAbort: true,
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
    "Runs a persistent Codex SDK worker under a controller loop that keeps going, finishes cleanly, or escalates real blockers.",
  kind: "agent_workflow",
  version: "0.5.0",
  requiredAgents: ["codex", "codex-controller"],
  terminalStates: ["done", "blocked", "aborted", "max_rounds_reached", "failed"],
  supportsAbort: true,
  inputSchemaSummary: [
    "task (string, required): original coding task passed directly to Codex; the worker only gets explicit workflow/task fields, not ambient Main/session chat, memory, or docs.",
    "workingDirectory (string, required in the low-level contract; run codex_controller defaults --cwd to pwd): requested project/worktree path. By default, git checkouts are provisioned into a workflow-owned clean linked worktree and Codex runs there; set workingDirectoryMode=existing to run directly in the provided path.",
    'workingDirectoryMode ("workflow_owned_worktree"|"existing", optional): defaults to workflow-owned linked-worktree isolation when the requested path is inside a git checkout; use `existing` only when the operator intentionally wants the worker to run in the provided directory.',
    "repoRoot (string, optional): explicit shared repo context for closeout/integration assessment when the worker is intentionally running against an existing checkout. Workflow-owned linked-worktree runs now use runtime-owned integration into a writable shared target branch before final cleanup.",
    "agentId (string, optional): selects agent-workspace bootstrap for the controller (skills/system prompt) and adds that workspace as extra readable Codex context; does not change worker cwd or import full Main/session chat, memory, or docs.",
    "maxRounds|maxRetries (number, optional): controller loop budget; operator CLI prefers --max-rounds; defaults to 10.",
    "successCriteria (string[], optional): additional completion criteria.",
    "constraints (string[], optional): extra constraints to keep in every turn.",
    `controllerPromptPath (string, optional): defaults to ${DEFAULT_CONTROLLER_PROMPT_PATH}.`,
    "workerModel (string, optional): explicit Codex model override; otherwise uses the codex-cli-wrapper default when configured.",
    "workerReasoningEffort (string, optional): explicit Codex reasoning effort override; otherwise uses the codex-cli-wrapper default when configured.",
    'workerCompactionMode ("off"|"app_server"|"acp_control_command", optional): semantic Codex thread compaction strategy; defaults to off. `acp_control_command` is kept as a legacy alias for the new app_server path.',
    `workerCompactionAfterRound (number, optional): first round that may trigger manual Codex thread compaction when workerCompactionMode is enabled; defaults to ${DEFAULT_WORKER_COMPACTION_AFTER_ROUND}.`,
  ],
  artifactContract: [
    "codex-controller-run-contract.json: persisted run-scoped controller/worker contract snapshot used as stable source of truth for long runs, retries, and re-entry under the same run id.",
    "round-<n>-codex.txt: raw Codex worker output per round.",
    "round-<n>-controller.txt: raw controller output per round, including normalized decision block.",
    "closeout-local-ready-assessment.json: workflow-owned local closeout assessment written before runtime-owned integration; existing-checkout runs still write only closeout-assessment.json.",
    "workflow-owned-integration.json: workflow-owned integration result/recovery metadata including target branch, worker head, managed branch, recovery ref, and integration worktree path.",
    "closeout-assessment.json: final machine-readable read-only closeout assessment written on the DONE path after repo-integrated verification when applicable.",
    "run-summary.txt: terminal summary with final status, reason, sessions, local closeout, integration, final closeout, and cleanup context.",
  ],
} satisfies WorkflowModuleManifest;

export const selfRalphWorkflowModuleManifest = {
  moduleId: "self_ralph",
  displayName: "Self Ralph",
  description:
    "Runs a native ideation-first self-Ralph workflow, then hands approved specs into the shared Ralph planning/execution core.",
  kind: "agent_workflow",
  version: "0.5.0",
  requiredAgents: ["codex", "codex-controller"],
  terminalStates: ["done", "planning_done", "blocked", "aborted", "max_rounds_reached", "failed"],
  supportsAbort: true,
  inputSchemaSummary: [
    "direction (string, required): broad product direction used for ideation-first planning.",
    "workingDirectory (string, required): existing writable workspace root for planning artifacts and optional later project bootstrap.",
    'executionMode ("plan_only"|"existing_repo"|"bootstrap_project", optional): defaults to bootstrap_project.',
    "repoRoot (string, optional): required only for executionMode=existing_repo.",
    "projectSlug|bootstrapTemplate (string, optional): bootstrap hints for executionMode=bootstrap_project.",
    "successCriteria (string[], optional): workflow-level acceptance criteria carried through planning and execution.",
    "constraints (string[], optional): global constraints for planning and execution.",
    "maxBrainstormingRounds|maxSpecsRounds|maxPRDRounds (number, optional): critique/revision budget per planning phase; defaults to 2 each.",
    "maxExecutionRounds|maxRounds (number, optional): Ralph execution budget; defaults to 6.",
    "maxStories (number, optional): backlog planner cap independent from the execution round budget.",
    "plannerAgentId|reviewerAgentId|workerAgentId (string, optional): defaults to codex-controller, codex-controller, codex.",
    "plannerModel|reviewerModel|workerModel (string, optional): model overrides per role.",
  ],
  artifactContract: [
    "brainstorming/specs/prd phase prompt, draft, and review artifacts per round in the workflow artifact store.",
    "brainstorming-final.md, optional brainstorming-options.json, specs-final.md, prd-final.md, story-backlog.json, execution-state.json, and run-summary.txt mirrored into <workingDirectory>/self-ralph/.",
    "executionMode=bootstrap_project additionally writes project-bootstrap.json into workflow artifacts and <workingDirectory>/self-ralph/.",
    "execution round worker/review prompts and outputs stay in workflow artifacts; execution-round-<n>-evidence.json is additionally mirrored into <workingDirectory>/self-ralph/.",
  ],
} satisfies WorkflowModuleManifest;

export const ralphFromSpecsWorkflowModuleManifest = {
  moduleId: "ralph_from_specs",
  displayName: "Ralph From Specs",
  description:
    "Starts from trusted approved specs, then runs the shared Ralph PRD/backlog/execution core without a specs review gate.",
  kind: "agent_workflow",
  version: "0.1.0",
  requiredAgents: ["codex", "codex-controller"],
  terminalStates: ["done", "planning_done", "blocked", "aborted", "max_rounds_reached", "failed"],
  supportsAbort: true,
  inputSchemaSummary: [
    "specs (string, required): trusted approved specs passed directly into the shared core.",
    "workingDirectory (string, required): existing writable workspace root for planning artifacts and optional later project bootstrap.",
    "direction|selectedConcept (string, optional): operator-facing context carried into PRD/backlog/execution summaries and prompts.",
    'executionMode ("plan_only"|"existing_repo"|"bootstrap_project", optional): defaults to bootstrap_project.',
    "repoRoot (string, optional): required only for executionMode=existing_repo.",
    "projectSlug|bootstrapTemplate (string, optional): bootstrap hints for executionMode=bootstrap_project.",
    "successCriteria (string[], optional): workflow-level acceptance criteria carried through PRD, backlog, and execution.",
    "constraints (string[], optional): global constraints for planning and execution.",
    "maxPRDRounds (number, optional): critique/revision budget for PRD generation; defaults to 2.",
    "maxExecutionRounds|maxRounds (number, optional): Ralph execution budget; defaults to 6.",
    "maxStories (number, optional): backlog planner cap independent from the execution round budget.",
    "plannerAgentId|reviewerAgentId|workerAgentId (string, optional): defaults to codex-controller, codex-controller, codex.",
    "plannerModel|reviewerModel|workerModel (string, optional): model overrides per role.",
  ],
  artifactContract: [
    "specs-final.md is persisted immediately from trusted input, then prd phase prompt/draft/review artifacts are written under the workflow artifact store.",
    "specs-final.md, prd-final.md, story-backlog.json, execution-state.json, and run-summary.txt mirrored into <workingDirectory>/ralph-from-specs/.",
    "executionMode=bootstrap_project additionally writes project-bootstrap.json into workflow artifacts and <workingDirectory>/ralph-from-specs/.",
    "execution round worker/review prompts and outputs stay in workflow artifacts; execution-round-<n>-evidence.json is additionally mirrored into <workingDirectory>/ralph-from-specs/.",
  ],
} satisfies WorkflowModuleManifest;

const workflowModuleManifestMap = new Map(
  [
    noopWorkflowModuleManifest,
    langgraphWorkerCriticModuleManifest,
    codexControllerWorkflowModuleManifest,
    ralphFromSpecsWorkflowModuleManifest,
    selfRalphWorkflowModuleManifest,
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
