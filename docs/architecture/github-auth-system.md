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

Synchronous chat ingress consumes the one-time browser URL/code once and returns
it outside the model/tool transcript. Asynchronous connectors subscribe to the
same audience-bound relay and deliver it through connector-owned APIs. Generic
Coding Worker progress events contain only opaque session state.

Telegram issues GitHub-auth admissions only for private bot chats. It never
posts a device URL or code into a group or supergroup. Connector delivery leases
the one-time challenge and acknowledges it only after Telegram accepts the
private message; a failed send releases the same lease for an explicit retry.
```

Synchronous chat ingress binds the normalized current event through request-local
trusted context while the orchestrator and Coding Worker execute. Telegram's
Flue `dispatch()` is asynchronous, so its verified ingress persists a short-lived
admission containing the exact event ID, connector, actor, conversation, and
purpose. The admission is keyed by the Flue agent instance, event ID, and
purpose; its identifier never enters the agent prompt or a tool argument.
Authentication tools validate the model-supplied `eventId` against the
request-local event or that server-bound admission and fail closed on agent,
event, audience, or expiry mismatch.

`src/workflows/github-auth.ts` is a finite internal Flue workflow that shares the same deep auth runtime as the worker tools. It requires a request-local trusted event whose ID matches its payload, starts or checks one transition, and returns without waiting for browser completion. It deliberately exports no public route: an independent HTTP/SDK workflow invocation needs a durable, short-lived event-scoped admission grant before it can safely cross Flue's asynchronous workflow boundary.

## Credential Boundary

Managed profiles live outside coding workspaces at `~/.gorombo/auth/github/` by default, overridable with `GOROMBO_GITHUB_AUTH_ROOT`. The root must resolve outside the Coding Worker workspace.

Credential precedence is explicit `GH_TOKEN`, explicit `GITHUB_TOKEN`, managed profile, then unauthenticated. An invalid selected explicit token reports `invalid`; it never falls back to a different account. Device login manages only the product profile and does not replace an explicit environment credential.

The Flue Node local sandbox is trusted same-UID host access, not a credential vault. General model shell commands receive no `GH_TOKEN`, `GITHUB_TOKEN`, `GH_CONFIG_DIR`, or `GIT_CONFIG_*` overrides. Managed auth initialization is lazy, so code-only runs and injected application clients do not require GitHub storage. Product-owned GitHub CLI calls first require live authenticated status and then receive the managed `GH_CONFIG_DIR`. Bounded Git subprocesses receive a command-scoped empty generic helper followed by the `https://github.com` `gh auth git-credential` helper. Credentials are injected only when every resolved fetch or push destination is credential-free HTTPS on `github.com` using the default HTTPS port; no host-global `gh auth setup-git`, SSH key generation, or global Git configuration mutation occurs.

## Device Challenge Handling

Starting device authorization requires `github.auth.login` approval. The approval is bound to the trusted event's connector, actor, conversation, event id, profile, hostname, scope, and opaque auth-session id.

If approval finishes after the initiating response, the next trusted event may present the prior opaque approval-request id. The Coding Worker verifies its connector, actor, conversation, hostname, and profile metadata, reuses the original auth-session id, and binds challenge delivery to the new current event. Login approvals expire after fifteen minutes.

The browser URL, one-time code, and expiry are temporary authorization capabilities. They are not returned by worker tools or workflows, not written to progress events, and not persisted in task records or telemetry. The in-memory relay releases a challenge only once to the matching connector, actor, and conversation, and notifies trusted connector listeners only after storing it. A later authenticated event in that same conversation may consume a challenge created before approval completed; a different actor or conversation cannot. Malformed and expired challenges fail closed, and replacement-safe timers remove abandoned challenges.

## Deferred Protocol Migration

Workspace guidance is human-readable operating context today. Once the Protocol Tool can evaluate connector/actor-bound policy, migrate these enforceable directives to SQLite protocol records: auth-initiation approval, HTTPS-only transport, no-secret output, audience-bound delivery, and capability-versus-readiness wording. Do not remove runtime enforcement when adding those records.
