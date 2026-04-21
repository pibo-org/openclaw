# `codex_controller` workflow module

Date: 2026-04-16

## Documentation status

Repo-nahe technische Referenz.

Kanonische PIBO-Doku für den aktuellen Betriebsstand:

- `~/docs/pibo/workflows/codex-controller.md`
- `~/docs/pibo/workflows/workflow-runtime-architecture.md`
- `~/docs/pibo/workflows/workflow-debugging.md`

Diese Datei bleibt nützlich für quellnahe technische Details, ist aber nicht alleinige Source of Truth für die übergreifende Workflow-Dokumentation.

## Purpose

`codex_controller` is a native PIBO workflow module for supervised coding loops with a persistent Codex SDK worker and a separate controller agent.

It is intended for tasks where:

- the coding worker should keep its own persistent Codex thread
- the worker must stay anchored to an explicit `workingDirectory`
- an optional `agentId` should be able to switch bootstrap/context resolution to a different agent workspace without moving the worker cwd
- a controller should decide whether to continue, stop as done, or escalate a real blocker

## Runtime shape

- module id: `codex_controller`
- native registry: `src/cli/pibo/workflows/modules/index.ts`
- native CLI: `openclaw pibo workflows ...`
- plugin/runtime bridge: `runtime.piboWorkflows`
- global PIBO agent tools now keep only delegate surfaces; workflow mutation starts go through the CLI contract

## Why the worker uses Codex SDK directly

The Codex worker now keeps a persistent Codex thread via `@openai/codex-sdk`, while the controller itself still runs on a normal native OpenClaw workflow session key.

This replaces the former ACP/ACPX worker path because the SDK/App-Server combination already exposes the pieces the workflow actually needs:

- persistent Codex thread reuse
- explicit worker `cwd`
- direct streamed item/turn events for telemetry
- app-server compaction when explicitly requested for debugging or specialized cases

This keeps the controller loop and workflow tracing intact while removing the extra ACP timeout/resume layer.

## Workspace semantics

The module keeps two paths distinct when `agentId` is provided:

- `workingDirectory`: the project repo/worktree used as the Codex SDK worker `cwd`
- `repoRoot`: explicit strict closeout target for the final read-only git/worktree/integration gate
- `agentId`: selects the controller workspace and is also exposed to the worker as an additional readable directory; it does not move the worker `cwd`

If `repoRoot` is omitted and `workingDirectory` is an active linked git worktree, closeout is scoped to that current worktree: the run must still end clean, but it does not need to self-integrate into `main` or close sibling worktrees just to report success. Provide `repoRoot` when the product needs shared-repo integration semantics instead.

If `agentId` is omitted, the prior behavior stays unchanged.

## Controller prompt/session model

The controller prompt template at `controllerPromptPath` still uses the human-oriented controller contract:

- `CONTINUE`
- `GUIDE`
- `ASK_USER`
- `STOP_BLOCKED`

The workflow runtime now sends controller context in two phases on the same persistent controller session:

1. One-time init message

- includes the stable controller prompt template
- includes the normalized workflow contract
- includes the decision-mapping rules
- includes stable run context such as `ORIGINAL_TASK`, `SUCCESS_CRITERIA`, and `CONSTRAINTS`
- is sent once at workflow start, before the per-round controller loop

2. Per-round delta message

- omits the stable controller contract/context by default
- sends only bounded dynamic supervisory context for the current round
- includes compact visible worker history, bounded controller history, current status hints, progress evidence, drift signals, and current `WORKER_OUTPUT`

This means the runtime no longer rebuilds the full controller wrapper prompt every round.

## Controller contract handling

The one-time init message carries an explicit normalized contract:

- `MODULE_DECISION: CONTINUE | ESCALATE_BLOCKED | DONE`
- `MODULE_REASON`
- `NEXT_INSTRUCTION`
- `BLOCKER`

The parser still accepts both:

1. the normalized module contract
2. the legacy controller contract as fallback

Legacy mapping:

- `CONTINUE` / `GUIDE` → continue the loop
- `ASK_USER` / `STOP_BLOCKED` → blocked escalation
- `DONE` should come from the normalized module block

This preserves decision-parsing reliability while avoiding stable prompt re-injection on later rounds.

## Done closeout semantics

`MODULE_DECISION: DONE` is no longer sufficient on its own.

The runtime now executes a read-only closeout assessment on the real DONE -> terminal path before it returns `done`:

- resolve the effective closeout repo from `repoRoot` first, with `workingDirectory` fallback
- require a clean repo/worktree
- if `repoRoot` is explicit, require no additional linked worktrees and require `HEAD` to be integrated into a known mainline ref (`origin/main`, `origin/master`, `main`, `master`)
- if `repoRoot` is omitted and the worker is running in a linked worktree, treat closeout as worktree-local and defer sibling-worktree cleanup plus mainline integration to a later explicit repo-root closeout step

If that closeout gate fails, the workflow ends as `blocked` instead of `done`.

Artifacts now include:

- `closeout-assessment.json`: machine-readable closeout result
- `run-summary.txt`: terminal status plus closeout reason/trace/context

## Compaction behavior

`workerCompactionMode` defaults to `off`.

That means the normal workflow path does **not** trigger manual compaction between rounds.

Codex should normally manage its own context and compaction behavior inside the worker thread. Workflow-driven manual compaction remains available only as an explicit exception path for debugging or specialized cases.

If manual compaction is explicitly wanted, set:

- `workerCompactionMode: "app_server"`
- `workerCompactionMode: "acp_control_command"` also still works as a legacy alias
- optionally `workerCompactionAfterRound` to delay the first manual compaction

The implementation now uses the Codex app server (`thread/resume` + `thread/compact/start`), not ACP control commands.

## Worker turn timeout and retry behavior

`codex_controller` now applies its own deliberate worker turn timeout around the Codex SDK turn instead of relying on ACPX defaults.

Current module-scoped policy:

- worker prompt timeout: `300s`
- retry budget for worker prompt turns: `2` total attempts (`1` automatic retry)
- retry backoff: `1000ms`

Why this is scoped here:

- the observed failure was on the Codex worker prompt path, not on the controller loop
- controller turns and unrelated OpenClaw workloads should not inherit worker-specific timeout policy
- the workflow should encode a safer default for heavy worker turns without masking unrelated failures across the repo

Retryability is intentionally narrow.

The workflow retries only when the worker turn fails like a retryable Codex turn timeout or another clearly transient Codex transport/prompt-completion failure. Deterministic failures such as permission problems, invalid runtime options, unsupported controls, prompt-size errors, and similar non-transient conditions still fail immediately without retry.

Before the retry starts, the workflow discards the in-memory SDK thread handle and lets the next attempt resume the same Codex thread via a fresh CLI exec process. This keeps retries local to the worker turn without reintroducing ACP runtime state.

Retry lifecycle observability:

- trace event + milestone report attempt when a retry is scheduled
- trace event + milestone report attempt when the retry starts
- trace event + milestone report attempt when the retry succeeds
- warning trace event + milestone report attempt when the retry budget is exhausted

These events include attempt counts, the module-scoped worker timeout, and the underlying worker error metadata.

## Verification checklist

Recommended verification steps:

```bash
node scripts/run-vitest.mjs run --config vitest.cli.config.ts \
  src/cli/pibo/workflows/modules/codex-controller.test.ts
node scripts/run-vitest.mjs run --config vitest.cli.config.ts \
  src/cli/pibo/workflows/agent-runtime.test.ts \
  src/cli/pibo/workflows/index.test.ts \
  src/cli/pibo/workflows/modules/codex-controller.test.ts
pnpm openclaw -- pibo workflows list
pnpm openclaw -- pibo workflows describe codex_controller
pnpm openclaw -- pibo workflows start noop \
  --owner-session-key 'agent:main:telegram:group:-100123:topic:333' \
  --channel telegram \
  --to 'group:-100123' \
  --thread-id 333 \
  --json '{"prompt":"smoke"}' \
  --output-json
```

Optional module smoke shape:

```bash
pnpm openclaw -- pibo workflows start codex_controller \
  --owner-session-key 'agent:main:telegram:group:-100123:topic:333' \
  --channel telegram \
  --to 'group:-100123' \
  --thread-id 333 \
  --json '{
    "task": "Inspect the repo and summarize one safe improvement.",
    "workingDirectory": "/absolute/path/to/repo",
    "agentId": "writer",
    "maxRetries": 1,
    "workerCompactionMode": "off"
  }' \
  --output-json
```

Use a real repo path and only run this where Codex CLI/SDK is available and configured.
