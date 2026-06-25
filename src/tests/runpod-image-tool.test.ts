import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadRunpodImageCatalog, getRunpodImageModel, getDefaultRunpodImageModel } from '../engine/tools/runpod-image/catalog.js';
import { normalizeWebApiMessage } from '../api/connectors/web-api.js';
import { persistImageArtifact } from '../engine/tools/runpod-image/artifact-store.js';
import { recordImageArtifactTool } from '../engine/tools/runpod-image/record-image-artifact-tool.js';
import { goromboPersistenceRuntime } from '../core/db.js';

test('catalog loads and validates', () => {
  const catalog = loadRunpodImageCatalog();
  assert.equal(catalog.version, 1);
  assert.equal(catalog.defaultModel, 'black-forest-labs-flux-1-dev');
  assert.ok(catalog.models.length >= 2);
});

test('catalog model lookup returns the right model', () => {
  const catalog = loadRunpodImageCatalog();
  const model = getRunpodImageModel(catalog, 'black-forest-labs-flux-1-schnell');
  assert.ok(model);
  assert.equal(model?.id, 'black-forest-labs-flux-1-schnell');
  assert.equal(model?.kind, 'text-to-image');
});

test('catalog default model is enabled', () => {
  const catalog = loadRunpodImageCatalog();
  const model = getDefaultRunpodImageModel(catalog);
  assert.equal(model.id, 'black-forest-labs-flux-1-dev');
  assert.notEqual(model.enabled, false);
});

test('persistImageArtifact writes row and indexes memory', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'runpod-image-test-'));
  const filePath = join(tmpDir, 'test.png');
  writeFileSync(filePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  const event = normalizeWebApiMessage({ text: 'make an image', actorId: 'a', conversationId: 'c' });

  try {
    const record = persistImageArtifact({
      event,
      generationResult: {
        ok: true,
        artifactId: randomUUID(),
        filePath,
        fileName: 'test.png',
        mimeType: 'image/png',
        modelId: 'black-forest-labs-flux-1-dev',
        generatedAt: new Date().toISOString(),
      },
      prompt: 'a test image',
      modelId: 'black-forest-labs-flux-1-dev',
      modelName: 'FLUX.1 [dev]',
      providerOptions: {},
    });

    const rows = goromboPersistenceRuntime.sessionDatabase.listImageArtifacts({ eventId: event.id });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].prompt, 'a test image');
    assert.equal(record.fileSizeBytes, 8);

    const memoryRows = goromboPersistenceRuntime.sessionDatabase.searchSessionMemory({
      text: 'Generated image: FLUX.1 [dev]',
      sessionId: event.id,
      limit: 5,
    });
    assert.ok(memoryRows.length >= 1);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});


test('record_image_artifact tool rejects a nonexistent eventId', async () => {
  await assert.rejects(
    async () => {
      await recordImageArtifactTool.execute({
        eventId: 'nonexistent-event-id',
        artifactId: randomUUID(),
        filePath: '/tmp/test.png',
        fileName: 'test.png',
        mimeType: 'image/png',
        prompt: 'a test image',
        modelId: 'black-forest-labs-flux-1-dev',
      });
    },
    (error: Error) => {
      assert.match(error.message, /nonexistent-event-id/);
      assert.match(error.message, /trusted eventId persisted by chat ingress/);
      return true;
    },
  );
});
