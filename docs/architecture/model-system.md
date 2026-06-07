# Model System

Flue agents reference models with string specifiers:

```text
provider-id/model-id
```

Built-in providers such as OpenAI and Anthropic can be referenced directly when their provider credentials are available. Non-built-in or OpenAI-compatible providers, such as Ollama and local model gateways, must be registered in project code before an agent references them.

This project keeps model definitions in `src/models` so the orchestrator does not hardcode model IDs.

## Ollama Cloud vs Local

Ollama has two different API paths:

- Direct Ollama Cloud API uses `https://ollama.com/v1` with `OLLAMA_API_KEY`.
- Local Ollama uses `http://localhost:11434/v1` or another local/DT1 OpenAI-compatible endpoint.

The provider IDs intentionally reflect that split:

```text
ollama-cloud  -> direct Ollama Cloud API
ollama-local  -> local or DT1 Ollama-compatible endpoint
```

Cloud model profiles use the direct Ollama Cloud model IDs, such as `minimax-m3` and `deepseek-v4-pro`. The `:cloud` suffix is for the local Ollama CLI/daemon path.

## Current Profiles

```text
minimax-m3-cloud       -> ollama-cloud/minimax-m3
deepseek-v4-pro-cloud  -> ollama-cloud/deepseek-v4-pro
codex-brain            -> ollama-local/<OLLAMA_CODEX_BRAIN_MODEL>
```

`minimax-m3-cloud` is the default agentic chat profile.

## Selection Rules

1. `GOROMBO_MODEL` wins when set. Use it only for an exact Flue model specifier.
2. Otherwise `GOROMBO_MODEL_PROFILE` selects a project-owned profile.
3. If no profile is set, `minimax-m3-cloud` is used.
4. If a requested profile is missing, startup fails instead of choosing an unreviewed fallback.

## Adding Models

Add model metadata to `src/models`, including:

- provider id
- model id
- Flue specifier
- roles
- capabilities
- context window
- max tokens
- provider env requirements

Then register the provider in `configureRuntimeModels(...)` before any agent uses the profile.
