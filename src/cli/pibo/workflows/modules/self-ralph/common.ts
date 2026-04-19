import {
  DEFAULT_EXECUTION_MODE,
  type ExecutionMode,
  type ExecutionReviewDecision,
  type PhaseReviewVerdict,
  type RalphWorkflowModuleId,
  type StoryState,
} from "./types.js";

function moduleErrorPrefix(moduleId: RalphWorkflowModuleId): string {
  return moduleId;
}

export function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

export function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

export function normalizeOptionalPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.floor(value));
}

export function normalizeExecutionMode(
  moduleId: RalphWorkflowModuleId,
  value: unknown,
): ExecutionMode {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_EXECUTION_MODE;
  }
  if (value === "plan_only" || value === "existing_repo" || value === "bootstrap_project") {
    return value;
  }
  throw new Error(
    `${moduleErrorPrefix(moduleId)} benötigt für \`input.executionMode\` einen der Werte \`plan_only\`, \`existing_repo\` oder \`bootstrap_project\`.`,
  );
}

export function toBulletLines(values: string[]): string {
  return values.length ? values.map((value) => `- ${value}`).join("\n") : "- none";
}

export function parseSection(raw: string, section: string): string[] {
  const normalized = raw.replace(/\r/g, "");
  const pattern = new RegExp(
    `(?:^|\\n)${section}:\\s*\\n([\\s\\S]*?)(?=\\n[A-Z_]+:\\s*(?:\\n|$)|$)`,
  );
  const match = normalized.match(pattern);
  if (!match) {
    return [];
  }
  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*+]\s*/, "").trim())
    .filter((line) => line && line.toLowerCase() !== "none");
}

export function parsePhaseReviewVerdict(
  moduleId: RalphWorkflowModuleId,
  raw: string,
): PhaseReviewVerdict {
  const match = raw.match(/VERDICT:\s*(APPROVE|REVISE|BLOCK)/);
  if (!match) {
    throw new Error(
      `${moduleErrorPrefix(moduleId)} phase review unparsbar. Erwartet wurde 'VERDICT: APPROVE|REVISE|BLOCK'.\n\n${raw}`,
    );
  }
  return {
    verdict: match[1] as PhaseReviewVerdict["verdict"],
    reason: parseSection(raw, "REASON"),
    gaps: parseSection(raw, "GAPS"),
    revisionRequest: parseSection(raw, "REVISION_REQUEST"),
    raw,
  };
}

export function parseExecutionDecision(
  moduleId: RalphWorkflowModuleId,
  raw: string,
): ExecutionReviewDecision {
  const match = raw.match(/DECISION:\s*(DONE|CONTINUE|BLOCKED)/);
  if (!match) {
    throw new Error(
      `${moduleErrorPrefix(moduleId)} execution review unparsbar. Erwartet wurde 'DECISION: DONE|CONTINUE|BLOCKED'.\n\n${raw}`,
    );
  }
  return {
    decision: match[1] as ExecutionReviewDecision["decision"],
    reason: parseSection(raw, "REASON"),
    learnings: parseSection(raw, "LEARNINGS"),
    nextTask: parseSection(raw, "NEXT_TASK"),
    raw,
  };
}

export function extractJsonBlock(moduleId: RalphWorkflowModuleId, raw: string): string {
  const fenced = raw.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const trimmed = raw.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  throw new Error(`${moduleErrorPrefix(moduleId)} story backlog unparsbar. JSON fehlt.\n\n${raw}`);
}

export function parseStoryBacklog(moduleId: RalphWorkflowModuleId, raw: string): StoryState[] {
  const payload = JSON.parse(extractJsonBlock(moduleId, raw)) as { stories?: unknown };
  if (!Array.isArray(payload.stories) || payload.stories.length === 0) {
    throw new Error(`${moduleErrorPrefix(moduleId)} story backlog benötigt mindestens eine Story.`);
  }
  return payload.stories.map((entry, index) => {
    const record = entry as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    const task = typeof record.task === "string" ? record.task.trim() : "";
    const idSource = typeof record.id === "string" ? record.id.trim() : `story-${index + 1}`;
    const id = idSource || `story-${index + 1}`;
    if (!title || !task) {
      throw new Error(
        `${moduleErrorPrefix(moduleId)} story backlog enthält eine unvollständige Story an Index ${index}.`,
      );
    }
    return {
      id,
      title,
      task,
      acceptanceCriteria: normalizeStringArray(record.acceptanceCriteria),
      status: "open",
      currentTask: task,
      learnings: [],
      attempts: 0,
      lastDecision: null,
      decisionReason: [],
      lastRound: null,
    };
  });
}

export function slugify(input: string): string {
  const normalized = input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "self-ralph-project";
}

export function workspaceArtifactDirectoryName(moduleId: RalphWorkflowModuleId): string {
  return moduleId.replace(/_/g, "-");
}
