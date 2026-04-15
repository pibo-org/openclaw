# Agents Repair Salvage Report

Date: 2026-04-15
Branch: `salvage/agents-repair-slice-2026-04-15`
Source: `stash@{0}` (`safety: dirty main checkout before perf main integration 2026-04-15`)

## Adopted

- `src/agents/workspace.ts`
- `src/agents/workspace.test.ts`
- `src/cli/program/register.agent.ts`
- `src/cli/program/register.agent.test.ts`
- `src/commands/agents.ts`
- `src/commands/agents.add.test.ts`
- `src/commands/agents.commands.repair.ts`
- `src/commands/agents.repair.test.ts`
- `docs/cli/agents.md`
- `docs/cli/index.md`

## Intentionally dropped

- `pnpm-lock.yaml`
  Reason: unrelated repo drift around `ui-custom` and package version churn; not required for the agent-repair slice.
- `openclaw-2026.4.9.tgz`
  Reason: build artifact, not source.

## Verified

- Workspace setup now ensures `.codex/skills` wiring inside agent workspaces.
- CLI registration exposes `openclaw agents repair`.
- Focused tests passed:
  `node scripts/run-vitest.mjs run --config vitest.config.ts src/agents/workspace.test.ts src/cli/program/register.agent.test.ts src/commands/agents.add.test.ts src/commands/agents.repair.test.ts`
