# Capability System

The capability system lets users and agents add skills, tools, workers (subagents), and MCP servers to a running SIM-ONE Alpha instance without rebuilding.

## Overview

Capabilities are stored in SQLite (`~/.gorombo/db/capabilities.sqlite` by default). The orchestrator reads the store at agent init (`createAgent(...)`) and merges user-defined capabilities into the same `tools`, `skills`, and `subagents` arrays that hold built-in capabilities. A service restart picks up changes — no rebuild needed.

Four capability kinds:

| Kind | Flue ingress | Runtime loading path |
| --- | --- | --- |
| Skill | `skills: [...]` + auto-discovery of `<cwd>/.agents/skills/<name>/` | Materialize user skill dirs into the discovery path. Flue loads natively. |
| Tool | `tools: ToolDefinition[]` | Dynamic `import()` of user JS modules exporting `defineTool(...)` results. (Phase 2) |
| Worker (subagent) | `subagents: AgentProfile[]` | Dynamic `import()` of user JS modules exporting `defineAgentProfile(...)` results. (Phase 2) |
| MCP | `connectMcpServer(name, opts) -> { tools }` | `connectMcpServer(...)` per enabled row at init; tools spread into `tools`. |

## Architecture

```text
User/Agent adds capability
-> capability-admin.mjs (CLI) or agent tool (Phase 3)
-> SQLite capabilities table
-> Service restart
-> createAgent(...) init
-> loadUserCapabilities(env) reads SQLite
-> materializeCapability() copies/clones skill dirs
-> connectUserMcpServers() opens MCP connections
-> merge into tools/skills/subagents arrays
-> built-in + user capabilities live together
```

## SQLite Schema

```sql
CREATE TABLE capabilities (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,  -- 'skill' | 'tool' | 'worker' | 'mcp'
  name          TEXT NOT NULL,
  description   TEXT NOT NULL,
  source        TEXT NOT NULL,  -- 'github' | 'local' | 'npm' | 'builtin'
  source_ref    TEXT NOT NULL,  -- URL | path | pkg name
  version       TEXT,
  enabled       INTEGER NOT NULL DEFAULT 0,
  config_json   TEXT NOT NULL DEFAULT '{}',
  installed_at  TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  installed_by  TEXT NOT NULL DEFAULT 'cli'
);
```

SQLite is authoritative. A config-file mirror (`gorombo.config.json` `capabilities` section) reconciles into SQLite on boot. (Phase 4)

## CLI

```sh
# Add a skill from GitHub
pnpm capabilities:add skill https://github.com/user/my-skill my-skill "My Skill" "Does X" --enable

# Add a skill from local path
pnpm capabilities:add skill /path/to/skill-dir my-skill "My Skill" --enable

# Add an MCP server
pnpm capabilities:add mcp my-mcp "My MCP Server" "Description" --url http://localhost:8080 --enable

# List all capabilities
pnpm capabilities:list

# List by kind
pnpm capabilities:list skill

# Enable/disable
pnpm capabilities:enable skill my-skill
pnpm capabilities:disable skill my-skill

# Update (re-fetch from source)
pnpm capabilities:update skill my-skill

# Remove
pnpm capabilities:remove skill my-skill
```

Environment variables:
- `GOROMBO_CAPABILITY_DB_PATH` — SQLite path (default: `.gorombo/db/capabilities.sqlite`)
- `GOROMBO_CAPABILITIES_DIR` — capability files root (default: `.gorombo/capabilities/`)

## Directory Layout

```text
.gorombo/capabilities/
  skills/<id>/SKILL.md + supporting files
  tools/<id>/index.mjs         (Phase 2)
  workers/<id>/index.mjs       (Phase 2)
```

Capabilities live outside `dist/` and survive upgrades.

## Source Code

```text
src/capabilities/
  types.ts                 CapabilityRecord, CapabilityStore interfaces
  capability-store.ts      SQLite CRUD
  capability-loader.ts     loadUserCapabilities(env) — reads SQLite, returns grouped by kind
  skill-materializer.ts    copies/github-clones user skill dirs into Flue's discovery path
  mcp-broker.ts            connectUserMcpServers() — opens MCP connections, returns tools
  index.ts                 barrel exports

scripts/
  capability-admin.mjs     CLI admin script (add/list/enable/disable/remove/update)

src/agents/
  orchestrator.ts          Modified — calls loadUserCapabilitiesFromStore(env) at init,
                            merges user tools/MCP into tools array, user workers into subagents
```

## Restart, Not Rebuild

Adding a capability writes to SQLite. The user restarts the running service (`node dist/server.mjs`) to pick it up. On restart, `createAgent(...)` init re-runs, the merge layer re-reads SQLite and re-scans the capability dir. No `flue build` needed — the built artifact in `dist/` doesn't change. User-defined capabilities live in SQLite + `~/.gorombo/capabilities/`, both outside `dist/`.

## Approval Gating (Phase 3)

Agent-initiated additions of code-exec kinds (tool, worker, MCP) will go through the existing approval service (fail-closed). Skill additions skip approval (markdown only, no code exec). CLI additions skip approval (user is the principal).

## Config-File Mirror

`gorombo.config.json` has a `capabilities` array that reconciles into SQLite on boot (in `src/db.ts`, at server startup — before any agent request). Config is additive: entries in config but missing from SQLite get inserted with `installedBy: "seed"`; entries already in SQLite are skipped (idempotent). Removal is a CLI/db operation, not a config edit.

```json
{
  "version": 1,
  "models": { "primary": "..." },
  "capabilities": [
    {
      "id": "my-skill",
      "kind": "skill",
      "name": "My Skill",
      "description": "...",
      "source": "github",
      "sourceRef": "https://github.com/user/my-skill",
      "enabled": true
    }
  ]
}
```