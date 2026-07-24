import test from 'node:test';
import assert from 'node:assert/strict';
import '../tools/chrome-bridge-extension/shared/commandManifest.js';
import { REAL_E2E_SCENARIOS, expandScenarioSelectors } from '../scripts/e2e-scenarios.js';
import { LOCAL_E2E_COMMAND_TYPES, LOCAL_E2E_LIVE_ONLY_BOUNDARIES } from '../scripts/e2e/mock-chatgpt/contract.js';

test('local ChatGPT protocol participant covers every shared command-manifest command', () => {
  const manifestTypes = globalThis.ChatGptBridgeCommandManifest.commandTypes().slice().sort();
  assert.deepEqual([...LOCAL_E2E_COMMAND_TYPES].sort(), manifestTypes);
});

test('local ChatGPT E2E default selects the complete registered scenario matrix', () => {
  assert.deepEqual(expandScenarioSelectors([]), REAL_E2E_SCENARIOS.map((scenario) => scenario.id));
});

test('remaining live-only boundaries are platform/product concerns, not canonical lifecycle gaps', () => {
  assert.ok(LOCAL_E2E_LIVE_ONLY_BOUNDARIES.length >= 3);
  assert.ok(LOCAL_E2E_LIVE_ONLY_BOUNDARIES.every((item) => typeof item === 'string' && item.length > 20));
});

test('mock extension hello identity is read from the bundled extension files', async () => {
  const [{ MOCK_EXTENSION_RUNTIME_IDENTITY }, { readBundledExtensionInfo }] = await Promise.all([
    import('../scripts/e2e/mock-chatgpt/extension-client.js'),
    import('../src/extensionStartup.js'),
  ]);
  const bundled = await readBundledExtensionInfo();
  assert.deepEqual(MOCK_EXTENSION_RUNTIME_IDENTITY, {
    extensionVersion: bundled.version,
    clientVersion: bundled.contentVersion,
    extensionBundleId: bundled.bundleId,
  });
});

test('mock browser download path creates regular files and cleanup removes them one at a time without deleting the directory', async (t) => {
  const [{ MockChatGptBrowser }, fs, os, path] = await Promise.all([
    import('../scripts/e2e/mock-chatgpt/extension-client.js'),
    import('node:fs/promises'),
    import('node:os'),
    import('node:path'),
  ]);
  const browser = new MockChatGptBrowser({ bridgeUrl: 'http://127.0.0.1:1' });
  browser.downloadRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-mock-browser-downloads-'));
  t.after(() => fs.rm(browser.downloadRoot, { recursive: true, force: true }));
  const first = await browser.createBrowserDownload({ name: 'one.json', fileName: 'one.json', buffer: Buffer.from('{"one":1}') });
  const second = await browser.createBrowserDownload({ name: 'two.csv', fileName: 'two.csv', buffer: Buffer.from('two,2\n') });
  assert.equal((await fs.lstat(first.filePath)).isFile(), true);
  assert.equal((await fs.lstat(second.filePath)).isFile(), true);
  const results = await browser.cleanupOwnedDownloads();
  assert.deepEqual(results.map((item) => item.removed), [true, true]);
  await assert.rejects(fs.lstat(first.filePath), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(second.filePath), { code: 'ENOENT' });
  assert.equal((await fs.lstat(browser.downloadRoot)).isDirectory(), true);
});
