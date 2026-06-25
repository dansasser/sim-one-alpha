import { experimental_generateImage as generateImage, type GenerateImageResult } from 'ai';
import { runpod, createRunpod, type RunpodProvider } from '@runpod/ai-sdk-provider';
import type { JSONObject } from '@ai-sdk/provider';
import type { RunpodImageModel } from '../../../core/schemas/runpod-image.js';

export interface RunpodGenerateOptions {
  apiKey?: string;
  baseURL?: string;
  modelId: string;
  model: RunpodImageModel;
  prompt: string | { text: string; images: string[] };
  aspectRatio?: string;
  providerOptions: Record<string, unknown>;
}

const DEFAULT_POLL_OPTIONS: JSONObject = {
  maxPollAttempts: 60,
  pollIntervalMillis: 5000,
};

export async function runpodGenerateImage(options: RunpodGenerateOptions): Promise<GenerateImageResult> {
  const provider = createRunpodProvider(options);

  const runpodOptions: JSONObject = {
    ...DEFAULT_POLL_OPTIONS,
    ...(options.providerOptions as JSONObject),
  };

  return generateImage({
    model: provider.image(options.model.id),
    prompt: options.prompt,
    ...(options.aspectRatio ? { aspectRatio: options.aspectRatio as `${number}:${number}` } : {}),
    providerOptions: { runpod: runpodOptions } as Record<string, JSONObject>,
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
