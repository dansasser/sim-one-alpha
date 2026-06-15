#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const approvalRoot = readRequiredEnv('GOROMBO_APPROVAL_ROOT');
const apiSecret = process.env.API_SECRET;

if (!apiSecret) {
  console.warn('Warning: API_SECRET is not set. Using a local-only operator principal.');
}

ensureCompiled();

const { createApprovalIngress, createFileApprovalBindingStore } = await import(
  '../.tmp/tsc/ingress/approval-ingress.js'
);
const { createSharedCodingApprovalService } = await import(
  '../.tmp/tsc/approvals/shared-approval-service.js'
);

const approvalService = createSharedCodingApprovalService({ GOROMBO_APPROVAL_ROOT: approvalRoot });
const ingress = createApprovalIngress({
  approvalService,
  bindingStore: createFileApprovalBindingStore(approvalRoot),
});

const [command, ...args] = process.argv.slice(2);

try {
  switch (command) {
    case 'list':
      await listCommand();
      break;
    case 'show':
      await showCommand(args[0]);
      break;
    case 'approve':
      await decisionCommand(args, true);
      break;
    case 'deny':
      await decisionCommand(args, false);
      break;
    case undefined:
    case 'help':
      printUsage();
      process.exit(0);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function listCommand() {
  const pending = await ingress.listPendingApprovals();
  if (pending.length === 0) {
    console.log('No pending approvals.');
    return;
  }
  for (const record of pending) {
    const request = record.request;
    console.log(`${request.id}  ${request.actionType.padEnd(20)}  ${request.taskId}  ${request.summary}`);
  }
}

async function showCommand(requestId) {
  if (!requestId) {
    throw new Error('Usage: approvals-cli.mjs show <requestId>');
  }
  const record = await ingress.getApprovalRequest(requestId);
  if (!record) {
    throw new Error(`Approval request not found: ${requestId}`);
  }
  console.log(JSON.stringify(record, null, 2));
}

async function decisionCommand(args, approved) {
  const requestId = args[0];
  if (!requestId) {
    throw new Error(`Usage: approvals-cli.mjs ${approved ? 'approve' : 'deny'} <requestId> [--reason <reason>]`);
  }
  const reason = parseOption(args.slice(1), '--reason');
  const decidedBy = process.env.USER || 'cli-operator';
  const decision = await ingress.recordApprovalDecision({
    requestId,
    approved,
    decidedBy,
    reason,
    principal: { id: decidedBy, roles: ['operator'] },
  });
  console.log(`Recorded ${decision.approved ? 'approve' : 'deny'} decision for ${requestId}.`);
}

function parseOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) {
    return undefined;
  }
  return args[index + 1];
}

function printUsage() {
  console.log(`Usage: node scripts/approvals-cli.mjs <command> [args]

Commands:
  list                              List pending approvals.
  show <requestId>                  Show a single approval request.
  approve <requestId> [--reason]    Record an approve decision.
  deny <requestId> [--reason]       Record a deny decision.

Environment:
  GOROMBO_APPROVAL_ROOT  Required. Shared approval persistence root.
  API_SECRET             Optional. If missing, uses a local-only operator principal.
`);
}

function readRequiredEnv(key) {
  const value = process.env[key];
  if (!value) {
    console.error(`Missing required environment variable: ${key}`);
    printUsage();
    process.exit(1);
  }
  return value;
}

function ensureCompiled() {
  const marker = resolve('.tmp/tsc/ingress/approval-ingress.js');
  if (existsSync(marker)) {
    return;
  }
  const result = spawnSync(
    process.execPath,
    ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
