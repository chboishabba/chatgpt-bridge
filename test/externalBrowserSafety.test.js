import test from 'node:test';
import assert from 'node:assert/strict';
import { safeExternalBrowserUrl } from '../src/bridge/externalBrowser.js';

const maintenanceUrl = 'chrome-extension://dchijcgcljbehhihflegffnhkambmmjb/maintenance-reload.html?confirm=chatgpt-bridge-maintenance-reload-v1&expectedVersion=2.3.7';

test('external browser helper permits only the confirmed extension maintenance page', () => {
  assert.equal(safeExternalBrowserUrl(maintenanceUrl, { allowExtensionMaintenance: true }), maintenanceUrl);
  assert.throws(() => safeExternalBrowserUrl('chrome-extension://dchijcgcljbehhihflegffnhkambmmjb/background.js', { allowExtensionMaintenance: true }), /untrusted extension URL/);
  assert.throws(() => safeExternalBrowserUrl('chrome-extension://dchijcgcljbehhihflegffnhkambmmjb/maintenance-reload.html', { allowExtensionMaintenance: true }), /untrusted extension URL/);
  assert.throws(() => safeExternalBrowserUrl(maintenanceUrl), /non-ChatGPT URL/);
});

test('ordinary external browser launches remain restricted to ChatGPT origins', () => {
  assert.equal(safeExternalBrowserUrl('https://chatgpt.com/c/test'), 'https://chatgpt.com/c/test');
  assert.throws(() => safeExternalBrowserUrl('https://example.com/'), /non-ChatGPT URL/);
});
