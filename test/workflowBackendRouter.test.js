import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  LEGACY_WORKFLOW_BACKEND,
  WorkflowBackendRouter,
} from '../src/workflow/workflowBackendRouter.js';
import { WORKFLOW_SERVER_BACKEND } from '../src/workflow/server/workflowServerState.js';

function legacy(lifecycle = 'ready') {
  return {
    id: 'workflow-1',
    execution: {
      schemaVersion: 3,
      lifecycle,
      run: lifecycle === 'ready'
        ? { id: '', phase: 'none' }
        : { id: 'legacy-run', phase: 'applying' },
    },
  };
}

function routerFixture({
  serverState = null,
  legacyWorkflow = null,
  serverHandler = async (workflowId) => `server:${workflowId}`,
  legacyHandler = async (workflowId) => `legacy:${workflowId}`,
} = {}) {
  const calls = { server: 0, legacy: 0 };
  const serverBackend = {
    async mutate(workflowId) {
      calls.server += 1;
      return await serverHandler(workflowId);
    },
  };
  const legacyBackend = {
    async mutate(workflowId) {
      calls.legacy += 1;
      return await legacyHandler(workflowId);
    },
  };
  const router = new WorkflowBackendRouter({
    serverBackend,
    legacyBackend,
    serverStore: { async get() { return structuredClone(serverState); } },
    readLegacy: async () => structuredClone(legacyWorkflow),
  });
  return { router, calls };
}

test('persisted server v4 ownership wins even when stale legacy state looks active', async () => {
  const { router, calls } = routerFixture({
    serverState: {
      schemaVersion: 4,
      localWorkflow: { backend: WORKFLOW_SERVER_BACKEND, projectId: 'project-1' },
    },
    legacyWorkflow: legacy('running'),
  });
  assert.deepEqual(
    await router.resolve('workflow-1'),
    {
      workflowId: 'workflow-1',
      backend: WORKFLOW_SERVER_BACKEND,
      reason: 'persisted_server_v4',
      serverState: {
        schemaVersion: 4,
        localWorkflow: { backend: WORKFLOW_SERVER_BACKEND, projectId: 'project-1' },
      },
      legacyWorkflow: null,
    },
  );
  assert.equal(await router.dispatch('workflow-1', 'mutate'), 'server:workflow-1');
  assert.deepEqual(calls, { server: 1, legacy: 0 });
});

test('active and inactive existing v3 workflows stay legacy until explicit migration', async () => {
  for (const [lifecycle, reason] of [
    ['running', 'active_legacy_run_settles'],
    ['ready', 'legacy_migration_required'],
  ]) {
    const { router, calls } = routerFixture({ legacyWorkflow: legacy(lifecycle) });
    const route = await router.resolve('workflow-1');
    assert.equal(route.backend, LEGACY_WORKFLOW_BACKEND);
    assert.equal(route.reason, reason);
    assert.equal(await router.dispatch('workflow-1', 'mutate'), 'legacy:workflow-1');
    assert.deepEqual(calls, { server: 0, legacy: 1 });
  }
});

test('only explicitly new workflows use the server default and server failure never falls back', async () => {
  const expected = Object.assign(new Error('server unavailable'), { code: 'SERVER_DOWN' });
  const { router, calls } = routerFixture({
    serverHandler: async () => { throw expected; },
  });
  const route = await router.resolve('workflow-new', { create: true });
  assert.equal(route.backend, WORKFLOW_SERVER_BACKEND);
  assert.equal(route.reason, 'new_workflow_server_default');
  await assert.rejects(
    router.dispatch('workflow-new', 'mutate', [], { create: true }),
    { code: 'SERVER_DOWN' },
  );
  assert.deepEqual(calls, { server: 1, legacy: 0 });
  await assert.rejects(
    router.resolve('workflow-missing'),
    { code: 'WORKFLOW_BACKEND_NOT_FOUND' },
  );
});

test('server routes cannot structurally import legacy mutation executors', async () => {
  const source = await fs.readFile(
    new URL('../src/workflow/workflowBackendRouter.js', import.meta.url),
    'utf8',
  );
  const imports = source.split('\n').filter((line) => line.startsWith('import ')).join('\n');
  assert.doesNotMatch(imports, /transaction|appl(?:y|ier)|gitCommit|checks\/runner|deploy/i);
});
