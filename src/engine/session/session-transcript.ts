import {
  parseOffset,
  type EventStreamStore,
} from '@flue/runtime/adapter';
import {
  isSupportedSlashCommand,
  parseSlashCommand,
} from '../commands/slash-commands.js';
import type {
  GoromboSessionDatabase,
  SessionNormalizedMessageRecord,
} from './session-database.js';

export type TranscriptActivityStatus = 'running' | 'completed' | 'failed';

export interface ChatTranscriptPrompt {
  id: string;
  text: string;
  receivedAt: string;
  visibility: 'user' | 'internal';
}

export interface ChatTranscriptActivity {
  id: string;
  kind: 'operation' | 'thinking' | 'tool' | 'task' | 'log';
  name: string;
  status: TranscriptActivityStatus;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  preview?: string;
  error?: string;
}

export interface ChatTranscriptAssistantMessage {
  id: string;
  text: string;
  completedAt: string;
}

export interface ChatTranscriptExchange {
  id: string;
  submissionId: string;
  prompt?: ChatTranscriptPrompt;
  activities: ChatTranscriptActivity[];
  assistant?: ChatTranscriptAssistantMessage;
  status: TranscriptActivityStatus;
}

export interface ChatTranscriptPage {
  session: {
    id: string;
    title?: string;
  };
  exchanges: ChatTranscriptExchange[];
  stream: {
    nextOffset: string;
    upToDate: boolean;
  };
  page: {
    limit: number;
    hasOlder: boolean;
    before?: string;
  };
}

export interface TranscriptCursorV1 {
  v: 1;
  receivedAt: string;
  eventId: string;
}

export interface TranscriptSourceEvent {
  offset: string;
  data: unknown;
}

export interface ProjectSessionTranscriptInput {
  session: {
    id: string;
    title?: string;
  };
  prompts: SessionNormalizedMessageRecord[];
  events: TranscriptSourceEvent[];
  stream: {
    nextOffset: string;
    upToDate: boolean;
  };
  page: {
    limit: number;
    hasOlder: boolean;
    before?: string;
  };
}

const LEGACY_STARTUP_PREFIX =
  'This is an automatic SIM-ONE Alpha local Ratatui TUI startup event.';
const MAX_ACTIVITY_NAME_CHARS = 120;
const MAX_THINKING_PREVIEW_CHARS = 500;
const MAX_LOG_PREVIEW_CHARS = 500;
const EVENT_STREAM_READ_LIMIT = 1_000;

export function encodeTranscriptCursor(cursor: TranscriptCursorV1): string {
  validateCursor(cursor);
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeTranscriptCursor(value: string): TranscriptCursorV1 {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    validateCursor(parsed);
    return parsed;
  } catch (error) {
    if (error instanceof TranscriptCursorError) {
      throw error;
    }
    throw new TranscriptCursorError();
  }
}

export function projectSessionTranscript(
  input: ProjectSessionTranscriptInput,
): ChatTranscriptPage {
  return projectSanitizedSessionTranscript(input, sanitizeEvents(input.events));
}

export async function loadSessionTranscriptPage(input: {
  session: {
    id: string;
    title?: string;
  };
  sessionDatabase: Pick<
    GoromboSessionDatabase,
    'getSessionNormalizedMessageEvent' | 'listNormalizedMessageEventsForSession'
  >;
  eventStreamStore: EventStreamStore;
  limit: number;
  before?: string;
}): Promise<ChatTranscriptPage> {
  const cursor = input.before ? decodeTranscriptCursor(input.before) : undefined;
  const cursorPrompt = cursor
    ? input.sessionDatabase.getSessionNormalizedMessageEvent({
        sessionId: input.session.id,
        eventId: cursor.eventId,
      })
    : undefined;
  if (cursor && !cursorPrompt) {
    throw new TranscriptCursorError();
  }
  const promptWindow = input.sessionDatabase.listNormalizedMessageEventsForSession({
    sessionId: input.session.id,
    limit: input.limit + 1,
    ...(cursor ? { before: cursor.eventId } : {}),
  });
  const hasOlder = promptWindow.length > input.limit;
  const prompts = hasOlder ? promptWindow.slice(1) : promptWindow;
  const before = hasOlder && prompts[0]
    ? encodeTranscriptCursor({
        v: 1,
        receivedAt: prompts[0].event.receivedAt,
        eventId: prompts[0].event.id,
      })
    : undefined;
  const streamPath = `agents/orchestrator/${input.session.id}`;

  if (prompts.length === 0) {
    const meta = await input.eventStreamStore.getStreamMeta(streamPath);
    return {
      session: input.session,
      exchanges: [],
      stream: {
        nextOffset: meta?.nextOffset ?? '-1',
        upToDate: true,
      },
      page: {
        limit: input.limit,
        hasOlder,
        ...(before ? { before } : {}),
      },
    };
  }

  const events: SanitizedEvent[] = [];
  const seen = new Set<string>();
  let offset = earliestPromptOffset(prompts);
  let upToDate = false;
  const endOffset = cursorPrompt ? promptOffset(cursorPrompt) : undefined;

  while (!upToDate) {
    const result = await input.eventStreamStore.readEvents(streamPath, {
      offset,
      limit: EVENT_STREAM_READ_LIMIT,
    });
    const pageEvents = endOffset
      ? result.events.filter((event) => compareOffsets(event.offset, endOffset) <= 0)
      : result.events;
    sanitizeEventsInto(pageEvents, events, seen);
    if (endOffset && (pageEvents.length < result.events.length
      || compareOffsets(result.nextOffset, endOffset) >= 0)) {
      offset = endOffset;
      upToDate = false;
      break;
    }
    upToDate = result.upToDate;
    if (!upToDate && result.nextOffset === offset) {
      throw new Error('Transcript event stream did not advance.');
    }
    offset = result.nextOffset;
  }

  return projectSanitizedSessionTranscript({
    session: input.session,
    prompts,
    events: [],
    stream: {
      nextOffset: offset,
      upToDate,
    },
    page: {
      limit: input.limit,
      hasOlder,
      ...(before ? { before } : {}),
    },
  }, events);
}

function projectSanitizedSessionTranscript(
  input: ProjectSessionTranscriptInput,
  events: SanitizedEvent[],
): ChatTranscriptPage {
  const prompts = input.prompts.filter(isReplayablePrompt);
  const builders = buildExchanges(events);
  const promptMatches = correlatePrompts(prompts, builders, events);
  const matchedSubmissionIds = new Set(
    [...promptMatches.values()].filter((value): value is string => Boolean(value)),
  );
  const entries: Array<{ sortKey: string; exchange: ChatTranscriptExchange }> = [];

  for (const prompt of prompts) {
    const submissionId = promptMatches.get(prompt.event.id);
    const builder = submissionId ? builders.get(submissionId) : undefined;
    const publicPrompt = toPublicTranscriptPrompt(prompt);
    if (builder) {
      entries.push({
        sortKey: prompt.event.receivedAt,
        exchange: finalizeExchange(builder, publicPrompt),
      });
      continue;
    }

    if (!publicPrompt) {
      continue;
    }
    const syntheticId = `prompt:${prompt.event.id}`;
    entries.push({
      sortKey: prompt.event.receivedAt,
      exchange: {
        id: syntheticId,
        submissionId: syntheticId,
        prompt: publicPrompt,
        activities: [],
        status: 'running',
      },
    });
  }

  const hasUnmatchedPrompt = promptMatches.size < prompts.length
    || [...promptMatches.values()].some((value) => value === undefined);
  if (prompts.length === 0 || hasUnmatchedPrompt) {
    for (const builder of builders.values()) {
      if (matchedSubmissionIds.has(builder.submissionId)) {
        continue;
      }
      entries.push({
        sortKey: builder.firstTimestamp ?? `~${String(builder.sequence).padStart(12, '0')}`,
        exchange: finalizeExchange(builder),
      });
    }
  }

  entries.sort((left, right) =>
    left.sortKey.localeCompare(right.sortKey)
      || left.exchange.id.localeCompare(right.exchange.id));

  return {
    session: input.session,
    exchanges: entries.map((entry) => entry.exchange),
    stream: input.stream,
    page: input.page,
  };
}

function isReplayablePrompt(prompt: SessionNormalizedMessageRecord): boolean {
  const hasDelivery = Boolean(
    prompt.delivery.submissionId
      || prompt.delivery.streamUrl
      || prompt.delivery.offset
      || prompt.legacyDeliveryId,
  );
  if (hasDelivery) {
    return true;
  }

  const command = parseSlashCommand(prompt.event.text);
  return !command || !isSupportedSlashCommand(command);
}

export class TranscriptCursorError extends Error {
  constructor() {
    super('Transcript cursor is invalid.');
    this.name = 'TranscriptCursorError';
  }
}

function validateCursor(value: unknown): asserts value is TranscriptCursorV1 {
  if (!isRecord(value)
    || value.v !== 1
    || !isNonEmptyString(value.receivedAt)
    || !isIsoTimestamp(value.receivedAt)
    || !isNonEmptyString(value.eventId)) {
    throw new TranscriptCursorError();
  }
}

function isIsoTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

interface SanitizedEvent {
  offset: string;
  type: string;
  submissionId: string;
  eventIndex?: number;
  timestamp?: string;
  operationId?: string;
  turnId?: string;
  toolCallId?: string;
  taskId?: string;
  name?: string;
  durationMs?: number;
  isError: boolean;
  role?: string;
  text?: string;
}

function sanitizeEvents(events: TranscriptSourceEvent[]): SanitizedEvent[] {
  const sanitized: SanitizedEvent[] = [];
  const seen = new Set<string>();
  sanitizeEventsInto(events, sanitized, seen);
  return sanitized;
}

function sanitizeEventsInto(
  events: TranscriptSourceEvent[],
  sanitized: SanitizedEvent[],
  seen: Set<string>,
): void {
  for (const source of events) {
    const event = sanitizeEvent(source);
    if (!event) {
      continue;
    }
    const identity = [
      event.submissionId,
      event.eventIndex ?? source.offset,
      event.type,
      event.timestamp ?? '',
    ].join('\u0000');
    if (seen.has(identity)) {
      continue;
    }
    seen.add(identity);
    sanitized.push(event);
  }
}

function sanitizeEvent(source: TranscriptSourceEvent): SanitizedEvent | null {
  if (!isRecord(source.data)) {
    return null;
  }
  const type = readString(source.data.type);
  const submissionId = readString(source.data.submissionId);
  if (!type || !submissionId) {
    return null;
  }

  const nested = readString(source.data.parentSession) !== undefined;
  if (nested) {
    return null;
  }
  const base: SanitizedEvent = {
    offset: source.offset,
    type,
    submissionId,
    isError: source.data.isError === true || source.data.error !== undefined,
    ...(readInteger(source.data.eventIndex) !== undefined
      ? { eventIndex: readInteger(source.data.eventIndex) }
      : {}),
    ...(readString(source.data.timestamp) ? { timestamp: readString(source.data.timestamp) } : {}),
    ...(readString(source.data.operationId)
      ? { operationId: readString(source.data.operationId) }
      : {}),
    ...(readString(source.data.turnId) ? { turnId: readString(source.data.turnId) } : {}),
    ...(readString(source.data.toolCallId)
      ? { toolCallId: readString(source.data.toolCallId) }
      : {}),
    ...(readString(source.data.taskId) ? { taskId: readString(source.data.taskId) } : {}),
    ...(readDuration(source.data.durationMs) !== undefined
      ? { durationMs: readDuration(source.data.durationMs) }
      : {}),
  };

  if (type === 'operation_start' || type === 'operation') {
    return {
      ...base,
      name: boundedText(
        readString(source.data.operationKind) ?? readString(source.data.name) ?? 'operation',
        MAX_ACTIVITY_NAME_CHARS,
      ),
    };
  }
  if (type === 'thinking_start' || type === 'thinking_delta' || type === 'thinking_end') {
    return {
      ...base,
      name: 'thinking',
      ...(boundedOptionalText(
        readString(source.data.delta)
          ?? readString(source.data.text)
          ?? readString(source.data.content),
        MAX_THINKING_PREVIEW_CHARS,
      ) ? {
          text: boundedOptionalText(
            readString(source.data.delta)
              ?? readString(source.data.text)
              ?? readString(source.data.content),
            MAX_THINKING_PREVIEW_CHARS,
          ),
        } : {}),
    };
  }
  if (type === 'tool_start' || type === 'tool') {
    return {
      ...base,
      name: boundedText(
        readString(source.data.toolName) ?? readString(source.data.name) ?? 'tool',
        MAX_ACTIVITY_NAME_CHARS,
      ),
    };
  }
  if (type === 'task_start' || type === 'task') {
    return {
      ...base,
      name: boundedText(
        readString(source.data.taskName) ?? readString(source.data.name) ?? 'task',
        MAX_ACTIVITY_NAME_CHARS,
      ),
    };
  }
  if (type === 'turn' || type === 'turn_start') {
    return base;
  }
  if (type === 'message_end') {
    const message = isRecord(source.data.message) ? source.data.message : undefined;
    const role = readString(message?.role);
    const text = role === 'assistant' ? extractMessageText(message?.content) : undefined;
    return {
      ...base,
      ...(role ? { role } : {}),
      ...(text ? { text } : {}),
    };
  }
  if (type === 'log') {
    const text = boundedOptionalText(
      readString(source.data.message) ?? readString(source.data.text),
      MAX_LOG_PREVIEW_CHARS,
    );
    return {
      ...base,
      name: 'log',
      ...(text ? { text } : {}),
    };
  }

  return null;
}

interface ExchangeBuilder {
  submissionId: string;
  sequence: number;
  firstTimestamp?: string;
  activities: Map<string, ChatTranscriptActivity>;
  activityOrder: string[];
  assistant?: ChatTranscriptAssistantMessage;
  operationSettled: boolean;
  failed: boolean;
}

function buildExchanges(events: SanitizedEvent[]): Map<string, ExchangeBuilder> {
  const builders = new Map<string, ExchangeBuilder>();

  for (const [sequence, event] of events.entries()) {
    const builder: ExchangeBuilder = builders.get(event.submissionId) ?? {
      submissionId: event.submissionId,
      sequence,
      firstTimestamp: event.timestamp,
      activities: new Map(),
      activityOrder: [],
      operationSettled: false,
      failed: false,
    };
    builders.set(event.submissionId, builder);
    if (!builder.firstTimestamp && event.timestamp) {
      builder.firstTimestamp = event.timestamp;
    }

    switch (event.type) {
      case 'operation_start':
      case 'operation': {
        const id = compoundId(event.submissionId, 'operation', event.operationId, event);
        upsertActivity(builder, id, {
          id,
          kind: 'operation',
          name: event.name ?? 'operation',
          status: event.type === 'operation_start'
            ? 'running'
            : event.isError ? 'failed' : 'completed',
          ...(event.type === 'operation_start' && event.timestamp
            ? { startedAt: event.timestamp }
            : {}),
          ...(event.type === 'operation' && event.timestamp
            ? { completedAt: event.timestamp }
            : {}),
          ...(event.type === 'operation' && event.durationMs !== undefined
            ? { durationMs: event.durationMs }
            : {}),
          ...(event.type === 'operation' && event.isError
            ? { error: 'Operation failed.' }
            : {}),
        });
        if (event.type === 'operation') {
          builder.operationSettled = true;
          builder.failed ||= event.isError;
        }
        break;
      }
      case 'thinking_start':
      case 'thinking_delta':
      case 'thinking_end': {
        const id = compoundId(event.submissionId, 'thinking', event.turnId, event);
        const current = builder.activities.get(id);
        const preview = event.text
          ? boundedText(
              event.type === 'thinking_delta'
                ? `${current?.preview ?? ''}${event.text}`
                : event.text,
              MAX_THINKING_PREVIEW_CHARS,
            )
          : current?.preview;
        upsertActivity(builder, id, {
          id,
          kind: 'thinking',
          name: 'thinking',
          status: event.type === 'thinking_end' ? 'completed' : 'running',
          ...(current?.startedAt
            ? { startedAt: current.startedAt }
            : event.timestamp ? { startedAt: event.timestamp } : {}),
          ...(event.type === 'thinking_end' && event.timestamp
            ? { completedAt: event.timestamp }
            : {}),
          ...(preview ? { preview } : {}),
        });
        break;
      }
      case 'tool_start':
      case 'tool': {
        const id = compoundId(event.submissionId, 'tool', event.toolCallId, event);
        upsertActivity(builder, id, terminalActivity(event, id, 'tool'));
        if (event.type === 'tool') {
          builder.failed ||= event.isError;
        }
        break;
      }
      case 'task_start':
      case 'task': {
        const id = compoundId(event.submissionId, 'task', event.taskId, event);
        upsertActivity(builder, id, terminalActivity(event, id, 'task'));
        if (event.type === 'task') {
          builder.failed ||= event.isError;
        }
        break;
      }
      case 'turn':
        builder.failed ||= event.isError;
        break;
      case 'message_end':
        if (event.role === 'assistant' && event.text) {
          builder.assistant = {
            id: compoundId(event.submissionId, 'message', undefined, event),
            text: event.text,
            completedAt: event.timestamp ?? '',
          };
        }
        break;
      case 'log': {
        const id = compoundId(event.submissionId, 'log', undefined, event);
        upsertActivity(builder, id, {
          id,
          kind: 'log',
          name: 'log',
          status: event.isError ? 'failed' : 'completed',
          ...(event.timestamp ? { completedAt: event.timestamp } : {}),
          ...(event.text ? { preview: event.text } : {}),
          ...(event.isError ? { error: 'Log event reported an error.' } : {}),
        });
        builder.failed ||= event.isError;
        break;
      }
      default:
        break;
    }
  }

  return builders;
}

function terminalActivity(
  event: SanitizedEvent,
  id: string,
  kind: 'tool' | 'task',
): ChatTranscriptActivity {
  const terminal = event.type === kind;
  return {
    id,
    kind,
    name: event.name ?? kind,
    status: terminal ? event.isError ? 'failed' : 'completed' : 'running',
    ...(!terminal && event.timestamp ? { startedAt: event.timestamp } : {}),
    ...(terminal && event.timestamp ? { completedAt: event.timestamp } : {}),
    ...(terminal && event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    ...(terminal && event.isError ? { error: `${capitalize(kind)} failed.` } : {}),
  };
}

function upsertActivity(
  builder: ExchangeBuilder,
  id: string,
  activity: ChatTranscriptActivity,
): void {
  const current = builder.activities.get(id);
  if (!current) {
    builder.activityOrder.push(id);
    builder.activities.set(id, activity);
    return;
  }
  builder.activities.set(id, {
    ...current,
    ...activity,
    ...(current.startedAt && !activity.startedAt ? { startedAt: current.startedAt } : {}),
  });
}

function correlatePrompts(
  prompts: SessionNormalizedMessageRecord[],
  builders: Map<string, ExchangeBuilder>,
  events: SanitizedEvent[],
): Map<string, string | undefined> {
  const matches = new Map<string, string | undefined>();
  const used = new Set<string>();
  const operationStarts = events
    .filter((event) => event.type === 'operation_start')
    .sort((left, right) => compareOffsets(left.offset, right.offset));

  for (const prompt of prompts) {
    const exact = prompt.delivery.submissionId
      ?? legacySubmissionId(prompt.legacyDeliveryId);
    if (exact && builders.has(exact) && !used.has(exact)) {
      matches.set(prompt.event.id, exact);
      used.add(exact);
    }
  }

  for (const prompt of prompts) {
    if (matches.has(prompt.event.id)) {
      continue;
    }
    const offset = prompt.delivery.offset ?? legacyOffset(prompt.legacyDeliveryId);
    if (!offset) {
      continue;
    }
    const operation = operationStarts.find((event) =>
      !used.has(event.submissionId) && compareOffsets(event.offset, offset) > 0);
    if (operation) {
      matches.set(prompt.event.id, operation.submissionId);
      used.add(operation.submissionId);
    }
  }

  const unmatchedPrompts = prompts.filter((prompt) => !matches.has(prompt.event.id));
  const unmatchedBuilders = [...builders.values()]
    .filter((builder) => !used.has(builder.submissionId))
    .sort((left, right) => left.sequence - right.sequence);
  if (unmatchedPrompts.length > 0 && unmatchedPrompts.length === unmatchedBuilders.length) {
    for (const [index, prompt] of unmatchedPrompts.entries()) {
      const submissionId = unmatchedBuilders[index]?.submissionId;
      matches.set(prompt.event.id, submissionId);
      if (submissionId) {
        used.add(submissionId);
      }
    }
  } else {
    for (const prompt of unmatchedPrompts) {
      matches.set(prompt.event.id, undefined);
    }
  }

  return matches;
}

function finalizeExchange(
  builder: ExchangeBuilder,
  prompt?: ChatTranscriptPrompt,
): ChatTranscriptExchange {
  return {
    id: builder.submissionId,
    submissionId: builder.submissionId,
    ...(prompt ? { prompt } : {}),
    activities: builder.activityOrder
      .map((id) => builder.activities.get(id))
      .filter((activity): activity is ChatTranscriptActivity => Boolean(activity)),
    ...(builder.assistant ? { assistant: builder.assistant } : {}),
    status: builder.failed
      ? 'failed'
      : builder.operationSettled || builder.assistant ? 'completed' : 'running',
  };
}

function toPublicTranscriptPrompt(
  prompt: SessionNormalizedMessageRecord,
): ChatTranscriptPrompt | undefined {
  const internal = prompt.event.context?.workflow === 'tui.startup-preflight'
    || prompt.event.text.startsWith(LEGACY_STARTUP_PREFIX);
  if (internal) {
    return undefined;
  }
  return {
    id: prompt.event.id,
    text: prompt.event.text,
    receivedAt: prompt.event.receivedAt,
    visibility: 'user',
  };
}

function legacySubmissionId(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return value.includes('#') ? undefined : value;
}

function legacyOffset(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const separator = value.lastIndexOf('#');
  if (separator < 0) {
    return undefined;
  }
  const offset = value.slice(separator + 1);
  try {
    parseOffset(offset);
    return offset;
  } catch {
    return undefined;
  }
}

function earliestPromptOffset(prompts: SessionNormalizedMessageRecord[]): string {
  for (const prompt of prompts) {
    const offset = prompt.delivery.offset ?? legacyOffset(prompt.legacyDeliveryId);
    if (offset) {
      return offset;
    }
  }
  return '-1';
}

function promptOffset(prompt: SessionNormalizedMessageRecord): string | undefined {
  return prompt.delivery.offset ?? legacyOffset(prompt.legacyDeliveryId);
}

function compareOffsets(left: string, right: string): number {
  try {
    return parseOffset(left) - parseOffset(right);
  } catch {
    return left.localeCompare(right);
  }
}

function compoundId(
  submissionId: string,
  kind: string,
  stableId: string | undefined,
  event: SanitizedEvent,
): string {
  return [
    submissionId,
    kind,
    stableId ?? event.eventIndex?.toString() ?? event.offset,
  ].join(':');
}

function extractMessageText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content.trim() || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .filter(isRecord)
    .filter((part) => part.type === 'text')
    .map((part) => readString(part.text))
    .filter((part): part is string => Boolean(part))
    .join('');
  return text.trim() || undefined;
}

function readString(value: unknown): string | undefined {
  return isNonEmptyString(value) ? value.trim() : undefined;
}

function readInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

function readDuration(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function boundedOptionalText(value: string | undefined, limit: number): string | undefined {
  return value ? boundedText(value, limit) : undefined;
}

function boundedText(value: string, limit: number): string {
  const characters = [...value];
  return characters.length <= limit
    ? value
    : `${characters.slice(0, Math.max(0, limit - 3)).join('')}...`;
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
