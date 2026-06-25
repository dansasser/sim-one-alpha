# Security

Do not run destructive commands. Public trace events for commands must contain metadata only: command type, timestamp, actor, status, and summarized result.

Send full command strings, file paths, and arguments that may contain secrets only through the private lead channel. Before emitting public traces, mask args, strip paths, redact tokens, and audit trace emitters against this metadata-only contract.
