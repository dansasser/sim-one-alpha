# Directory Cleanup Audit

## Purpose

Track directory-structure cleanup decisions for the post-persona-workspace branch.

This file is a planning checklist. Do not treat it as completed implementation until the corresponding source moves, import updates, tests, docs, and build checks have been done.

## Corrected Directory Rules

- Routes and middleware are not the same category.
- `src/routes/` owns concrete HTTP route registration and endpoint handlers.
- `src/middleware/` owns reusable request middleware such as auth/security checks.
- If route behavior was placed in middleware, that is a bug to fix later; do not solve it by merging routes and middleware into one category.
- `src/workflows/` owns Flue workflow entrypoints and bounded workflow orchestration.
- `src/tools/` owns model-callable tool wrappers.
- `src/agents/` owns main Flue agent entrypoints.
- `src/workers/<worker-name>/` owns worker/subagent implementation files and that worker's `workspace/`.
- No loose worker implementation files should live directly under `src/workers/`.
- Shared subsystems may live at top level when they are real architecture layers and not generic utilities.
- `src/utils/` is only for small generic helpers, not domain subsystems.
- Database adapter, schema, migration, and seed code lives with the subsystem or worker that owns the data.
- Runtime SQLite, JSON, or other database files live under `.gorombo/db/` and are not committed.

## Cleanup Candidates

## Active Implementation Checklist

### Legacy Non-Flue Path Removal

- [x] Delete `src/orchestrator/orchestrator.ts`.
- [x] Delete `src/gateway/secure-web-api.ts` if it is only tied to the legacy orchestrator class.
- [x] Remove legacy exports from `src/index.ts`.
- [x] Remove tests that only exercise the legacy class path.
- [x] Update architecture tests to assert the legacy files are absent and the live Flue route remains wired.
- [x] Update docs that still listed the removed `gateway/` source directory.
- [x] Search for stale legacy references after edits.
- [x] Run `npm test`.
- [x] Run `npm run typecheck`.
- [x] Run `npm run build`.
- [x] Run `npm run smoke:http`.
- [x] Run an HTTP prompt test that should invoke researcher web search.

Verification result:

- `npm test` passed with 89 tests.
- `npm run typecheck` passed.
- `npm run build` passed and found 1 agent plus 4 workflows.
- `npm run smoke:http` passed.
- Live HTTP prompt test passed using the main checkout `.env`; run `workflow:chat:01KTSHH9V62NPZ12JVVQP9YGV2` completed, returned a Gorombo URL, delegated to `researcher`, and called `web_research`.

### Fix Worker Layout

- [x] Keep the placeholder coding worker in this cleanup branch.
- [x] Move the loose coding worker file into its own worker directory.
- [x] Add coding worker workspace files matching the established workspace contract.
- [x] Move the coding worker Flue profile out of the orchestrator and into the worker file.
- [x] Update imports, registry expectations, tests, and docs.

Verification result:

- Stale path search found no remaining references to the former loose coding worker file.
- Coding worker workspace contains the full persona file set.
- `npm test` passed with 91 tests.
- `npm run typecheck` passed.
- `npm run build` passed and found 1 agent plus 4 workflows.
- `npm run smoke:http` passed.
- Live HTTP prompt test passed using the main checkout `.env`; run `workflow:chat:01KTSJP4DRMZWNAXEHWRHMX7KR` completed, returned a Gorombo URL, delegated to `researcher`, and called `web_research`.

### Move Researcher-Owned Support Code

- [x] Move the former top-level cached web provider under the researcher worker area.
- [x] Move the former top-level research cache under the researcher worker area.
- [x] Use `src/workers/researcher/research/` as the researcher-owned target.
- [x] Update imports in `src/workflows/web-research.ts` and tests.
- [x] Update docs that referred to the former top-level research support directory.
- [x] Add a directory README describing researcher-owned research support code.

Verification result:

- Stale path search found no remaining references to the former top-level research support directory, old relative imports, or old research cache DB path.
- `npm test` passed with 89 tests.
- `npm run typecheck` passed.
- `npm run build` passed and found 1 agent plus 4 workflows.
- `npm run smoke:http` passed.
- Live HTTP prompt test passed using the main checkout `.env`; run `workflow:chat:01KTSJ2H3KK1XZP49A150D0XRV` completed, returned a Gorombo URL, delegated to `researcher`, and called `web_research`.

### Rename Shared Retrieval Subsystem

- [ ] Keep the current `src/rag/` concept at top level because it is a shared subsystem, not a tool, workflow, worker, or utility.
- [ ] Rename `src/rag/` only after the user chooses the new directory name.
- [ ] After the name is chosen, update imports in retrieval/web-research workflows, tests, and docs.
- [ ] Consider renaming `rag-router.ts` to match the chosen subsystem name.

### Classify Workspace Loader Runtime Support

- [x] Inspect former persona directory usage.
- [x] Move the single shared workspace loader to `src/workspace-loader.ts`.
- [x] Remove the one-file persona directory.
- [x] Do not move workspace loader code into `src/workspace/`, because that directory is user-editable persona content.
- [x] Update `docs/architecture/gorombo-flue-map.md` with every current top-level `src/` directory and root support files.
- [x] Add an architecture test requiring the Flue map to mention every top-level `src/` directory.

Verification result:

- Architecture tests now require the Flue map to document every current top-level `src/` directory.
- `npm test` passed with 91 tests.
- Stale reference search found no remaining old persona-directory imports or docs references.
- `npm test` passed with 91 tests after moving the loader.
- `npm run typecheck` passed.
- `npm run build` passed and found 1 agent plus 4 workflows.
- `npm run smoke:http` passed.
- Live HTTP prompt test passed using the main checkout `.env`; run `workflow:chat:01KTSKCZ65KYV83RQFZFKVN6HZ` completed, returned a Gorombo URL, delegated to `researcher`, and called `web_research`.

### Runtime Database Directory

- [ ] Keep `.gorombo/db/README.md` tracked as the directory contract.
- [ ] Keep generated database files ignored.
- [x] Move current research cache default DB path toward `.gorombo/db/research-cache.sqlite`.
- [ ] Keep database code with the owning subsystem or worker instead of creating `src/databases/`.

## Keep Separate For Now

- `src/routes/`
- `src/middleware/`
- `src/workflows/`
- `src/tools/`
- `src/agents/`
- `src/workers/`
- `src/workspace/`
- `src/models/`
- `src/session/`
- `src/memory/`
- `src/protocols/`
- `src/registries/`
- `src/telemetry/`
- `src/types/`
- `src/utils/`

## Discussion Items

- Should `src/index.ts` remain as a package barrel, or is the app only shipped through the Flue build output?
- What user-selected name should replace `src/rag/`?
- Should the placeholder coding worker remain in this cleanup branch, or should it wait until the real coding worker phase?
- Should historical plan docs be updated when paths move, or left as historical records?
- Which default DB file names should each subsystem use under `.gorombo/db/`?
