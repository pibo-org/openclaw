# PIBo Managed Sessions

Date: 2026-04-09

## Summary

A thin PIBo-managed session layer was added on top of the existing OpenClaw plugin runtime and gateway/session primitives.

Goals:
- keep Telegram/Cron/OpenClaw default session behavior unchanged
- avoid gateway-core session rewrites
- allow PIBo-owned deterministic workflow sessions
- allow the first managed workflow run to start immediately

## What was added

New runtime module:
- `src/plugins/runtime/runtime-managed-sessions.ts`

Runtime exposure:
- `runtime.managedSessions`

Type definitions:
- `src/plugins/runtime/types.ts`

Runtime wiring:
- `src/plugins/runtime/index.ts`

Tests:
- `src/plugins/runtime/index.test.ts`

CLI smoke path:
- `src/cli/pibo/commands/managed-session.ts`
- `openclaw pibo managed-session smoke`

## Supported capabilities

`runtime.managedSessions` now exposes:
- `buildWorkflowKey(...)`
- `resolve(...)`
- `create(...)`
- `patch(...)`
- `reset(...)`
- `delete(...)`
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
- actual execution still goes through existing OpenClaw run/session primitives

For the CLI smoke path:
- we use direct gateway handler calls for `sessions.create`, `agent`, `agent.wait`, and `sessions.get`
- this avoids the earlier mismatch between plain CLI context and gateway-bound subagent context

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

## Dynamic command scan logging

PIBo dynamic command registration still exists, but noisy startup scan logging is now disabled by default.

To re-enable registration diagnostics explicitly:

```bash
PIBO_DYNAMIC_COMMAND_DEBUG=1 openclaw ...
```

This keeps normal startup cleaner while preserving the dynamic command feature.
