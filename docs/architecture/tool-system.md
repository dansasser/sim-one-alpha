# Tool System

Tools are executable, model-callable capabilities in SIM-ONE Alpha. They are implemented with Flue's `defineTool(...)` and attached only to the agents that should own them.

Tools live in `src/tools/`. Each tool is a focused capability with a typed parameter schema, a description, and an `execute` function that returns structured output. Tools are not protocols, skills, or workers. They do what they are told and return results.

## Tool Ownership

- The main orchestrator owns orchestration-support tools such as `load_protocols`, `retrieve_memory`, and image generation tools.
- The researcher subagent owns web-research tools.
- The coding worker owns worker-local tools under `src/workers/coding-worker/tools/`.
- Internal worker subagents must not be exposed as top-level orchestrator tools.

## Discoverability

Tools are discovered at build time by Flue and wired into the owning agent's `tools` array. Runtime-extensible tools should eventually be exposed through a registry wrapper or gateway rather than hardcoded into the orchestrator.

## Adding a Tool

1. Create the tool file under `src/tools/` or a focused subdirectory such as `src/tools/runpod-image/`.
2. Define Valibot/Flue parameter schemas and a clear `description`.
3. Implement `execute` to perform the capability and return structured JSON or a string.
4. Export the tool from `src/tools/index.ts`.
5. Attach the tool to the owning agent in `src/agents/orchestrator.ts` or a worker entrypoint.
6. Update `src/workspace/TOOLS.md` to document when and how the tool should be used.
7. Update `docs/architecture/gorombo-flue-map.md` if the new tool introduces a new directory or cross-cutting concern.

## Tool Boundaries

- Tools must not silently mutate global state outside their documented scope.
- Tools should fail closed when required configuration is missing.
- Tools should return structured errors instead of throwing raw SDK exceptions into the agent context.
- Tools that perform side effects should be attached to the agent that is accountable for the side effect.

## Example: Image Generation Tools

The Runpod Public Endpoints image tools demonstrate the pattern:

```text
src/tools/runpod-image/
  generate-image-tool.ts       # generate_image
  record-image-artifact-tool.ts # record_image_artifact
  list-image-artifacts-tool.ts  # list_image_artifacts
  catalog.ts                    # YAML model catalog loader
  runpod-client.ts              # thin Runpod AI SDK wrapper
  artifact-store.ts             # SQLite persistence + memory indexing
  models.yaml                   # human-editable model catalog
```

The orchestrator has direct access to all three tools without delegating to a worker, because image generation is a bounded, output-producing capability that fits tool semantics.
