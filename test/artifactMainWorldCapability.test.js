import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

test('isolated content runtime keeps MAIN-world artifact capture explicitly disabled', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/transportRuntime.js'), 'utf8');
  assert.doesNotMatch(source, /PAGE_ARTIFACT_(CONTENT|MAIN)_SOURCE/, 'page-world artifact IPC constants should not remain wired into the isolated runtime');
  assert.doesNotMatch(source, /window\.postMessage\([^\n]*artifact\.capture/i, 'isolated runtime must not publish artifact capture commands into page world');
  assert.doesNotMatch(source, /addEventListener\(['"]message['"][\s\S]{0,800}artifact\.capture/i, 'isolated runtime must not trust page-world artifact capture responses');
  assert.match(source, /PAGE_ARTIFACT_CAPTURE_DISABLED/, 'compatibility shim must fail closed immediately');
});
