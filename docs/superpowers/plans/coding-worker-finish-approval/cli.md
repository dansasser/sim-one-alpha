# Approvals CLI

The approvals CLI is a local operator tool for inspecting and resolving pending coding-worker approval requests stored in the shared approval root.

## Usage

```bash
node scripts/approvals-cli.mjs <command> [args]
```

## Commands

### `list`

List all pending approvals.

```bash
GOROMBO_APPROVAL_ROOT=/path/to/approvals node scripts/approvals-cli.mjs list
```

Output shows one approval per line:

```
<requestId>  <actionType>  <taskId>  <summary>
```

### `show`

Print a single approval request as formatted JSON.

```bash
GOROMBO_APPROVAL_ROOT=/path/to/approvals node scripts/approvals-cli.mjs show <requestId>
```

### `approve`

Record an approve decision.

```bash
GOROMBO_APPROVAL_ROOT=/path/to/approvals node scripts/approvals-cli.mjs approve <requestId> --reason "Looks good."
```

### `deny`

Record a deny decision.

```bash
GOROMBO_APPROVAL_ROOT=/path/to/approvals node scripts/approvals-cli.mjs deny <requestId> --reason "Too risky."
```

## Environment

- `GOROMBO_APPROVAL_ROOT` — **Required.** Directory shared by the coding worker and the HTTP/CLI/Telegram ingress layer. Must be outside the coding-worker workspace root.
- `API_SECRET` — Optional. When absent, the CLI prints a warning and uses a local-only `operator` principal (`$USER` or `cli-operator`).

## Notes

- The CLI reads and writes the same file-backed approval store that the coding worker uses, so decisions made locally are visible to the worker on its next poll.
- If the TypeScript output in `.tmp/tsc/` is missing, the CLI compiles it automatically with `tsc -p tsconfig.json` before running.
