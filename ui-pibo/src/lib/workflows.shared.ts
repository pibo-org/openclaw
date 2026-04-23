export const WORKFLOW_TRACE_EVENT_KINDS = [
  "run_started",
  "run_status_changed",
  "round_started",
  "role_turn_started",
  "role_turn_completed",
  "artifact_written",
  "report_delivery_attempted",
  "report_delivered",
  "report_failed",
  "run_completed",
  "run_aborted",
  "run_blocked",
  "run_failed",
  "warning",
  "custom",
] as const;

export const WORKFLOW_STATUSES = [
  "pending",
  "running",
  "done",
  "planning_done",
  "blocked",
  "aborted",
  "failed",
  "max_rounds_reached",
] as const;

export const WORKFLOW_TIME_WINDOWS = ["24h", "7d", "30d", "90d", "all"] as const;
export const ARTIFACT_PREVIEW_MODES = ["head", "tail"] as const;

export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];
export type WorkflowTraceEventKind = (typeof WORKFLOW_TRACE_EVENT_KINDS)[number];
export type WorkflowTimeWindow = (typeof WORKFLOW_TIME_WINDOWS)[number];
export type ArtifactPreviewMode = (typeof ARTIFACT_PREVIEW_MODES)[number];

export type WorkflowModuleOption = {
  moduleId: string;
  displayName: string;
};

export type WorkflowDashboardQuery = {
  q: string;
  status: WorkflowStatus | "all";
  moduleId: string;
  role: string;
  window: WorkflowTimeWindow;
  activeOnly: boolean;
  limit: number;
};

export type WorkflowDashboardStats = {
  total: number;
  active: number;
  blocked: number;
  failed: number;
  done: number;
  aborted: number;
  maxRoundsReached: number;
  abortRequested: number;
};

export type WorkflowDashboardRunRow = {
  runId: string;
  moduleId: string;
  moduleDisplayName: string;
  status: WorkflowStatus;
  terminalReason: string | null;
  abortRequested: boolean;
  currentRound: number;
  maxRounds: number | null;
  createdAt: string;
  updatedAt: string;
  originalTask: string | null;
  currentTask: string | null;
  latestWorkerOutput: string | null;
  latestCriticVerdict: string | null;
  taskSnippet: string;
  sessions: {
    orchestrator?: string;
    worker?: string;
    critic?: string;
    extras?: Record<string, string>;
  };
  trace: {
    summaryAvailable: boolean;
    traceLevel: number;
    eventCount: number;
    artifactCount: number;
    rolesSeen: string[];
    lastEventKind: string | null;
    lastEventAt: string | null;
    errorSummary: string | null;
    hasMeaningfulError: boolean;
  };
};

export type WorkflowDashboardPage = {
  generatedAt: string;
  query: WorkflowDashboardQuery;
  stats: WorkflowDashboardStats;
  modules: WorkflowModuleOption[];
  roles: string[];
  runs: WorkflowDashboardRunRow[];
};

export type WorkflowTraceEventView = {
  eventId: string;
  ts: string;
  seq: number;
  kind: WorkflowTraceEventKind;
  stepId: string | null;
  round: number | null;
  role: string | null;
  sessionKey: string | null;
  agentId: string | null;
  artifactPath: string | null;
  status: string | null;
  summary: string | null;
  payloadText: string | null;
};

export type WorkflowArtifactView = {
  name: string;
  path: string;
  sizeBytes: number;
  updatedAt: string;
  previewable: boolean;
};

export type WorkflowArtifactPreview = {
  artifactName: string;
  mode: ArtifactPreviewMode;
  totalLines: number | null;
  truncated: boolean;
  content: string;
  unsupportedReason: string | null;
};

export type WorkflowDetailQuery = {
  kind: WorkflowTraceEventKind | "";
  role: string;
  q: string;
  afterSeq: number | null;
  eventLimit: number;
  artifact: string;
  artifactMode: ArtifactPreviewMode;
  artifactLines: number;
};

export type WorkflowRunDetailPage = {
  generatedAt: string;
  query: WorkflowDetailQuery;
  module: {
    moduleId: string;
    displayName: string;
    description: string;
    version: string;
    kind: string;
  };
  run: {
    runId: string;
    moduleId: string;
    status: WorkflowStatus;
    terminalReason: string | null;
    abortRequested: boolean;
    abortRequestedAt: string | null;
    currentRound: number;
    maxRounds: number | null;
    createdAt: string;
    updatedAt: string;
    originalTask: string | null;
    currentTask: string | null;
    latestWorkerOutput: string | null;
    latestCriticVerdict: string | null;
    sessions: {
      orchestrator?: string;
      worker?: string;
      critic?: string;
      extras?: Record<string, string>;
    };
    origin?: {
      ownerSessionKey: string;
      channel?: string;
      accountId?: string;
      to?: string;
      threadId?: string;
    };
    reporting?: {
      deliveryMode?: "topic_origin";
      senderPolicy?: "emitting_agent";
      headerMode?: "runtime_header";
      events?: Array<"started" | "milestone" | "blocked" | "completed">;
    };
  };
  progress: {
    statusPhase: string | null;
    humanSummary: string;
    isTerminal: boolean;
    currentStepId: string | null;
    activeRole: string | null;
    lastCompletedRole: string | null;
    lastArtifactName: string | null;
    lastEventSeq: number | null;
    lastEventKind: string | null;
    lastEventAt: string | null;
    lastEventSummary: string | null;
    eventCount: number;
    artifactCount: number;
  };
  traceSummary: {
    summaryAvailable: boolean;
    traceLevel: number;
    status: string | null;
    startedAt: string | null;
    endedAt: string | null;
    durationMs: number | null;
    eventCount: number;
    stepCount: number;
    roundCount: number;
    rolesSeen: string[];
    artifactCount: number;
    lastEventKind: string | null;
    errorSummary: string | null;
    hasMeaningfulError: boolean;
  };
  availableRoles: string[];
  availableKinds: WorkflowTraceEventKind[];
  events: WorkflowTraceEventView[];
  artifacts: WorkflowArtifactView[];
  artifactPreview: WorkflowArtifactPreview | null;
};

export type WorkflowStreamEvent = {
  runId: string;
  relativePath: string;
  scope: "run" | "trace" | "artifact";
  eventType: "create" | "update" | "delete";
  mtimeMs: number;
};
