#!/usr/bin/env node
/**
 * Post-install patch for Ink's log-update.js.
 *
 * Clamps cursorUp() and eraseLines() calls to stream.rows (viewport height)
 * to prevent the terminal scrollback snap-to-top bug.
 *
 * Based on PR #917: https://github.com/vadimdemedes/ink/pull/917
 *
 * This patch is a safety net. The section-based TUI layout should keep
 * rendered output within the viewport, but this ensures that even if
 * it doesn't, the cursorUp never overshoots.
 *
 * Runs automatically via `postinstall` hook in package.json.
 * Skips silently if the fix is already present or Ink can't be found.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { globSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const inkPaths = globSync('node_modules/.pnpm/ink@*/node_modules/ink/build/log-update.js', { cwd: repoRoot });

if (inkPaths.length === 0) {
  process.exit(0);
}

for (const relPath of inkPaths) {
  const fullPath = resolve(repoRoot, relPath);

  if (!existsSync(fullPath)) continue;

  let content = readFileSync(fullPath, 'utf8');

  if (content.includes('__clampToViewport')) {
    continue;
  }

  const helper = `
const __getViewportRows = (stream) => (stream && stream.rows) ? stream.rows : Infinity;
const __clampToViewport = (count, stream) => Math.min(count, __getViewportRows(stream));
`;

  content = content.replace(
    "import ansiEscapes from 'ansi-escapes';",
    "import ansiEscapes from 'ansi-escapes';" + helper,
  );

  content = content.replace(
    /ansiEscapes\.eraseLines\(previousLineCount\)/g,
    "ansiEscapes.eraseLines(__clampToViewport(previousLineCount, stream))",
  );

  content = content.replace(
    /ansiEscopes\.eraseLines\(previousLines\.length\)/g,
    "ansiEscapes.eraseLines(__clampToViewport(previousLines.length, stream))",
  );

  content = content.replace(
    /ansiEscapes\.cursorUp\(visibleCount\)/g,
    "ansiEscapes.cursorUp(__clampToViewport(visibleCount, stream))",
  );

  content = content.replace(
    /ansiEscapes\.cursorUp\(previousLines\.length - 1\)/g,
    "ansiEscapes.cursorUp(__clampToViewport(previousLines.length - 1, stream))",
  );

  content = content.replace(
    /ansiEscapes\.eraseLines\(previousVisible - visibleCount \+ extraSlot\)/g,
    "ansiEscapes.eraseLines(__clampToViewport(previousVisible - visibleCount + extraSlot, stream))",
  );

  writeFileSync(fullPath, content, 'utf8');
  console.log(`[patch-ink] Applied cursorUp/eraseLines viewport clamp to ${relPath}`);
}