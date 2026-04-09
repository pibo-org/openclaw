# PIBO CLI integration into OpenClaw

Most of the former standalone `pibo-cli` has been ported into the OpenClaw fork as the native subcommand tree:

- `openclaw pibo twitter ...`
- `openclaw pibo agents ...`
- `openclaw pibo find ...`
- `openclaw pibo commands ...`
- `openclaw pibo docs-sync ...`
- `openclaw pibo local-sync ...`
- `openclaw pibo mcp ...`
- `openclaw pibo todo ...`
- `openclaw pibo samba ...`
- `openclaw pibo workflows ...`

## Workflow cutover status

The workflow runtime is now native to the OpenClaw fork.

Current reality:

- workflow code lives under `src/cli/pibo/workflows/`
- `openclaw pibo workflows ...` is the native source of truth
- `extensions/pibo` now uses OpenClaw's in-process runtime surface instead of shelling out to the external `pibo-cli` repo
- `langgraph_worker_critic` runs through OpenClaw-managed workflow sessions with persisted session keys in the run record

The former standalone `pibo-cli` repo remains a historical migration source, not an active workflow runtime dependency.
It is now archived locally at:

- `/home/pibo/code/_archive/pibo-cli-legacy-2026-04-09`

## Integration shape

- Registration happens through OpenClaw's internal sub-CLI registrar in `src/cli/program/register.subclis.ts`.
- The ported command modules live under `src/cli/pibo/`.
- Docs-sync assets are now shipped from `docs/pibo-cli/assets/` so the packaged OpenClaw build can still install/copy them.
- `find init` now writes bundled prompt templates directly instead of depending on a separate `prompts/find` folder from the legacy repo.

## Runtime migration

The old active runtime path was the globally linked `pibo-cli` package and its `pibo` binary. After the native workflow cutover, that external workflow path is no longer needed for normal PIBO operation inside OpenClaw.

For local development from the repo checkout, the intended entrypoint is:

- `pnpm openclaw -- pibo ...`
