import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

export const echoTool = defineTool({
  name: 'test_echo',
  description: 'Echoes back the provided text. A test tool for automated testing.',
  parameters: v.object({
    text: v.pipe(v.string(), v.description('Text to echo back')),
  }),
  execute: async ({ text }) => {
    return `Echo: ${text}`;
  },
});

export default echoTool;