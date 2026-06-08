# Model System

Flue agents reference models with string specifiers:

```text
provider-id/model-id
```

Built-in providers such as OpenAI and Anthropic can be referenced directly when their provider credentials are available. Non-built-in or OpenAI-compatible providers, such as Ollama and local model gateways, must be registered in project code before an agent references them.

This project keeps model cards in `src/models/cards` so the orchestrator does not hardcode model IDs, context limits, or provider-specific capabilities.

## Why Cards Exist

Cards are the boundary between model selection and runtime behavior. They make model metadata explicit before the agent, session manager, RAG router, or compaction layer makes token-budget decisions.

The same provider can expose models with very different limits. MiniMax M3, DeepSeek V4 Pro, and Qwen 3.5 all run through `ollama-cloud`, but they do not have the same context window, output ceiling, modalities, or long-context reliability profile. Keeping those facts in card files lets downstream systems ask the selected card for limits instead of spreading hardcoded numbers across the codebase.

Cards also preserve conflicting-but-useful metadata. For example, MiniMax advertises M3 as a 1M-context model with a guaranteed 512K minimum, while Ollama Cloud currently reports 524288. The card stores each value separately so session budgeting can choose the conservative operational budget while still retaining the advertised/native capability.

## Runtime Use

Runtime setup has two layers:

1. Provider modules in `src/models/providers` register Flue provider IDs from `src/app.ts`.
2. Model cards in `src/models/cards` provide the model IDs and per-model metadata used by those provider registrations and by the orchestrator model registry.

The orchestrator should not register providers itself. It selects a model through `GOROMBO_MODEL` or `GOROMBO_MODEL_PROFILE`, then uses the card specifier as the Flue model string. Session-budget and compaction code resolves the selected card before estimating, reserving, or compacting context.

## Ollama Cloud vs Local

Ollama has two different API paths:

- Direct Ollama Cloud API uses `https://ollama.com/v1` with `OLLAMA_API_KEY`.
- Local Ollama uses `http://localhost:11434/v1` or another local/DT1 OpenAI-compatible endpoint.

The provider IDs intentionally reflect that split:

```text
ollama-cloud  -> direct Ollama Cloud API
ollama-local  -> local or DT1 Ollama-compatible endpoint
```

Cloud model cards use the direct Ollama Cloud model IDs, such as `minimax-m3` and `deepseek-v4-pro`. The `:cloud` suffix is for the local Ollama CLI/daemon path.

## Current Cards

```text
minimax-m3-cloud       -> ollama-cloud/minimax-m3
deepseek-v4-pro-cloud  -> ollama-cloud/deepseek-v4-pro
qwen3-5-cloud          -> ollama-cloud/qwen3.5:397b
codex-brain            -> ollama-local/<OLLAMA_CODEX_BRAIN_MODEL>
```

`minimax-m3-cloud` is the default agentic chat profile.

The current card context limits are:

```text
minimax-m3-cloud       advertised=1,000,000  guaranteed=512,000  ollama-reported=524,288  max-output=131,072
deepseek-v4-pro-cloud  context=1,048,576     max-output=1,048,576
qwen3-5-cloud          context=262,144       max-output=65,536
codex-brain            context=128,000       max-output=32,000 until DT1 metadata is confirmed
```

MiniMax M3 intentionally tracks more than one limit because MiniMax advertises 1M context with a guaranteed 512K minimum, while Ollama Cloud currently reports 524288 for both direct `/api/show` and local `minimax-m3:cloud` metadata.

## Selection Rules

1. `GOROMBO_MODEL` wins when set. Use it only for an exact Flue model specifier.
2. Otherwise `GOROMBO_MODEL_PROFILE` selects a project-owned profile.
3. If no profile is set, `minimax-m3-cloud` is used.
4. If a requested profile is missing, startup fails instead of choosing an unreviewed fallback.

## Adding Models

Add a card file to `src/models/cards`, including:

- provider id
- model id
- Flue specifier
- roles
- capabilities
- context window
- guaranteed or provider-reported context limits when they differ from the advertised limit
- max output tokens
- provider env requirements

Provider transport belongs in `src/models/providers`. Register custom providers from `src/app.ts` before any agent uses the card specifier.

As of June 7, 2026, Ollama Cloud's live model list did not expose a dedicated embedding model, so no embedding card is added yet.

## Budget Policy

The session-management layer uses cards in this order:

1. Resolve the selected model card from the active Flue model specifier.
2. Use the provider-reported context window for safety when available.
3. Reserve output tokens before calculating usable input budget.
4. Warn before the prompt approaches the compaction threshold.
5. Derive current session usage from stored Flue `SessionData` when available.
6. Trigger `session.compact()` before Flue or the provider rejects the prompt.
7. Give RAG only the remaining context budget after system instructions, protocol context, memory, current user input, and output reserve are accounted for.

RAG should come after this budget layer because retrieved context must fit into the selected card's remaining budget.

The default web retrieval provider is Ollama Search through `POST https://ollama.com/api/web_search`, authenticated with the existing `OLLAMA_API_KEY`. The agent-facing RAG tool calls the `retrieval` Flue workflow boundary, which selects providers, optionally expands top web results through fetch, packs contexts to a token budget, and records non-fatal provider failures. Other providers can be added behind the same RAG provider interface.
