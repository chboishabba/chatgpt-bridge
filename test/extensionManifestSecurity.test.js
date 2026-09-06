import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

test('extension manifest does not inject scripts into the ChatGPT MAIN world', async () => {
  const manifest = JSON.parse(await fs.readFile(path.resolve('tools/chrome-bridge-extension/manifest.json'), 'utf8'));
  for (const script of manifest.content_scripts || []) {
    assert.notEqual(String(script.world || 'ISOLATED').toUpperCase(), 'MAIN');
    assert.equal((script.js || []).includes('artifactCaptureMain.js'), false);
  }
});
