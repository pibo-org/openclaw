# PIBO CLI integration into OpenClaw

The former standalone `pibo-cli` has been ported into the OpenClaw fork as the native subcommand tree:

- `openclaw pibo twitter ...`
- `openclaw pibo agents ...`
- `openclaw pibo find ...`
- `openclaw pibo commands ...`
- `openclaw pibo docs-sync ...`
- `openclaw pibo local-sync ...`
- `openclaw pibo mcp ...`
- `openclaw pibo todo ...`
- `openclaw pibo samba ...`

## Integration shape

- Registration happens through OpenClaw's internal sub-CLI registrar in `src/cli/program/register.subclis.ts`.
- The ported command modules live under `src/cli/pibo/`.
- Docs-sync assets are now shipped from `docs/pibo-cli/assets/` so the packaged OpenClaw build can still install/copy them.
- `find init` now writes bundled prompt templates directly instead of depending on a separate `prompts/find` folder from the legacy repo.

## Runtime migration

The old active runtime path was the globally linked `pibo-cli` package and its `pibo` binary. After validating the OpenClaw fork build, remove/disable that global package so the PIBO command surface lives only under OpenClaw.
