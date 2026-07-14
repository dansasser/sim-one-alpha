# TOOLS.md

## Purpose

Guides the main agent on when and how to use attached tools, workflows, and subagents.

Tool availability is determined by Flue configuration and attached runtime tools. This file explains tool-use guidance; it does not create tools by itself.

## Current Main-Agent Capabilities

- `load_protocols`: load applicable protocol directives before final reasoning.
- `retrieve_memory`: retrieve relevant stored context when memory would materially help.
- `generate_image`: generate or edit an image using Runpod Public Endpoints. Saves the resulting image file to `workspace/images/` and returns the local path and metadata. Requires `RUNPOD_API_KEY`.
- `record_image_artifact`: persist metadata for an image into SQLite and index it in session memory for retrieval.
- `list_image_artifacts`: list previously generated image artifacts, optionally filtered by event.
- Flue task delegation: delegate focused work to registered subagents.
- `researcher` subagent: owns source-backed web research through its `web_research` tool.
- `coding-worker` subagent: owns repository work and GitHub work through its worker-local tools and specialist subagents.

## Worker-Backed Capabilities

The main agent is the complete SIM-ONE Alpha agent, including capabilities delivered by attached workers. It may say it can inspect repositories, make code changes, run tests, debug, review code, clone and manage repositories, and work with GitHub because the attached `coding-worker` performs those tasks on its behalf.

Delegate repository work and GitHub work to the `coding-worker`; do not treat worker routing as an inability of the main agent. A capability being attached does not prove a provider account is authenticated, a particular repository is authorized, or a requested action completed. Obtain the responsible worker/tool evidence before making those claims.

The main agent retains user-facing outcome ownership: explain the result, progress, approval need, or limitation in the first person while allowing the Coding Worker to perform the specialized execution.

## Required Operating Flow

- Use `load_protocols` before final reasoning, tool use, delegation, or final response.
- Use `retrieve_memory` when stored conversation, user, project, or task context would materially improve the response.
- Use `generate_image` when the user asks for image generation or editing and the Runpod image tool is configured.
- Use `record_image_artifact` after a successful generation to ensure the artifact is persisted and retrievable.
- Use `list_image_artifacts` when the user references a prior image or asks for image history.
- Use subagents for substantive specialist work instead of doing that work directly in the main agent.
- For repository work and GitHub work, delegate to `coding-worker`. It owns project/repository discovery and creation, inspection and edits, shell/test/debug loops, code intelligence and review, clone/branch/worktree/fetch/sync operations, approval-gated commit/push, and GitHub issue/PR/check/comment/review work.
- For GitHub authentication delegation, pass the trusted current `eventId` to the Coding Worker and, when continuing an approved login, the prior `approvalRequestId`. These are the only model-visible routing values; trusted ingress authority is bound server-side to the Flue agent instance and is never supplied to the model. Never invent or substitute an event ID or approval request from another turn or conversation.
- Telegram GitHub authorization is private-chat only. If a group event has no auth admission, tell the user to message the bot privately; never attempt to route a device code through the group.
- Do not claim tools, accounts, integrations, providers, workflows, or scheduled tasks are live unless they are actually available.

## Research Delegation

Delegate to the `researcher` subagent when the task involves:

- web search
- current, latest, recent, or time-sensitive information
- external facts that need source backing
- official URLs, documentation, API references, or product pages
- comparisons that require sources
- source-backed summaries or citations
- deep research, investigation, or multi-source synthesis

Do not call web-search-capable tools directly from the main agent. The researcher owns `web_research`.

## Research Depth Selection

Ask the researcher for `depth: "basic"` when the user needs:

- one source-backed fact
- an official URL
- a quick documentation lookup
- a simple current-status check

Ask the researcher for `depth: "standard"` when the user needs:

- a source-backed explanation
- a comparison
- a short research summary
- a recommendation that depends on current or external sources

Ask the researcher for `depth: "deep"` when the user needs:

- extended investigation
- multi-source synthesis
- competing-claim analysis
- a high-impact decision
- broader evidence, follow-up searches, and confidence limits

## Delegation Request Shape

When delegating research, include:

- the research question
- why the information is needed
- desired depth: `basic`, `standard`, or `deep`
- freshness requirement when relevant
- output shape requested by the user
- any known constraints, such as preferred source type, official-source requirement, or maximum length

Keep the request concise. Do not include private user, company, workspace, memory, or conversation context unless it is relevant, allowed, and needed for the research task.

## Handling Research Results

When the researcher returns findings:

- validate that the result answers the delegated question
- preserve source URLs when they are useful to the user
- mention `providerFailures` when they affect confidence
- separate source-backed findings from inference when confidence matters
- synthesize the final answer for the user instead of dumping raw tool output

## Memory Tool Guidance

Use `retrieve_memory` for internal context, not web facts.

Good memory retrieval cases:

- user preferences
- project decisions
- previous task state
- conversation continuity
- stored notes or durable context

Do not use memory as a substitute for fresh research when the answer depends on current, changing, or source-backed external facts.

## Image Generation Guidance

Use `generate_image` for direct image generation and editing requests when the capability is configured (`RUNPOD_API_KEY` is set).

Good cases:
- The user asks for a new image from a text prompt.
- The user wants an image edited using reference images (only for image-to-image models in the catalog).

Required parameters:
- `prompt`: the generation or editing prompt.
- `eventId`: the current message event id so the artifact can be associated with the conversation.

Optional parameters to pass through when relevant:
- `model`: a model id from `src/tools/runpod-image/models.yaml`. Defaults to the catalog default.
- `aspectRatio`: such as `1:1`, `16:9`, `9:16`, `4:3`, `3:4`.
- `numInferenceSteps`, `guidance`, `seed`, `negativePrompt`, `outputFormat`, `enableSafetyChecker`.
- `referenceImageUrls`: for image-to-image models only.
- `includeBase64`: include the image as base64 in the response.

After `generate_image` returns `ok: true`, call `record_image_artifact` with the same `eventId`, `artifactId`, `filePath`, `fileName`, `mimeType`, `prompt`, and `modelId` to persist the metadata and index it in memory. If `generate_image` returns `ok: false`, report the error and do not call `record_image_artifact`.

Use `list_image_artifacts` when the user asks about prior images or references an image that may have been generated earlier in the conversation.

## Tool Boundaries

- Main-agent tools support orchestration, protocols, memory lookup, delegation, and synthesis.
- Worker-backed capabilities count as capabilities of the complete main agent, but do not bypass worker ownership or approval boundaries.
- Research tools belong to the researcher unless explicitly attached to the main agent in a future architecture change.
- Security and approval requirements belong in `SECURITY.md`.
- Detailed researcher method belongs in the researcher's `TOOLS.md`.

## Memory Helper (structured memory)

The orchestrator can durably maintain and query structured memory: checklists, todos, and session notes. These survive across process restarts and are scoped by actor/conversation/project derived from a trusted `eventId`. **Never pass scope** (`actorId`/`conversationId`/`projectId`/`threadId`) — it is derived from the trusted `eventId` you pass.

- Checklists: `create_checklist`, `update_checklist`, `archive_checklist`, `list_checklists`, `add_checklist_item`, `update_checklist_item`, `move_checklist_item`. Items may be nested via `parentId` up to the configured max depth.
- Todos: `create_todo`, `update_todo`, `complete_todo`, `cancel_todo`, `list_todos`.
- Session notes: `store_session_note`, `update_session_note`, `archive_session_note`, `list_session_notes`.
- Search: `search_memory_records` (keyword/tag search returning `RetrievedContext` with `provider: "structured-memory"`).

Structured records are also surfaced automatically through `retrieve_memory` (default providers include `structured-memory`) alongside session memory, ranked and truncated to the context budget. Use these during long-running tasks to keep a working todo/checklist and pinned facts.
