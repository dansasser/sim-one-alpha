#!/usr/bin/env node
/**
 * Download the bundled all-MiniLM-L6-v2 ONNX model and tokenizer files.
 * Run with: node scripts/fetch-embedding-model.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODEL_DIR = resolve(__dirname, '../assets/models/embeddings/all-MiniLM-L6-v2');
const HF_REPO = 'sentence-transformers/all-MiniLM-L6-v2';
// Pinned revision for reproducible, immutable downloads.
const HF_REVISION = '1110a243fdf4706b3f48f1d95db1a4f5529b4d41';
function readTimeoutMs() {
  const envValue = process.env.DOWNLOAD_TIMEOUT_MS;
  if (!envValue) {
    return 30_000;
  }
  const parsed = Number(envValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[WARN] Invalid DOWNLOAD_TIMEOUT_MS "${envValue}"; using default 30000ms`);
    return 30_000;
  }
  return parsed;
}

const DOWNLOAD_TIMEOUT_MS = readTimeoutMs();

// Files we need. The ONNX model lives in the onnx/ subfolder.
const FILES = [
  { remote: 'onnx/model.onnx', local: 'model.onnx' },
  { remote: 'tokenizer.json', local: 'tokenizer.json' },
  { remote: 'tokenizer_config.json', local: 'tokenizer_config.json' },
  { remote: 'config.json', local: 'config.json' },
  { remote: 'vocab.txt', local: 'vocab.txt' },
  { remote: 'special_tokens_map.json', local: 'special_tokens_map.json' },
];

async function downloadFile(remotePath, localPath) {
  const url = `https://huggingface.co/${HF_REPO}/resolve/${HF_REVISION}/${remotePath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Download timed out after ${DOWNLOAD_TIMEOUT_MS}ms: ${url}`);
    }
    throw new Error(`Failed to download ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
  clearTimeout(timer);

  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(localPath, buffer);
  console.log(`  downloaded ${remotePath} (${buffer.length} bytes)`);
}

async function main() {
  console.log(`Downloading embedding model to ${MODEL_DIR}`);
  await mkdir(MODEL_DIR, { recursive: true });

  for (const { remote, local } of FILES) {
    await downloadFile(remote, resolve(MODEL_DIR, local));
  }

  console.log('Embedding model download complete.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
