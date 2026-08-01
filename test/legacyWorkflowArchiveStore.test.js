import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LegacyWorkflowArchiveStore } from '../src/workflow/migration/legacyWorkflowArchiveStore.js';

test('legacy archive is immutable and bound to its migration receipt', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-legacy-archive-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new LegacyWorkflowArchiveStore(root);
  const input = {
    workflowId: 'legacy-one',
    sourceFingerprint: 'sha256-source',
    receipt: { receiptId: 'receipt-one', targetRevision: 4 },
    legacyWorkflow: { id: 'legacy-one', lifecycle: 'stopped' },
    legacyConfig: { preset: 'guided-task' },
  };
  const created = await store.archive(input);
  assert.equal(created.existed, false);
  const replay = await store.archive(structuredClone(input));
  assert.equal(replay.existed, true);
  const stored = JSON.parse(await fs.readFile(created.file, 'utf8'));
  assert.equal(stored.readOnly, true);
  assert.deepEqual(stored.receipt, input.receipt);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(created.file)).mode & 0o777, 0o400);
  }
  await assert.rejects(
    store.archive({
      ...input,
      receipt: { receiptId: 'receipt-other', targetRevision: 4 },
    }),
    (error) => error?.code === 'LEGACY_ARCHIVE_CONFLICT',
  );
});
