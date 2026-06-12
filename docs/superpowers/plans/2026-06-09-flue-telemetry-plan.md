# Flue Telemetry Plan

## Goal

Add live telemetry so HTTP tests and operators can verify whether the main agent delegated to the researcher subagent and whether the researcher called `web_research`.

## Flue Source

Flue exposes live application telemetry through `observe(...)` from `@flue/runtime`.

Relevant Flue event types for this phase:

- `task_start`: includes `agent`, `taskId`, session fields, and `runId` when emitted during a workflow.
- `task`: records task completion.
- `tool_start` and `tool_call`: include `toolName` and `toolCallId`.
- `operation_start` and `operation`: include `operationKind`.
- `run_start` and `run_end`: bound workflow activity by `runId`.

Important boundary:

- `observe(...)` is live in the running application context.
- It is not cross-process aggregation by itself.
- Content-bearing telemetry must be sanitized before external export.

## Implementation

- [x] Add `src/telemetry/flue-telemetry.ts`.
- [x] Register a single Flue observer at app startup.
- [x] Store sanitized event summaries in memory by `runId`.
- [x] Track whether a run delegated to `researcher`.
- [x] Track whether a run called `web_research`.
- [x] Expose protected route `GET /api/telemetry/runs/:runId`.
- [x] Expose protected route `GET /api/telemetry/runs`.
- [x] Keep prompt text, model messages, tool args, and tool result content out of the project telemetry route.
- [x] Add tests for the telemetry store.
- [x] Add tests for protected HTTP telemetry route behavior.

## Current Output Shape

`GET /api/telemetry/runs/:runId` returns:

- `runId`
- `eventCount`
- `delegatedToResearcher`
- `calledWebResearch`
- `taskStarts`
- `toolCalls`
- `operations`
- `errors`
- sanitized `events`

## Deferred Work

- [ ] Add external OpenTelemetry export through `@flue/opentelemetry` when we choose an exporter.
- [ ] Add durable telemetry storage if in-process summaries are not enough.
- [ ] Add trace IDs to chat responses if the product should expose telemetry links to clients.
- [ ] Add retention and access-control policy for production telemetry.
- [ ] Add UI or CLI helpers for inspecting a run's delegation path.

## Verification Plan

- [x] Run `corepack pnpm test`.
- [x] Run `corepack pnpm run typecheck`.
- [x] Run `corepack pnpm run build`.
- [x] Run live HTTP chat test.
- [x] Query `/api/telemetry/runs/:runId` for the live run and confirm `delegatedToResearcher` and `calledWebResearch`.
