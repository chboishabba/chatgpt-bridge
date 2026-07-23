import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

function makeWindow() {
  const listeners = new Map();
  const posted = [];
  return {
    posted,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      listeners.set(type, list.filter((item) => item !== fn));
    },
    postMessage(data) {
      posted.push(data);
      for (const fn of [...(listeners.get('message') || [])]) fn({ source: this, data });
      if (data?.type === 'page.reload.arm') {
        const ack = {
          source: 'chatgpt-browser-bridge-artifact-main-v1',
          type: 'page.reload.armed',
          reloadId: data.reloadId,
          delayMs: data.delayMs,
        };
        for (const fn of [...(listeners.get('message') || [])]) fn({ source: this, data: ack });
      }
    },
  };
}

test('content runtime arms a page-owned reload before restarting the extension', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/sessionCommands.js'), 'utf8');
  const window = makeWindow();
  const timers = [];
  const sent = [];
  const extensionRequests = [];
  const context = vm.createContext({
    globalThis: null,
    window,
    location: new URL('https://chatgpt.com/'),
    document: { title: 'ChatGPT', querySelectorAll() { return []; } },
    URL,
    Date,
    Math,
    setTimeout(fn, delay) { const timer = { fn, delay }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
  });
  context.globalThis = context;
  vm.runInContext(source, context, { filename: 'sessionCommands.js' });
  const commands = context.ChatGptSessionCommands.createSessionCommands({
    CONFIG: { serverUrl: 'http://127.0.0.1:18181', token: '' },
    CONTENT_SCRIPT_VERSION: '4.0.0',
    EXTENSION_VERSION: '2.0.0',
    safeLaunchBridgeServerUrl(value) { return value; },
    stageTemporaryConnectionOverride() { return { staged: true, reason: 'differs_from_saved', serverUrl: 'http://127.0.0.1:18181' }; },
    send(payload) { sent.push(payload); },
    diagnostic() {},
    async extensionRequest(type, payload) {
      assert.equal(window.posted.some((message) => message.type === 'page.reload.arm'), true, 'Page-owned reload must be armed before the service worker receives its reload request');
      extensionRequests.push({ type, payload });
      return { scheduled: true };
    },
  });

  await commands.handleExtensionReload({
    commandId: 'reload-command', reloadTabs: true,
    expectedVersion: '2.0.0', connection: { serverUrl: 'http://127.0.0.1:18181' },
  });

  const accepted = sent.find((payload) => payload.type === 'extension.reload.accepted');
  assert.ok(accepted);
  assert.equal(accepted.pageReload.armed, true);
  assert.equal(accepted.pageReload.delayMs, 12_000);
  assert.equal(extensionRequests.length, 1);
  assert.equal(extensionRequests[0].type, 'bridge.extension.reload');
  assert.equal(extensionRequests[0].payload.commandId, 'reload-command');
  assert.equal(extensionRequests[0].payload.reloadTabs, true);
  assert.equal(extensionRequests[0].payload.expectedVersion, '2.0.0');
});


test('content runtime cancels the page-owned reload when background scheduling fails', async () => {
  const source = await fs.readFile(path.resolve('tools/chrome-bridge-extension/content/sessionCommands.js'), 'utf8');
  const window = makeWindow();
  const context = vm.createContext({
    globalThis: null,
    window,
    location: new URL('https://chatgpt.com/'),
    document: { title: 'ChatGPT', querySelectorAll() { return []; } },
    URL,
    Date,
    Math,
    setTimeout(fn, delay) { return { fn, delay }; },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
  });
  context.globalThis = context;
  vm.runInContext(source, context, { filename: 'sessionCommands.js' });
  const commands = context.ChatGptSessionCommands.createSessionCommands({
    CONFIG: { serverUrl: 'http://127.0.0.1:18181', token: '' },
    CONTENT_SCRIPT_VERSION: '4.0.0',
    EXTENSION_VERSION: '2.0.0',
    safeLaunchBridgeServerUrl(value) { return value; },
    stageTemporaryConnectionOverride() { return { staged: true }; },
    send() {},
    diagnostic() {},
    async extensionRequest() { throw new Error('reload scheduling failed'); },
  });

  await assert.rejects(() => commands.handleExtensionReload({
    commandId: 'reload-command-failed', reloadTabs: true, expectedVersion: '2.0.0',
  }), /reload scheduling failed/);

  const armed = window.posted.find((message) => message.type === 'page.reload.arm');
  const cancelled = window.posted.find((message) => message.type === 'page.reload.cancel');
  assert.ok(armed);
  assert.ok(cancelled);
  assert.equal(cancelled.reloadId, armed.reloadId);
});
