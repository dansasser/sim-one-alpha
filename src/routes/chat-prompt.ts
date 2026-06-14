import type { NormalizedMessageEvent } from '../types/index.js';

export function createChatPrompt(event: NormalizedMessageEvent): string {
  const safeEvent = {
    connector: event.connector,
    messageKind: event.kind,
    receivedAt: event.receivedAt,
    ...(event.actor.displayName ? { actorDisplayName: event.actor.displayName } : {}),
    ...(event.context?.workflow ? { workflow: event.context.workflow } : {}),
    ...(event.context?.task ? { task: event.context.task } : {}),
    text: event.text,
  };

  return `
You are handling a normalized chat event for this AI employee system.

Before you answer:
1. Use the load_protocols tool for this event with eventId: "${event.id}". Do not pass or invent clientId, projectId, raw payloads, or other hidden identifiers.
2. Do not perform web search directly and do not call web-capable retrieval tools from the orchestrator.
3. Use the Flue task tool with agent: "researcher" for any current, external, web, source-backed, or research task. The researcher owns web_research and decides how many searches or fetches are needed.
4. Use retrieve_memory with eventId: "${event.id}" when stored conversation or project memory would help. Do not pass or invent actorId or conversationId.
5. If research metadata reports providerFailures, say that plainly when it affects confidence and continue with the best available context.
6. If a specific provider is still a placeholder, say that plainly and continue with the best available answer.
7. If this event came from the telegram connector and you want to respond, use the telegram_reply tool with eventId: "${event.id}" and the text you want to send. Do not invent chat_id; the tool reads it from the trusted persisted event.

Safe event:
${JSON.stringify(safeEvent, null, 2)}

Answer the user message naturally and keep the response concise.
`;
}
