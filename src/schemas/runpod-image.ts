import * as v from 'valibot';

export const RunpodImageModelKindSchema = v.picklist(['text-to-image', 'image-to-image']);

export const RunpodImageModelSchema = v.object({
  id: v.string(),
  name: v.string(),
  kind: RunpodImageModelKindSchema,
  description: v.optional(v.string()),
  supportedAspectRatios: v.optional(v.array(v.string())),
  defaultProviderOptions: v.optional(v.record(v.string(), v.unknown())),
  maxReferenceImages: v.optional(v.number()),
  enabled: v.optional(v.boolean(), true),
});

export const RunpodImageCatalogSchema = v.object({
  version: v.literal(1),
  defaultModel: v.string(),
  models: v.array(RunpodImageModelSchema),
});

export type RunpodImageModel = v.InferOutput<typeof RunpodImageModelSchema>;
export type RunpodImageCatalog = v.InferOutput<typeof RunpodImageCatalogSchema>;

export const GeneratedImageFileSchema = v.object({
  filePath: v.string(),
  fileName: v.string(),
  mimeType: v.string(),
  bytes: v.number(),
});

export const ImageArtifactRecordSchema = v.object({
  artifactId: v.string(),
  eventId: v.string(),
  prompt: v.string(),
  modelId: v.string(),
  modelName: v.string(),
  aspectRatio: v.optional(v.string()),
  seed: v.optional(v.number()),
  negativePrompt: v.optional(v.string()),
  providerOptions: v.optional(v.record(v.string(), v.unknown())),
  sourceUrl: v.optional(v.string()),
  filePath: v.string(),
  fileName: v.string(),
  mimeType: v.string(),
  fileSizeBytes: v.number(),
  referenceImageUrls: v.optional(v.array(v.string())),
  createdAt: v.string(),
});

export type ImageArtifactRecord = v.InferOutput<typeof ImageArtifactRecordSchema>;

export const GenerateImageSuccessSchema = v.object({
  ok: v.literal(true),
  artifactId: v.string(),
  filePath: v.string(),
  fileName: v.string(),
  mimeType: v.string(),
  modelId: v.string(),
  seed: v.optional(v.number()),
  generatedAt: v.string(),
  base64: v.optional(v.string()),
});

export const GenerateImageErrorSchema = v.object({
  ok: v.literal(false),
  error: v.string(),
  modelId: v.optional(v.string()),
});

export const RecordImageArtifactSuccessSchema = v.object({
  ok: v.literal(true),
  artifactId: v.string(),
  persistedAt: v.string(),
});

export const ImageArtifactQueryResultSchema = v.object({
  artifacts: v.array(ImageArtifactRecordSchema),
});

export type GenerateImageSuccess = v.InferOutput<typeof GenerateImageSuccessSchema>;
export type GenerateImageError = v.InferOutput<typeof GenerateImageErrorSchema>;
