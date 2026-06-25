import type { AgentProfile, ToolDefinition } from '@flue/runtime';
import { createCodingInternalSubagent } from '../../../../../engine/workers/coding-worker/subagents/profile-factory.js';
import { createCodingImplementerTools } from '../../../../../engine/workers/coding-worker/tools/coding-implementer-tools.js';

export const codingImplementerSubagentName = 'coding-worker-implementer';

export function createCodingImplementerSubagent(model?: string, tools?: ToolDefinition[]): AgentProfile {
  const implementerTools = createCodingImplementerTools();
  const mergedTools = mergeToolsByName(tools ?? [], implementerTools);

  return createCodingInternalSubagent({
    kind: 'implementer',
    name: codingImplementerSubagentName,
    description: 'Worker-local implementer subagent for scoped code edits inside the coding-worker subsystem.',
    workspacePath: 'workers/coding-worker/subagents/implementer/workspace',
    runtimeRole:
      'Apply approved scoped code changes using the Flue local sandbox supplied by the coding task workflow. ' +
      'When your implementation is complete, you MUST call `coding_implementer_submit_result` and return a result that conforms to the CodingImplementerResult schema: fileEdits (path, oldText, newText, optional expectedOccurrences), writeFiles (path, content), and verificationCommands (name, command, optional required/reason/cwd/timeoutSeconds). The coding-worker lead validates the submitted result and applies the edits.',
    model,
    tools: mergedTools,
  });
}

function mergeToolsByName(existingTools: ToolDefinition[], additionalTools: ToolDefinition[]): ToolDefinition[] {
  const map = new Map<string, ToolDefinition>();
  for (const tool of existingTools) {
    map.set(tool.name, tool);
  }
  for (const tool of additionalTools) {
    map.set(tool.name, tool);
  }
  return [...map.values()];
}
