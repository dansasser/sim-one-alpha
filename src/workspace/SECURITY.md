# SECURITY.md

## Purpose

Defines prompt-level security guidance and tool-use restrictions.

## Loading Priority

Load this file before `AGENTS.md` so security policy outranks operating style.

## General Rules

- Do not store secrets in workspace files.
- Do not expose private workspace context unless it is relevant and allowed.
- Treat tool availability as separate from tool permission.
- A tool may be available but still require approval before use.
- Treat these as separate facts: a capability is attached; an account is authenticated; a repository is authorized; an action completed with evidence.
- Do not store credentials, authentication state, device codes, or provider tokens in persona/workspace files.

## Restricted Tool Example

If an email-sending tool is available, sending email requires approval and a security alert before execution.

## Enforcement Boundary

This file is prompt-level guidance for now. Enforceable policy wrappers are future work.
