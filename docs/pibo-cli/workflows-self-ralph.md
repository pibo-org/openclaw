# `self_ralph` workflow module

Stand: 2026-04-18  
Module ID: `self_ralph`

`self_ralph` is a native PIBO/OpenClaw workflow module for an ideation-first product workflow.
It now owns only the direction-first front half and then hands approved specs into the shared Ralph core:

1. direction intake
2. brainstorming with real concept generation and reviewer selection
3. specs
4. shared core
5. PRD
6. story backlog
7. optional Ralph-style story execution with a fresh worker per iteration

The design remains AI-gated:

- planning phases are controlled by explicit review verdicts
- brainstorming is expected to widen first, then narrow to one selected concept
- approved specs become the handoff boundary into the shared core
- specs and PRD become explicit artifacts on disk
- execution still proceeds one concrete story at a time
- the reviewer decides `DONE | CONTINUE | BLOCKED` per execution round

`ralph_from_specs` is the sibling specs-first entrypoint for the same shared core. It skips direction, brainstorming, and specs review because passed specs are already trusted approved input.

## Module contract

- module id: `self_ralph`
- kind: `agent_workflow`
- required agents: `codex`, `codex-controller`
- terminal states: `done`, `planning_done`, `blocked`, `aborted`, `failed`, `max_rounds_reached`

## Input

Required:

- `direction`
- `workingDirectory`

Optional:

- `successCriteria`
- `constraints`
- `maxBrainstormingRounds`
- `maxSpecsRounds`
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
- planning rounds: `2`
- execution rounds: `6`
- execution mode: `bootstrap_project`

### `direction`

`direction` is intentionally broad. It should describe the product direction, not a pre-narrowed implementation task.

Valid examples:

- `Erstelle eine Social Media App`
- `Entwickle ein kleines B2B-Tool fuer Angebotsfreigaben`
- `Baue ein Multiplayer-Wissensspiel fuer Freunde`

### `workingDirectory`

`workingDirectory` is required, but it is now a writable workspace root, not a mandatory git repo at run start.

Before planning begins, the module validates only that it:

- exists
- is a directory
- is writable for artifact persistence

The module mirrors operator-facing artifacts into:

- `<workingDirectory>/self-ralph/brainstorming-final.md`
- `<workingDirectory>/self-ralph/brainstorming-options.json`
- `<workingDirectory>/self-ralph/specs-final.md`
- `<workingDirectory>/self-ralph/prd-final.md`
- `<workingDirectory>/self-ralph/story-backlog.json`
- `<workingDirectory>/self-ralph/execution-state.json`
- `<workingDirectory>/self-ralph/execution-round-<n>-evidence.json`
- `<workingDirectory>/self-ralph/project-bootstrap.json` when applicable
- `<workingDirectory>/self-ralph/run-summary.txt`

### `executionMode`

Supported modes:

- `plan_only`
  - planning stops cleanly after PRD approval and story backlog generation
  - terminal state is `planning_done`
  - no git repo is required
- `existing_repo`
  - planning still runs from `workingDirectory`
  - execution uses `repoRoot`
  - git/worktree validation happens only at execution readiness
- `bootstrap_project`
  - default mode
  - after planning, the module derives or uses `projectSlug`
  - it creates and initializes a fresh repo target under `workingDirectory`
  - execution then runs inside that bootstrap target

### `repoRoot`

`repoRoot` is only required for `executionMode=existing_repo`.

### `projectSlug`

Optional explicit target directory name for `bootstrap_project`. If omitted, the module derives a slug from the selected concept or direction.

## Flow

### 1. Planning preflight

- normalize input
- validate `workingDirectory` as a writable workspace
- create the orchestrator session
- emit run-start trace and reporting

### 2. Brainstorming

The planner is expected to produce 3 to 5 serious product concepts before selecting one. The reviewer approves only when the artifact contains both breadth and a justified selected concept.

### 3. Specs

The planner turns the selected concept into a concrete product spec with scope, key flows, key objects, UX assumptions, non-goals, and MVP boundaries.

### 4. Shared Core Handoff

Once specs are approved, `self_ralph` enters the same internal core that is also used by `ralph_from_specs`.

The shared core owns:

- PRD generation plus PRD review
- story backlog generation
- execution readiness
- Ralph execution

### 5. PRD

The planner turns brainstorming plus specs into a PRD with features, acceptance criteria, boundaries, MVP scope, and technical guardrails where needed.

### 6. Story backlog

After PRD approval, the planner derives a machine-readable backlog in `story-backlog.json`.

### 7. Execution readiness gate

Only after planning completes does the module resolve execution readiness:

- `plan_only` ends successfully with `planning_done`
- `existing_repo` validates `repoRoot` as a git repo/worktree context
- `bootstrap_project` creates and initializes a target repo under `workingDirectory`

### 8. Ralph execution loop

Once execution starts, the later loop stays materially the same:

- select the next open story
- create a fresh worker session and a fresh reviewer session
- run the worker against only that story in the execution workspace
- collect git and verification evidence
- send the reviewer the story, worker output, and structured evidence
- apply the reviewer decision `DONE | CONTINUE | BLOCKED`
- rewrite `execution-state.json` after the decision so the artifact reflects post-decision truth

## Artifact model

Workflow artifacts under the normal runtime store still include prompt, draft, and review files per phase and per execution round.

The mirrored workspace artifact set is the operator-facing planning and execution snapshot:

- `brainstorming-final.md`
- `brainstorming-options.json`
- `specs-final.md`
- `prd-final.md`
- `story-backlog.json`
- `execution-state.json`
- `execution-round-<n>-evidence.json`
- `project-bootstrap.json` when applicable
- `run-summary.txt`

For the specs-first sibling module, see [workflows-ralph-from-specs.md](./workflows-ralph-from-specs.md).

## Terminal semantics

- `planning_done`: planning completed cleanly and intentionally stopped before coding
- `done`: planning and execution completed
- `blocked`: reviewer or execution blocker halted the run
- `max_rounds_reached`: a planning or execution budget was exhausted
- `failed`: preflight, parse, or runtime error
- `aborted`: operator abort
