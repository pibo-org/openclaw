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
- the worker must stay anchored to an explicit execution `workingDirectory`, with default git runs isolated into a workflow-owned linked worktree instead of inheriting ambient repo dirt
- the worker should only receive explicit workflow/task context, not ambient Main/session chat, memory, or docs
- an optional `agentId` should be able to switch agent-workspace bootstrap context and add extra readable workspace context without moving the worker cwd or inheriting the full Main/session context
- a controller should decide whether to continue, stop as done, or escalate a real blocker

## Runtime shape

- module id: `codex_controller`
- native registry: `src/cli/pibo/workflows/modules/index.ts`
- native CLI: `openclaw pibo workflows ...`
- plugin/runtime bridge: `runtime.piboWorkflows`
- global PIBO agent tools now keep only delegate surfaces; workflow mutation starts go through the CLI contract

## Operator start path

The task-first path for normal operator use is:

```bash
openclaw pibo workflows run codex_controller \
  --reply-here \
  --task "Inspect the repo and fix the issue" \
  --success "Verify in browser" \
  --constraint "Do not touch unrelated dirty changes"
```

`run` starts asynchronously by default and prints the run id, reporting target, effective working directory, and next `progress` command. Use `--wait` when the CLI should block until the workflow reaches a terminal state.

For `codex_controller`, `run` accepts direct operator flags:

- `--task <text>`
- `--cwd <path>`; defaults to the current `pwd` when omitted
- `--existing-working-directory`; opt out of workflow-owned linked-worktree isolation and run directly in `--cwd`
- `--repo-root <path>`
- `--agent-id <id>`
- repeated `--success <text>`
- repeated `--constraint <text>`
- `--max-rounds <n>`
- `--worker-model <id>`
- `--worker-reasoning-effort <level>`
- `--worker-fast-mode <on|off>`

### Worker model, reasoning, and fast-mode defaults

`codex_controller` has two model layers:

1. The OpenClaw `codex-controller` agent model, resolved through normal
   OpenClaw model config.
2. The Codex SDK worker model, controlled by workflow input or Codex defaults.

Use `openclaw models --agent codex-controller status --json` to inspect the
OpenClaw agent layer.

Use explicit worker overrides when a run must pin Codex behavior:

```bash
openclaw pibo workflows run codex_controller \
  --worker-model gpt-5.5 \
  --worker-reasoning-effort high \
  --worker-fast-mode on \
  --task "..."
```

When worker overrides are omitted, the Codex worker default is resolved in this order:

1. `--worker-model` / `--worker-reasoning-effort` / `--worker-fast-mode` or the JSON `workerModel` / `workerReasoningEffort` / `workerFastMode` fields for this run.
2. The wrapper default in `~/.config/codex-cli-wrapper/config.json`.
3. If the wrapper default is unset, the Codex SDK / Codex defaults.

For the normal `codex_controller` worker default, set:

```json
{
  "model": "gpt-5.5",
  "effort": "high",
  "fastMode": true
}
```

Check it with:

```bash
python3 -m json.tool ~/.config/codex-cli-wrapper/config.json
```

Codex worker fast mode uses Codex CLI `service_tier`: `on` maps to `fast`, `off` maps to `flex` for that run.

The normal Codex CLI config in `~/.codex/config.toml` is separate. It may matter as a Codex fallback, but it is not the explicit workflow-worker default. The worker also runs through this repo's pinned `@openai/codex-sdk`, so newly released Codex models may require bumping that package even if the global `codex` CLI already supports them.

OpenClaw `thinkingDefault`, Codex `model_reasoning_effort`, wrapper `effort`, and wrapper `fastMode` are separate settings. A model can support `xhigh` while the operating default remains `high`.

`--reply-here` resolves the reporting target only when a trusted current origin is available. For plain local CLI use, pass `--owner-session-key`, `--channel`, `--to`, and optionally `--thread-id` explicitly, or provide `OPENCLAW_WORKFLOW_OWNER_SESSION_KEY`, `OPENCLAW_WORKFLOW_CHANNEL`, `OPENCLAW_WORKFLOW_TO`, and optionally `OPENCLAW_WORKFLOW_ACCOUNT_ID` / `OPENCLAW_WORKFLOW_THREAD_ID`.

The low-level JSON contract remains available:

```bash
openclaw pibo workflows start-async codex_controller \
  --owner-session-key <key> \
  --channel <channel> \
  --to <target> \
  --json @input.json
```

## Why the worker uses Codex SDK directly

The Codex worker now keeps a persistent Codex thread via `@openai/codex-sdk`, while the controller itself still runs on a normal native OpenClaw workflow session key.

This replaces the former ACP/ACPX worker path because the SDK/App-Server combination already exposes the pieces the workflow actually needs:

- persistent Codex thread reuse
- explicit worker `cwd`
- direct streamed item/turn events for telemetry
- app-server compaction when explicitly requested for debugging or specialized cases

This keeps the controller loop and workflow tracing intact while removing the extra ACP timeout/resume layer.

## Context boundaries

The workflow has three separate context layers. They should not be conflated.

1. Execution workspace: `workingDirectory`

- `workingDirectory` in the low-level input is the requested project/worktree path.
- When that path is inside a git checkout, the default runtime path is now a workflow-owned linked worktree under the PIBO workflow state dir, and the Codex SDK worker `cwd` becomes that clean isolated worktree path.
- `workingDirectoryMode=existing` keeps the old behavior and runs directly in the provided path.
- Setting `agentId` still does **not** move the worker away from the resolved execution cwd.

2. Explicit run contract: workflow input and controller follow-up

- The worker receives the explicit run contract built from this workflow invocation: `task`, `successCriteria`, `constraints`, finish-quality requirements, and later controller follow-up instructions.
- The persisted `codex-controller-run-contract.json` is the stable source of truth for that worker run across retries, resumes, and compaction.
- The worker does **not** automatically inherit ambient Main/session transcript state, prior chat turns, memory search results, or repo docs just because they existed in some other OpenClaw session.

3. Optional agent-workspace context: `agentId`

- When `agentId` is provided, the runtime resolves that agent's workspace directory.
- Controller turns run with that workspace as `workspaceDir`, so agent-workspace bootstrap files can affect the controller's local skills/system-prompt/workspace bootstrap behavior.
- The Codex worker gets the same directory as `additionalDirectories`, which means extra readable workspace context alongside the real `workingDirectory`.
- This is still bounded context. `agentId` does **not** transplant the full Main chat, full session memory, or all Main/workspace docs into the worker.

Practical reading of `agentId`:

- yes: switch which agent workspace is used for controller bootstrap and extra readable workspace context
- yes: expose that agent workspace directory in addition to `workingDirectory`
- no: change the worker cwd away from `workingDirectory`
- no: implicitly inherit ambient Main/session chat, memory, or docs

If `repoRoot` is omitted and `workingDirectory` is an active linked git worktree, closeout is scoped to that current worktree: the run must still end clean, but it does not need to self-integrate into `main` or close sibling worktrees just to report success. Provide `repoRoot` when the product needs shared-repo integration semantics instead.

In the default workflow-owned mode, the worker still receives an explicit execution cwd, but that cwd is owned by the workflow. The worker is responsible for leaving that owned worktree clean; the runtime is then responsible for integrating the result into the shared repo target branch, verifying repo-integrated closeout, and only then cleaning up workflow-owned worktrees/refs.

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

- includes a compact persisted run-contract reminder from the workflow artifact store
- sends only bounded dynamic supervisory context for the current round
- includes compact visible worker history, bounded controller history, current status hints, progress evidence, drift signals, and current `WORKER_OUTPUT`

This means the runtime still avoids rebuilding the full controller wrapper prompt every round, but no longer relies only on early transcript context for long runs or after compaction.

## Persisted run contract

Each `codex_controller` run now writes `codex-controller-run-contract.json` under the workflow artifact store.

It snapshots the resolved stable contract for that run:

- normalized workflow input after defaults/aliases are resolved, including requested-vs-effective working directory and workflow-owned worktree ownership metadata when applicable
- for workflow-owned runs, managed integration metadata such as the owned branch, recovery ref, integration target branch, and integration worktree path
- the controller prompt contents loaded from `controllerPromptPath`
- the resolved optional `contextWorkspaceDir`
- worker-scoped Codex `developer_instructions` derived from the same contract

The module reuses that persisted artifact as the run-local source of truth when the same run id is re-entered, instead of assuming the original prompt file, agent workspace config, or early transcript context are still sufficient.

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

The runtime now executes staged closeout on the real DONE -> terminal path before it returns `done`:

- existing-checkout runs still resolve the effective closeout repo from `repoRoot` first, with `workingDirectory` fallback
- operator-owned existing-checkout success still requires a clean repo/worktree, no additional linked worktrees, and `HEAD` integrated into a known mainline ref (`origin/main`, `origin/master`, `main`, `master`)
- if `repoRoot` is omitted and the worker is running in a linked worktree, closeout remains worktree-local and defers sibling-worktree cleanup plus mainline integration to a later explicit repo-root closeout step
- if the worker is running in a workflow-owned linked worktree, DONE first requires a clean owned worktree (`local ready`), then the runtime creates/updates a recovery ref for the worker HEAD, auto-integrates into a writable local target branch (`main`, `master`, or a hydrated local branch from `origin/main` / `origin/master`), runs a repo-integrated closeout check, and only then cleans up workflow-owned worktrees/refs

Workflow-owned `done` now means `repo integrated + final closeout passed + cleanup passed`.

If local closeout, integration, final closeout, or cleanup fails, the workflow ends as `blocked` instead of `done`. Failed workflow-owned integration preserves the worker worktree, managed branch/recovery ref, and integration worktree metadata for recovery instead of silently deleting them.

Cleanup is ownership-aware:

- only workflow-owned linked worktrees/refs under the workflow state dir are auto-removed
- operator-owned or manually supplied worktrees are never auto-removed
- workflow-owned cleanup happens only after integration success and final repo-integrated closeout success
- if workflow-owned cleanup itself fails after integration succeeded, the run ends blocked with an explicit cleanup reason instead of pretending success; the integrated branch result remains reachable

Artifacts now include:

- `closeout-local-ready-assessment.json`: workflow-owned local readiness assessment before integration
- `workflow-owned-integration.json`: workflow-owned integration result and recovery metadata
- `closeout-assessment.json`: final machine-readable closeout result
- `run-summary.txt`: terminal status plus local closeout, integration, final closeout, and cleanup context

## Compaction behavior

`workerCompactionMode` defaults to `off`.

That means the normal workflow path does **not** trigger manual compaction between rounds.

Codex should normally manage its own context and compaction behavior inside the worker thread. Workflow-driven manual compaction remains available only as an explicit exception path for debugging or specialized cases.

If manual compaction is explicitly wanted, set:

- `workerCompactionMode: "app_server"`
- `workerCompactionMode: "acp_control_command"` also still works as a legacy alias
- optionally `workerCompactionAfterRound` to delay the first manual compaction

The implementation now uses the Codex app server (`thread/resume` + `thread/compact/start`), not ACP control commands, and it passes the same run-scoped worker instructions through that app-server path without writing to global Codex config files.

## Worker turn timeout and retry behavior

`codex_controller` now applies its own deliberate worker turn timeout around the Codex SDK turn instead of relying on ACPX defaults.

Current module-scoped policy:

- worker prompt timeout: `7200s`
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
pnpm openclaw -- pibo workflows run codex_controller --help
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
pnpm openclaw -- pibo workflows run codex_controller \
  --owner-session-key 'agent:main:telegram:group:-100123:topic:333' \
  --channel telegram \
  --to 'group:-100123' \
  --thread-id 333 \
  --task "Inspect the repo and summarize one safe improvement." \
  --cwd /absolute/path/to/repo \
  --agent-id writer \
  --max-rounds 1 \
  --output-json
```

Use a real repo path and only run this where Codex CLI/SDK is available and configured.
