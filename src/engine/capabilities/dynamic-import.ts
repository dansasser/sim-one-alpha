import { pathToFileURL } from 'node:url';

export async function dynamicImport(modulePath: string): Promise<Record<string, unknown> | undefined> {
  const fileUrl = pathToFileURL(modulePath).href;
  const mod = await import(fileUrl);
  return mod as Record<string, unknown> | undefined;
}