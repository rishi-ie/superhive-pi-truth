# superhive-pi-truth

Single source of truth for all Pi agent configuration.

After the first launch, `manifest.json` is dormant. The settings file
`Superhive-pi-{foldername}.json` becomes the live, watcher-driven control
surface that Superhive (or any external tool) reads and writes.

## What it does

1. **First-run migration** — on the first launch, copies the manifest
   state into `Superhive-pi-{foldername}.json` at the agent root.
2. **File watcher** — watches the file for external changes (Superhive,
   text editor, `jq`, anything). Re-reads, validates, diffs against the
   in-memory snapshot, and applies the diff to the running session.
3. **Live apply** — Tier 1 changes (model, thinking level, active tools,
   environment, providers, permissions) take effect within ~100ms.
4. **Reload-flag** — Tier 2 changes (UI flags, advanced, telemetry) are
   stored and surface a `/reload` notification. User runs the built-in
   `/reload` to apply.
5. **Sessions indexer** — periodically scans `workspace/.pi/agent/sessions/`
   and writes a `sessionsIndex` block with id, name, tokens, cost, path for
   every session.
6. **Catalog scanner** — scans `./skills`, `./extensions`, `./prompts` and
   writes a `catalog` block listing every addable file with its active state.
7. **8 agent-callable tools** — the LLM can also read and write the file
   directly (list_sessions, get_session_detail, update_settings,
   toggle_resource, list_catalog, etc.).

## File format

The file uses the full Settings schema (45+ fields) plus a few
extension-managed blocks. See the schema in [`settings-schema.ts`](./settings-schema.ts).

```jsonc
{
  "version": 1,
  "managedBy": "superhive-pi-truth@1#42",  // writer counter
  "lastModified": "2026-07-06T...Z",

  // Manifest-compatible fields
  "name": "...", "description": "...", "workspace": "./workspace",
  "model": { "provider": "anthropic", "name": "claude-sonnet-4-5" },
  "systemPrompt": "...",
  "environment": { "ANTHROPIC_API_KEY": "sk-..." },
  "skills": ["./skills/review.md"],
  "extensions": ["./extensions/superhive-pi-truth"],
  "prompts": ["./prompts/refactor.md"],
  "permissions": { "filesystem": true, "terminal": true, "network": true },

  // All Settings interface fields
  "theme": "dark", "compaction": {...}, "retry": {...},
  "defaultProvider": "...", "enabledModels": [...],

  // Live runtime state
  "runtime": {
    "thinkingLevel": "high",
    "activeTools": ["read", "write", "edit", "bash"],
    "currentSessionId": "...",
    "lastReloadedAt": "..."
  },

  // Catalog (extension-written, external-readable)
  "catalog": {
    "lastScanned": "...",
    "scanRoots": ["./skills", "./extensions", "./prompts"],
    "skills":     [ { "path": "./skills/review.md", "active": true, "size": 1234 } ],
    "extensions": [ { "path": "./extensions/foo",   "active": false } ],
    "prompts":    [ { "path": "./prompts/x.md",     "active": false } ]
  },

  // Sessions index (extension-written, external-readable)
  "sessionsIndex": {
    "lastUpdated": "...",
    "sessions": [
      { "id": "abc", "name": "...", "messageCount": 42, "tokens": {...}, "cost": 0.012, "path": "..." }
    ]
  },

  // Last event (ring buffer)
  "lastEvent": { "type": "entry_appended", "sessionId": "abc", "timestamp": "..." }
}
```

## Architecture

```
extensions/superhive-pi-truth/
├── package.json          # pi.extensions: ["./index.ts"]
├── index.ts              # entry point; wires everything on session_start
├── settings-schema.ts    # full schema + migration + path helpers
├── file-io.ts            # atomic read/write + writer counter
├── watcher.ts            # fs.watch + debounce + writer-tag guard
├── applier.ts            # diff → runtime API calls (Tier 1 live, Tier 2 flag)
├── sessions-indexer.ts   # scan + write sessionsIndex
├── catalog-scanner.ts    # scan + write catalog
├── state.ts              # module-level singleton shared with tools
├── tools.ts              # 8 agent-callable tools
├── README.md
└── test/                 # 54 unit tests (node:test)
```

## The writer-tag mechanism

Every write bumps a counter encoded in the `managedBy` field as
`superhive-pi-truth@1#N`. The watcher remembers the last-seen counter; if
a watcher event shows a counter `<=` the last-seen one, it's treated as
the agent's own write and skipped. This prevents the agent's own writes
(when it persists catalog/sessions/lastEvent) from being misinterpreted as
external changes.

External writers (Superhive, text editors, `jq`) should either use
TypeBox-compatible writes that go through `writeSettings`, or just edit
the file with any tool — the watcher will detect the change as long as
the counter or `lastModified` timestamp differs.

## Tools (LLM-callable)

| Name | Purpose |
|---|---|
| `get_current_settings` | Return the full file contents |
| `update_settings` | Apply a partial update (JSON Merge Patch, RFC 7396) |
| `list_sessions` | List sessions in the current workspace |
| `get_session_detail` | Granular detail of a session's entries |
| `get_session_tree` | Tree structure (branches + labels) |
| `get_session_stats` | Token totals + cost for a session |
| `list_catalog` | List addable skills/extensions/prompts |
| `toggle_resource` | Enable or disable a skill/extension/prompt |

## Slash commands

- `/superhive-rescan` — rebuild the catalog and sessions index

## Tier classification

| Tier | Examples | Apply |
|---|---|---|
| 1 | `model`, `runtime.thinkingLevel`, `runtime.activeTools`, `environment`, `providers`, `permissions` | Live (~100ms) |
| 2 | `theme`, `compaction`, `retry`, `terminal`, `images`, `thinkingBudgets`, `steeringMode`, `followUpMode`, `skills`, `extensions`, `prompts`, `packages`, `themes` | Stored + reload-flag (user runs `/reload`) |
| 3 | `runtime.currentSessionId`, `lastEvent` | Stored only, agent-managed |

## Running tests

```bash
cd extensions/superhive-pi-truth
../../pi/node_modules/.bin/tsx --test test/*.test.ts
```

54 tests, all passing.

## Security notes

- The file is gitignored (`.gitignore` adds `Superhive-pi-*.json`)
- API keys live in `environment` and `providers` blocks
- `.pi/settings.json` in the workspace is bypassed (per `manifest-pi` design)
- The file should NOT be synced to cloud services or committed to git
- For multi-clone safety, the filename includes the folder name (each clone
  gets its own file)
