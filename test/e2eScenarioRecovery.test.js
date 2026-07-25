import test from 'node:test';
import assert from 'node:assert/strict';
import { findOwnedBrowserClient, recoverBrowserAfterScenarioFailure, turnFailureDetail } from '../scripts/e2e/scenario-recovery.js';

test('turn failure detail includes stored turn error', () => {
  assert.equal(turnFailureDetail({ turn: { status: 'failed', error: { code: 'BROWSER_BUSY', message: 'Another prompt is active' } } }, 'Project turn'), 'Project turn: failed (BROWSER_BUSY: Another prompt is active)');
});

test('failed scenario settles canonical work and lease before continuing to the next scenario', async () => {
  let stopped = false;
  const calls = [];
  const api = async (_options, pathname, request = {}) => {
    calls.push({ pathname, request });
    if (pathname === '/browser/stop') { stopped = true; return { cancelled: 1 }; }
    if (pathname === '/turns?status=running&limit=100') return { turns: [{ id: 'turn-stale' }] };
    if (pathname === '/turns/turn-stale/interrupt') return { turn: { status: 'interrupted' } };
    if (pathname === '/health') return { activeRequests: stopped ? [] : [{ requestId: 'stale' }] };
    if (pathname === '/browser/clients') {
      return {
        clients: [{
          id: 'ext-1',
          ready: true,
          pageReady: true,
          composerReady: true,
          chatMainReady: true,
          activeRequest: stopped ? null : { requestId: 'stale' },
          releasePending: false,
          releaseState: 'idle',
          tabObservation: { generation: stopped ? 'idle' : 'active' },
        }],
      };
    }
    throw new Error(`Unexpected path: ${pathname}`);
  };
  const waitUntil = async (check) => {
    for (let index = 0; index < 4; index += 1) {
      const value = await check();
      if (value) return value;
    }
    throw new Error('not ready');
  };
  const result = await recoverBrowserAfterScenarioFailure({
    options: { tabReadyTimeoutMs: 10_000, quiescenceSettleMs: 0 },
    sourceClientId: 'ext-1',
    scenarioId: 'passive-workflow',
    api,
    waitUntil,
    testLog: () => {},
  });
  assert.equal(result.recovered, true);
  assert.equal(result.reason, 'canonical-work-stopped');
  assert.equal(calls.filter((call) => call.pathname === '/browser/stop').length, 1);
  assert.equal(calls.filter((call) => call.pathname === '/turns/turn-stale/interrupt').length, 1);
  assert.equal(calls.some((call) => call.pathname === '/browser/tabs/reload'), false);
});


test('failed scenario reloads only after canonical work and lease settled when the browser projection remains busy', async () => {
  let stopped = false;
  let reloaded = false;
  let releasePendingReads = 1;
  const calls = [];
  const api = async (_options, pathname, request = {}) => {
    calls.push({ pathname, request });
    if (pathname === '/browser/stop') { stopped = true; return { cancelled: 1 }; }
    if (pathname === '/turns?status=running&limit=100') return { turns: [] };
    if (pathname === '/health') return { activeRequests: stopped ? [] : [{ requestId: 'stale' }] };
    if (pathname === '/browser/tabs/reload') { reloaded = true; return { ok: true, reloading: true }; }
    if (pathname === '/browser/clients') {
      const releasePending = stopped && releasePendingReads-- > 0;
      const busy = !reloaded;
      return {
        clients: [{
          id: 'ext-object-state',
          ready: true,
          pageReady: true,
          composerReady: true,
          chatMainReady: true,
          activeRequest: stopped ? null : { requestId: 'stale' },
          releasePending,
          releaseState: releasePending ? 'pending' : 'idle',
          tabObservation: {
            generation: { state: busy ? 'active' : 'stopped' },
            output: { state: busy ? 'streaming' : 'final' },
          },
        }],
      };
    }
    throw new Error(`Unexpected path: ${pathname}`);
  };
  const waitUntil = async (check) => {
    for (let index = 0; index < 6; index += 1) {
      const value = await check();
      if (value) return value;
    }
    throw new Error('not ready');
  };
  const result = await recoverBrowserAfterScenarioFailure({
    options: { tabReadyTimeoutMs: 10_000, quiescenceSettleMs: 0 },
    sourceClientId: 'ext-object-state',
    scenarioId: 'passive-workflow',
    api,
    waitUntil,
    testLog: () => {},
  });
  assert.equal(result.recovered, true);
  assert.equal(result.reason, 'canonical-work-stopped-and-tab-reloaded');
  const stopIndex = calls.findIndex((call) => call.pathname === '/browser/stop');
  const reloadIndex = calls.findIndex((call) => call.pathname === '/browser/tabs/reload');
  const settledClientReadIndex = calls.findLastIndex((call, index) => call.pathname === '/browser/clients' && index < reloadIndex);
  assert.ok(stopIndex >= 0 && reloadIndex > stopIndex, 'reload must happen only after canonical stop');
  assert.ok(settledClientReadIndex > stopIndex, 'lease projection must be checked before reload');
});


test('quiescence waits for the physical release barrier and rejects a quarantined terminal lease', async () => {
  let stopped = false;
  let clientReads = 0;
  const api = async (_options, pathname) => {
    if (pathname === '/browser/stop') { stopped = true; return { cancelled: 1 }; }
    if (pathname === '/turns?status=running&limit=100') return { turns: [] };
    if (pathname === '/health') return { activeRequests: stopped ? [] : [{ requestId: 'steer-stale' }] };
    if (pathname === '/browser/clients') {
      clientReads += 1;
      if (clientReads === 1) {
        return { clients: [{
          id: 'ext-quarantine', ready: true, pageReady: true, composerReady: true, chatMainReady: true,
          activeRequest: { requestId: 'steer-stale' }, releasePending: false, releaseState: 'idle',
          tabObservation: { generation: 'active', output: 'streaming' },
        }] };
      }
      if (clientReads < 4) {
        return { clients: [{
          id: 'ext-quarantine', ready: true, pageReady: true, composerReady: true, chatMainReady: true,
          activeRequest: null, releasePending: true, releaseState: 'pending',
          tabObservation: { generation: 'stopped', output: 'final' },
        }] };
      }
      return { clients: [{
        id: 'ext-quarantine', ready: true, pageReady: true, composerReady: true, chatMainReady: true,
        activeRequest: null, releasePending: false, releaseState: 'quarantined', quarantined: true,
        quarantineReason: 'RELEASE_CLEANUP_TIMEOUT', tabObservation: { generation: 'stopped', output: 'final' },
      }] };
    }
    throw new Error(`Unexpected path: ${pathname}`);
  };
  const waitUntil = async (check) => {
    for (let index = 0; index < 8; index += 1) {
      const value = await check();
      if (value) return value;
    }
    throw new Error('not ready');
  };
  const result = await recoverBrowserAfterScenarioFailure({
    options: { tabReadyTimeoutMs: 10_000, quiescenceSettleMs: 0 },
    sourceClientId: 'ext-quarantine',
    scenarioId: 'reasoning-steer',
    api,
    waitUntil,
    testLog: () => {},
  });
  assert.equal(result.recovered, false);
  assert.equal(result.reason, 'lease-quarantined');
  assert.equal(result.quiescence.quarantined, true);
  assert.ok(clientReads >= 4, 'recovery must not return while releasePending is still true');
});

test('failed scenario adopts a reconnected content client by stable browser tab identity', async () => {
  let reads = 0;
  const api = async (_options, pathname) => {
    assert.equal(pathname, '/browser/clients');
    reads += 1;
    return {
      clients: reads === 1 ? [] : [{
        id: 'ext-reconnected',
        browserTabId: 42,
        launchToken: 'bridge-real-e2e-run',
        ready: true,
        pageReady: true,
        composerReady: true,
        chatMainReady: true,
        activeRequest: null,
        tabObservation: { generation: { state: 'stopped' }, output: { state: 'final' } },
      }],
    };
  };
  const waitUntil = async (check) => {
    for (let index = 0; index < 3; index += 1) {
      const value = await check();
      if (value) return value;
    }
    throw new Error('not ready');
  };
  const result = await recoverBrowserAfterScenarioFailure({
    options: { tabReadyTimeoutMs: 10_000, quiescenceSettleMs: 0 },
    sourceClientId: 'ext-before-reload',
    clientIdentity: {
      clientId: 'ext-before-reload',
      browserTabId: 42,
      launchToken: 'bridge-real-e2e-run',
    },
    scenarioId: 'reload-mid-request',
    api,
    waitUntil,
    testLog: () => {},
  });
  assert.equal(result.recovered, true);
  assert.equal(result.reason, 'client-reconnected');
  assert.equal(result.client.id, 'ext-reconnected');
});


test('stable browser ownership does not adopt a reused tab with a different launch token', () => {
  const client = findOwnedBrowserClient([{
    id: 'ext-unrelated',
    browserTabId: 42,
    launchToken: 'another-e2e-run',
  }], {
    clientId: 'ext-before-reload',
    browserTabId: 42,
    launchToken: 'bridge-real-e2e-run',
  });
  assert.equal(client, null);
});
