import { defineTool, Type } from '@flue/runtime';
import { goromboPersistenceRuntime } from '../../db.js';
import type { ImageArtifactRecord } from '../../schemas/runpod-image.js';

export const listImageArtifactsTool = defineTool({
  name: 'list_image_artifacts',
  description:
    'List previously generated image artifacts from SQLite, optionally filtered by event.',
  parameters: Type.Object({
    eventId: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Number()),
    after: Type.Optional(Type.String()),
  }),
  execute: async (input) => {
    const db = goromboPersistenceRuntime.sessionDatabase;
    const rows = db.listImageArtifacts({
      eventId: input.eventId,
      limit: input.limit,
      after: input.after,
    });

    const artifacts: ImageArtifactRecord[] = rows.map((row) => ({
      artifactId: row.artifact_id,
      eventId: row.event_id,
      prompt: row.prompt,
      modelId: row.model_id,
      modelName: row.model_name,
      aspectRatio: row.aspect_ratio ?? undefined,
      seed: row.seed ?? undefined,
      negativePrompt: row.negative_prompt ?? undefined,
      providerOptions: JSON.parse(row.provider_options_json),
      sourceUrl: row.source_url ?? undefined,
      filePath: row.file_path,
      fileName: row.file_name,
      mimeType: row.mime_type,
      fileSizeBytes: row.file_size_bytes,
      referenceImageUrls: row.reference_image_urls_json ? JSON.parse(row.reference_image_urls_json) : undefined,
      createdAt: row.created_at,
    }));

    return JSON.stringify({ artifacts });
  },
});
