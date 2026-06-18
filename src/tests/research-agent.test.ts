import assert from 'node:assert/strict';
import test from 'node:test';
import { createResearcherSubagent, researcherAgentName } from '../workers/researcher/researcher.js';

test('researcher subagent has web research tools', () => {
  const subagent = createResearcherSubagent('ollama-cloud/minimax-m3');

  assert.equal(subagent.name, researcherAgentName);
  assert.equal(subagent.model, 'ollama-cloud/minimax-m3');
  assert.match(subagent.description ?? '', /source-backed research/);
  assert.match(subagent.instructions ?? '', /Researcher Workspace Instructions/);
  assert.match(subagent.instructions ?? '', /Name: Athena/);
  assert.match(subagent.instructions ?? '', /web_research/);
  assert.match(subagent.instructions ?? '', /providerFailures/);
  assert.match(subagent.instructions ?? '', /depth: "deep"/);
  assert.match(subagent.instructions ?? '', /Runtime Capabilities/);
  assert.equal(subagent.tools?.some((tool) => tool.name === 'web_research'), true);
  assert.equal(subagent.tools?.some((tool) => tool.name === 'retrieve_context'), false);
});
