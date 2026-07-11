# Managed GitHub Authentication

## Purpose

SIM-ONE Alpha performs repository and GitHub work through the Coding Worker. The main persona owns the user-facing outcome, while the Coding Worker owns GitHub authentication and execution details.

Authentication is distinct from capability, repository authorization, and completed-action evidence:

1. The Coding Worker being attached means SIM-ONE Alpha has GitHub capability.
2. Managed `gh` status plus API identity plus HTTPS protocol checks establish account authentication.
3. A requested Git operation establishes authorization for that exact repository.
4. A tool result that verifies the resulting state establishes completion.

## Data Flow

```text
Main persona
  -> Coding Worker lead
    -> github_auth_status / github_auth_start
      -> approval service
      -> managed GitHub auth runtime
        -> gh auth login --web (HTTPS only)
        -> private challenge relay
          -> initiating connector + actor + conversation only

Chat ingress consumes the one-time browser URL/code once and returns it outside
the model/tool transcript. Generic Coding Worker progress events contain only
opaque session state.
```

`src/workflows/github-auth.ts` is a finite, admitted Flue workflow for UI/operator callers. It shares the same deep auth runtime as the worker tools. A workflow invocation starts or checks one transition and returns; it never waits for browser completion or imports another workflow's `run()` function.

## Credential Boundary

Managed profiles live outside coding workspaces at `~/.gorombo/auth/github/` by default, overridable with `GOROMBO_GITHUB_AUTH_ROOT`. The root must resolve outside the Coding Worker workspace.

Credential precedence is explicit `GH_TOKEN`, explicit `GITHUB_TOKEN`, managed profile, then unauthenticated. An invalid selected explicit token reports `invalid`; it never falls back to a different account. Device login manages only the product profile and does not replace an explicit environment credential.

The Flue Node local sandbox is trusted same-UID host access, not a credential vault. General model shell commands receive no `GH_TOKEN`, `GITHUB_TOKEN`, `GH_CONFIG_DIR`, or Git credential-helper configuration. Product-owned GitHub CLI calls receive the managed `GH_CONFIG_DIR`. Bounded Git subprocesses for exact `https://github.com/...` remotes receive an invocation-scoped `gh auth git-credential` helper; no host-global `gh auth setup-git`, SSH key generation, or global Git configuration mutation occurs.

## Device Challenge Handling

Starting device authorization requires `github.auth.login` approval. The approval is bound to the trusted event's connector, actor, conversation, event id, profile, hostname, scope, and opaque auth-session id.

The browser URL, one-time code, and expiry are temporary authorization capabilities. They are not returned by worker tools or workflows, not written to progress events, and not persisted in task records or telemetry. The in-memory relay releases a challenge only once to the matching initiating audience. If the client disconnects before delivery, the code is not broadcast; a new authorized request is required.

## Deferred Protocol Migration

Workspace guidance is human-readable operating context today. Once the Protocol Tool can evaluate connector/actor-bound policy, migrate these enforceable directives to SQLite protocol records: auth-initiation approval, HTTPS-only transport, no-secret output, audience-bound delivery, and capability-versus-readiness wording. Do not remove runtime enforcement when adding those records.
