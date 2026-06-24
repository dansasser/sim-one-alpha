import { defineAgentProfile } from '@flue/runtime';

export default defineAgentProfile({
  name: 'test-worker',
  description: 'A test worker for automated testing.',
  instructions: 'Base instructions from the module.',
});