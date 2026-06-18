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
- 64-bit OS: Windows x64, Linux x64 (glibc), macOS x64
- ~300 MB disk for `onnxruntime-node` binaries + model
- ~200 MB RAM available at runtime for a single embedding
- CPU with AVX/AVX2 support preferred; pre-AVX x86 not supported by default installer

### Platform notes

`onnxruntime-node` supports a wider set of platforms, but the Node.js `tokenizers` binding used by this path currently only publishes native binaries for the three platforms listed above (via `tokenizers-*` optional dependencies at `0.13.4-rc1`). Linux arm64/musl and macOS arm64 are not covered by the current published tokenizer native packages, so the bundled local embedding path will fail to load on those systems unless a tokenizer binary is provided another way.

## Dependencies

- `onnxruntime-node@^1.26.0`
- `tokenizers@^0.13.3` (latest stable Node binding from Hugging Face)

## Override the model path

Set the environment variable:

```
GOROMBO_EMBEDDING_MODEL_PATH=/path/to/all-MiniLM-L6-v2
```

The directory must contain `model.onnx` and `tokenizer.json`.
