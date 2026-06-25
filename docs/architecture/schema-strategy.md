# SIM-ONE Alpha Schema Strategy

This document describes how runtime schemas are organized in `sim-one-alpha`, why we chose Valibot, and when to promote a schema to a shared location.

## Why we need a schema layer

Types alone cannot validate data at runtime. Flue supports structured output via `session.task(..., { result: Schema })`, tools receive untrusted arguments from the model, and persisted data in SQLite/MongoDB/Postgres must be validated on read and write. A single source of truth for each shape prevents the TypeScript type and the runtime validator from drifting apart.

## Schema library: Valibot

We use [Valibot](https://valibot.dev/) because:

- **Flue already depends on it.** `@flue/runtime` uses Valibot for `session.prompt`, `session.skill`, and `session.task` structured-result overloads. Staying aligned with Flue avoids adding a second validation library.
- **Small and tree-shakeable.** Valibot is designed to be modular; unused validators do not bloat the bundle.
- **Derives TypeScript types.** `v.InferOutput<typeof Schema>` gives us a TS type from the same source as the runtime validator.
- **JSON-Schema compatible.** The `@valibot/to-json-schema` package (already a transitive dependency) can convert Valibot schemas to JSON Schema or OpenAPI when we need API documentation or generated forms.

## Directory layout

```text
src/core/schemas/
  Shared Valibot schemas for cross-cutting runtime contracts.
  One file per domain. Promote a schema here only when it is reused across files or subsystems.

src/engine/workers/<domain>/schemas.ts (optional)
  Worker-local schemas that are only consumed inside that worker.
  Useful when a schema is private to a single tool or workflow.

src/core/types/
  Pure TypeScript type contracts. May re-export inferred types from
  `src/core/schemas/` so consumers can continue importing from one place.
```

## Decision rules

### Keep a schema next to its consumer when:

- It is used by exactly one tool, workflow, or function.
- It is not part of a public handoff contract.
- It is unlikely to be reused by another subsystem.

Example: a one-off validation schema inside a single tool file.

### Promote a schema to `src/core/schemas/` when:

- It is reused by more than one file.
- It represents a cross-subsystem contract (orchestrator ? worker, worker ? memory, worker ? DB).
- It is used for Flue structured output (`session.task(..., { result: ... })`) and the type is referenced in a shared type contract.
- It needs to be converted to JSON Schema or used for database validation.

Example: `CodingImplementerResultSchema` lives in `src/core/schemas/coding-worker.ts` because it is shared between the implementer tool, the delegation path, and the public `CodingSubagentRunResult` type contract.

## Pattern: schema + derived type + re-export

Define the schema and derive its type in the schema file:

```ts
// src/core/schemas/coding-worker.ts
import * as v from 'valibot';

export const CodingImplementerResultSchema = v.object({
  fileEdits: v.array(
    v.object({
      path: v.string(),
      oldText: v.string(),
      newText: v.string(),
      expectedOccurrences: v.optional(v.number()),
    })
  ),
  writeFiles: v.array(
    v.object({
      path: v.string(),
      content: v.string(),
    })
  ),
  verificationCommands: v.array(
    v.object({
      name: v.string(),
      command: v.string(),
      required: v.optional(v.boolean()),
      reason: v.optional(v.string()),
      cwd: v.optional(v.string()),
      timeoutSeconds: v.optional(v.number()),
    })
  ),
});

export type CodingImplementerResult = v.InferOutput<typeof CodingImplementerResultSchema>;
```

Import and re-export from the domain type contract so existing consumers do not need to change paths:

```ts
// src/engine/workers/coding-worker/types.ts
import { CodingImplementerResultSchema } from '../../../core/schemas/coding-worker.js';

export { CodingImplementerResultSchema };
export type CodingImplementerResult = import('../../../core/schemas/coding-worker.js').CodingImplementerResult;
```

Use the schema for structured Flue output:

```ts
// src/engine/workers/coding-worker/workflow/coordination.ts
import { CodingImplementerResultSchema } from '../../../../core/schemas/coding-worker.js';

const response = await session.task(prompt, {
  agent: codingImplementerSubagentName,
  result: CodingImplementerResultSchema,
});

return {
  subagent: 'implementer',
  summary: `Implementer submitted ${response.data.fileEdits.length} edit(s)...`,
  evidence: [agent, childSession],
  structuredOutput: { type: 'implementer', result: response.data },
};
```

## Future growth

- Add one file per domain to `src/core/schemas/` as contracts stabilize.
- If a domain becomes large, split it into `src/core/schemas/<domain>/*.ts` with an `index.ts` barrel.
- Do not create a `src/core/schemas/` file for a schema that is purely internal to one function; that belongs next to its consumer.
- When a shape is shared across workers or between workers and the orchestrator, that is the signal to move it to `src/core/schemas/`.

## Relationship to SIM-ONE

SIM-ONE governs memory, security, and development process. The schema layer supports SIM-ONE by:

- Enforcing validated boundaries at worker handoff points.
- Keeping persisted memory/event shapes typed and tamper-evident on read.
- Providing a single source of truth that security-sensitive tools can reference instead of redefining shapes.
