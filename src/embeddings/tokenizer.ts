import { Tokenizer } from '@huggingface/tokenizers';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface EncodedInput {
  readonly inputIds: bigint[];
  readonly attentionMask: bigint[];
  readonly tokenTypeIds: bigint[];
}

export interface LocalTokenizer {
  encode(text: string, maxLength: number): EncodedInput;
}

export function loadTokenizer(modelPath: string): LocalTokenizer {
  const tokenizerPath = resolve(modelPath, 'tokenizer.json');
  if (!existsSync(tokenizerPath)) {
    throw new Error(`Tokenizer file not found at ${tokenizerPath}. Run "pnpm fetch-embedding-model".`);
  }

  const configPath = resolve(modelPath, 'tokenizer_config.json');
  const tokenizerJson = JSON.parse(readFileSync(tokenizerPath, 'utf8')) as unknown;
  const tokenizerConfig = existsSync(configPath)
    ? (JSON.parse(readFileSync(configPath, 'utf8')) as unknown)
    : undefined;

  const tokenizer = new Tokenizer(tokenizerJson as Record<string, unknown>, tokenizerConfig as Record<string, unknown> | undefined);

  return {
    encode(text: string, maxLength: number): EncodedInput {
      const encoding = tokenizer.encode(text, {
        add_special_tokens: true,
        return_token_type_ids: true,
      });

      let inputIds = encoding.ids.map(BigInt);
      let attentionMask = encoding.attention_mask.map(BigInt);
      let tokenTypeIds = (encoding.token_type_ids ?? new Array(encoding.ids.length).fill(0)).map(BigInt);

      if (inputIds.length > maxLength) {
        // Manual longest-first-style truncation: keep [CLS], take the first
        // maxLength - 2 content tokens, keep [SEP].
        const clsId = inputIds[0];
        const sepId = inputIds[inputIds.length - 1];
        const content = inputIds.slice(1, maxLength - 1);
        inputIds = [clsId, ...content, sepId];
        attentionMask = attentionMask.slice(0, inputIds.length);
        tokenTypeIds = tokenTypeIds.slice(0, inputIds.length);
      }

      return {
        inputIds,
        attentionMask,
        tokenTypeIds,
      };
    },
  };
}
