import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanupExactE2eDownloadFiles, verifyExactE2eDownloadFilesAbsent } from '../scripts/e2e/download-source-cleanup.js';

function identity(stat) {
  return {
    dev: Number(stat.dev) || 0,
    ino: Number(stat.ino) || 0,
    size: Number(stat.size) || 0,
    birthtimeMs: Number(stat.birthtimeMs) || 0,
    ctimeMs: Number(stat.ctimeMs) || 0,
    mtimeMs: Number(stat.mtimeMs) || 0,
  };
}

async function makeAudit(target, downloadId = 1) {
  const stat = await fs.lstat(target);
  return {
    artifactId: `artifact-${downloadId}`,
    cleanupRequired: true,
    status: 'skipped',
    path: target,
    downloadId,
    capturedStatIdentity: identity(stat),
    captureIdentity: {
      captureSource: 'chrome-downloads',
      downloadId,
      browserCaptureStartedAt: Date.now() - 100,
      browserCapturedAt: Date.now(),
      browserActualName: path.basename(target),
    },
  };
}

test('final E2E download cleanup unlinks exact owned files sequentially and leaves the directory', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-e2e-download-cleanup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = path.join(root, 'first.txt');
  const second = path.join(root, 'second.txt');
  await fs.writeFile(first, 'one');
  await fs.writeFile(second, 'two');
  const audits = [await makeAudit(first, 1), await makeAudit(second, 2)];
  const actions = [];
  const results = await cleanupExactE2eDownloadFiles(audits, {
    testLog(level, scope, message, fields) {
      if (level === 'action') actions.push({ scope, message, path: fields.path });
    },
  });
  assert.deepEqual(results.map((item) => item.status), ['removed', 'removed']);
  assert.deepEqual(actions.map((item) => item.path), [first, second]);
  assert.equal((await fs.lstat(root)).isDirectory(), true);
  await assert.rejects(fs.lstat(first), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(second), { code: 'ENOENT' });
  assert.equal((await verifyExactE2eDownloadFilesAbsent(audits)).every((item) => item.absent), true);
});

test('final E2E download cleanup never deletes a directory or a replaced file', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-e2e-download-guard-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'looks-like.zip');
  await fs.mkdir(directory);
  const directoryAudit = await makeAudit(directory, 3);
  const file = path.join(root, 'owned.txt');
  await fs.writeFile(file, 'original');
  const fileAudit = await makeAudit(file, 4);
  await fs.writeFile(file, 'replacement-with-different-identity');

  const results = await cleanupExactE2eDownloadFiles([directoryAudit, fileAudit]);
  assert.deepEqual(results.map((item) => item.status), ['left_untouched', 'left_untouched']);
  assert.deepEqual(results.map((item) => item.reason), ['not_regular_file', 'identity_changed_after_capture']);
  assert.equal((await fs.lstat(directory)).isDirectory(), true);
  assert.equal(await fs.readFile(file, 'utf8'), 'replacement-with-different-identity');
});
