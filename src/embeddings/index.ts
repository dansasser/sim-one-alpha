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

function resolveOptions(options?: LocalEmbeddingOptions): Required<LocalEmbeddingOptions> {
  const maxSequenceLength = options?.maxSequenceLength ?? DEFAULT_MAX_SEQUENCE_LENGTH;
  if (!Number.isInteger(maxSequenceLength) || maxSequenceLength < 2) {
    throw new TypeError(`maxSequenceLength must be an integer of at least 2, received ${maxSequenceLength}`);
  }
  return {
    modelPath: options?.modelPath ?? resolveModelPath(),
    maxSequenceLength,
  };
}

async function runInference(texts: string[], options: Required<LocalEmbeddingOptions>): Promise<number[][]> {
  const tokenizer = loadTokenizer(options.modelPath);
  const { session, dimensions } = await loadSessionWithShape(options.modelPath);

  const encoded = texts.map((text) => tokenizer.encode(text, options.maxSequenceLength));

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
  const outputName = session.outputNames[0];
  if (!outputName) {
    throw new Error('ONNX session has no outputs');
  }
  const lastHiddenState = results[outputName] as ort.Tensor;
  const data = lastHiddenState.data as Float32Array;

  if (
    lastHiddenState.dims.length !== 3 ||
    lastHiddenState.dims[0] !== batchSize ||
    lastHiddenState.dims[1] !== maxLength ||
    lastHiddenState.dims[2] !== dimensions
  ) {
    throw new Error(
      `Unexpected ONNX output shape [${lastHiddenState.dims.join(', ')}], expected [${batchSize}, ${maxLength}, ${dimensions}]`,
    );
  }

  const vectors: number[][] = [];
  for (let b = 0; b < batchSize; b++) {
    const raw = meanPool(
      data.subarray(b * maxLength * dimensions, (b + 1) * maxLength * dimensions),
      encoded[b].attentionMask,
      dimensions,
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

async function loadSessionWithShape(modelPath: string): Promise<{ session: ort.InferenceSession; dimensions: number }> {
  const session = await getOnnxSession(modelPath);
  const outputName = session.outputNames[0];
  if (!outputName) {
    throw new Error('ONNX session has no outputs');
  }
  const metadata = session.outputMetadata as unknown as Record<string | number, { name?: string; shape?: readonly unknown[]; dimensions?: number[] }>;
  const tensorInfo =
    metadata[outputName] ??
    metadata[0] ??
    Object.values(metadata).find((info) => info?.name === outputName);
  const dims = (tensorInfo?.shape ?? tensorInfo?.dimensions) as number[] | undefined;
  if (!dims || dims.length < 2) {
    throw new Error(`Unexpected ONNX output shape: ${JSON.stringify(dims)}`);
  }
  const lastDim = dims[dims.length - 1];
  const dimensions = typeof lastDim === 'number' ? lastDim : Number(lastDim);
  if (!Number.isFinite(dimensions) || dimensions <= 0) {
    throw new Error(`Unexpected ONNX output dimension: ${String(lastDim)}`);
  }
  return { session, dimensions };
}
