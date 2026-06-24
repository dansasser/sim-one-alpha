import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, resolve } from 'node:path';
import { load } from 'js-yaml';
import * as v from 'valibot';
import {
  RunpodImageCatalogSchema,
  type RunpodImageCatalog,
  type RunpodImageModel,
} from '../../schemas/runpod-image.js';

export interface CatalogLoaderOptions {
  modelsPath?: string;
}

const catalogCache = new Map<string, RunpodImageCatalog>();

export function loadRunpodImageCatalog(options: CatalogLoaderOptions = {}): RunpodImageCatalog {
  const path = resolveCatalogPath(options.modelsPath);
  const cached = catalogCache.get(path);
  if (cached) {
    return cached;
  }

  const raw = readFileSync(path, 'utf8');
  const parsed = load(raw) as unknown;

  const result = v.safeParse(RunpodImageCatalogSchema, parsed);
  if (!result.success) {
    throw new Error(`Invalid Runpod image model catalog at ${path}: ${JSON.stringify(v.flatten(result.issues))}`);
  }

  catalogCache.set(path, result.output);
  return result.output;
}

export function getRunpodImageModel(
  catalog: RunpodImageCatalog,
  modelId: string,
): RunpodImageModel | undefined {
  return catalog.models.find((m) => m.enabled !== false && m.id === modelId);
}

export function getDefaultRunpodImageModel(catalog: RunpodImageCatalog): RunpodImageModel {
  const model = getRunpodImageModel(catalog, catalog.defaultModel);
  if (!model) {
    throw new Error(`Default Runpod image model "${catalog.defaultModel}" is not enabled or not found.`);
  }
  return model;
}

function resolveCatalogPath(override?: string): string {
  if (override) {
    return isAbsolute(override) ? override : resolve(process.cwd(), override);
  }

  const envPath = process.env.RUNPOD_IMAGE_MODELS_PATH;
  if (envPath) {
    return isAbsolute(envPath) ? envPath : resolve(process.cwd(), envPath);
  }

  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = dirname(thisFile);

  const sourceCandidate = resolve(thisDir, 'models.yaml');
  if (existsSync(sourceCandidate)) {
    return sourceCandidate;
  }

  const bundleCandidate = resolve(process.cwd(), '.gorombo/sim-one-alpha/tools/runpod-image/models.yaml');
  if (existsSync(bundleCandidate)) {
    return bundleCandidate;
  }

  const distCandidate = resolve(process.cwd(), 'dist/tools/runpod-image/models.yaml');
  if (existsSync(distCandidate)) {
    return distCandidate;
  }

  const tscCandidate = resolve(process.cwd(), '.tmp/tsc/tools/runpod-image/models.yaml');
  if (existsSync(tscCandidate)) {
    return tscCandidate;
  }

  throw new Error(
    'Could not find runpod-image models.yaml. Set RUNPOD_IMAGE_MODELS_PATH or ensure the file is copied next to the source/bundle.',
  );
}
