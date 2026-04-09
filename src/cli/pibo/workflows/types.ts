export type WorkflowModuleKind = "agent_workflow" | "analysis_workflow" | "maintenance_workflow";

export type WorkflowTerminalState =
  | "done"
  | "blocked"
  | "aborted"
  | "failed"
  | "max_rounds_reached";

export type WorkflowRunStatus = "pending" | "running" | WorkflowTerminalState;

export type WorkflowRunSessions = {
  orchestrator?: string;
  worker?: string;
  critic?: string;
  extras?: Record<string, string>;
};

export interface WorkflowModuleManifest {
  moduleId: string;
  displayName: string;
  description: string;
  kind: WorkflowModuleKind;
  version: string;
  requiredAgents: string[];
  terminalStates: WorkflowTerminalState[];
  supportsAbort: boolean;
  inputSchemaSummary: string[];
  artifactContract: string[];
}

export interface WorkflowRunRecord {
  runId: string;
  moduleId: string;
  status: WorkflowRunStatus;
  terminalReason: string | null;
  currentRound: number;
  maxRounds: number | null;
  input: unknown;
  artifacts: string[];
  sessions: WorkflowRunSessions;
  latestWorkerOutput: string | null;
  latestCriticVerdict: string | null;
  originalTask: string | null;
  currentTask: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowStartRequest {
  input: unknown;
  maxRounds?: number | null;
}

export interface WorkflowModuleContext {
  runId: string;
  nowIso(): string;
  persist(record: WorkflowRunRecord): void;
}

export interface WorkflowModule {
  manifest: WorkflowModuleManifest;
  start(request: WorkflowStartRequest, ctx: WorkflowModuleContext): Promise<WorkflowRunRecord>;
}
