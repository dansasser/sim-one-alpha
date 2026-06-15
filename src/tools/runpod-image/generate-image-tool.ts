import { defineTool, Type } from '@flue/runtime';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadRunpodImageCatalog, getRunpodImageModel, getDefaultRunpodImageModel } from './catalog.js';
import { runpodGenerateImage } from './runpod-client.js';
import type { RunpodImageModel } from '../../schemas/runpod-image.js';

export const generateImageTool = defineTool({
  name: 'generate_image',
  description:
    'Generate or edit an image using Runpod Public Endpoints, download the resulting image file, and save it to workspace/images/. Returns the local file path and metadata.',
  parameters: Type.Object({
    prompt: Type.String(),
    eventId: Type.String(),
    model: Type.Optional(Type.String()),
    aspectRatio: Type.Optional(Type.String()),
    negativePrompt: Type.Optional(Type.String()),
    numInferenceSteps: Type.Optional(Type.Number()),
    guidance: Type.Optional(Type.Number()),
    seed: Type.Optional(Type.Number()),
    outputFormat: Type.Optional(Type.String({ enum: ['png', 'jpeg'] })),
    referenceImageUrls: Type.Optional(Type.Array(Type.String())),
    includeBase64: Type.Optional(Type.Boolean()),
    enableSafetyChecker: Type.Optional(Type.Boolean()),
    maxPollAttempts: Type.Optional(Type.Number()),
    pollIntervalMillis: Type.Optional(Type.Number()),
  }),
  execute: async (input) => {
    const apiKey = readStringEnv('RUNPOD_API_KEY');
    if (!apiKey) {
      return JSON.stringify({ ok: false, error: 'RUNPOD_API_KEY is not configured.' });
    }

    try {
      const baseURL = readStringEnv('RUNPOD_API_BASE_URL');
      const catalog = loadRunpodImageCatalog({ modelsPath: readStringEnv('RUNPOD_IMAGE_MODELS_PATH') });
      const modelId = input.model ?? catalog.defaultModel;
      const model = getRunpodImageModel(catalog, modelId) ?? getDefaultRunpodImageModel(catalog);

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

function resolveImageOutputDir(): string {
  const configuredDir = readStringEnv('GOROMBO_IMAGE_OUTPUT_DIR');
  const workspaceRoot =
    readStringEnv('GOROMBO_WORKSPACE_ROOT') ??
    readStringEnv('GOROMBO_CODING_WORKSPACE_ROOT') ??
    process.cwd();
  const dir = configuredDir ? resolve(configuredDir) : resolve(workspaceRoot, 'workspace', 'images');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
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
  set('image_format', input.outputFormat);
  set('enable_safety_checker', input.enableSafetyChecker);
  set('maxPollAttempts', input.maxPollAttempts);
  set('pollIntervalMillis', input.pollIntervalMillis);

  return defaults;
}
