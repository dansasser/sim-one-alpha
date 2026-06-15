import { experimental_generateImage as generateImage, type GenerateImageResult } from 'ai';
import { runpod, createRunpod, type RunpodProvider } from '@runpod/ai-sdk-provider';
import type { JSONObject } from '@ai-sdk/provider';
import type { RunpodImageModel } from '../../schemas/runpod-image.js';

export interface RunpodGenerateOptions {
  apiKey?: string;
  baseURL?: string;
  modelId: string;
  model: RunpodImageModel;
  prompt: string | { text: string; images: string[] };
  aspectRatio?: string;
  providerOptions: Record<string, unknown>;
}

export async function runpodGenerateImage(options: RunpodGenerateOptions): Promise<GenerateImageResult> {
  const provider = createRunpodProvider(options);

  return generateImage({
    model: provider.image(options.modelId),
    prompt: options.prompt,
    ...(options.aspectRatio ? { aspectRatio: options.aspectRatio as `${number}:${number}` } : {}),
    providerOptions: { runpod: options.providerOptions as JSONObject } as Record<string, JSONObject>,
  });
}

function createRunpodProvider(options: RunpodGenerateOptions): RunpodProvider {
  if (options.apiKey || options.baseURL) {
    return createRunpod({
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    });
  }
  return runpod;
}
