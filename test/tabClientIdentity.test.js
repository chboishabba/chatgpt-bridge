import test from 'node:test';
import assert from 'node:assert/strict';
import { tabScopedClientId } from '../tools/chrome-bridge-extension/shared/tabClientIdentity.js';

test('tab-scoped client identity survives reload but separates cloned sessionStorage across tabs', () => {
  const clonedContentId = 'ext-cloned-session';
  assert.equal(tabScopedClientId(clonedContentId, 41), 'ext-cloned-session:tab:41');
  assert.equal(tabScopedClientId(clonedContentId, 42), 'ext-cloned-session:tab:42');
  assert.equal(tabScopedClientId('ext-cloned-session:tab:41', 41), 'ext-cloned-session:tab:41');
  assert.equal(tabScopedClientId('ext-cloned-session:tab:41', 42), 'ext-cloned-session:tab:42');
});

test('tab-scoped client identity does not invent ownership without a browser tab id', () => {
  assert.equal(tabScopedClientId('ext-content', null), 'ext-content');
  assert.equal(tabScopedClientId('', null), '');
});
