import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRunpodImageCatalog, getRunpodImageModel, getDefaultRunpodImageModel } from './catalog.js';
import { runpodGenerateImage } from './runpod-client.js';
import { resolveImageOutputDir } from './paths.js';
import type { RunpodImageModel } from '../../schemas/runpod-image.js';

export const generateImageTool = defineTool({
  name: 'generate_image',
  description:
    'Generate or edit an image using Runpod Public Endpoints, download the resulting image file, and save it to workspace/images/. Returns the local file path and metadata.',
  parameters: v.object({
    prompt: v.string(),
    eventId: v.string(),
    model: v.optional(v.string()),
    aspectRatio: v.optional(v.string()),
    negativePrompt: v.optional(v.string()),
    numInferenceSteps: v.optional(v.number()),
    guidance: v.optional(v.number()),
    seed: v.optional(v.number()),
    outputFormat: v.optional(v.picklist(['png', 'jpeg'])),
    referenceImageUrls: v.optional(v.array(v.string())),
    includeBase64: v.optional(v.boolean()),
    enableSafetyChecker: v.optional(v.boolean()),
    maxPollAttempts: v.optional(v.number()),
    pollIntervalMillis: v.optional(v.number()),
  }),
  execute: async (input) => {
    const apiKey = readStringEnv('RUNPOD_API_KEY');
    if (!apiKey) {
      return JSON.stringify({ ok: false, error: 'RUNPOD_API_KEY is not configured.' });
    }

    try {
      const baseURL = readStringEnv('RUNPOD_API_BASE_URL');
      const catalog = loadRunpodImageCatalog({ modelsPath: readStringEnv('RUNPOD_IMAGE_MODELS_PATH') });
      let modelId = input.model ?? catalog.defaultModel;
      const model = getRunpodImageModel(catalog, modelId) ?? getDefaultRunpodImageModel(catalog);
      modelId = model.id;

      const providerOptions = buildProviderOptions(model, input);
      const prompt = buildPrompt(model, input.prompt, input.referenceImageUrls);

      const result = await runpodGenerateImage({
        apiKey,
        baseURL,
        modelId,
        model,
        prompt,
        aspectRatio: input.aspectRatio,
        providerOptions,
      });

      const outputFormat = (input.outputFormat ?? model.defaultProviderOptions?.image_format ?? 'png') as string;
      const mimeType = outputFormat === 'png' ? 'image/png' : 'image/jpeg';
      const extension = outputFormat === 'png' ? 'png' : 'jpeg';
      const outputDir = resolveImageOutputDir();
      const artifactId = randomUUID();
      const fileName = `${new Date().toISOString()}-${model.id}-${artifactId.slice(0, 8)}.${extension}`;
      const filePath = join(outputDir, fileName);

      writeFileSync(filePath, Buffer.from(result.image.uint8Array));

      const response: Record<string, unknown> = {
        ok: true,
        artifactId,
        filePath,
        fileName,
        mimeType,
        modelId,
        generatedAt: new Date().toISOString(),
      };

      if (input.seed != null) {
        response.seed = input.seed;
      }

      if (input.includeBase64) {
        response.base64 = result.image.base64;
      }

      return JSON.stringify(response);
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        modelId: input.model,
      });
    }
  },
});

function readStringEnv(key: string): string | undefined {
  const value = process.env[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function buildPrompt(
  model: RunpodImageModel,
  text: string,
  referenceImageUrls?: string[],
): string | { text: string; images: string[] } {
  if (referenceImageUrls && referenceImageUrls.length > 0) {
    if (model.kind !== 'image-to-image') {
      throw new Error(`Model ${model.id} does not support reference images.`);
    }
    const max = model.maxReferenceImages ?? referenceImageUrls.length;
    return { text, images: referenceImageUrls.slice(0, max) };
  }
  return text;
}

function buildProviderOptions(
  model: RunpodImageModel,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const defaults: Record<string, unknown> = { ...(model.defaultProviderOptions ?? {}) };

  const set = (key: string, value: unknown) => {
    if (value !== undefined && value !== null) {
      defaults[key] = value;
    }
  };

  set('negative_prompt', input.negativePrompt);
  set('num_inference_steps', input.numInferenceSteps);
  set('guidance', input.guidance);
  set('seed', input.seed);
  set('output_format', input.outputFormat);
  set('enable_safety_checker', input.enableSafetyChecker);
  set('maxPollAttempts', input.maxPollAttempts);
  set('pollIntervalMillis', input.pollIntervalMillis);

  return defaults;
}
