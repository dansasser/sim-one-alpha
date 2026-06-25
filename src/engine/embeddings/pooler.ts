export function meanPool(lastHiddenState: Float32Array, attentionMask: bigint[], dimensions: number): number[] {
  const sequenceLength = attentionMask.length;
  const embedding: number[] = new Array(dimensions).fill(0);
  let validTokens = 0;

  for (let i = 0; i < sequenceLength; i++) {
    if (attentionMask[i] === 0n) {
      continue;
    }
    validTokens++;
    const offset = i * dimensions;
    for (let d = 0; d < dimensions; d++) {
      embedding[d] += lastHiddenState[offset + d];
    }
  }

  if (validTokens === 0) {
    return embedding;
  }

  for (let d = 0; d < dimensions; d++) {
    embedding[d] /= validTokens;
  }

  return embedding;
}

export function l2Normalize(vector: number[]): number[] {
  let sum = 0;
  for (const value of vector) {
    sum += value * value;
  }

  const norm = Math.sqrt(sum);
  if (norm === 0) {
    return vector;
  }

  return vector.map((value) => value / norm);
}
