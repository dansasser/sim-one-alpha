# Installation

SIM-ONE Alpha supports a packaged installation for normal use and a source
build for users who need to inspect or modify the product.

## Packaged Installation

Run the release installer from a POSIX shell:

```bash
curl -fsSL https://github.com/dansasser/sim-one-alpha/releases/latest/download/sim-one.sh | sh
```

The installer:

- installs the self-hosted SIM-ONE Alpha runtime;
- installs the `sim-one` product command and terminal interface;
- installs the structured-memory engine and bundled retrieval assets;
- creates the runtime directories under `~/.gorombo/`;
- opens the onboarding interface.

Node.js, npm, pnpm, Rust, and `wasm-pack` are not required for a packaged
installation.

Continue with [Onboarding](onboarding.md) to configure credentials, validate
the gateway, and start the first conversation.

## Installed Files

The installer keeps the product runtime and mutable user data under
`~/.gorombo/`.

| Path | Purpose |
| --- | --- |
| `~/.gorombo/sim-one-alpha/` | Installed agent runtime and product configuration |
| `~/.gorombo/sim-one-cli/` | Product command |
| `~/.gorombo/db/` | Sessions, protocols, memory, schedules, and capability records |
| `~/.gorombo/capabilities/` | User- and agent-added skills, tools, and workers |
| `~/.gorombo/auth/` | Product-managed authentication state |
| `~/.gorombo/logs/` | Bounded operational diagnostics |
| `~/.gorombo/.env` | Provider, connector, and service secrets |

Keep `~/.gorombo/.env`, databases, authentication state, and approval records
private. Back up the runtime data directory before moving the installation to
another machine.

## Build From Source

Source builds require:

- Git;
- Node.js 22.18 or newer;
- npm or pnpm 10;
- Rust stable with the `wasm32-unknown-unknown` target;
- `wasm-pack` 0.13.1.

Clone the repository:

```bash
git clone https://github.com/dansasser/sim-one-alpha.git
cd sim-one-alpha
```

Choose one package-manager path.

### npm

```bash
npm install
npm --prefix sim-one-cli install
npm run fetch-embedding-model
npm run wasm:build
npm run build
npm run build:tui
npm --prefix sim-one-cli run build
```

### pnpm

```bash
pnpm install
pnpm fetch-embedding-model
pnpm run wasm:build
pnpm run build
pnpm run build:tui
pnpm run build:cli
```

Start onboarding from the built product command:

```bash
./.gorombo/sim-one-cli/sim-one install
```

After onboarding, launch SIM-ONE Alpha with:

```bash
./.gorombo/sim-one-cli/sim-one
```

Both build paths produce the Flue runtime, terminal interface, Rust/WebAssembly
memory helper, bundled embedding assets, and unified product command.

## Verify The Installation

Run:

```bash
sim-one doctor
sim-one status
```

Then open the terminal interface:

```bash
sim-one
```

If a check fails, use the [Troubleshooting Guide](../operations/troubleshooting.md).

## Next Steps

- [Complete onboarding](onboarding.md)
- [Use the terminal interface and sessions](../guides/terminal-and-sessions.md)
- [Configure providers and runtime behavior](../reference/configuration.md)
- [Connect Telegram or another connector](../guides/connectors.md)
