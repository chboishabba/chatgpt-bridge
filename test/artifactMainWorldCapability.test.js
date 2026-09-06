import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

test('isolated content runtime does not attempt disabled MAIN-world artifact capture', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/transportRuntime.js'), 'utf8');
  assert.doesNotMatch(source, /armPageArtifactCapture\s*\(/, 'MAIN-world artifact capture must stay disabled unless a safe capability transport is reintroduced');
  assert.doesNotMatch(source, /PAGE_ARTIFACT_(CONTENT|MAIN)_SOURCE/, 'page-world artifact IPC constants should not remain wired into the isolated runtime');
});
