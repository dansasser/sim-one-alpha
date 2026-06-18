# Local ONNX Embeddings

Bundled `all-MiniLM-L6-v2` embedding model running in-process via `onnxruntime-node`.

## Usage

```ts
import { embed, embedBatch } from './embeddings/index.js';

const vector = await embed('hello world');
console.log(vector.length); // 384

const vectors = await embedBatch(['hello', 'world']);
```

## Model files

Download with:

```bash
pnpm fetch-embedding-model
```

Files are stored in `assets/models/embeddings/all-MiniLM-L6-v2/`.

## System requirements

- Node.js >=22.18
- 64-bit OS: Windows x64/arm64, Linux x64/arm64 (glibc/musl), macOS x64/arm64
- ~300 MB disk for `onnxruntime-node` binaries + model
- ~200 MB RAM available at runtime for a single embedding
- CPU with AVX/AVX2 support preferred; pre-AVX x86 not supported by default installer

## Dependencies

- `onnxruntime-node@^1.26.0`
- `@huggingface/tokenizers@^0.1.3` (pure-JS tokenizer; no native binary required)

## Override the model path

Set the environment variable:

```
GOROMBO_EMBEDDING_MODEL_PATH=/path/to/all-MiniLM-L6-v2
```

The directory must contain `model.onnx` and `tokenizer.json`.
