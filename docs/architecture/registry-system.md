# Registry System

Registries are the extension boundary for base and user-defined capabilities.

Phase 1 includes typed in-memory registries for:

- tools
- skills
- agents and workers
- protocols

Each registry definition has a stable `id`, `scope`, `enabled` flag, and metadata. The orchestrator reads from registries instead of hardcoding every future capability.

Native Flue tools can be wired directly into an agent. Runtime-defined tools should later go through a registry gateway so user additions do not require changing orchestrator logic.

Protocols are separate from skills. Protocols are stored rule records loaded by the protocol provider and applied through tools.

