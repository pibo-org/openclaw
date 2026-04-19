# `ralph_from_specs` workflow module

Stand: 2026-04-19
Module ID: `ralph_from_specs`

`ralph_from_specs` is the specs-first sibling of `self_ralph`.
It starts from trusted approved specs and enters the same shared internal core that `self_ralph` uses after its own specs phase:

1. trusted specs intake
2. PRD
3. story backlog
4. optional Ralph-style story execution with a fresh worker per iteration

Binding behavior:

- there is no specs review gate in this module
- passed specs are treated as approved input
- brainstorming context is optional and absent by default
- PRD, backlog, execution readiness, and execution are the same shared core path used by `self_ralph`

## Module contract

- module id: `ralph_from_specs`
- kind: `agent_workflow`
- required agents: `codex`, `codex-controller`
- terminal states: `done`, `planning_done`, `blocked`, `aborted`, `failed`, `max_rounds_reached`

## Input

Required:

- `specs`
- `workingDirectory`

Optional:

- `direction`
- `selectedConcept`
- `successCriteria`
- `constraints`
- `maxPRDRounds`
- `maxExecutionRounds`
- `maxStories`
- `plannerAgentId`
- `reviewerAgentId`
- `workerAgentId`
- `plannerModel`
- `reviewerModel`
- `workerModel`
- `executionMode`
- `repoRoot`
- `projectSlug`
- `bootstrapTemplate`

Defaults:

- planner: `codex-controller`
- reviewer: `codex-controller`
- worker: `codex`
- PRD rounds: `2`
- execution rounds: `6`
- execution mode: `bootstrap_project`

### `specs`

`specs` must already be approved. The module persists them immediately as:

- `<workingDirectory>/ralph-from-specs/specs-final.md`

The shared core then uses that artifact as the source for PRD generation.

### `direction`

Optional operator-facing label used in prompts, summaries, and reports.
If omitted, the module falls back to `selectedConcept` and then to `Approved specs input`.

### `workingDirectory`

`workingDirectory` is a writable workspace root.
The module mirrors operator-facing artifacts into:

- `<workingDirectory>/ralph-from-specs/specs-final.md`
- `<workingDirectory>/ralph-from-specs/prd-final.md`
- `<workingDirectory>/ralph-from-specs/story-backlog.json`
- `<workingDirectory>/ralph-from-specs/execution-state.json`
- `<workingDirectory>/ralph-from-specs/execution-round-<n>-evidence.json`
- `<workingDirectory>/ralph-from-specs/project-bootstrap.json` when applicable
- `<workingDirectory>/ralph-from-specs/run-summary.txt`

### `executionMode`

Supported modes match `self_ralph`:

- `plan_only`
  - planning stops cleanly after PRD approval and story backlog generation
  - terminal state is `planning_done`
  - no git repo is required
- `existing_repo`
  - execution uses `repoRoot`
  - git/worktree validation happens only at execution readiness
- `bootstrap_project`
  - default mode
  - after planning, the module derives or uses `projectSlug`
  - it creates and initializes a fresh repo target under `workingDirectory`
  - execution then runs inside that bootstrap target

## Flow

### 1. Trusted specs intake

- normalize input
- validate `workingDirectory` as a writable workspace
- persist `specs-final.md`
- create the orchestrator session
- emit run-start trace and reporting

### 2. Shared core PRD phase

The planner turns approved specs into a PRD.
If a reviewer requests revisions, only the PRD loops.
There is no review round for the input specs themselves.

### 3. Story backlog

After PRD approval, the planner derives a machine-readable backlog in `story-backlog.json`.

### 4. Execution readiness gate

- `plan_only` ends successfully with `planning_done`
- `existing_repo` validates `repoRoot` as a git repo/worktree context
- `bootstrap_project` creates and initializes a target repo under `workingDirectory`

### 5. Ralph execution loop

The later execution behavior matches `self_ralph`:

- select the next open story
- create a fresh worker session and a fresh reviewer session
- run the worker against only that story in the execution workspace
- collect git and verification evidence
- send the reviewer the story, worker output, and structured evidence
- apply the reviewer decision `DONE | CONTINUE | BLOCKED`
- rewrite `execution-state.json` after the decision so the artifact reflects post-decision truth

## Relationship To `self_ralph`

- `self_ralph`: direction -> brainstorming -> specs -> shared core
- `ralph_from_specs`: trusted specs -> shared core

Both modules share:

- PRD generation and review
- story backlog generation
- execution readiness
- Ralph execution
- mirrored execution-state and run-summary artifacts
