import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ResolveModelPathOptions {
  modelPath?: string;
}

const DEFAULT_MODEL_PATH = resolve(process.cwd(), 'assets/models/embeddings/all-MiniLM-L6-v2');

export function resolveModelPath(options?: ResolveModelPathOptions): string {
  return options?.modelPath ?? process.env.GOROMBO_EMBEDDING_MODEL_PATH ?? DEFAULT_MODEL_PATH;
}

export function assertModelFilesExist(modelPath: string): void {
  const modelFile = resolve(modelPath, 'model.onnx');
  const tokenizerFile = resolve(modelPath, 'tokenizer.json');

  if (!existsSync(modelFile) || !existsSync(tokenizerFile)) {
    throw new Error(
      `Local embedding model not found at ${modelPath}. Run "pnpm fetch-embedding-model".`,
    );
  }
}

export function getModelError(modelPath: string): string {
  return `Local embedding model not found at ${modelPath}. Run "pnpm fetch-embedding-model".`;
}
