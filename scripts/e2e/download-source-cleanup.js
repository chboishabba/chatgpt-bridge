import fs from 'node:fs/promises';
import path from 'node:path';

function numeric(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function statIdentity(stat = {}) {
  return {
    dev: numeric(stat.dev),
    ino: numeric(stat.ino),
    size: numeric(stat.size),
    birthtimeMs: numeric(stat.birthtimeMs),
    ctimeMs: numeric(stat.ctimeMs),
    mtimeMs: numeric(stat.mtimeMs),
  };
}

function sameStatIdentity(left = {}, right = {}) {
  if (numeric(left.dev) && numeric(right.dev) && numeric(left.dev) !== numeric(right.dev)) return false;
  if (numeric(left.ino) && numeric(right.ino) && numeric(left.ino) !== numeric(right.ino)) return false;
  return numeric(left.size) === numeric(right.size)
    && numeric(left.birthtimeMs) === numeric(right.birthtimeMs)
    && numeric(left.ctimeMs) === numeric(right.ctimeMs)
    && numeric(left.mtimeMs) === numeric(right.mtimeMs);
}

async function lstatExact(absolute) {
  try {
    return await fs.lstat(absolute);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function cleanupIdentity(audit = {}) {
  const identity = audit.capturedStatIdentity && typeof audit.capturedStatIdentity === 'object'
    ? audit.capturedStatIdentity
    : null;
  const capture = audit.captureIdentity && typeof audit.captureIdentity === 'object'
    ? audit.captureIdentity
    : null;
  return { identity, capture };
}

function validateExactOwnedFile(absolute, current, audit = {}) {
  if (current.isSymbolicLink()) return { ok: false, reason: 'symbolic_link' };
  if (!current.isFile()) return { ok: false, reason: 'not_regular_file' };
  const { identity, capture } = cleanupIdentity(audit);
  if (!identity || !capture) return { ok: false, reason: 'missing_capture_identity' };
  if (String(capture.captureSource || '') !== 'chrome-downloads') return { ok: false, reason: 'untrusted_capture_source' };
  if (capture.downloadId == null || !capture.browserActualName) return { ok: false, reason: 'incomplete_capture_identity' };
  if (path.basename(absolute) !== path.basename(String(capture.browserActualName))) return { ok: false, reason: 'captured_name_changed' };
  if (!sameStatIdentity(identity, statIdentity(current))) return { ok: false, reason: 'identity_changed_after_capture' };
  return { ok: true };
}

export async function cleanupExactE2eDownloadFiles(audits = [], { testLog = () => {} } = {}) {
  const results = [];
  for (const audit of Array.isArray(audits) ? audits : []) {
    if (!audit?.cleanupRequired || !audit.path) continue;
    const absolute = path.resolve(String(audit.path));
    const current = await lstatExact(absolute);
    if (!current) {
      results.push({ artifactId: audit.artifactId || '', path: absolute, status: 'already_absent', downloadId: audit.downloadId ?? null });
      continue;
    }
    const validation = validateExactOwnedFile(absolute, current, audit);
    if (!validation.ok) {
      results.push({ artifactId: audit.artifactId || '', path: absolute, status: 'left_untouched', reason: validation.reason, downloadId: audit.downloadId ?? null });
      testLog('warn', 'download-cleanup', 'Exact E2E download file was left untouched because ownership could not be re-proven', {
        artifactId: audit.artifactId || '',
        path: absolute,
        reason: validation.reason,
        downloadId: audit.downloadId ?? null,
      });
      continue;
    }
    testLog('action', 'download-cleanup', 'Deleting one exact E2E-owned download file', {
      artifactId: audit.artifactId || '',
      path: absolute,
      downloadId: audit.downloadId ?? null,
    });
    await fs.unlink(absolute);
    const after = await lstatExact(absolute);
    if (after) throw new Error(`Exact E2E download file still exists after unlink: ${absolute}`);
    results.push({ artifactId: audit.artifactId || '', path: absolute, status: 'removed', downloadId: audit.downloadId ?? null });
  }
  return results;
}

export async function verifyExactE2eDownloadFilesAbsent(audits = []) {
  const verified = [];
  for (const audit of Array.isArray(audits) ? audits : []) {
    if (!audit?.cleanupRequired || !audit.path) continue;
    const absolute = path.resolve(String(audit.path));
    const current = await lstatExact(absolute);
    verified.push({ artifactId: audit.artifactId || '', path: absolute, absent: !current, downloadId: audit.downloadId ?? null });
    if (current) throw new Error(`E2E-owned browser download source still exists: ${absolute}`);
  }
  return verified;
}
