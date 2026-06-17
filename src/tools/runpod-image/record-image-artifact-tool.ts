import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { loadRunpodImageCatalog, getRunpodImageModel } from './catalog.js';
import { persistImageArtifact } from './artifact-store.js';
import { resolveImageArtifactFilePath } from './paths.js';
import { goromboPersistenceRuntime } from '../../db.js';

export const recordImageArtifactTool = defineTool({
  name: 'record_image_artifact',
  description:
    'Persist metadata for a generated image into SQLite and index it in session memory for retrieval.',
  parameters: v.object({
    eventId: v.string(),
    artifactId: v.string(),
    filePath: v.string(),
    fileName: v.string(),
    mimeType: v.string(),
    prompt: v.string(),
    modelId: v.string(),
    modelName: v.optional(v.string()),
    aspectRatio: v.optional(v.string()),
    seed: v.optional(v.number()),
    negativePrompt: v.optional(v.string()),
    providerOptions: v.optional(v.object({})),
    referenceImageUrls: v.optional(v.array(v.string())),
    sourceUrl: v.optional(v.string()),
  }),
  execute: async (input) => {
    const event = goromboPersistenceRuntime.sessionDatabase.getNormalizedMessageEvent(input.eventId);
    if (!event) {
      return JSON.stringify({ ok: false, error: `No persisted event found for eventId ${input.eventId}` });
    }

    try {
      const catalog = loadRunpodImageCatalog();
      const model = getRunpodImageModel(catalog, input.modelId);
      const modelName = input.modelName ?? model?.name ?? input.modelId;

      const safeFilePath = resolveImageArtifactFilePath(input.filePath);

      const record = persistImageArtifact({
        event,
        generationResult: {
          ok: true,
          artifactId: input.artifactId,
          filePath: safeFilePath,
          fileName: input.fileName,
          mimeType: input.mimeType,
          modelId: input.modelId,
          seed: input.seed,
          generatedAt: new Date().toISOString(),
        },
        prompt: input.prompt,
        modelId: input.modelId,
        modelName,
        aspectRatio: input.aspectRatio,
        negativePrompt: input.negativePrompt,
        providerOptions: input.providerOptions ?? {},
        referenceImageUrls: input.referenceImageUrls,
        sourceUrl: input.sourceUrl,
      });

      return JSON.stringify({
        ok: true,
        artifactId: record.artifactId,
        persistedAt: record.createdAt,
      });
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
});
