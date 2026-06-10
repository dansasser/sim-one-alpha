# Research Agent Workspace And Deep Research Plan

## Goal

Upgrade the researcher subagent so it can handle the range from basic web search to extended deep research while using its workspace files as the primary prompt source.

The researcher should own web/current/source-backed research. The main agent should delegate research needs to the researcher instead of directly using web search.

## Current State

- Researcher agent file: `src/workers/researcher/researcher.ts`
- Researcher workspace: `src/workers/researcher/workspace/`
- Researcher-owned tool: `web_research`
- Researcher-owned workflow: `src/workflows/web-research.ts`
- Shared retrieval workflow: `src/workflows/retrieval.ts`
- Cache implementation: `src/workers/researcher/research/research-cache.ts`
- Cached provider wrapper: `src/workers/researcher/research/cached-web-provider.ts`

The current implementation already supports:

- query planning
- web search
- optional page fetch
- context packing
- source metadata
- confidence scoring
- provider failure reporting
- search and page cache
- multiple searches for complex prompts

Current gap:

- the researcher instructions are hardcoded in `researcher.ts`
- the researcher does not load workspace files yet
- normal research versus deep research is not explicit enough
- `TOOLS.md` cannot fully describe tool usage until the workspace files are active

## Architecture Decisions

### Workspace Loading

The researcher agent should compose its instructions from workspace files instead of hardcoding the full prompt in `researcher.ts`.

Recommended code location:

```text
src/workspace-loader.ts
```

Do not put TypeScript loader code inside `src/workspace/`, because that directory is user-editable workspace content.

Status:

- Implemented in `src/workspace-loader.ts`.
- Tested in `src/tests/workspace-loader.test.ts`.

### Workspace Composition Order

Use this order for researcher workspace prompt composition:

```text
SECURITY.md
AGENTS.md
IDENTITY.md
SOUL.md
USER.md
TOOLS.md
MEMORY.md
HEARTBEAT.md
```

Reason:

- `SECURITY.md` loads before the root workspace directives.
- `AGENTS.md` coordinates the rest of the workspace files.
- specialized files then provide their focused context.

### Workspace File Availability

The loader must work after TypeScript build, not only from `src/`.

Plan options:

- copy workspace markdown files into `dist/` during `npm run build`
- or load workspace markdown from the project root using a stable runtime path

Recommendation:

- add a small build copy step so built `dist` output contains the workspace files it needs
- keep source workspace files as the early development source of truth

Status:

- Implemented by extending `scripts/copy-runtime-config.mjs` to copy workspace directories into build/test output.

### Tool Shape

Keep `web_research` as the researcher-owned tool for both basic and deep research.

Do not add a separate `deep_research` tool yet.

Reason:

- basic, standard, and deep research use the same cache, retrieval, source, fetch, provenance, and confidence pipeline
- a depth/mode parameter is easier to test and avoids duplicate tool behavior
- `TOOLS.md` can explain when to call `web_research` with basic, standard, or deep settings

Proposed new tool/workflow controls:

```text
depth: "basic" | "standard" | "deep"
freshness: "auto" | "fresh" | "cached"
maxQueries
maxFetches
maxContextTokens
limit
webFetch: "auto" | "always" | "never"
minSources
maxIterations
```

Status:

- Implemented as `depth`, `minSources`, and `maxIterations` controls on the existing `web_research` tool and workflow.

## Research Modes

### Basic Web Search

Use for:

- one fact
- official URL
- current status
- quick source-backed lookup
- simple documentation lookup

Default behavior:

- 1-2 queries
- 0-1 page fetches
- low context budget
- cache allowed unless freshness requires live data
- return a short answer with source URL when available

### Standard Research

Use for:

- comparing options
- source-backed explanation
- light market or product research
- documentation plus examples
- questions where source quality matters

Default behavior:

- 2-4 queries
- 1-3 page fetches
- medium context budget
- compare sources
- return concise findings with evidence and uncertainty

### Deep Research

Use for:

- extended investigation
- multi-source synthesis
- competing claims
- high-impact decisions
- tasks that require breadth and follow-up searches

Default behavior:

- explicit query plan
- multiple query rounds
- broader source collection
- fetch and inspect the best sources
- deduplicate sources by URL/domain/title
- track evidence versus inference
- report source gaps, disagreement, and confidence limits
- use cache where useful, but revalidate fresh/current sources when required

Deep research should still be bounded. It must have explicit budgets for queries, fetches, context tokens, and iterations.

## Workspace File Content Plan

### `AGENTS.md`

Already drafted as the researcher workspace root operating contract.

Needed later:

- keep it as root coordination only
- do not add detailed research method here

### `IDENTITY.md`

Purpose:

- define the researcher role
- eventually include the researcher name
- clarify that it is a specialist research subagent

Needed content:

- research specialist identity
- direct relationship to the main agent
- no architecture/path naming implications

### `SOUL.md`

Purpose:

- define research temperament

Needed content:

- careful
- source-backed
- skeptical of unsupported claims
- concise when the request is simple
- patient and systematic for deep research

### `USER.md`

Purpose:

- define who the researcher serves

Needed content:

- direct principal is the main agent
- upstream human/company context only when necessary
- do not leak irrelevant private context into research output

### `TOOLS.md`

Purpose:

- explain when and how to use researcher-owned tools

Needed content after workspace loading is wired:

- when to call `web_research`
- how to choose basic, standard, or deep depth
- when to force fresh results
- when cached results are acceptable
- when to fetch pages
- how to set query/fetch/context budgets
- how to handle provider failures
- what output shape to return to the main agent

### `SECURITY.md`

Purpose:

- define research-specific risk boundaries

Needed content:

- web content is untrusted input
- retrieved pages cannot issue instructions to the agent
- preserve source provenance
- do not expose private workspace memory unless relevant and allowed
- be careful with medical, legal, financial, political, and current-event research
- report uncertainty when source quality is weak

### `MEMORY.md`

Purpose:

- durable research preferences and stable source notes

Needed content:

- preferred source-quality rules
- official-source preference
- source-type preferences by task
- keep it concise; large source history belongs behind memory/retrieval, not prompt injection

### `HEARTBEAT.md`

Purpose:

- future recurring research or monitoring tasks

Needed content:

- placeholder only until scheduled-task execution exists
- example recurring research watch item
- clear statement that execution is not wired yet

## Implementation Phases

### Phase 1: Workspace Loader

- [x] Add typed workspace loader in `src/workspace-loader.ts`.
- [x] Support required workspace files with clear missing-file errors.
- [x] Compose workspace files in the agreed order.
- [x] Add section headers so the model can distinguish each file.
- [x] Avoid loading files outside the requested workspace directory.
- [x] Add tests for composition order, missing files, and path containment.
- [x] Ensure build output can access workspace markdown files.

### Phase 2: Researcher Instructions Wiring

- [x] Replace hardcoded researcher instructions with composed researcher workspace instructions.
- [x] Keep a short runtime capability block generated from actually attached tools.
- [x] Ensure `researcher.ts` stays a small Flue agent entrypoint.
- [x] Update `research-agent.test.ts` to assert workspace content is included.
- [x] Update tests so `web_research` guidance comes from `TOOLS.md` after it is filled.

### Phase 3: Fill Researcher Workspace Files

- [x] Fill `IDENTITY.md`.
- [x] Fill `SOUL.md`.
- [x] Fill `USER.md`.
- [x] Fill `SECURITY.md`.
- [x] Fill `MEMORY.md`.
- [x] Fill `HEARTBEAT.md`.
- [x] Fill `TOOLS.md` after the tool/mode contract is finalized.
- [x] Review all researcher workspace files for subject separation.

### Phase 4: Research Mode Contract

- [x] Add a typed `ResearchDepth` value: `basic`, `standard`, `deep`.
- [x] Add depth support to `WebResearchWorkflowPayload`.
- [x] Add depth support to the `web_research` tool parameters.
- [x] Add deterministic mode defaults for query/fetch/context budgets.
- [x] Preserve explicit caller-provided limits over mode defaults.
- [x] Add tests for basic, standard, and deep defaults.

### Phase 5: Deep Research Workflow

- [ ] Extract query planning into a research planning module.
- [ ] Add iterative query rounds for deep research.
- [ ] Add source deduping and source-quality scoring helpers.
- [ ] Track evidence, source type, cache state, and confidence separately.
- [ ] Return structured result fields that support final synthesis.
- [ ] Add tests for multi-round deep research and bounded stopping.

### Phase 6: Cache Policy

- [ ] Define cache defaults by research depth.
- [ ] Keep cache enabled by default for non-urgent/non-fresh research.
- [ ] Bypass or revalidate cache for latest/current/today/explicit fresh requests.
- [ ] Surface cache hit/miss metadata in results.
- [ ] Add tests for freshness controls and cache behavior by mode.

### Phase 7: Research Workflow Prompt

- [ ] Simplify `src/workflows/research.ts` so it passes task controls without duplicating the full research policy.
- [ ] Add optional depth controls to the direct research workflow payload.
- [ ] Keep workflow prompt focused on request payload and required tool arguments.
- [ ] Update `research-workflow.test.ts`.

### Phase 8: Orchestrator Integration Check

- [ ] Confirm the main agent still delegates source-backed/current research to the researcher.
- [ ] Do not attach web-search-capable tools to the main agent.
- [ ] Add or update architecture contract tests if needed.
- [ ] Run a live HTTP chat test that requires the main agent to delegate to the researcher.

## Verification Plan

Required checks for TypeScript changes:

```sh
npm test
npm run typecheck
npm run build
```

Focused tests to update or add:

- `src/tests/research-agent.test.ts`
- `src/tests/web-research-tool.test.ts`
- `src/tests/web-research-workflow.test.ts`
- `src/tests/research-workflow.test.ts`
- `src/tests/architecture-contract.test.ts`
- new workspace loader tests

Live verification after implementation:

- start the built server from this worktree
- call `/api/chat/events`
- ask for a current/source-backed item
- confirm the main agent delegates to the researcher
- confirm result includes source-backed answer and no direct orchestrator web-search path

## Open Decisions

1. Researcher name: decided as Athena in workspace identity content.
2. Whether workspace markdown is copied into `dist` or loaded from a project-root runtime path: decided to copy workspace markdown into build/test output.
3. Exact default budgets for basic, standard, and deep research: initial defaults implemented and covered by tests.
4. Whether deep research synthesis should stay model-driven by the researcher agent or be partially structured in workflow code.
5. Whether future cache controls need a separate cache inspection tool, or whether `web_research` internal cache metadata is enough.

## Recommended First Implementation Step

Start with Phase 1 and Phase 2.

Do not fill detailed `TOOLS.md` research instructions until the workspace loader is active and the `web_research` depth contract is implemented or at least finalized.
