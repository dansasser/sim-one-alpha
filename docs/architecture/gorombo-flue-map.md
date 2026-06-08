# GOROMBO Flue Map

This file maps Flue architecture to this repository.

## Runtime Surfaces

```text
src/app.ts
  Hono application shell.
  Mounts Flue with app.route('/', flue()).
  May expose health checks and app-owned ingress.
  Custom chat ingress forwards to the Flue chat workflow.
  Must not call the old non-Flue orchestrator.

src/agents/orchestrator.ts
  Main Flue orchestrator agent.
  Coordinates protocols, memory lookup, subagent delegation, and final synthesis.
  Does not own web search.

src/agents/researcher.ts
  Research subagent profile and direct researcher agent.
  Owns web research behavior.
  May use tools, skills, and workflows.

src/workflows/chat.ts
  Finite chat workflow.
  Normalizes a web/API message, initializes the orchestrator, checks session budget, compacts before oversize prompts, and prompts the orchestrator.

src/workflows/research.ts
  Finite direct research harness for testing or direct research runs.
  Initializes the researcher.

src/workflows/retrieval.ts
  Shared retrieval machinery.
  Web-search provider access is restricted to the researcher/research workflow caller boundary.
  Does not expose a public route.

src/workflows/web-research.ts
  Researcher-owned web research workflow.
  Handles query planning, cache, web search, fetch, evidence packing, confidence, and failures.
  Used by the researcher-owned web_research tool.

src/tools/protocol-tool.ts
  Orchestrator-safe protocol loading tool.

src/tools/memory-tool.ts
  Orchestrator-safe memory lookup tool.

src/tools/web-research-tool.ts
  Researcher-owned web research tool.

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

const app = new Hono();

app.get('/health', (c) => c.json({ ok: true }));

app.route('/', flue());

export default app;
```

Custom ingress may be added only if it enters the Flue agent/workflow path.
