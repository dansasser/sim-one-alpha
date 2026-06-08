import assert from 'node:assert/strict';
import test from 'node:test';
import { createResearcherProfile, researcherAgentName } from '../agents/researcher.js';

test('researcher profile is a Flue subagent with retrieval tools', () => {
  const profile = createResearcherProfile('ollama-cloud/minimax-m3');

  assert.equal(profile.name, researcherAgentName);
  assert.equal(profile.model, 'ollama-cloud/minimax-m3');
  assert.match(profile.description ?? '', /source-backed research/);
  assert.match(profile.instructions ?? '', /retrieve_context/);
  assert.match(profile.instructions ?? '', /providerFailures/);
  assert.equal(profile.tools?.some((tool) => tool.name === 'retrieve_context'), true);
});
