import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMaintenanceReloadUrl,
  runMaintenanceReload,
} from '../tools/chrome-bridge-extension/maintenanceReload.js';

function memoryArea(initial = {}) {
  const values = structuredClone(initial);
  return {
    values,
    async get(keys) {
      if (keys == null) return structuredClone(values);
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((key) => key in values).map((key) => [key, structuredClone(values[key])]));
    },
    async set(record) { Object.assign(values, structuredClone(record)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key]; },
  };
}

function maintenanceHref(extra = {}) {
  const url = new URL('chrome-extension://dchijcgcljbehhihflegffnhkambmmjb/maintenance-reload.html');
  url.searchParams.set('confirm', 'chatgpt-bridge-maintenance-reload-v1');
  url.searchParams.set('expectedVersion', '2.3.5');
  url.searchParams.set('reloadTabs', '1');
  url.searchParams.set('serverUrl', 'http://127.0.0.1:18181');
  url.searchParams.set('commandId', 'maintenance-bootstrap-fixture');
  url.searchParams.set('sourceTabId', '42');
  url.searchParams.set('sourceLaunchToken', 'bridge-real-e2e-fixture-token');
  url.searchParams.set('requestedUrl', 'https://chatgpt.com/c/fixture');
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, String(value));
  return url.toString();
}

test('maintenance reload page persists handoff and reloads without the old command-result path', async () => {
  const session = memoryArea({
    'chatgptBridgeLaunchedTab:42': {
      launchToken: 'bridge-real-e2e-fixture-token',
      requestedUrl: 'https://chatgpt.com/c/fixture',
      createdAt: 123,
      serverUrl: 'http://127.0.0.1:18181',
    },
  });
  const local = memoryArea();
  let reloads = 0;
  const chromeApi = {
    storage: { session, local },
    tabs: { async query() { return [{ id: 42, url: 'https://chatgpt.com/c/fixture' }]; } },
    runtime: { reload() { reloads += 1; } },
  };
  const pending = await runMaintenanceReload({ chromeApi, href: maintenanceHref(), delayMs: 0 });
  assert.equal(reloads, 1);
  assert.equal(pending.bootstrapPage, true);
  assert.equal(pending.expectedVersion, '2.3.5');
  assert.deepEqual(pending.tabIds, [42]);
  assert.equal(pending.launchRecords['42'].launchToken, 'bridge-real-e2e-fixture-token');
  assert.deepEqual(local.values.bridgePendingExtensionReload, pending);
});

test('maintenance reload page refuses to reload while any persisted tab lease is active', async () => {
  const session = memoryArea({
    'chatgptBridgeV6:tab:77': { lease: { requestId: 'request-active', leaseId: 'lease-active' } },
  });
  const local = memoryArea();
  let reloads = 0;
  const chromeApi = {
    storage: { session, local },
    tabs: { async query() { return []; } },
    runtime: { reload() { reloads += 1; } },
  };
  await assert.rejects(
    runMaintenanceReload({ chromeApi, href: maintenanceHref({ sourceTabId: '' }), delayMs: 0 }),
    /blocked while browser leases are active/,
  );
  assert.equal(reloads, 0);
  assert.equal(local.values.bridgePendingExtensionReload, undefined);
});



test('maintenance reload page does not reload twice when Chrome restores the page after runtime restart', async () => {
  const session = memoryArea();
  const local = memoryArea({
    bridgeMaintenanceReloadPageGuard: { commandId: 'maintenance-bootstrap-fixture', requestedAt: Date.now() },
  });
  let reloads = 0;
  let removedTab = null;
  const chromeApi = {
    storage: { session, local },
    tabs: {
      async query() { return []; },
      async getCurrent() { return { id: 99 }; },
      async remove(tabId) { removedTab = tabId; },
    },
    runtime: { reload() { reloads += 1; } },
  };
  const result = await runMaintenanceReload({ chromeApi, href: maintenanceHref(), delayMs: 0 });
  assert.equal(result.alreadyReloaded, true);
  assert.equal(reloads, 0);
  assert.equal(removedTab, 99);
});
test('maintenance reload URL parser does not invent tab zero when sourceTabId is absent', () => {
  const parsed = parseMaintenanceReloadUrl(maintenanceHref({ sourceTabId: '' }));
  assert.equal(parsed.sourceTabId, null);
});
