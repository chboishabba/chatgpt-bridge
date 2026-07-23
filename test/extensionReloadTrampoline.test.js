import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extensionReloadTrampolineHtml,
  normalizeExtensionReloadDelay,
  normalizeExtensionReloadTarget,
} from '../src/http/extensionReloadTrampoline.js';

test('reload trampoline only accepts ChatGPT targets and clamps its delay', () => {
  assert.equal(normalizeExtensionReloadTarget('https://chatgpt.com/c/example'), 'https://chatgpt.com/c/example');
  assert.equal(normalizeExtensionReloadTarget('https://chat.openai.com/c/example'), 'https://chat.openai.com/c/example');
  assert.equal(normalizeExtensionReloadTarget('https://example.com/steal'), '');
  assert.equal(normalizeExtensionReloadTarget('javascript:alert(1)'), '');
  assert.equal(normalizeExtensionReloadDelay(20), 500);
  assert.equal(normalizeExtensionReloadDelay(99_000), 15_000);
});

test('reload trampoline returns the same tab to its exact ChatGPT URL', () => {
  const target = 'https://chatgpt.com/c/example#chatgpt-bridge-launch=bridge-real-e2e-example';
  const html = extensionReloadTrampolineHtml(target, 2_500);
  assert.match(html, /Updating ChatGPT Bridge/);
  assert.match(html, /location\.replace\(target\)/);
  assert.match(html, /2500/);
  assert.ok(html.includes(target.replace(/&/g, '&amp;')) || html.includes(target));
});
