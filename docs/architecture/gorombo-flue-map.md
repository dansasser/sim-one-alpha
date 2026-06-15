# GOROMBO Flue Map

This file maps Flue architecture to this repository.

## Top-Level Source Directory Map

Every top-level `src/` directory should fit one of these categories. If a new directory is added, update this map in the same change.

| Path | Type | Ownership rule |
| --- | --- | --- |
| `src/agents/` | Flue agent entrypoints | Main `createAgent(...)` files discovered by Flue. |
| `src/approvals/` | Shared approval subsystem | Approval service factory and ingress types shared by the coding worker and connectors/HTTP/CLI surfaces. |
| `src/commands/` | Pre-LLM command parsing | Slash command definitions and parsing that run before prompts reach the LLM. |
| `src/config/` | Runtime configuration | Typed config loaders and shipped runtime config source files. |
| `src/ingress/` | Application ingress modules | Cross-cutting ingress logic that turns internal worker events and storage into HTTP/connector-facing surfaces. Example: the approval ingress bridges `CodingApprovalService` to HTTP routes, CLI, and connectors. |
| `src/connectors/` | Connector normalization | External-source adapters that normalize input into internal message shapes. |
| `src/memory/` | Shared memory subsystem | Memory retrieval interfaces and routing shared by agents/tools/workflows. |
| `src/middleware/` | HTTP middleware | Reusable Hono middleware such as API-secret auth. |
| `src/models/` | Model subsystem | Model cards, provider registration, model registry, limits, and runtime bootstrap. |
| `src/protocols/` | Protocol storage/access subsystem | Protocol schemas and provider implementations used by protocol tools. |
| `src/rag/` | Shared retrieval subsystem | Retrieval provider interfaces and routing. This name is pending a user-selected rename, but the concept remains top-level because it is shared architecture. |
| `src/registries/` | Registry subsystem | Typed registries for tools, skills, agents, protocols, and future discoverable capabilities. |
| `src/routes/` | HTTP route modules | Concrete app-owned Hono route registration modules. |
| `src/schemas/` | Shared runtime schemas | Valibot schemas for structured-output contracts and cross-subsystem data shapes. Each domain owns a file here when its schemas are reused outside a single file. Imported by `src/types/` and worker type contracts; kept separate so type-only consumers do not pull in schema runtime code. |
| `src/session/` | Session/context subsystem | Flue session persistence, compaction policy, context budget, and usage tracking. |
| `src/services/` | Shared service modules | Non-tool persistence helpers used by both routes and tools, such as `knowledge-service.ts`. Kept separate from `src/tools/` so routes do not import tool modules and tools do not import route modules. |
| `src/telemetry/` | Observability subsystem | Sanitized Flue event capture and run summaries. |
| `src/tests/` | Test suite | Node test files compiled to `.tmp/tsc/tests`. |
| `src/tools/` | Model-callable tools | `defineTool(...)` capabilities attached only to owning agents. |
| `src/types/` | Shared TypeScript contracts | Public/common interfaces used across subsystems. |
| `src/utils/` | Generic helpers | Small cross-cutting helpers only; domain subsystems do not belong here. |
| `src/workers/` | Worker/subagent implementations | Specialized worker profiles plus worker-local support code and worker workspaces. |
| `src/workflows/` | Flue workflows | Finite Flue operations that can initialize agents, manage bounded loops, and return structured results. |
| `src/workspace/` | Main agent workspace content | User-editable persona markdown for the main agent. Also the default coding-worker sandbox root; code work lives under `repos/` and non-git projects under `projects/` inside this directory. No TypeScript runtime code belongs here. |

Root source files:

```text
src/app.ts
  Hono application shell and Flue route mount.

src/db.ts
  Flue Node persistence adapter entrypoint discovered by Flue at build time.
  Exports the GOROMBO persistence adapter wrapper around Flue's sqlite() adapter.

src/index.ts
  Package barrel for exported connector, registry, and type helpers.
  It must not re-export removed non-Flue orchestrator or gateway paths.

src/workspace-loader.ts
  Shared workspace markdown loader.
  Composes workspace files in a fixed order for agent instructions.
  Stays as a root support file because it is currently the only file in this category.
  Keeps user-editable workspace content separate from TypeScript agent entrypoints.
```

## Runtime Surfaces

```text
src/app.ts
  Hono application shell.
  Mounts Flue with app.route('/', flue()).
  May expose health checks and app-owned ingress.
  Registers the lightweight Flue telemetry observer.
  Applies imported API-secret middleware to public Flue route families.
  Custom chat ingress forwards to the durable Flue orchestrator agent route.
  Must not call the old non-Flue orchestrator.

src/middleware/api-secret.ts
  Imported Hono middleware for API-secret auth.
  Reads runtime env bindings and Node process env.
  Fails closed when API_SECRET is missing.

src/routes/chat-events.ts
  App-owned /api/chat/events ingress alias.
  Verifies API-secret middleware, exposes /api/chat/sessions for HTTP chat lists, normalizes the HTTP boundary, persists trusted event context, resolves the product session, and prompts the durable /agents/orchestrator/:sessionId route.
  Does not call c.executionCtx, a workflow route for normal chat execution, or a non-Flue orchestrator.

src/routes/knowledge.ts
  App-owned /api/knowledge and /api/knowledge/reindex routes.
  Accepts API-secret-authenticated knowledge entries, persists them to the vector knowledge base, and triggers background re-indexing of project files and knowledge docs.

src/db.ts
  Flue persistence adapter entrypoint.
  Uses Flue's Node sqlite() adapter for canonical agent sessions, durable direct/dispatch submissions, and event streams.
  Supplies SQLite workflow run and run registry records through GOROMBO's persistence wrapper.
  Wraps the Flue session store to maintain logical session indexes, direct agent instance indexes, persisted normalized event context, and extracted session-memory FTS records.
  Exposes a shared LanceDB vector store and embedding client used by session memory, document index, and knowledge base retrieval.

src/routes/telemetry.ts
  Protected app-owned telemetry inspection routes.
  Exposes sanitized Flue event summaries by workflow run id.
  Falls back to persisted Flue run events when the in-memory telemetry observer no longer has the run.

src/schemas/
  Shared Valibot schemas for structured runtime contracts.
  Owned by the subsystem that defines the shape; promoted here only when the schema is reused across files or subsystems.
  Example: `src/schemas/coding-worker.ts` holds `CodingImplementerResultSchema` and the derived `CodingImplementerResult` type, used by the implementer subagent tool, the delegation path in `src/workers/coding-worker/workflow/coordination.ts`, and re-exported from `src/workers/coding-worker/types.ts`.

src/telemetry/flue-telemetry.ts
  Registers Flue observe(...) once per running application context.
  Stores sanitized live event summaries in memory by runId.
  Tracks whether a run delegated to the researcher and whether web_research was called.

src/agents/orchestrator.ts
  Main Flue orchestrator agent.
  Coordinates protocols, memory lookup, subagent delegation, and final synthesis.
  Composes its instructions from main workspace files plus a small runtime capability block.
  Does not own web search.

src/workspace/
  Main agent user-editable workspace persona files.
  Persona names and identity details live inside file contents, not architecture paths.

src/workers/researcher/researcher.ts
  Research subagent and direct researcher agent.
  Owns web research behavior.
  Composes its instructions from its workspace files plus a small runtime capability block.
  May use tools, skills, and workflows.

src/workers/researcher/workspace/
  Researcher subagent user-editable workspace persona files.

src/workers/coding-worker/coding-worker.ts
  Coding worker lead subagent profile.
  Owns coding-worker instructions, worker-local GitHub tools, coding-process skills, approval-aware side-effect boundaries, public progress event rules, and worker-local internal subagent profiles.
  The main orchestrator delegates coding work only to this lead profile.
  Receives the configured runtime workspace root from the orchestrator and passes it to worker-owned tools.

src/workers/coding-worker/workspace/
  Coding worker user-editable workspace persona files.
  Documents the lead coding worker identity, principal hierarchy, tools, approval gates, verification rules, and progress expectations.

src/workers/coding-worker/subagents/
  Worker-local internal coding subagents used only by the coding-worker lead.
  Includes triage, implementer, test-debug, code-review, and GitHub/PR specialists.
  These are not top-level orchestrator-addressable workers.

src/workers/coding-worker/tools/
  Worker-local workspace/project, shell, git, GitHub, and approval-aware execution tools.
  File/shell/git/test execution is backed by Flue's Node local sandbox factory.
  The sandbox is rooted at the configured runtime workspace root. By default this root is `src/workspace/` (the main agent persona workspace). User-editable workspace files live at that root; non-git projects live under `projects/**`; repositories live under `repos/**`.
  The coding worker must create or resolve new project work under that runtime workspace root.
  The main orchestrator does not own these tools directly.

src/workers/coding-worker/subagents/<name>/workspace/
  Worker-local subagent user-editable workspace persona files.
  `USER.md` describes the coding-worker lead as the immediate principal, on behalf of the main orchestrator.

src/workspace-loader.ts
  Shared workspace markdown loader.
  Composes workspace files in a fixed order for agent instructions.
  Keeps user-editable workspace content separate from TypeScript agent entrypoints.

src/commands/
  Pre-LLM slash command parsing and command registry helpers.
  Commands are application machinery; they are not sent to the LLM as prompts.

src/config/
  Typed loader and source JSON for the main GOROMBO runtime config file.

dist/gorombo.config.json
  Built editable runtime config shipped with the product. Starts with primary and backup model card keys.

src/workflows/research.ts
  Finite direct research harness for testing or direct research runs.
  Initializes the researcher.

src/workflows/retrieval.ts
  Shared retrieval machinery.
  Web-search provider access is restricted to the researcher/research workflow caller boundary.
  Does not expose a public route.

src/workflows/web-research.ts
  Researcher-owned web research workflow.
  Handles query planning, basic/standard/deep research depth, cache, web search, fetch, evidence packing, confidence, and failures.
  Used by the researcher-owned web_research tool.

src/tools/protocol-tool.ts
  Orchestrator-safe protocol loading tool.

src/tools/memory-tool.ts
  Orchestrator-safe memory lookup tool.
  Uses persisted session-memory FTS records and LanceDB vector embeddings extracted from Flue SessionData.
  Combines keyword and semantic search for hybrid retrieval.

src/tools/knowledge-tool.ts
  Orchestrator-safe knowledge writing tool.
  Embeds and stores agent-captured knowledge in the vector knowledge base.

src/tools/web-research-tool.ts
  Researcher-owned web research tool.
  Accepts bounded research controls such as depth, freshness, query/fetch budgets, and context budgets.

src/tools/rag-tool.ts
  Researcher-only low-level retrieval tool.
  Not attached to the orchestrator.

src/workers/researcher/research/
  Researcher-owned research cache and web-provider wrappers.

src/models/providers/
  Provider registration and provider-owned model cards.
  Providers resolve env bindings declared by their cards.
  Providers with multiple cards store them in their own cards/ subdirectory.

src/models/catalog.ts
  Aggregates provider-owned cards and resolves Flue model specifiers.

src/models/runtime.ts
  Model-provider runtime bootstrap.
```

## Orchestrator Boundary

Allowed orchestrator capabilities:

```text
load_protocols
retrieve_memory
task delegation to researcher/coding/future workers
final synthesis
```

Forbidden orchestrator capabilities:

```text
web_search
web_fetch
retrieve_context when it can select web-search
direct RAG router web provider access
old non-Flue orchestrator routes
```

## Research Boundary

The researcher owns:

```text
web_research
query planning
one-search versus multi-search decisions
source/page cache
web search
web fetch
source comparison
confidence
provider failure reporting
structured findings
```

The researcher may implement that behavior through tools, skills, and workflow files.

## app.ts Contract

`src/app.ts` must stay close to:

```ts
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';
import './models/runtime.js';
import { requireApiSecret } from './middleware/api-secret.js';
import { registerChatEventRoutes } from './routes/chat-events.js';
import { registerTelemetryRoutes } from './routes/telemetry.js';
import { registerFlueTelemetryObserver } from './telemetry/flue-telemetry.js';

registerFlueTelemetryObserver();

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

app.use('/agents/*', requireApiSecret);
app.use('/workflows/*', requireApiSecret);
app.use('/runs/*', requireApiSecret);
registerChatEventRoutes(app);
registerTelemetryRoutes(app);
app.route('/', flue());

export default app;
```

Custom ingress may be added only if it enters the Flue agent/workflow path.

The built HTTP chat path enters the durable orchestrator agent route:

```text
POST /api/chat/events
-> persist normalized event context in SQLite
-> POST /agents/orchestrator/:sessionId?wait=result
-> 200 { result, streamUrl, offset, event, session }
```

Async connector-style delivery should use Flue `dispatch(...)` against the orchestrator agent instance. Direct prompts and dispatched inputs share Flue's durable agent submission lifecycle when the Node runtime uses the SQLite `src/db.ts` adapter.
