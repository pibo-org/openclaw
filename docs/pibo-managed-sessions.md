# PIBo Managed Sessions

Date: 2026-04-09

## Summary

A thin PIBo-managed session layer was added on top of the existing OpenClaw plugin runtime.

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

This is intentionally thin.

For now, the managed-session runtime uses the existing plugin subagent runtime as its execution path:

- actual run dispatch goes through `subagent.run(...)`
- delete/reset currently use `subagent.deleteSession(...)`
- create is lazy and materializes on first run
- resolve is currently best-effort and transcript-backed via session message lookup

This is enough for a first managed workflow smoke path without touching the default platform behavior.

## Non-goals

This change does **not**:

- replace OpenClaw session persistence
- alter Cron session logic
- alter Telegram routing/session ownership
- introduce a second gateway session architecture

## Smoke path

Example:

```ts
const runtime = createPluginRuntime({ allowGatewaySubagentBinding: true });

const result = await runtime.managedSessions.runFirstManagedWorkflowTurn({
  flowId: "flow-001",
  role: "worker",
  name: "a",
  agentId: "pibo",
  policy: "reusable",
  label: "PIBo Worker A",
  message: "Analyse this task and produce a first draft.",
  deliver: false,
});
```

This creates or reuses the managed workflow session key and starts the first run.

## Scan removal note

As requested, scan was not included in the managed-session module design.
The module only contains deterministic keying, lightweight lifecycle policy, and managed session/run wrappers.
