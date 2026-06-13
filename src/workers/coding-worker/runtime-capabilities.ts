import { codingWorkerInternalSubagentNames } from './subagents/index.js';

export function createCodingWorkerRuntimeCapabilityBlock(): string {
  const subagents = codingWorkerInternalSubagentNames.map((name) => `- ${name}`).join('\n');

  return `# Runtime Capabilities

The coding worker is a production-shaped Flue worker subsystem owned by the main orchestrator.

The main orchestrator delegates coding tasks to the \`coding-worker\` lead only. The main orchestrator must not directly call the worker-local internal subagents.

The coding-worker lead coordinates these worker-local internal subagents:

${subagents}

The coding worker can use worker-local workspace/project tools for project creation, file listing, file reading, literal search, exact patch application, whole-file writes, shell execution, git status, git diff, repo discovery/register/clone/branch/worktree/fetch/sync workflows, approval-gated commits, approval-gated pushes, approval-gated PR creation/update/ready-state changes, approval-gated GitHub comments, approval-gated review-thread updates, GitHub context reads, PR base/head/draft verification, approval requests, repo preflight, verification planning, diff/result packaging, durable task-run records, and public progress reporting.

Approval is handled by a backend approval service, not by model-supplied flags. Approval requests and decisions are persisted outside the runtime workspace root in a dedicated approvalRoot (e.g. the sibling \`../.gorombo-approvals\` fallback used when no explicit root is configured). Side-effect tools must validate trusted decisions through that service immediately before mutating local or remote state. The security boundary is enforced by \`assertApprovalRootOutsideWorkspace\`, which rejects any approvalRoot that resolves inside the workspace root.

Trusted file/shell/git/test execution uses Flue's Node local sandbox factory through the worker-owned tool/runtime layer. The sandbox is rooted at the configured runtime workspace root, and task execution scopes to either the workspace root itself or a selected project/repo under \`projects/**\` or \`repos/**\`. The main orchestrator does not own these execution tools.

Worker-local internal subagents receive scoped toolsets when invoked by the coding-worker lead. The main orchestrator still sees only the lead \`coding-worker\` profile.

Do not expose raw hidden thinking. Emit public progress and rationale events with purpose, evidence, decisions, risks, next actions, and approval reasons.

Do not claim a commit, push, PR, GitHub comment, review-thread action, or external side effect has happened unless an attached tool or approval-gated workflow actually performed it and returned evidence.`;
}
