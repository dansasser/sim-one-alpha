import * as ort from 'onnxruntime-node';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveModelPath } from './model-loader.js';

const sessions = new Map<string, ort.InferenceSession | Promise<ort.InferenceSession>>();

export async function getOnnxSession(modelPath?: string): Promise<ort.InferenceSession> {
  const resolvedPath = modelPath ?? resolveModelPath();
  const modelFile = resolve(resolvedPath, 'model.onnx');
  if (!existsSync(modelFile)) {
    throw new Error(`ONNX model not found at ${modelFile}. Run "pnpm fetch-embedding-model".`);
  }

  const existing = sessions.get(modelFile);
  if (existing) {
    return existing;
  }

  const sessionPromise = ort.InferenceSession.create(modelFile, {
    executionProviders: ['cpu'],
  });
  sessions.set(modelFile, sessionPromise);

  try {
    const session = await sessionPromise;
    console.error(`[INFO] embeddings.onnx-loaded model=${modelFile}`);
    return session;
  } catch (error) {
    sessions.delete(modelFile);
    throw error;
  }
}
