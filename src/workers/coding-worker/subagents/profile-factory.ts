import { defineAgentProfile, type AgentProfile, type ToolDefinition } from '@flue/runtime';
import {
  composeWorkspaceInstructions,
  resolveWorkspaceDirectory,
} from '../../../workspace-loader.js';
import type { CodingSubagentKind } from '../types.js';

export interface CodingInternalSubagentConfig {
  kind: CodingSubagentKind;
  name: string;
  description: string;
  workspacePath: string;
  runtimeRole: string;
  model?: string;
  tools?: ToolDefinition[];
}

export function createCodingInternalSubagent(config: CodingInternalSubagentConfig): AgentProfile {
  const instructions = [
    composeWorkspaceInstructions({
      workspaceDir: resolveWorkspaceDirectory(config.workspacePath),
      title: `${config.name} Workspace Instructions`,
    }),
    createInternalRuntimeBlock(config),
  ].join('\n\n');

  return defineAgentProfile({
    name: config.name,
    description: config.description,
    ...(config.model ? { model: config.model } : {}),
    ...(config.tools ? { tools: config.tools } : {}),
    instructions,
  });
}

function createInternalRuntimeBlock(config: CodingInternalSubagentConfig): string {
  return `# Runtime Capabilities

This is a worker-local internal subagent owned by the coding-worker lead.

Role: ${config.runtimeRole}

The main orchestrator must not call this subagent directly. The coding-worker lead decides when this subagent is needed and passes focused context into its child session.

Return structured findings, evidence, risks, and next actions to the coding-worker lead. Emit public trace summaries through the lead; do not expose raw hidden thinking or full internal prompts.`;
}

