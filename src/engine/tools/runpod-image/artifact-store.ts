import { statSync } from 'node:fs';
import { goromboPersistenceRuntime } from '../../../core/db.js';
import { estimateTextTokens } from '../../../engine/session/context-budget.js';
import type {
  ImageArtifactRecord,
  GenerateImageSuccess,
} from '../../../core/schemas/runpod-image.js';
import type { NormalizedMessageEvent } from '../../../core/types/index.js';

export interface PersistImageArtifactInput {
  event: NormalizedMessageEvent;
  generationResult: GenerateImageSuccess;
  prompt: string;
  modelId: string;
  modelName: string;
  aspectRatio?: string;
  negativePrompt?: string;
  providerOptions: Record<string, unknown>;
  referenceImageUrls?: string[];
  sourceUrl?: string;
}

export function persistImageArtifact(input: PersistImageArtifactInput): ImageArtifactRecord {
  const db = goromboPersistenceRuntime.sessionDatabase;
  const now = new Date().toISOString();
  const stats = statSync(input.generationResult.filePath);
  const artifactId = input.generationResult.artifactId;

  const record: ImageArtifactRecord = {
    artifactId,
    eventId: input.event.id,
    prompt: input.prompt,
    modelId: input.modelId,
    modelName: input.modelName,
    aspectRatio: input.aspectRatio,
    seed: input.generationResult.seed,
    negativePrompt: input.negativePrompt,
    providerOptions: input.providerOptions ?? {},
    sourceUrl: input.sourceUrl,
    filePath: input.generationResult.filePath,
    fileName: input.generationResult.fileName,
    mimeType: input.generationResult.mimeType,
    fileSizeBytes: stats.size,
    referenceImageUrls: input.referenceImageUrls,
    createdAt: now,
  };

  db.createImageArtifact({
    artifactId: record.artifactId,
    eventId: record.eventId,
    prompt: record.prompt,
    modelId: record.modelId,
    modelName: record.modelName,
    aspectRatio: record.aspectRatio,
    seed: record.seed,
    negativePrompt: record.negativePrompt,
    providerOptions: record.providerOptions ?? {},
    sourceUrl: record.sourceUrl,
    filePath: record.filePath,
    fileName: record.fileName,
    mimeType: record.mimeType,
    fileSizeBytes: record.fileSizeBytes,
    referenceImageUrls: record.referenceImageUrls,
  });

  indexArtifactInSessionMemory(record, input.event);

  return record;
}

function indexArtifactInSessionMemory(
  record: ImageArtifactRecord,
  event: NormalizedMessageEvent,
): void {
  const db = goromboPersistenceRuntime.sessionDatabase;
  const content = `Prompt: ${record.prompt}\nModel: ${record.modelId}\nFile: ${record.filePath}`;
  db.recordSessionMemoryChunk({
    storageKey: `image:${record.artifactId}`,
    harnessName: 'image-tool',
    sessionName: record.eventId,
    entryId: record.artifactId,
    kind: 'image.artifact',
    actorId: event.actor.id,
    conversationId: event.conversation.id,
    title: `Generated image: ${record.modelName}`,
    content,
    tokenEstimate: estimateTextTokens(content),
    metadata: {
      artifactId: record.artifactId,
      modelId: record.modelId,
      filePath: record.filePath,
      mimeType: record.mimeType,
    },
    createdAt: record.createdAt,
    updatedAt: record.createdAt,
  });
}
