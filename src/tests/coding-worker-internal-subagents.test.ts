import assert from 'node:assert/strict';
import test from 'node:test';

import { createCodingWorkerInternalSubagents } from '../workers/coding-worker/subagents/index.js';
import type { AgentProfile } from '@flue/runtime';

const MEMORY_TOOL_PREFIX = 'coding_task_';

function collectToolNames(profiles: AgentProfile[] | undefined, into: Set<string>): void {
  if (!profiles) return;
  for (const profile of profiles) {
    for (const tool of profile.tools ?? []) {
      if (typeof tool.name === 'string') {
        into.add(tool.name);
      }
    }
    collectToolNames(profile.subagents, into);
  }
}

test('coding-worker internal subagents do not receive Memory Helper tools (lead-only boundary)', () => {
  const profiles = createCodingWorkerInternalSubagents({
    workspaceRoot: '/tmp/cw-workspace',
    targetKind: 'project',
    projectId: 'proj-b',
    projectSlug: 'slug-b',
    projectRelativePath: 'projects/slug-b',
    env: {},
  });
  const names = new Set<string>();
  collectToolNames(profiles, names);
  const leaked = [...names].filter((n) => n.startsWith(MEMORY_TOOL_PREFIX));
  assert.deepEqual(leaked, [], `internal subagents must not expose memory tools, found: ${leaked.join(', ')}`);
});
