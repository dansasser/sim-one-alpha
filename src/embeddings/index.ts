import * as ort from 'onnxruntime-node';
import { getOnnxSession } from './session.js';
import { loadTokenizer } from './tokenizer.js';
import { l2Normalize, meanPool } from './pooler.js';
import { resolveModelPath } from './model-loader.js';

export interface LocalEmbeddingOptions {
  /** Directory containing model.onnx, tokenizer.json, etc. */
  modelPath?: string;
  /** Maximum sequence length. Defaults to 256. */
  maxSequenceLength?: number;
}

const DEFAULT_MAX_SEQUENCE_LENGTH = 256;
const EMBEDDING_DIMENSIONS = 384;

function resolveOptions(options?: LocalEmbeddingOptions): Required<LocalEmbeddingOptions> {
  return {
    modelPath: options?.modelPath ?? resolveModelPath(),
    maxSequenceLength: options?.maxSequenceLength ?? DEFAULT_MAX_SEQUENCE_LENGTH,
  };
}

async function runInference(texts: string[], options: Required<LocalEmbeddingOptions>): Promise<number[][]> {
  const tokenizer = loadTokenizer(options.modelPath);
  const session = await getOnnxSession(options.modelPath);

  const encoded = await Promise.all(
    texts.map((text) => tokenizer.encode(text, options.maxSequenceLength)),
  );

  const maxLength = Math.max(...encoded.map((e) => e.inputIds.length));
  const batchSize = encoded.length;

  const inputIds = new BigInt64Array(batchSize * maxLength);
  const attentionMask = new BigInt64Array(batchSize * maxLength);
  const tokenTypeIds = new BigInt64Array(batchSize * maxLength);

  for (let b = 0; b < batchSize; b++) {
    const e = encoded[b];
    for (let i = 0; i < e.inputIds.length; i++) {
      inputIds[b * maxLength + i] = e.inputIds[i];
      attentionMask[b * maxLength + i] = e.attentionMask[i];
      tokenTypeIds[b * maxLength + i] = e.tokenTypeIds[i];
    }
  }

  const shape: number[] = [batchSize, maxLength];
  const feeds: Record<string, ort.Tensor> = {
    input_ids: new ort.Tensor('int64', inputIds, shape),
    attention_mask: new ort.Tensor('int64', attentionMask, shape),
    token_type_ids: new ort.Tensor('int64', tokenTypeIds, shape),
  };

  const results = await session.run(feeds);
  const lastHiddenState = results.last_hidden_state as ort.Tensor;
  const data = lastHiddenState.data as Float32Array;

  const vectors: number[][] = [];
  for (let b = 0; b < batchSize; b++) {
    const raw = meanPool(
      data.subarray(b * maxLength * EMBEDDING_DIMENSIONS, (b + 1) * maxLength * EMBEDDING_DIMENSIONS),
      encoded[b].attentionMask,
      EMBEDDING_DIMENSIONS,
    );
    vectors.push(l2Normalize(raw));
  }

  return vectors;
}

export async function embed(text: string, options?: LocalEmbeddingOptions): Promise<number[]> {
  const vectors = await embedBatch([text], options);
  return vectors[0] ?? [];
}

export async function embedBatch(texts: string[], options?: LocalEmbeddingOptions): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }
  return runInference(texts, resolveOptions(options));
}
