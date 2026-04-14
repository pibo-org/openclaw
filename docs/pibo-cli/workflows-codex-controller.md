# `codex_controller` workflow module

Date: 2026-04-10

## Documentation status

Repo-nahe technische Referenz.

Kanonische PIBO-Doku für den aktuellen Betriebsstand:

- `~/docs/pibo/workflows/codex-controller.md`
- `~/docs/pibo/workflows/workflow-runtime-architecture.md`
- `~/docs/pibo/workflows/workflow-debugging.md`

Diese Datei bleibt nützlich für quellnahe technische Details, ist aber nicht alleinige Source of Truth für die übergreifende Workflow-Dokumentation.

## Purpose

`codex_controller` is a native PIBO workflow module for supervised coding loops with a persistent Codex ACP worker and a separate controller agent.

It is intended for tasks where:

- the coding worker should keep its own persistent ACP thread
- the worker must stay anchored to an explicit `workingDirectory`
- a controller should decide whether to continue, stop as done, or escalate a real blocker

## Runtime shape

- module id: `codex_controller`
- native registry: `src/cli/pibo/workflows/modules/index.ts`
- native CLI: `openclaw pibo workflows ...`
- plugin/runtime bridge: `runtime.piboWorkflows`
- agent/tool bridge: `pibo_workflow_start|status|describe|abort`

## Why the worker uses ACP directly

The Codex worker keeps a persistent ACP session and requires an explicit ACP `cwd`/working directory during initialization.

The controller itself runs on a normal native OpenClaw workflow session key, but the worker remains on the ACP session-manager path because that is the runtime path that currently exposes:

- persistent ACP thread reuse
- explicit ACP `cwd`
- optional ACP control-command steering such as `/compact` when explicitly requested for debugging or specialized cases

This is deliberate, not accidental.

## Controller contract handling

The controller prompt template at `controllerPromptPath` still uses the human-oriented controller contract:

- `CONTINUE`
- `GUIDE`
- `ASK_USER`
- `STOP_BLOCKED`

The workflow module now wraps that prompt with an explicit normalized contract:

- `MODULE_DECISION: CONTINUE | ESCALATE_BLOCKED | DONE`
- `MODULE_REASON`
- `NEXT_INSTRUCTION`
- `BLOCKER`

The parser accepts both:

1. the normalized module contract
2. the legacy controller contract as fallback

Legacy mapping:

- `CONTINUE` / `GUIDE` → continue the loop
- `ASK_USER` / `STOP_BLOCKED` → blocked escalation
- `DONE` should come from the normalized module block

This avoids silent breakage when the underlying prompt template is still on the older contract.

## Compaction behavior

`workerCompactionMode` defaults to `off`.

That means the normal workflow path does **not** send `/compact ...` into the persistent Codex ACP thread.

Codex should normally manage its own context and compaction behavior inside the worker session. Workflow-driven manual ACP compaction remains available only as an explicit exception path for debugging or specialized cases.

If manual ACP compaction is explicitly wanted, set:

- `workerCompactionMode: "acp_control_command"`
- optionally `workerCompactionAfterRound` to delay the first manual `/compact`

This is intentionally **not** wired to the generic OpenClaw session-compaction path such as `openclaw sessions compact`, because normal session compaction is not the same thing as semantic Codex ACP thread compaction.

## Verification checklist

Recommended verification steps:

```bash
node scripts/run-vitest.mjs run --config vitest.cli.config.ts \
  src/cli/pibo/workflows/index.test.ts \
  src/cli/pibo/workflows/modules/codex-controller.test.ts
pnpm openclaw -- pibo workflows list
pnpm openclaw -- pibo workflows describe codex_controller
pnpm openclaw -- pibo workflows start noop --json '{"prompt":"smoke"}' --output-json
```

Optional module smoke shape:

```bash
pnpm openclaw -- pibo workflows start codex_controller \
  --json '{
    "task": "Inspect the repo and summarize one safe improvement.",
    "workingDirectory": "/absolute/path/to/repo",
    "maxRetries": 1,
    "workerCompactionMode": "off"
  }' \
  --output-json
```

Use a real repo path and only run this where Codex ACP is available and configured.
