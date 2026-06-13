import type { Skill } from '@flue/runtime';

export const codingWorkerSkills: Skill[] = [
  {
    name: 'coding-worker.triage-loop',
    description:
      'Worker-local process guidance for classifying coding tasks, deciding which internal coding subagents are needed, and producing a public triage summary.',
  },
  {
    name: 'coding-worker.code-change-loop',
    description:
      'Worker-local process guidance for planning, editing, focused verification, debugging, and packaging code changes.',
  },
  {
    name: 'coding-worker.ci-debug-loop',
    description:
      'Worker-local process guidance for reading check failures, choosing focused reruns, debugging, and escalating unresolved CI blockers.',
  },
  {
    name: 'coding-worker.code-review-loop',
    description:
      'Worker-local process guidance for an independent diff review that checks requirements, regression risk, and verification evidence.',
  },
  {
    name: 'coding-worker.github-pr-loop',
    description:
      'Worker-local process guidance for GitHub issue, PR, checks, comments, branch, commit, push, and approval-aware publishing workflows.',
  },
];

export function createCodingWorkerSkillCapabilityBlock(): string {
  return `# Worker-Local Skills

The coding worker has these process skills registered as worker-local guidance:

- coding-worker.triage-loop
- coding-worker.code-change-loop
- coding-worker.ci-debug-loop
- coding-worker.code-review-loop
- coding-worker.github-pr-loop

Skills describe process and judgment. They do not replace tools, the Flue local sandbox, verification evidence, approval gates, or public progress events.`;
}

