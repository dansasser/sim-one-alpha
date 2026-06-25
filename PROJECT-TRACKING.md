# Project Tracking Bundle — Capability Registry Workstream

## Current Worktree

- **Path:** `/opt/ai/sim-one-alpha-capability-registry/`
- **Branch:** `opencode/capability-registry`
- **Base:** `main` at `f0c9cfb` (PR #46 merged)
- **Latest commit:** `2f0ca09` (MCP SDK dep + broker timeout)
- **Commits on branch:** 5 (add18af, 7d33b39, 1706e80, 6af4fcf, 2f0ca09)
- **PR status:** NOT opened yet — waiting for MCP end-to-end verification

## Other Worktrees (do NOT work in these)

- `/opt/ai/sim-one-alpha/` — main checkout, `main` branch. Source of `.env` and `assets/` if needed.
- `/opt/ai/sim-one-alpha-capability-registry-tui-proto/` — tui-proto worktree, `opencode/agent-tui-proto` branch. PR #46 merged. Has a working `dist/server.mjs` build from before.

## Environment Facts (MEMORIZE THESE)

### Node.js
- **Required:** Node >= 22.18.0 (per `package.json#engines`)
- **Installed:** v22.22.3 at `/root/.nvm/versions/node/v22.22.3/bin/node`
- **nvm script:** `source /root/.nvm/nvm.sh && nvm use 22`
- **IMPORTANT:** `pnpm` and `npx` use whatever Node is first on PATH. If `nvm use 22` hasn't been sourced in the current shell, they default to Node v20.20.0 which is TOO OLD for Flue. Always set PATH first:
  ```sh
  export PATH="/root/.nvm/versions/node/v22.22.3/bin:$PATH"
  ```
- **Direct node binary (no nvm needed):** `/root/.nvm/versions/node/v22.22.3/bin/node`

### Rust / WASM
- **wasm-pack:** `/root/.cargo/bin/wasm-pack`
- **cargo env:** `source ~/.cargo/env`
- **Required for build:** `prebuild` script runs `wasm-build.mjs` which needs wasm-pack on PATH
- **WASM artifact:** `crates/gorombo-memory/pkg/gorombo_memory_bg.wasm` — built by wasm-pack, copied to `.gorombo/sim-one-alpha/memory/` by `copy-wasm-artifact.mjs`

### .env File
- **Location:** `/opt/ai/sim-one-alpha-capability-registry/.env` (copied from main checkout)
- **Source:** `/opt/ai/sim-one-alpha/.env` — copy if missing: `cp /opt/ai/sim-one-alpha/.env .env`
- **Key env vars:** `OLLAMA_API_KEY`, `CODEX_BRAIN_LOCAL_API_KEY`, `CODEX_BRAIN_LOCAL_API_URL`, `JINA_API_KEY`, `API_SECRET` (external connectors only), `JUELS_API_KEY`, `RUNPOD_API_KEY`
- **No TELEGRAM_* vars** — Telegram is optional (fixed in PR #46)
- **No GOROMBO_APPROVAL_ROOT** — approval endpoints return 400/500 (not configured)

### Embedding Model (ONNX)
- **Location:** `assets/models/embeddings/all-MiniLM-L6-v2/model.onnx` (90MB, gitignored)
- **Fetch:** `pnpm fetch-embedding-model` (downloads from HuggingFace)
- **If missing:** server logs `[WARN] embedding.onnx-local.unavailable` and background indexing fails, but server still boots
- **Startup time:** ONNX model load blocks the event loop for ~30 seconds. Server accepts TCP but doesn't respond to HTTP until load completes. Health check will fail for ~30s then start working.

### Port Conflicts
- Port 3000 is nginx on this machine — DO NOT use for SIM-ONE Alpha server
- Port 9300 is another node service — DO NOT use
- Use ports 3940-3960 range for testing
- Always check `ss -tlnp | grep <port>` before starting a server
- ALWAYS kill old servers before starting new ones: `kill <pid>` (get PID from `pgrep -f "node.*<port>"`)

## Architecture Context

### What We're Building
Runtime capability registry for SIM-ONE Alpha — lets users and agents add skills, tools, workers (subagents), and MCP servers to a running instance without rebuilding. Service restart picks up changes.

### Key Design Decisions (settled with Dan)
1. **Restart required** (not rebuild, not hot-reload) — user restarts `node .gorombo/sim-one-alpha/server.mjs` to pick up new capabilities
2. **Same loading path as built-ins** — merge layer in `orchestrator.ts` reads SQLite + scans dir at init, spreads into `tools/skills/subagents` arrays alongside built-in imports
3. **SQLite authoritative** — config file is a mirror that reconciles into SQLite on boot (additive, idempotent)
4. **`~/.gorombo/capabilities/`** for user skill/tool/worker dirs (outside `.gorombo/sim-one-alpha/`, survives upgrades)
5. **Admin CLI** — standalone `capability-admin.mjs` script (like `protocol-admin.mjs` pattern)
6. **Approval gating** — skills auto-enable (markdown only); tools/workers/MCP require user approval (enabled=0 until CLI/TUI approves)
7. **3rd plan impact** — agent-tui plan defines where things ultimately live (production TUI owns admin subcommands); this PR builds runtime store + merge layer

### Phase Status
- **Phase 1** ✅ — SQLite capability store + CLI + merge layer + docs (commit `add18af`)
- **Phase 2** ✅ — Tool/worker dynamic-import loaders (commit `7d33b39`) — verified: agent called `user_echo` tool
- **Phase 3** ✅ — Agent add-capability tools with approval gating (commit `1706e80`) — verified: agent added skill via `add_skill` tool
- **Phase 4** ✅ — Config-file mirror reconcile at boot (commit `6af4fcf`) — verified: reconciled at boot, idempotent on restart
- **MCP fix** ✅ — `@modelcontextprotocol/sdk` dep + broker timeout (commit `2f0ca09`) — verified: `connectMcpServer` works directly against Astro docs MCP

### 400 Investigation — RESOLVED (not a bug)

**Finding:** The 400 is a **curl-specific issue**, not a server bug. The server works correctly with Node's `fetch()` and `@flue/sdk`.

- `curl -X POST /agents/orchestrator/test` → 400 (empty body)
- `fetch('POST /agents/orchestrator/test')` → 202 (correct, returns submissionId)
- `@flue/sdk client.agents.send()` → 202 (correct)

**Verified pre-existing:** The 400 happens on the tui-proto build too (before any capability changes). It's a `curl` vs `@hono/node-server` compatibility issue, not caused by the capability system.

**Impact:** None. The TUI uses `@flue/sdk` which uses `fetch()`. The 400 only affects manual curl testing. The server and all its endpoints work correctly with fetch/SDK.

### MCP End-to-End — VERIFIED

The full MCP flow works:
1. `capability-admin.mjs add mcp astro-docs --url https://mcp.docs.astro.build/mcp --transport streamable-http --enable` → SQLite row
2. Server restart → agent init → `[capabilities] MCP connected: astro-docs (1 tools)`
3. Agent prompt → agent finds `mcp__astro-docs__search_astro_docs` tool → calls it → returns search results

The agent successfully called the MCP tool and returned Astro docs search results for "view transitions".

### Memory Leak (verified by another agent — do not re-litigate)
- **Symptom:** Built server grows to ~16GB resident in under a minute, gets OOM-killed every 3-7 min. `flue dev` restarts it, making it look like things are "working" but the process is dying constantly. Global OOM can take down collateral processes.
- **NOT the cause:** wasm/gorombo-memory (no .wasm mapped in leaking process; in-memory engine fallback is running)
- **Root cause area:** `runBackgroundIndexing` in `src/rag/indexers/background-indexer.ts`, fired fire-and-forget from `src/session/session-persistence.ts:55`. It loads ALL knowledge docs + ALL project files, embeds the entire corpus in a single batch via `embeddingClient.embedBatchWithOutcome(contents)`, and writes to LanceDB in one Arrow batch via `vectorStore.upsert(collection, vectorRecords)`.
- **Leak is native, not JS:** ~20.6GB single contiguous native allocation (onnxruntime-node + LanceDB path). JS heap is only ~130MB.
- **Fix direction (needs verification):**
  1. Batch the indexing — chunk records into fixed-size batches, embed/upsert per batch instead of one shot
  2. Cap/tune onnxruntime arena and LanceDB Arrow buffer sizes
  3. Make background indexing incremental/debounced rather than re-embedding entire corpus per session init
- **Unpinned:** Whether the 20.6GB is onnxruntime's tensor arena or LanceDB's Arrow buffer specifically. Needs native profiler on a fresh instance (catch in first ~20s before OOM).
- **Containment while working:** `systemd-run --scope --unit=flue-dev-cap -p MemoryMax=6G -p MemoryHigh=4G pnpm dev` — leak still happens but only dev tree recycles, box stays up. Remove cap once fixed.

### Plans
- `/opt/ai/plans/capability-registry/plan.md` — the system being built
- `/opt/ai/plans/agent-tui-proto/plan.md` — tui-proto (done, PR #46 merged)
- `/opt/ai/plans/agent-tui/plan.md` — production TUI (future)

## Build & Test Commands (ALWAYS use correct Node)

```sh
# Set PATH FIRST (do this every time before any command)
export PATH="/root/.nvm/versions/node/v22.22.3/bin:$PATH"
source ~/.cargo/env 2>/dev/null

# Install deps
pnpm install

# Fetch embedding model (one-time)
pnpm fetch-embedding-model

# Copy .env if missing
cp /opt/ai/sim-one-alpha/.env .env

# Build
pnpm run build

# Typecheck
pnpm run typecheck

# Unit tests
pnpm run test:unit

# Start built server (use a port in 3940-3960 range)
PORT=3956 node --env-file=.env .gorombo/sim-one-alpha/server.mjs

# Start dev server (watches for changes, rebuilds automatically)
npx flue dev --target node --port 3956

# CLI admin
node scripts/capability-admin.mjs list
node scripts/capability-admin.mjs add skill /path/to/skill my-skill "My Skill" --enable
node scripts/capability-admin.mjs add mcp my-mcp "My MCP" --url http://localhost:8080 --enable

# Kill servers
kill $(pgrep -f "node.*<port>")
```

## Server Startup Sequence
1. `node --env-file=.env .gorombo/sim-one-alpha/server.mjs` starts
2. `src/db.ts` loads → config reconcile runs → `[capabilities] Reconciled N capability(ies)` if config has capabilities
3. ONNX model loads (~30 seconds, blocks event loop) → `[INFO] embeddings.onnx-loaded`
4. `[flue] Server listening on http://localhost:<port>`
5. Health endpoint starts responding (`GET /health` → `{"ok":true}`)
6. Agent init (`createAgent`) runs on FIRST agent request, not at boot
7. Agent init calls `loadUserCapabilitiesFromStore()` → reads SQLite → materializes skills → connects MCP servers → loads user tools/workers → merges into tools/subagents arrays

## Key Files (in capability-registry worktree)

```
src/capabilities/
  types.ts                      — CapabilityRecord, CapabilityStore interfaces
  capability-store.ts           — SQLite CRUD (node:sqlite DatabaseSync)
  capability-loader.ts          — loadUserCapabilities(), resolveCapabilitiesDir()
  skill-materializer.ts         — copies/github-clones skill dirs into discovery path
  mcp-broker.ts                 — connectUserMcpServers() with 15s timeout
  tool-loader.ts                — dynamic import() of user tool modules
  worker-loader.ts              — dynamic import() of user worker modules
  dynamic-import.ts             — pathToFileURL + import() helper
  capability-config-reconcile.ts — reconciles config capabilities into SQLite at boot
  index.ts                      — barrel exports

src/tools/capability-tools.ts   — add_skill, add_tool, add_worker, add_mcp_server, list_capabilities
src/agents/orchestrator.ts      — merge layer (loadUserCapabilitiesFromStore at init)
src/db.ts                       — config reconcile at boot
src/config/gorombo-config.ts    — GoromboCapabilityConfig type
src/config/gorombo.config.json  — capabilities: [] array

scripts/capability-admin.mjs    — CLI admin (add/list/enable/disable/remove/update)
docs/architecture/capability-system.md — full system docs
docs/architecture/gorombo-flue-map.md  — updated with capabilities dir
```

## Dependencies Added (not in original main)
- `@modelcontextprotocol/sdk: ^1.29.0` — needed by Flue's `connectMcpServer` at runtime (dynamic import)
- `@hono/node-server: ^2.0.6` — needed by Flue's built server for HTTP request handling (was in pnpm store but not hoisted)

## Known Test Failures (pre-existing, not caused by this work)
- 3 embedding tests fail with dimension mismatch (768 vs 384): `createEmbeddingClient truncates long input`, `createEmbeddingClient tries cloud first`, `createEmbeddingClient embedWithOutcome reports onnx-local`
- These fail on clean main too (just need the right Node version + embedding model to reproduce)