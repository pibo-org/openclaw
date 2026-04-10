# PIBo Managed Sessions

Date: 2026-04-09

## Summary

A thin PIBo-managed session layer was added on top of the existing OpenClaw plugin runtime and gateway/session primitives.

Goals:

- keep Telegram/Cron/OpenClaw default session behavior unchanged
- avoid gateway-core session rewrites
- allow PIBo-owned deterministic workflow sessions
- allow the first managed workflow run to start immediately
- anchor the native PIBO workflow runtime on stable Worker/Critic session keys

## What was added

New runtime module:

- `src/plugins/runtime/runtime-managed-sessions.ts`

Runtime exposure:

- `runtime.managedSessions`
- `runtime.piboWorkflows`

Type definitions:

- `src/plugins/runtime/types.ts`

Runtime wiring:

- `src/plugins/runtime/index.ts`

Tests:

- `src/plugins/runtime/index.test.ts`
- `src/cli/pibo/workflows/index.test.ts`

CLI smoke path:

- `src/cli/pibo/commands/managed-session.ts`
- `openclaw pibo managed-session smoke`

Native workflow path:

- `src/cli/pibo/workflows/*`
- `openclaw pibo workflows ...`
- `extensions/pibo/src/workflow-runtime.ts`

The plugin workflow adapter now formats and routes native workflow calls through
`runtime.piboWorkflows`; it no longer shells out to an external standalone repo.

CLI management commands:

- `openclaw pibo managed-session list`
- `openclaw pibo managed-session resolve`
- `openclaw pibo managed-session status`
- `openclaw pibo managed-session add`
- `openclaw pibo managed-session edit`
- `openclaw pibo managed-session delete`
- `openclaw pibo managed-session reset`
- `openclaw pibo managed-session compact`
- `openclaw pibo managed-session send`
- `openclaw pibo managed-session abort`

Current CLI defaults:

- `openclaw pibo managed-session list` focuses on PIBo sessions by default
- `--session-type <pibo|native|both>` switches between PIBo-only, native-only, or combined views
- text output is compact by default
- JSON output is opt-in via `--json`
- list output is bounded by default; use `--all` or `--limit <n>` to widen it

## Supported capabilities

`runtime.managedSessions` now exposes:

- `buildKey(...)`
- `buildWorkflowKey(...)`
- `list(...)`
- `get(...)`
- `status(...)`
- `resolveSelector(...)`
- `resolve(...)`
- `create(...)`
- `add(...)`
- `patch(...)`
- `edit(...)`
- `reset(...)`
- `delete(...)`
- `compact(...)`
- `ensureWorkflowSession(...)`
- `runOnManagedSession(...)`
- `runFirstManagedWorkflowTurn(...)`

## Key format

Managed workflow keys are deterministic and currently follow:

- `agent:<agentId>:pibo:workflow:<flowId>:<role>:<name>`

Example:

- `agent:pibo:pibo:workflow:flow-001:worker:a`

## Current implementation note

This layer is intentionally thin.

For runtime/plugin use:

- managed session helpers live on `runtime.managedSessions`
- workflow commands/tools live on `runtime.piboWorkflows`
- actual execution still goes through existing OpenClaw run/session primitives

For the CLI management path:

- we use direct gateway handler calls for session CRUD/control methods
- this keeps `openclaw pibo managed-session ...` usable as a local admin surface without relying on a separate WebSocket CLI path
- `list` and `resolve` now apply PIBo-specific filtering semantics instead of mirroring the global session list blindly

For the native workflow path:

- workflow runs keep their own run record under `~/.local/state/pibo-workflows/runs/`
- managed sessions provide the operative worker/critic execution surface
- `langgraph_worker_critic` persists its Worker/Critic session keys inside the workflow run record for later debugging

## Using managed sessions with the normal `openclaw agent` CLI

Managed sessions are now usable from the normal agent surface without falling back to the agent main session.

Operational contract:

- `openclaw agent --agent <id>` without `--session-key` still defaults to `agent:<id>:main`
- `openclaw agent --agent <id> --session-key <key>` runs that agent on the explicit session key
- visible delivery remains separate from session selection

Minimal example:

```bash
openclaw pibo managed-session add \
  --key 'agent:langgraph:pibo:workflow:e2e:worker:main' \
  --agent-id langgraph \
  --label 'LangGraph E2E Worker'
```

```bash
openclaw agent \
  --agent langgraph \
  --session-key 'agent:langgraph:pibo:workflow:e2e:worker:main' \
  --message "Continue this worker session."
```

If the same run should also send a visible Telegram reply:

```bash
openclaw agent \
  --agent langgraph \
  --session-key 'agent:langgraph:pibo:workflow:e2e:worker:main' \
  --channel telegram \
  --deliver \
  --reply-account langgraph \
  --reply-to '-1003736645971:1609' \
  --message "Reply exactly with: TELEGRAM DELIVERY TEST OK"
```

In that case:

- execution context = explicit managed session key
- visible sender = `langgraph`
- visible destination = Telegram topic `1609`

## Important runtime fix

A plugin/dist resolution drift was fixed in:

- `src/plugins/runtime/runtime-plugin-boundary.ts`

The boundary loader now uses the same alias map construction as the main plugin loader via:

- `buildPluginLoaderAliasMap(...)`

This fixed the failing extension/plugin-sdk resolution during actual managed-session agent runs.

## Verified smoke result

The managed-session smoke path now successfully:

- creates a deterministic managed session
- runs the `main` agent on that session
- waits for completion
- reads back transcript messages from the managed session

Verified successful reply in session transcript:

- `MANAGED_SESSION_SMOKE_OK`

## Non-goals

This change does **not**:

- replace OpenClaw session persistence
- alter Cron session logic
- alter Telegram routing/session ownership
- introduce a second gateway session architecture
- make `--reply-to` or `--reply-account` replace explicit session selection

## Dynamic command scan logging

PIBo dynamic command registration still exists, but noisy startup scan logging is now disabled by default.

To re-enable registration diagnostics explicitly:

```bash
PIBO_DYNAMIC_COMMAND_DEBUG=1 openclaw ...
```

This keeps normal startup cleaner while preserving the dynamic command feature.
