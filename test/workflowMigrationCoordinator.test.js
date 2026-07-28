import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkflowMigrationReceiptStore } from '../src/workflow/migration/migrationReceiptStore.js';
import { WorkflowMigrationCoordinator } from '../src/workflow/migration/workflowMigrationCoordinator.js';
import { WorkflowServerStore } from '../src/workflow/server/workflowServerStore.js';

function legacyWorkflow(overrides = {}) {
  const { execution: executionOverrides = {}, ...workflowOverrides } = overrides;
  return {
    id: 'workflow-1',
    projectRoot: '/tmp/project',
    preset: 'apply-changes',
    checks: ['npm test'],
    execution: {
      schemaVersion: 3,
      revision: 4,
      lifecycle: 'ready',
      run: { id: '', phase: 'none' },
      binding: { clientId: 'client-1', sessionId: 'session-1', epoch: 1 },
      localEffects: {},
      ...executionOverrides,
    },
    ...workflowOverrides,
  };
}

function legacyConfig() {
  return {
    projectRoot: '/tmp/project',
    preset: 'apply-changes',
    apply: {
      sync: true,
      protectedPaths: ['.env*'],
      commands: ['npm test'],
      timeoutMs: 60_000,
    },
    automation: { steps: [], maxCycles: 5, noProgressLimit: 3 },
    commit: {
      policy: {
        mode: 'automatic',
        iterationStrategy: 'checkpoint',
        completionStrategy: 'squash',
      },
    },
    ux: {},
  };
}

function zipflowWorkflow() {
  return {
    revision: 7,
    workflow: {
      version: 9,
      name: 'Project',
      projectPath: '/tmp/project',
      archive: { mode: 'overlay' },
      exclude: ['.git/**'],
      checks: [],
      git: { checkpoint: 'ask', resultCommit: 'ask' },
      deploy: { policy: 'disabled', commandText: '', cwd: '.' },
    },
  };
}

async function harness(t, {
  failReceiptCommit = false,
  failCutover = false,
  failArchive = false,
  workflow = legacyWorkflow(),
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-migration-coordinator-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const realReceiptStore = new WorkflowMigrationReceiptStore(root);
  const realServerStore = new WorkflowServerStore(root);
  await Promise.all([realReceiptStore.ready, realServerStore.ready]);
  const failures = {
    receipt: failReceiptCommit,
    cutover: failCutover,
    archive: failArchive,
  };
  const receiptStore = {
    begin: (...args) => realReceiptStore.begin(...args),
    getIntent: (...args) => realReceiptStore.getIntent(...args),
    getReceipt: (...args) => realReceiptStore.getReceipt(...args),
    commit: async (...args) => {
      if (failures.receipt) throw Object.assign(new Error('receipt disk failure'), { code: 'EIO_RECEIPT' });
      return await realReceiptStore.commit(...args);
    },
  };
  const serverStore = {
    get: (...args) => realServerStore.get(...args),
    update: async (...args) => {
      const receipt = await realReceiptStore.getReceiptForWorkflow(args[0]);
      assert.ok(receipt, 'cutover requires a durable migration receipt');
      const intent = await realReceiptStore.getIntent(receipt.migrationId);
      assert.ok(intent, 'cutover requires a durable migration intent');
      if (failures.cutover) throw Object.assign(new Error('cutover disk failure'), { code: 'EIO_CUTOVER' });
      return await realServerStore.update(...args);
    },
  };
  const legacy = {
    workflow: structuredClone(workflow),
    config: legacyConfig(),
  };
  const calls = { put: [], archive: 0 };
  const client = {
    async getWorkflow() { return zipflowWorkflow(); },
    async putWorkflow(projectId, draft, options) {
      calls.put.push({
        projectId,
        draft: structuredClone(draft),
        options: structuredClone(options),
      });
      return {
        revision: 8,
        receiptId: 'zipflow-receipt-1',
        workflow: structuredClone(draft),
      };
    },
  };
  let clockTick = 0;
  const coordinator = new WorkflowMigrationCoordinator({
    client,
    serverStore,
    receiptStore,
    readLegacy: async () => structuredClone(legacy),
    archiveLegacyReadOnly: async ({ receipt, readOnly }) => {
      calls.archive += 1;
      assert.equal(readOnly, true);
      assert.ok(await realReceiptStore.getReceipt(receipt.migrationId));
      assert.ok(await realServerStore.get('workflow-1'));
      if (failures.archive) throw Object.assign(new Error('archive failure'), { code: 'EIO_ARCHIVE' });
    },
    clock: () => `2026-07-28T00:00:0${clockTick++}.000Z`,
  });
  const review = await coordinator.prepare('workflow-1', { projectId: 'project-1' });
  return {
    calls,
    client,
    coordinator,
    failures,
    legacy,
    realReceiptStore,
    realServerStore,
    review,
  };
}

function explicitConfirmation(review) {
  return {
    confirmation: {
      explicit: true,
      id: review.confirmation.id,
    },
  };
}

test('migration requires exact explicit confirmation and rechecks source immediately before PUT', async (t) => {
  const state = await harness(t);
  await assert.rejects(
    state.coordinator.migrate(state.review, {
      confirmation: { explicit: false, id: state.review.confirmation.id },
    }),
    { code: 'MIGRATION_CONFIRMATION_REQUIRED' },
  );
  assert.equal(await state.realReceiptStore.getIntent(state.review.migrationId), null);
  assert.equal(state.calls.put.length, 0);

  state.legacy.workflow.execution.revision += 1;
  await assert.rejects(
    state.coordinator.migrate(state.review, explicitConfirmation(state.review)),
    { code: 'MIGRATION_SOURCE_CHANGED' },
  );
  assert.ok(await state.realReceiptStore.getIntent(state.review.migrationId));
  assert.equal(await state.realReceiptStore.getReceipt(state.review.migrationId), null);
  assert.equal(await state.realServerStore.get('workflow-1'), null);
  assert.equal(state.calls.put.length, 0);
});

test('active legacy runs cannot create a confirmed migration intent', async (t) => {
  const state = await harness(t, {
    workflow: legacyWorkflow({
      execution: {
        lifecycle: 'running',
        run: { id: 'legacy-run', phase: 'applying' },
      },
    }),
  });
  assert.equal(state.review.eligible, false);
  assert.equal(state.review.blockers[0].code, 'LEGACY_WORKFLOW_ACTIVE');
  await assert.rejects(
    state.coordinator.migrate(state.review, explicitConfirmation(state.review)),
    { code: 'MIGRATION_NOT_ELIGIBLE' },
  );
  assert.equal(await state.realReceiptStore.getIntent(state.review.migrationId), null);
  assert.equal(state.calls.put.length, 0);
});

test('fault after server PUT replays only the same idempotent request before cutover', async (t) => {
  const state = await harness(t, { failReceiptCommit: true });
  await assert.rejects(
    state.coordinator.migrate(state.review, explicitConfirmation(state.review)),
    { code: 'EIO_RECEIPT' },
  );
  assert.ok(await state.realReceiptStore.getIntent(state.review.migrationId));
  assert.equal(await state.realReceiptStore.getReceipt(state.review.migrationId), null);
  assert.equal(await state.realServerStore.get('workflow-1'), null);
  assert.equal(state.calls.archive, 0);
  assert.equal(state.calls.put.length, 1);

  state.failures.receipt = false;
  const result = await state.coordinator.resume(state.review.migrationId);
  assert.equal(result.migrated, true);
  assert.equal(state.calls.put.length, 2);
  assert.deepEqual(
    state.calls.put.map((call) => call.options.idempotencyKey),
    [state.review.idempotencyKey, state.review.idempotencyKey],
  );
  assert.deepEqual(state.calls.put[1].draft, state.calls.put[0].draft);
  assert.equal(state.calls.put[1].options.ifMatch, 7);
  assert.equal(state.calls.put[1].options.confirmation, 'explicit');
  assert.equal((await state.realServerStore.get('workflow-1')).localWorkflow.projectId, 'project-1');
  assert.equal(state.calls.archive, 1);
});

test('fault after durable receipt resumes cutover without another server PUT', async (t) => {
  const state = await harness(t, { failCutover: true });
  await assert.rejects(
    state.coordinator.migrate(state.review, explicitConfirmation(state.review)),
    { code: 'EIO_CUTOVER' },
  );
  assert.ok(await state.realReceiptStore.getReceipt(state.review.migrationId));
  assert.equal(await state.realServerStore.get('workflow-1'), null);
  assert.equal(state.calls.put.length, 1);
  assert.equal(state.calls.archive, 0);

  state.failures.cutover = false;
  const result = await state.coordinator.resume(state.review.migrationId);
  assert.equal(result.resumed, true);
  assert.equal(state.calls.put.length, 1);
  assert.equal((await state.realServerStore.get('workflow-1')).localWorkflow.backend, 'zipflow-server-v1');
  assert.equal(state.calls.archive, 1);
});

test('fault after cutover retries only read-only archive from the durable receipt', async (t) => {
  const state = await harness(t, { failArchive: true });
  await assert.rejects(
    state.coordinator.migrate(state.review, explicitConfirmation(state.review)),
    (error) => {
      assert.equal(error.code, 'LEGACY_ARCHIVE_FAILED');
      assert.equal(error.details.cutoverCommitted, true);
      return true;
    },
  );
  assert.ok(await state.realReceiptStore.getReceipt(state.review.migrationId));
  assert.ok(await state.realServerStore.get('workflow-1'));
  assert.equal(state.calls.put.length, 1);
  assert.equal(state.calls.archive, 1);

  state.failures.archive = false;
  const result = await state.coordinator.resume(state.review.migrationId);
  assert.equal(result.resumed, true);
  assert.equal(result.archived, true);
  assert.equal(state.calls.put.length, 1);
  assert.equal(state.calls.archive, 2);
});
