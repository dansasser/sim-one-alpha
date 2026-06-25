import type { NormalizedMessageEvent, ProtocolBundle, ProtocolDefinition } from '../../core/types/index.js';

export interface ProtocolProvider {
  loadApplicable(event: NormalizedMessageEvent): Promise<ProtocolBundle>;
  listSeedProtocols(): ProtocolDefinition[];
}

export const baseProtocolSeeds: ProtocolDefinition[] = [
  {
    id: 'global.protocols-first',
    name: 'Protocols First',
    description: 'The orchestrator must load protocols before tool use, delegation, or final response.',
    scope: 'base',
    enabled: true,
    priority: 100,
    appliesTo: {},
    rules: [
      'Load applicable protocols before final reasoning.',
      'Treat protocols as runtime directives, not skills.',
      'Pass loaded protocol directives to delegated workers when they govern the task.',
    ],
    source: 'seed',
    tags: ['global', 'orchestration'],
  },
  {
    id: 'orchestrator.delegate-only',
    name: 'Orchestrator Delegation',
    description: 'The main orchestrator coordinates; substantive work is delegated to specialized workers.',
    scope: 'base',
    enabled: true,
    priority: 90,
    appliesTo: {},
    rules: [
      'The orchestrator does not perform web research, coding, or substantive execution directly.',
      'Delegate research to the researcher worker.',
      'Delegate coding tasks to the coding-worker lead only.',
    ],
    source: 'seed',
    tags: ['global', 'orchestration'],
  },
  {
    id: 'chat.basic-safe-response',
    name: 'Basic Safe Chat Response',
    description: 'Default chat routing rule for normalized message events.',
    scope: 'base',
    enabled: true,
    priority: 10,
    appliesTo: {
      messageKind: 'chat.message',
    },
    rules: ['Return a structured response even when all external tools are placeholders.'],
    source: 'seed',
    tags: ['chat'],
  },
  {
    id: 'coding.use-coding-worker',
    name: 'Coding Worker Delegation',
    description: 'Coding work is owned by the coding-worker lead.',
    scope: 'base',
    enabled: true,
    priority: 80,
    appliesTo: {
      workflow: 'coding',
    },
    rules: [
      'Delegate all coding work to the coding-worker lead only.',
      'Never invoke coding-worker internal subagents directly from the orchestrator.',
    ],
    source: 'seed',
    tags: ['coding', 'delegation'],
  },
  {
    id: 'coding.required-loop',
    name: 'Coding Worker Required Loop',
    description: 'Mandatory stages for a coding task.',
    scope: 'base',
    enabled: true,
    priority: 70,
    appliesTo: {
      workflow: 'coding',
    },
    rules: [
      'Run triage before implementation.',
      'Produce and follow a written plan before editing files.',
      'Run required verification before claiming completion.',
      'Run code review before finalizing mutating side effects.',
    ],
    source: 'seed',
    tags: ['coding', 'workflow'],
  },
  {
    id: 'coding.verify-before-complete',
    name: 'Verification Before Completion',
    description: 'The coding worker must verify before claiming success.',
    scope: 'base',
    enabled: true,
    priority: 70,
    appliesTo: {
      workflow: 'coding',
    },
    rules: [
      'Do not declare a coding task complete without passing required verification commands.',
      'If verification fails, debug and retry up to the configured replan budget.',
    ],
    source: 'seed',
    tags: ['coding', 'verification'],
  },
  {
    id: 'coding.mutating-actions-require-approval',
    name: 'Approval-Gated Mutations',
    description: 'All mutating side effects require explicit human approval.',
    scope: 'base',
    enabled: true,
    priority: 80,
    appliesTo: {
      workflow: 'coding',
    },
    rules: [
      'File edits require an explicit file.edit approval record.',
      'Git commit, push, and PR creation require explicit approval records.',
      'The model cannot approve its own requests.',
    ],
    source: 'seed',
    tags: ['coding', 'approval', 'safety'],
  },
  {
    id: 'coding.emit-progress',
    name: 'Coding Progress Visibility',
    description: 'The coding worker must surface progress events at every checkpoint.',
    scope: 'base',
    enabled: true,
    priority: 60,
    appliesTo: {
      workflow: 'coding',
    },
    rules: [
      'Emit public progress events at every loop checkpoint: plan, edits, verification, approval, PR.',
      'Do not behave like a black box.',
    ],
    source: 'seed',
    tags: ['coding', 'progress'],
  },
  {
    id: 'coding.output-report',
    name: 'Coding Completion Report',
    description: 'Required output format for a completed coding task.',
    scope: 'base',
    enabled: true,
    priority: 50,
    appliesTo: {
      workflow: 'coding',
      task: 'code-change',
    },
    rules: [
      'Report files created and modified.',
      'Report verification commands run and their results.',
      'Report any approvals requested or received.',
      'State the next recommended step.',
    ],
    source: 'seed',
    tags: ['coding', 'output'],
  },
];

