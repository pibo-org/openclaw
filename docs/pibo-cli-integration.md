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
- workflow mutation starts now require explicit trusted routing flags:
  `--owner-session-key`, `--channel`, `--to`, with optional `--account-id` and `--thread-id`
- `extensions/pibo` now uses OpenClaw's in-process runtime surface instead of shelling out to the external `pibo-cli` repo
- `extensions/pibo` only registers the delegate tools globally; workflow start/status/abort tooling is no longer exposed as global agent tools
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

## Browser DevTools MCP

For PIBo's built-in `chrome-devtools` MCP registration, the canonical local
OpenClaw browser endpoint is the managed `openclaw` browser profile on
`http://127.0.0.1:18800`.

Example local registration for the built-in OpenClaw browser:

```bash
openclaw pibo mcp register chrome-devtools '{
  "transport": "stdio",
  "command": "npx",
  "args": [
    "-y",
    "chrome-devtools-mcp@latest",
    "--browser-url=http://127.0.0.1:18800",
    "--no-usage-statistics"
  ]
}'
openclaw pibo mcp doctor chrome-devtools
openclaw browser status
openclaw pibo mcp call chrome-devtools list_pages --json '{}'
```

`openclaw pibo mcp doctor|tools|inspect|call|refresh` now use the PIBo registry
definition from `~/.config/pibo/mcp-servers.json` directly. They do not fall back
to the active OpenClaw MCP layer.

Only activate a server in OpenClaw when you want it exposed to the model/runtime
tool layer as `mcp.servers`:

```bash
openclaw pibo mcp activate-openclaw chrome-devtools
```

Operational note after the 2026-04-20 MCP fixes:

- real `openclaw pibo mcp call ...` runs now finalize cleanly instead of hanging after output
- this applies both to successful tool calls and to the common Chrome-not-reachable error path
- `openclaw pibo mcp doctor chrome-devtools` proves the MCP server runtime and discovery path, not that Chrome itself is reachable
- `openclaw pibo mcp activate-openclaw ...` is the explicit opt-in step for making a PIBo-registered server visible to OpenClaw model/runtime tools
- actual browser-backed tool calls still require the OpenClaw browser to be running on `18800`
- after a gateway restart, check `openclaw browser status`; if it shows `running: false`, start the browser before blaming the MCP layer

Typical recovery if the server is healthy but Chrome is down:

```bash
openclaw browser status
openclaw browser start
openclaw pibo mcp call chrome-devtools list_pages --json '{}'
```

Use `9222` only for explicit external or remote Chrome CDP endpoints, for
example a separately managed Chrome instance on another host:

```bash
openclaw pibo mcp register chrome-devtools-remote '{
  "transport": "stdio",
  "command": "npx",
  "args": [
    "-y",
    "chrome-devtools-mcp@latest",
    "--browser-url=http://REMOTE_HOST:9222",
    "--no-usage-statistics"
  ]
}'
```

Keep the distinction explicit:

- built-in OpenClaw browser / local `openclaw` profile: `18800`
- separate external or remote Chrome CDP endpoint: whatever that browser serves,
  often `9222`

## Twitter feed surface

The native Twitter/X CLI is now a general feed scraper instead of a specialized checker.

- `openclaw pibo twitter check following --new 20 --max-scanned 1000`
- `openclaw pibo twitter check for-you --stateless`
- `openclaw pibo twitter state status --feed following`
- `openclaw pibo twitter state reset --feed for-you`

The scrape commands return structured raw tweet data with feed-specific dedupe state keyed by `statusId`.
When a feed tweet article exposes an in-article `Show more` control, the checker follows the public status URL in the same browser session and replaces the preview text with the fuller status-page `tweetText`.
