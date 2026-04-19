import { toBulletLines } from "./common.js";
import type { ExecutionMode, PhaseName, PlanningMetadata } from "./types.js";

export function parseBrainstormingMetadata(raw: string): PlanningMetadata {
  const normalized = raw.replace(/\r/g, "");
  const brainstormingOptions = Array.from(
    normalized.matchAll(/^###\s*Concept\s+\d+\s*:\s*(.+)$/gim),
    (match) => match[1]?.trim() ?? "",
  ).filter(Boolean);
  const selectedSection =
    normalized.match(/(?:^|\n)##\s*Selected Concept\s*\n([\s\S]*?)(?=\n##\s+|$)/i)?.[1] ?? "";
  const selectedConceptMatch =
    selectedSection.match(/(?:^|\n)-\s*Title:\s*(.+)$/im) ??
    selectedSection.match(/(?:^|\n)Title:\s*(.+)$/im);
  return {
    selectedConcept: selectedConceptMatch?.[1]?.trim() || brainstormingOptions[0] || null,
    brainstormingOptions,
  };
}

function buildPhaseInstruction(phase: PhaseName): string[] {
  if (phase === "brainstorming") {
    return [
      "Develop 3 to 5 distinct product concepts from the broad direction before narrowing.",
      "Brainstorming must stay ideation-first instead of jumping straight into implementation tasks.",
      "Return markdown with exactly these sections:",
      "# Brainstorming",
      "## Direction",
      "## Concept Options",
      "### Concept 1: <title>",
      "- Target users: ...",
      "- Core problem: ...",
      "- Core loop: ...",
      "- Differentiation: ...",
      "- MVP fit: ...",
      "Repeat for each concept.",
      "## Selected Concept",
      "- Title: ...",
      "- Why selected: ...",
      "- MVP thesis: ...",
    ];
  }
  if (phase === "specs") {
    return [
      "Turn the approved selected concept into a concrete product spec.",
      "Make the artifact implementation-ready enough for a PRD author.",
      "Cover product scope, key objects, key flows, UX assumptions, non-goals, and MVP boundary.",
      "Return markdown only.",
    ];
  }
  return [
    "Turn the approved inputs into a PRD.",
    "Cover features, acceptance criteria, system boundaries, MVP scope, and technical guardrails only when needed.",
    "Do not embed the final JSON backlog here. The backlog is generated in the next step.",
    "Return markdown only.",
  ];
}

export function buildPhasePrompt(params: {
  workflowLabel: string;
  phase: PhaseName;
  round: number;
  maxRounds: number;
  directionLabel: string;
  executionMode: ExecutionMode;
  workspaceRoot: string;
  successCriteria: string[];
  constraints: string[];
  approvedBrainstorming?: string;
  approvedSpecs?: string;
  priorArtifact?: string;
  revisionRequest: string[];
}) {
  return [
    `You are writing the ${params.phase} artifact for ${params.workflowLabel}.`,
    `Round: ${params.round}/${params.maxRounds}.`,
    `Execution mode after planning: ${params.executionMode}.`,
    `Workspace root for persisted planning artifacts: ${params.workspaceRoot}`,
    "",
    "DIRECTION:",
    params.directionLabel,
    "",
    "SUCCESS_CRITERIA:",
    toBulletLines(params.successCriteria),
    "",
    "CONSTRAINTS:",
    toBulletLines(params.constraints),
    "",
    "APPROVED_BRAINSTORMING:",
    params.approvedBrainstorming?.trim() || "none",
    "",
    "APPROVED_SPECS:",
    params.approvedSpecs?.trim() || "none",
    "",
    "PREVIOUS_ARTIFACT:",
    params.priorArtifact?.trim() || "none",
    "",
    "REVISION_REQUEST:",
    toBulletLines(params.revisionRequest),
    "",
    "CURRENT_PHASE_GOAL:",
    ...buildPhaseInstruction(params.phase),
  ].join("\n");
}

export function buildPhaseReviewPrompt(params: {
  workflowLabel: string;
  phase: PhaseName;
  round: number;
  maxRounds: number;
  directionLabel: string;
  successCriteria: string[];
  constraints: string[];
  draft: string;
}) {
  const approvalGate =
    params.phase === "brainstorming"
      ? "Approve only when the draft develops multiple serious concepts and names one selected concept worth carrying into specs."
      : params.phase === "specs"
        ? "Approve only when the spec is concrete enough to hand off into a PRD without relying on unstated assumptions."
        : "Approve only when the PRD is concrete enough to generate a small verifiable story backlog.";
  return [
    `You are reviewing the ${params.phase} artifact for ${params.workflowLabel}.`,
    `Round: ${params.round}/${params.maxRounds}.`,
    "",
    "DIRECTION:",
    params.directionLabel,
    "",
    "SUCCESS_CRITERIA:",
    toBulletLines(params.successCriteria),
    "",
    "CONSTRAINTS:",
    toBulletLines(params.constraints),
    "",
    "DRAFT:",
    params.draft,
    "",
    "Respond exactly in this format:",
    "VERDICT: APPROVE | REVISE | BLOCK",
    "REASON:",
    "- ...",
    "GAPS:",
    "- ...",
    "REVISION_REQUEST:",
    "- ...",
    "",
    approvalGate,
  ].join("\n");
}

export function buildStoryPlannerPrompt(params: {
  directionLabel: string;
  selectedConcept: string | null;
  prd: string;
  maxStories?: number;
}) {
  return [
    "Extract a small verifiable story backlog from the approved PRD.",
    params.maxStories
      ? `Return JSON only with at most ${params.maxStories} stories.`
      : "Return JSON only.",
    "",
    "DIRECTION:",
    params.directionLabel,
    "",
    "SELECTED_CONCEPT:",
    params.selectedConcept ?? "none",
    "",
    "PRD:",
    params.prd,
    "",
    "Return exactly:",
    "{",
    '  "stories": [',
    '    { "id": "story-1", "title": "...", "task": "...", "acceptanceCriteria": ["..."] }',
    "  ]",
    "}",
    "",
    "Rules:",
    "- One concrete story per backlog item.",
    "- Stories must be small and verifiable.",
    "- Preserve the intended implementation order.",
  ].join("\n");
}
