---
summary: "CLI reference for `openclaw sessions` (list, compact, and maintain sessions)"
read_when:
  - You want to inspect, compact, or maintain stored sessions
title: "sessions"
---

# `openclaw sessions`

List stored conversation sessions and inspect them with bounded progressive-disclosure commands.

```bash
openclaw sessions
openclaw sessions --agent work
openclaw sessions --all-agents
openclaw sessions --active 120
openclaw sessions --verbose
openclaw sessions --json
```

Scope selection:

- default: configured default agent store
- `--verbose`: verbose logging
- `--agent <id>`: one configured agent store
- `--all-agents`: aggregate all configured agent stores
- `--store <path>`: explicit store path (cannot be combined with `--agent` or `--all-agents`)

`openclaw sessions --all-agents` reads configured agent stores. Gateway and ACP
session discovery are broader: they also include disk-only stores found under
the default `agents/` root or a templated `session.store` root. Those
discovered stores must resolve to regular `sessions.json` files inside the
agent root; symlinks and out-of-root paths are skipped.

JSON examples:

`openclaw sessions --all-agents --json`:

```json
{
  "path": null,
  "stores": [
    { "agentId": "main", "path": "/home/user/.openclaw/agents/main/sessions/sessions.json" },
    { "agentId": "work", "path": "/home/user/.openclaw/agents/work/sessions/sessions.json" }
  ],
  "allAgents": true,
  "count": 2,
  "activeMinutes": null,
  "sessions": [
    { "agentId": "main", "key": "agent:main:main", "model": "gpt-5" },
    { "agentId": "work", "key": "agent:work:main", "model": "claude-opus-4-6" }
  ]
}
```

## Progressive Session Inspection

Use the exploration subcommands to inspect long sessions without dumping the full transcript.
Defaults stay small, sanitized, and bounded.

### Peek

Show a tiny recent sanitized window:

```bash
openclaw sessions peek main
openclaw sessions peek main --limit 8
openclaw sessions peek main --role assistant
openclaw sessions peek agent:work:main --json
```

- default: last 5 sanitized messages
- tool messages are hidden unless you pass `--include-tools`
- `--role user|assistant|tool`: narrow the window before output
- `--json`: includes `sessionKey`, `limit`, `messages`, `truncated`, `contentTruncated`, `contentRedacted`, and `bytes`

### Grep

Search one session and return snippets instead of message dumps:

```bash
openclaw sessions grep main compaction
openclaw sessions grep main token --ignore-case
openclaw sessions grep main error --role assistant
openclaw sessions grep agent:work:main build --json
```

- searches sanitized message text fields
- returns bounded snippets, not full transcript bodies
- `--before-chars` / `--after-chars`: control snippet context
- `--role user|assistant|tool`: narrow the search surface first
- `--json`: includes `sessionKey`, `query`, `hits`, `truncated`, and `bytes`

### Find

Search session metadata across stores to identify likely candidates first:

```bash
openclaw sessions find discord
openclaw sessions find launch --agent work
openclaw sessions find prod --active 120
openclaw sessions find compaction --json
```

- default scope: configured agent stores
- metadata only: this does not load transcript bodies
- `--active <minutes>`: only recent candidates
- `--limit <n>`: bound candidate output

### Show

Browse one session in bounded chunks with explicit cursor paging:

```bash
openclaw sessions show main
openclaw sessions show main --cursor before:42
openclaw sessions show main --after 42
openclaw sessions show agent:work:main --json
```

- default: last 20 sanitized messages
- output includes `older` / `newer` cursor tokens so you can page without dumping the full transcript
- supports `--cursor`, `--before`, `--after`, and `--limit`
- tool messages are hidden unless you pass `--include-tools`

## Manual compaction

Run semantic/manual compaction for a session key:

```bash
openclaw sessions compact main
openclaw sessions compact "agent:main:telegram:direct:123"
openclaw sessions compact main --json
```

`openclaw sessions compact <key>` calls the existing gateway `sessions.compact`
path without `maxLines`, so it triggers the embedded semantic compaction flow
instead of transcript line truncation.

- text mode prints a concise summary such as `Compacted session main.` or
  `Session main was not compacted: no transcript.`
- `--json` returns the gateway payload directly, including `compacted`, `reason`,
  and any result metadata such as `tokensAfter`
- pass the canonical session key when you want to target a specific non-default
  session bucket

## Cleanup maintenance

Run maintenance now (instead of waiting for the next write cycle):

```bash
openclaw sessions cleanup --dry-run
openclaw sessions cleanup --agent work --dry-run
openclaw sessions cleanup --all-agents --dry-run
openclaw sessions cleanup --enforce
openclaw sessions cleanup --enforce --active-key "agent:main:telegram:direct:123"
openclaw sessions cleanup --json
```

`openclaw sessions cleanup` uses `session.maintenance` settings from config:

- Scope note: `openclaw sessions cleanup` maintains session stores/transcripts only. It does not prune cron run logs (`cron/runs/<jobId>.jsonl`), which are managed by `cron.runLog.maxBytes` and `cron.runLog.keepLines` in [Cron configuration](/automation/cron-jobs#configuration) and explained in [Cron maintenance](/automation/cron-jobs#maintenance).

- `--dry-run`: preview how many entries would be pruned/capped without writing.
  - In text mode, dry-run prints a per-session action table (`Action`, `Key`, `Age`, `Model`, `Flags`) so you can see what would be kept vs removed.
- `--enforce`: apply maintenance even when `session.maintenance.mode` is `warn`.
- `--fix-missing`: remove entries whose transcript files are missing, even if they would not normally age/count out yet.
- `--active-key <key>`: protect a specific active key from disk-budget eviction.
- `--agent <id>`: run cleanup for one configured agent store.
- `--all-agents`: run cleanup for all configured agent stores.
- `--store <path>`: run against a specific `sessions.json` file.
- `--json`: print a JSON summary. With `--all-agents`, output includes one summary per store.

`openclaw sessions cleanup --all-agents --dry-run --json`:

```json
{
  "allAgents": true,
  "mode": "warn",
  "dryRun": true,
  "stores": [
    {
      "agentId": "main",
      "storePath": "/home/user/.openclaw/agents/main/sessions/sessions.json",
      "beforeCount": 120,
      "afterCount": 80,
      "pruned": 40,
      "capped": 0
    },
    {
      "agentId": "work",
      "storePath": "/home/user/.openclaw/agents/work/sessions/sessions.json",
      "beforeCount": 18,
      "afterCount": 18,
      "pruned": 0,
      "capped": 0
    }
  ]
}
```

Related:

- Session config: [Configuration reference](/gateway/configuration-reference#session)
