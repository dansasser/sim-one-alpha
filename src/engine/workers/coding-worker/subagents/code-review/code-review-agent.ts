import type { AgentProfile, ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import {
  CodingCodeReviewFindingSchema,
  CodingCodeReviewResultSchema,
  type CodingCodeReviewResult,
  type CodingCodeReviewFinding,
} from '../../../../../core/schemas/coding-worker.js';
import { createCodingInternalSubagent } from '../../../../../engine/workers/coding-worker/subagents/profile-factory.js';

export const codingCodeReviewSubagentName = 'coding-worker-code-review';

export function createCodingCodeReviewSubagent(model?: string, tools?: ToolDefinition[]): AgentProfile {
  return createCodingInternalSubagent({
    kind: 'code-review',
    name: codingCodeReviewSubagentName,
    description: 'Worker-local code review subagent for independent diff, risk, and verification review.',
    workspacePath: 'workers/coding-worker/subagents/code-review/workspace',
    runtimeRole:
      'Review the resulting diff against requirements, verify test evidence, identify risks, and return a structured result. ' +
      'The final response must be a JSON object matching CodingCodeReviewResult: { findings: CodingCodeReviewFinding[], approved: boolean }. ' +
      'Each finding must include severity (info|warning|blocker), a message, and the file path and line range when applicable. ' +
      'Do not approve completion unless required verification evidence is passing and no blockers remain.',
    model,
    tools,
  });
}

/**
 * Fallback parser for free-text code review output.
 *
 * Use this when the model does not return a native structured result. It extracts
 * findings with severity, message, and optional file/line locations, and infers the
 * approval status from explicit markers or the absence of blockers.
 */
export function parseCodingCodeReviewText(text: string): CodingCodeReviewResult {
  const lines = text.split(/\r?\n/);
  const findings: CodingCodeReviewFinding[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const severity = parseFindingSeverity(line);
    if (!severity) continue;

    const location = parseFindingLocation(line);
    const message = parseFindingMessage(line, severity, location);
    if (!message) continue;

    const finding: CodingCodeReviewFinding = {
      severity,
      message,
      ...(location.file ? { file: location.file } : {}),
      ...(location.lineStart !== undefined ? { lineStart: location.lineStart } : {}),
      ...(location.lineEnd !== undefined ? { lineEnd: location.lineEnd } : {}),
    };

    const parsed = v.safeParse(CodingCodeReviewFindingSchema, finding);
    if (parsed.success) {
      findings.push(parsed.output);
    }
  }

  const approved = inferApproval(text, findings);
  const result: CodingCodeReviewResult = { findings, approved };

  const parsedResult = v.safeParse(CodingCodeReviewResultSchema, result);
  return parsedResult.success ? parsedResult.output : { findings: [], approved: false };
}

function parseFindingSeverity(line: string): CodingCodeReviewFinding['severity'] | undefined {
  const markerMatch = line.match(/\[(info|warning|blocker)\]/i) || line.match(/\*\*(info|warning|blocker)\*\*[:;]?/i);
  if (markerMatch) {
    const severity = markerMatch[1].toLowerCase();
    if (severity === 'info' || severity === 'warning' || severity === 'blocker') {
      return severity;
    }
  }

  const leadingMatch = line.match(/^(info|warning|blocker)[:;\s-]/i);
  if (leadingMatch) {
    const severity = leadingMatch[1].toLowerCase();
    if (severity === 'info' || severity === 'warning' || severity === 'blocker') {
      return severity;
    }
  }

  return undefined;
}

interface FindingLocation {
  file?: string;
  lineStart?: number;
  lineEnd?: number;
}

function parseFindingLocation(line: string): FindingLocation {
  const match = line.match(/`?([^`\s:]+\.[A-Za-z0-9._-]+):(\d+)(?:-(\d+))?`?/);
  if (!match) {
    return {};
  }

  const file = match[1];
  const lineStart = Number.parseInt(match[2], 10);
  const lineEnd = match[3] ? Number.parseInt(match[3], 10) : undefined;

  return {
    file,
    lineStart,
    lineEnd,
  };
}

function parseFindingMessage(line: string, severity: string, location: FindingLocation): string | undefined {
  let message = line;

  message = message.replace(new RegExp(`\\[${severity}\\]`, 'i'), '');
  message = message.replace(new RegExp(`\\*\\*${severity}\\*\\*[:;]?`, 'i'), '');
  message = message.replace(new RegExp(`^${severity}[:;\\s-]`, 'i'), '');

  if (location.file) {
    const locationPattern = new RegExp(
      '`?' +
        location.file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
        ':(\\d+)(?:-(\\d+))?`?',
    );
    message = message.replace(locationPattern, '');
  }

  message = message.replace(/^[\s\-—:]+/, '').trim();
  return message || 'No detailed message provided.';
}

function inferApproval(text: string, findings: CodingCodeReviewFinding[]): boolean {
  const explicitApproved = text.match(/approved[:\s]*(true|false|yes|no)/i);
  if (explicitApproved) {
    const value = explicitApproved[1].toLowerCase();
    return value === 'true' || value === 'yes';
  }

  return !findings.some((finding) => finding.severity === 'blocker');
}
