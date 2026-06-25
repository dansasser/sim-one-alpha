# Astro Docs MCP — Built-in and Coding Agent Integration

## Built-in MCP for the Orchestrator

SIM-ONE Alpha includes a built-in MCP connection to the Astro docs MCP server (`https://mcp.docs.astro.build/mcp`). This is wired in `src/engine/capabilities/builtin-mcp.ts` and connected at orchestrator init alongside user-defined MCP servers.

The built-in MCP gives the orchestrator access to the `mcp__astro-docs__search_astro_docs` tool, which searches Astro framework documentation. This is useful because:
- Flue is built by the Astro team — the agent can look up Flue-adjacent framework docs
- The gorombo.com website is built with Astro — the agent can help with Astro development
- It serves as a working example of Flue's MCP integration out of the box
- It fills the `mcpServers` array in `builtin-capabilities.json` so the builtin registry is complete

The `astro-docs` name is reserved in the builtin registry — users cannot add a capability with that name.

## Coding Agent Workflow (planned)

The coding worker should also have access to the Astro docs MCP. When the coding agent is working on:
- The gorombo.com website (Astro-based)
- Flue integration code (Astro team framework)
- Any Astro component or page

...it should be able to search the Astro docs directly from its workflow without delegating to the researcher subagent.

### How to wire it

The coding worker is created in `src/agents/orchestrator.ts` via `createCodingWorkerSubagent()`. To give the coding worker access to the Astro docs MCP:

1. Call `connectBuiltinMcpServers()` during coding worker creation (same as the orchestrator does)
2. Pass the resulting tools to the coding worker's `tools` array
3. The coding worker's workspace should document that `mcp__astro-docs__search_astro_docs` is available for Astro-related questions

This keeps the MCP connection shared (one connection per process, not per agent) while giving the coding worker direct access to the search tool.

### Important boundaries
- The coding worker should NOT get access to user-defined MCP servers (those are orchestrator-only unless explicitly configured)
- The built-in Astro docs MCP is safe to share with the coding worker (read-only, public, no secrets)
- The researcher subagent does NOT need this MCP (it has its own web research tools that are more capable)

## Related

- `src/engine/capabilities/builtin-mcp.ts` — built-in MCP connection implementation
- `src/agents/orchestrator.ts` — where the built-in MCP is wired into the orchestrator
- `scripts/generate-builtin-registry.mjs` — includes `astro-docs` in the `mcpServers` array
- `docs/architecture/capability-system.md` — full capability system documentation
- `docs/architecture/product-flow.md` — product flow including MCP as a capability kind