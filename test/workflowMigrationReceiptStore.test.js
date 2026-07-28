import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  WorkflowMigrationReceiptStore,
} from '../src/workflow/migration/migrationReceiptStore.js';

async function tempRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-migration-receipts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function intent(overrides = {}) {
  return {
    migrationId: 'migration-1',
    workflowId: 'workflow-1',
    createdAt: '2026-07-28T00:00:00.000Z',
    source: { schemaVersion: 3, revision: 4, fingerprint: 'source-sha' },
    target: {
      backend: 'zipflow-server-v1',
      projectId: 'project-1',
      expectedRevision: 7,
      draftFingerprint: 'draft-sha',
      workflow: { version: 9, projectPath: '/tmp/project', checks: [] },
    },
    confirmation: {
      explicit: true,
      id: 'confirmation-1',
      confirmedAt: '2026-07-28T00:00:00.000Z',
    },
    idempotencyKey: 'bridge-migration:migration-1',
    ...overrides,
  };
}

function receipt(overrides = {}) {
  return {
    receiptId: 'bridge-migration:migration-1',
    migrationId: 'migration-1',
    workflowId: 'workflow-1',
    completedAt: '2026-07-28T00:00:01.000Z',
    source: { schemaVersion: 3, revision: 4, fingerprint: 'source-sha' },
    target: {
      backend: 'zipflow-server-v1',
      projectId: 'project-1',
      workflowRevision: 8,
      serverReceiptId: 'server-receipt-1',
      idempotencyKey: 'bridge-migration:migration-1',
    },
    confirmation: { explicit: true, id: 'confirmation-1' },
    ...overrides,
  };
}

test('migration intent and receipt are immutable, durable, and separate from legacy state', async (t) => {
  const root = await tempRoot(t);
  const workflowDir = path.join(root, 'workflows');
  const legacyFile = path.join(workflowDir, 'state.json');
  const legacyBytes = '{"schemaVersion":4,"workflows":{"workflow-1":{"legacy":true}}}\n';
  await fs.mkdir(workflowDir, { recursive: true });
  await fs.writeFile(legacyFile, legacyBytes, 'utf8');

  const store = new WorkflowMigrationReceiptStore(root);
  await store.begin(intent());
  assert.deepEqual((await store.listPending()).map((item) => item.migrationId), ['migration-1']);
  await assert.rejects(
    store.begin(intent({ idempotencyKey: 'different' })),
    { code: 'MIGRATION_INTENT_CONFLICT' },
  );
  await store.commit(receipt());
  assert.deepEqual(await store.listPending(), []);
  await assert.rejects(
    store.commit(receipt({
      target: { ...receipt().target, workflowRevision: 9 },
    })),
    { code: 'MIGRATION_RECEIPT_CONFLICT' },
  );
  await store.close();

  assert.equal(await fs.readFile(legacyFile, 'utf8'), legacyBytes);
  const persisted = JSON.parse(await fs.readFile(
    path.join(workflowDir, 'migration-receipts-v1.json'),
    'utf8',
  ));
  assert.equal(persisted.receipts['migration-1'].target.workflowRevision, 8);

  const restored = new WorkflowMigrationReceiptStore(root);
  assert.equal((await restored.getIntent('migration-1')).confirmation.explicit, true);
  assert.equal((await restored.getReceipt('migration-1')).target.serverReceiptId, 'server-receipt-1');
  assert.equal((await restored.getReceiptForWorkflow('workflow-1')).migrationId, 'migration-1');
});

test('a receipt cannot exist before its matching durable intent', async (t) => {
  const root = await tempRoot(t);
  const store = new WorkflowMigrationReceiptStore(root);
  await assert.rejects(
    store.commit(receipt()),
    { code: 'MIGRATION_INTENT_NOT_FOUND' },
  );
  await store.begin(intent());
  await assert.rejects(
    store.commit(receipt({
      source: { ...receipt().source, fingerprint: 'different' },
    })),
    { code: 'MIGRATION_RECEIPT_MISMATCH' },
  );
  assert.equal(await store.getReceipt('migration-1'), null);
});
