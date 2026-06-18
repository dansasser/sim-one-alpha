import { Tokenizer } from 'tokenizers';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface EncodedInput {
  readonly inputIds: bigint[];
  readonly attentionMask: bigint[];
  readonly tokenTypeIds: bigint[];
}

export interface LocalTokenizer {
  encode(text: string, maxLength: number): Promise<EncodedInput>;
}

export function loadTokenizer(modelPath: string): LocalTokenizer {
  const tokenizerPath = resolve(modelPath, 'tokenizer.json');
  if (!existsSync(tokenizerPath)) {
    throw new Error(`Tokenizer file not found at ${tokenizerPath}. Run "pnpm fetch-embedding-model".`);
  }

  const tokenizer = Tokenizer.fromFile(tokenizerPath);

  return {
    async encode(text: string, maxLength: number): Promise<EncodedInput> {
      tokenizer.setTruncation(maxLength, { strategy: 'LongestFirst' as unknown as NonNullable<NonNullable<Parameters<Tokenizer['setTruncation']>[1]>['strategy']> });
      tokenizer.disablePadding();

      const encoding = await tokenizer.encode(text, null, {
        addSpecialTokens: true,
      });

      return {
        inputIds: encoding.getIds().map(BigInt),
        attentionMask: encoding.getAttentionMask().map(BigInt),
        tokenTypeIds: encoding.getTypeIds().map(BigInt),
      };
    },
  };
}
