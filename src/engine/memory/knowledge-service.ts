import { goromboPersistenceRuntime } from '../../db.js';
import { LanceDbKnowledgeStore } from '../../engine/rag/knowledge-store.js';
import type { AddKnowledgeInput } from '../../engine/rag/knowledge-store.js';

export const sharedKnowledgeStore = new LanceDbKnowledgeStore({
  vectorStore: goromboPersistenceRuntime.vectorStore,
  embeddingClient: goromboPersistenceRuntime.embeddingClient,
});

export async function addKnowledge(input: AddKnowledgeInput): Promise<ReturnType<LanceDbKnowledgeStore['add']>> {
  return sharedKnowledgeStore.add(input);
}
