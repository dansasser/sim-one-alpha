# GOROMBO Flue Map

This file maps Flue architecture to this repository.

## Runtime Surfaces

```text
src/app.ts
  Hono application shell.
  Mounts Flue with app.route('/', flue()).
  May expose health checks and app-owned ingress.
  Registers the lightweight Flue telemetry observer.
  Applies imported API-secret middleware to public Flue route families.
  Custom chat ingress forwards to the Flue chat workflow.
  Must not call the old non-Flue orchestrator.

src/middleware/api-secret.ts
  Imported Hono middleware for API-secret auth.
  Reads runtime env bindings and Node process env.
  Fails closed when API_SECRET is missing.

src/routes/chat-events.ts
  App-owned /api/chat/events ingress alias.
  Verifies API-secret middleware, normalizes the HTTP boundary, and forwards to /workflows/chat.
  Does not call c.executionCtx or a non-Flue orchestrator.

src/routes/telemetry.ts
  Protected app-owned telemetry inspection routes.
  Exposes sanitized Flue event summaries by workflow run id.

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

src/persona/workspace-loader.ts
  Shared workspace markdown loader.
  Composes workspace files in a fixed order for agent instructions.
  Keeps user-editable workspace content separate from TypeScript agent entrypoints.

src/workflows/chat.ts
  Finite chat workflow.
  Normalizes a web/API message, initializes the orchestrator, checks session budget, compacts before oversize prompts, prompts the orchestrator, and retries with the configured backup model card when the primary model is recoverably unavailable.
  Exposes its Flue HTTP route through imported API-secret middleware.

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

src/tools/web-research-tool.ts
  Researcher-owned web research tool.
  Accepts bounded research controls such as depth, freshness, query/fetch budgets, and context budgets.

src/tools/rag-tool.ts
  Researcher-only low-level retrieval tool.
  Not attached to the orchestrator.

src/research/
  Research cache and web-provider wrappers.

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

The built HTTP chat path is asynchronous because it uses Flue workflow routing:

```text
POST /api/chat/events
-> POST /workflows/chat
-> 202 { runId }
-> GET /runs/:runId
-> completed workflow result
```
