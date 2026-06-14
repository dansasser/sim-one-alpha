import type { AgentProfile, ToolDefinition } from '@flue/runtime';
import type { CodingApprovalService } from '../approvals/approval-service.js';
import type { GitHubClient } from '../github/github-client.js';
import { createCodingGitHubTools } from '../github/github-tools.js';
import type { CodingWorkspaceTargetInput } from '../repo/workspace-target.js';
import { createCodingGitTools } from '../tools/coding-git-tools.js';
import { createCodingImplementerTools } from '../tools/coding-implementer-tools.js';
import { createCodingCodeIntelligenceTools } from '../tools/code-intelligence/index.js';
import { createCodingRepoTools } from '../tools/coding-repo-tools.js';
import { createCodingRepoWorkflowTools } from '../tools/coding-repo-workflow-tools.js';
import { createCodingTestDebugTools } from '../tools/coding-test-debug-tools.js';
import { createCodingTriageTools } from '../tools/coding-triage-tools.js';
import { createCodingCodeReviewSubagent, codingCodeReviewSubagentName } from './code-review/code-review-agent.js';
import { createCodingGithubSubagent, codingGithubSubagentName } from './github/github-agent.js';
import { createCodingImplementerSubagent, codingImplementerSubagentName } from './implementer/implementer-agent.js';
import { createCodingTestDebugSubagent, codingTestDebugSubagentName } from './test-debug/test-debug-agent.js';
import { createCodingTriageSubagent, codingTriageSubagentName } from './triage/triage-agent.js';

export const codingWorkerInternalSubagentNames = [
  codingTriageSubagentName,
  codingImplementerSubagentName,
  codingTestDebugSubagentName,
  codingCodeReviewSubagentName,
  codingGithubSubagentName,
] as const;

export interface CodingWorkerInternalSubagentsOptions extends CodingWorkspaceTargetInput {
  model?: string;
  env?: Record<string, string | undefined>;
  approvalService?: CodingApprovalService;
  githubClient?: GitHubClient;
}

export function createCodingWorkerInternalSubagents(
  options?: CodingWorkerInternalSubagentsOptions,
): AgentProfile[] {
  const toolsets = createInternalToolsets(options ?? {});

  return [
    createCodingTriageSubagent(options?.model, toolsets.triage),
    createCodingImplementerSubagent(options?.model, toolsets.implementer),
    createCodingTestDebugSubagent(options?.model, toolsets.testDebug),
    createCodingCodeReviewSubagent(options?.model, toolsets.codeReview),
    createCodingGithubSubagent(options?.model, toolsets.github),
  ];
}

function createInternalToolsets(options: CodingWorkerInternalSubagentsOptions): {
  triage?: ToolDefinition[];
  implementer?: ToolDefinition[];
  testDebug?: ToolDefinition[];
  codeReview?: ToolDefinition[];
  github?: ToolDefinition[];
} {
  if (!options.workspaceRoot && !options.repoPath) {
    return {
      triage: createCodingTriageTools(),
      implementer: createCodingImplementerTools(),
      testDebug: createCodingTestDebugTools(),
      codeReview: [],
      github: [],
    };
  }

  const commonTarget = {
    workspaceRoot: options.workspaceRoot,
    targetKind: options.targetKind,
    projectId: options.projectId,
    projectSlug: options.projectSlug,
    projectRelativePath: options.projectRelativePath,
    repoPath: options.repoPath,
    env: options.env,
  };
  const repoTools = createCodingRepoTools({
    ...commonTarget,
    sessionId: 'coding-worker-internal-repo-tools',
  });
  const codeIntelligenceTools = createCodingCodeIntelligenceTools({
    ...commonTarget,
    sessionId: 'coding-worker-internal-code-intelligence-tools',
  });
  const gitTools = createCodingGitTools({
    ...commonTarget,
    sessionId: 'coding-worker-internal-git-tools',
    approvalService: options.approvalService,
  });
  const repoWorkflowTools = createCodingRepoWorkflowTools({
    ...commonTarget,
    sessionId: 'coding-worker-internal-repo-workflow-tools',
    approvalService: options.approvalService,
  });
  const githubTools = createCodingGitHubTools({
    client: options.githubClient,
    approvalService: options.approvalService,
  });
  const implementerOutputTools = createCodingImplementerTools();
  const testDebugTools = createCodingTestDebugTools();
  const triageOutputTools = createCodingTriageTools();

  return {
    triage: selectTools(
      [...repoTools, ...codeIntelligenceTools, ...repoWorkflowTools, ...githubTools, ...triageOutputTools],
      'coding_repo_list_files',
      'coding_repo_read_file',
      'coding_repo_search',
      'coding_repo_discover',
      'coding_repo_git_state',
      'coding_github_read_context',
      'coding_triage_submit_result',
      'coding_ast_parse_file',
      'coding_symbol_navigate',
      'coding_import_graph',
    ),
    implementer: selectTools(
      [...repoTools, ...codeIntelligenceTools, ...implementerOutputTools],
      'coding_repo_list_files',
      'coding_repo_read_file',
      'coding_repo_search',
      'coding_repo_write_file',
      'coding_repo_apply_patch',
      'coding_shell_run',
      'coding_progress_emit',
      'coding_implementer_submit_result',
      'coding_ast_parse_file',
      'coding_symbol_navigate',
      'coding_find_symbol_declarations',
      'coding_find_symbol_references',
    ),
    testDebug: selectTools(
      [...repoTools, ...codeIntelligenceTools, ...repoWorkflowTools, ...testDebugTools],
      'coding_repo_read_file',
      'coding_repo_search',
      'coding_shell_run',
      'coding_repo_git_state',
      'coding_progress_emit',
      'coding_test_debug_submit_result',
      'coding_ast_parse_file',
      'coding_symbol_navigate',
      'coding_import_graph',
    ),
    codeReview: selectTools(
      [...repoTools, ...codeIntelligenceTools, ...gitTools, ...repoWorkflowTools],
      'coding_repo_read_file',
      'coding_repo_search',
      'coding_shell_run',
      'coding_git_status',
      'coding_git_diff',
      'coding_repo_git_state',
    ),
    github: githubTools,
  };
}

function selectTools(tools: ToolDefinition[], ...names: string[]): ToolDefinition[] {
  const wanted = new Set(names);
  const available = new Set(tools.map((tool) => tool.name));
  const missing = [...wanted].filter((name) => !available.has(name));
  if (missing.length > 0) {
    console.warn(`[coding-worker] selectTools dropped unknown tool names: ${missing.join(', ')}`);
  }
  return tools.filter((tool) => wanted.has(tool.name));
}

export {
  codingCodeReviewSubagentName,
  codingGithubSubagentName,
  codingImplementerSubagentName,
  codingTestDebugSubagentName,
  codingTriageSubagentName,
  createCodingCodeReviewSubagent,
  createCodingGithubSubagent,
  createCodingImplementerSubagent,
  createCodingTestDebugSubagent,
  createCodingTriageSubagent,
};
