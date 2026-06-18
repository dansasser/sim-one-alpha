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
  const url = `https://huggingface.co/${HF_REPO}/resolve/main/${remotePath}`;
  const response = await fetch(url);
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
