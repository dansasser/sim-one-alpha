# Coding Worker & Orchestrator Architectural Assessment

## 1. Overview and Current State

The SIM-ONE Alpha system currently has a functioning main Orchestrator Agent and a highly sophisticated Coding Worker subagent built on the Astro Flue framework. Based on an architectural code review and unit tests execution (201 passing tests in total), the infrastructure claims have been fully realized.

The Orchestrator acts as the "relaying" brain—retrieving contexts, invoking memory or protocols—and correctly delegates technical coding tasks directly to the `coding-worker` subagent. The `coding-worker` itself is not a monolith but a sophisticated loop controller (a "Lead") that further delegates to specialized, worker-local subagents (`triage`, `implementer`, `test-debug`, `code-review`, and `github`).

### Key Capabilities Demonstrated:
- **Flue-Native Architecture:** Deeply integrated with `@flue/runtime`, utilizing isolated node sandboxes for safe execution.
- **Agentic Code Loop:** The `coding-worker` enforces a rigorous loop with distinct stages (Triage -> Plan -> Implement -> Test/Debug -> Code Review -> GitHub PR).
- **Mandatory Verification:** Mutating commands (like `git commit`, `git push`, or creating PRs) and actual file edits are heavily gated. A backend Approval Service explicitly checks policies (not relying just on model-level flags).
- **Test-Driven Corrections:** The `test-debug` subagent runs pre-defined verification commands (e.g., `pnpm test`, `pytest`, `tsc`). If commands fail, it patches the code iteratively until the checks pass.
- **Extensive Tooling:** Implemented `code-intelligence` (AST parsing for multiple languages), repo tools, git workflow tools, shell execution policies, and GitHub tools (via gh CLI wrapping).

---

## 2. Comparison: SIM-ONE Alpha vs. OpenClaw Architecture

OpenClaw traditionally approaches workflows by trying to bake immense amounts of context directly into the prompt and relies on a "black box" chain-of-thought where the entire system acts as one giant loop, frequently running into context token limits and un-auditable intermediate states.

**The Gap & Architectural Shifts:**
- **De-monolithization:** SIM-ONE Alpha completely deviates from OpenClaw's model. Instead of one agent doing everything, SIM-ONE Alpha splits the responsibilities. The orchestrator does *not* do web search or coding. It hands off to `researcher` or `coding-worker`. The `coding-worker` then hands off to specific `implementer` or `test-debug` subagents.
- **Visibility and Event Streaming:** Unlike OpenClaw's black box, SIM-ONE Alpha emphasizes "Progress and Handoff Visibility." Every tool execution, subagent handoff, and verification result emits a structured progress event for UI consumption.
- **Registry and Protocol Approach:** Instead of embedding rules in prompts, SIM-ONE Alpha uses SQLite-backed protocols and tool registries. The orchestrator uses the `load_protocols` tool *before* final reasoning.
- **Memory vs. Prompt Stuffing:** SIM-ONE Alpha uses a context budget calculator (via `src/session/context-budget.ts`) and explicit model card limits (e.g., distinguishing between 1M advertised vs 512K actual limits on models like MiniMax M3). OpenClaw would historically just overflow or drop context blindly.

---

## 3. Comparison: SIM-ONE Alpha Coding Worker vs. Claude Code

Claude Code (Anthropic's terminal-based agent) represents the current gold standard for local, agentic coding loops. It excels at fast context gathering, iterating through errors, running tests, and managing Git state autonomously.

**How SIM-ONE Alpha Compares to Claude Code:**
- **The Loop Dynamics:** SIM-ONE Alpha has successfully implemented a comparable "agentic loop". Just like Claude Code, SIM-ONE Alpha's `coding-worker` creates a plan, implements, runs tests, reads the output, and iterates on failure (via the `test-debug` subagent).
- **Approval & Safety Gates:** Claude Code prompts the user interactively in the terminal for sensitive actions (like running an unknown bash script or pushing to remote). SIM-ONE Alpha implements this via a strict `Approval Service`. File edits, shell executions, and Git mutations require an explicit approval record stored *outside* the workspace root. This is a robust, enterprise-friendly equivalent to Claude's interactive prompts.
- **Specialization vs. Monolithic LLM:** Claude Code relies heavily on Claude 3.5/3.7 Sonnet's immense inherent coding abilities and massive context window to do all tasks (planning, editing, git) holistically. SIM-ONE Alpha takes a multi-agent approach (`triage` -> `implementer` -> `reviewer`). This makes SIM-ONE Alpha more modular and potentially cheaper (using smaller specialized models for sub-tasks), though it requires more orchestration overhead than Claude's single-model approach.
- **Code Intelligence:** Claude Code does intelligent grep and AST-like exploration natively. SIM-ONE Alpha has built a dedicated `code-intelligence` toolset to parse ASTs for TypeScript, JavaScript, and Python to find declarations and references.

**Summary Verdict:**
The SIM-ONE Alpha `coding-worker` is a highly functional, fully realized replacement for the structural loop of Claude Code. It has all the necessary tools (file reading, writing, testing, debugging, PR creation). The primary difference is structural: SIM-ONE Alpha uses a strict worker-delegation pipeline with explicit, auditable security boundaries, whereas Claude Code relies on terminal interactivity and a massive single-model context. The SIM-ONE Alpha architecture is exactly where it needs to be for a functional AI Employee system.