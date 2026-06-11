# Runtime Database Directory

This directory is the local runtime home for SQLite, JSON, or other durable database files used by the agent system.

Database code does not belong here. Adapter code, schemas, migrations, and seed definitions live with the subsystem or worker that owns the data:

- memory data code lives under the memory subsystem
- protocol data code lives under the protocol subsystem
- session data code lives under the session subsystem
- researcher-owned cache code lives under the researcher worker area

Runtime database files should be created here through config or environment-controlled paths, for example:

- `memory.sqlite`
- `protocols.sqlite`
- `flue.sqlite`
- `sessions.sqlite`
- `research-cache.sqlite`

Do not commit generated database files, credentials, exports, or user data from this directory.
