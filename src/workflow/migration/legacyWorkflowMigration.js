import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  WORKFLOW_STATE_SCHEMA_VERSION,
  WorkflowEffectStatus,
  isWorkflowActive,
} from '../state/workflowState.js';
import { isSafeLocalEffect } from '../state/localEffects.js';

export const WORKFLOW_MIGRATION_REVIEW_VERSION = 1;

const UNSAFE_MIGRATION_STATUSES = new Set([
  WorkflowEffectStatus.DISPATCHED,
  WorkflowEffectStatus.UNCERTAIN,
]);

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function canonicalValue(value) {
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== 'object') return String(value);
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalValue(value[key])]),
  );
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');
}

function migrationError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details: clone(details) });
}

function legacyState(workflow = {}) {
  const source = record(workflow);
  return Object.keys(record(source.execution)).length ? record(source.execution) : source;
}

function localEffectEntries(state = {}) {
  const effects = state.localEffects;
  const entries = Array.isArray(effects)
    ? effects.map((effect, index) => [text(effect?.id) || String(index), effect])
    : Object.entries(record(effects));
  return entries
    .filter(([, effect]) => effect && typeof effect === 'object')
    .sort(([left], [right]) => left.localeCompare(right));
}

export function legacyWorkflowSourceFingerprint({
  workflowId = '',
  legacyWorkflow = {},
  legacyConfig = {},
} = {}) {
  return fingerprint({
    workflowId: text(workflowId || legacyWorkflow?.id),
    state: legacyState(legacyWorkflow),
    config: record(legacyConfig),
  });
}

export function evaluateLegacyWorkflowMigration(legacyWorkflow = {}) {
  const state = legacyState(legacyWorkflow);
  const schemaVersion = Number(
    state.schemaVersion
      ?? legacyWorkflow?.workflowStateSchemaVersion
      ?? legacyWorkflow?.execution?.schemaVersion,
  );
  const revision = Number(state.revision ?? legacyWorkflow?.workflowStateRevision ?? 0);
  const lifecycle = text(state.lifecycle || legacyWorkflow?.lifecycle);
  const blockers = [];

  if (schemaVersion !== WORKFLOW_STATE_SCHEMA_VERSION) {
    blockers.push({
      code: 'LEGACY_WORKFLOW_SCHEMA_UNSUPPORTED',
      message: `Only workflow state v${WORKFLOW_STATE_SCHEMA_VERSION} can be migrated`,
      schemaVersion: Number.isFinite(schemaVersion) ? schemaVersion : null,
    });
  }

  if (isWorkflowActive(state)) {
    blockers.push({
      code: 'LEGACY_WORKFLOW_ACTIVE',
      message: 'The active legacy run must reach a terminal lifecycle before migration',
      lifecycle,
      runId: text(state.run?.id || legacyWorkflow?.run?.id),
    });
  }

  for (const [key, effect] of localEffectEntries(state)) {
    const kind = text(effect.kind);
    const status = text(effect.status);
    if (isSafeLocalEffect(kind) || !UNSAFE_MIGRATION_STATUSES.has(status)) continue;
    blockers.push({
      code: 'LEGACY_UNSAFE_LOCAL_EFFECT_UNSETTLED',
      message: `Unsafe local effect ${text(effect.id) || key} is ${status}`,
      effectId: text(effect.id) || key,
      kind,
      status,
    });
  }

  return {
    eligible: blockers.length === 0,
    schemaVersion: Number.isFinite(schemaVersion) ? schemaVersion : null,
    revision: Number.isFinite(revision) ? revision : 0,
    lifecycle,
    blockers,
  };
}

function uniqueStrings(...groups) {
  return Array.from(new Set(groups.flatMap(array).map(text).filter(Boolean)));
}

function relativeProjectCwd(projectRoot, value = '.') {
  const root = path.resolve(projectRoot || '.');
  const candidate = text(value) || '.';
  const absolute = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(root, candidate);
  const relative = path.relative(root, absolute);
  if (relative === '') return { cwd: '.', valid: true };
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { cwd: candidate, valid: false };
  }
  return { cwd: relative.split(path.sep).join('/'), valid: true };
}

function checkCommands(legacyWorkflow, legacyConfig) {
  const projected = array(legacyWorkflow?.checks);
  if (projected.length) {
    return projected.map((value) => {
      const source = typeof value === 'string' ? { command: value } : record(value);
      const command = text(source.command || source.commandText || source.run);
      const step = array(legacyConfig?.automation?.steps).find((item) => text(item?.command) === command);
      return { ...record(step), ...source, command };
    }).filter((item) => item.command);
  }
  if (legacyConfig?.preset === 'apply-changes') {
    return array(legacyConfig?.apply?.commands).map((command) => ({ command: text(command) }));
  }
  return array(legacyConfig?.automation?.steps)
    .map((step) => ({ ...record(step), command: text(step?.command) }))
    .filter((step) => step.command);
}

function mapChecks(legacyWorkflow, legacyConfig) {
  const root = text(legacyConfig?.projectRoot || legacyWorkflow?.projectRoot) || '.';
  const defaultTimeoutMs = Number(
    legacyConfig?.preset === 'apply-changes'
      ? legacyConfig?.apply?.timeoutMs
      : legacyConfig?.automation?.stepTimeoutMs,
  ) || 600_000;
  const blockers = [];
  const checks = [];
  const seen = new Set();
  for (const source of checkCommands(legacyWorkflow, legacyConfig)) {
    const commandText = text(source.command);
    const location = relativeProjectCwd(root, source.cwd || '.');
    if (!location.valid) {
      blockers.push({
        code: 'LEGACY_CHECK_CWD_OUTSIDE_PROJECT',
        message: `Check command cannot be migrated outside the project: ${commandText}`,
        commandText,
        cwd: text(source.cwd),
      });
      continue;
    }
    const identity = `${location.cwd}\n${commandText}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const id = `bridge:${fingerprint(identity).slice(0, 16)}`;
    checks.push({
      id,
      name: text(source.name || source.id) || (commandText.length <= 72 ? commandText : `${commandText.slice(0, 69)}...`),
      description: commandText,
      kind: 'custom',
      type: 'custom',
      commandText,
      cwd: location.cwd,
      projectPath: location.cwd,
      selected: true,
      required: source.continueOnFailure !== true,
      timeoutMs: Math.max(1_000, Number(source.timeoutMs) || defaultTimeoutMs),
      custom: true,
    });
  }
  return { checks, blockers };
}

function strategyPolicy(strategy, mode) {
  const normalizedStrategy = text(strategy).toLowerCase();
  const normalizedMode = text(mode).toLowerCase();
  if (['none', 'never', 'disabled', 'off'].includes(normalizedMode)
    || ['none', 'never', 'disabled', 'off'].includes(normalizedStrategy)) return 'never';
  if (['ask', 'manual', 'prompt'].includes(normalizedMode)
    || ['ask', 'manual', 'prompt'].includes(normalizedStrategy)) return 'ask';
  return 'auto';
}

function mapGit(base, legacyConfig) {
  const policy = record(legacyConfig?.commit?.policy);
  return {
    ...record(base),
    checkpoint: strategyPolicy(policy.iterationStrategy, policy.mode),
    resultCommit: strategyPolicy(policy.completionStrategy, policy.mode),
  };
}

function deployPolicy(value) {
  const policy = text(value).toLowerCase();
  if (!policy || ['none', 'never', 'disabled', 'off'].includes(policy)) return 'disabled';
  if (['ask', 'prompt'].includes(policy)) return 'ask';
  if (['always', 'auto', 'automatic', 'required'].includes(policy)) return 'always';
  if (['manual', 'on-demand', 'ondemand'].includes(policy)) return 'on-demand';
  return '';
}

function mapDeploy(base, legacyConfig) {
  const configured = record(legacyConfig?.deployment || legacyConfig?.deploy);
  const daemon = record(legacyConfig?.daemonRestart);
  const source = Object.keys(configured).length
    ? configured
    : daemon.enabled && daemon.mode === 'command'
      ? { policy: 'always', commandText: daemon.command, cwd: '.' }
      : {};
  const warnings = [];
  const blockers = [];
  if (legacyConfig?.extensionUpdate?.enabled) {
    warnings.push({
      code: 'LEGACY_EXTENSION_UPDATE_REQUIRES_REVIEW',
      message: 'The structured Bridge extension update has no automatic Zipflow deployment mapping',
    });
  }
  if (daemon.enabled && daemon.mode !== 'command') {
    warnings.push({
      code: 'LEGACY_DAEMON_RESTART_REQUIRES_REVIEW',
      message: `Bridge daemon restart mode ${text(daemon.mode) || 'unknown'} has no command to migrate`,
    });
  }
  const policy = deployPolicy(source.policy);
  const commandText = text(source.commandText || source.command);
  if (!policy) {
    blockers.push({
      code: 'LEGACY_DEPLOY_POLICY_UNSUPPORTED',
      message: `Deployment policy cannot be migrated: ${text(source.policy)}`,
    });
  }
  if (policy !== 'disabled' && !commandText) {
    blockers.push({
      code: 'LEGACY_DEPLOY_COMMAND_REQUIRED',
      message: 'An enabled deployment policy requires a configured command',
    });
  }
  const location = relativeProjectCwd(legacyConfig?.projectRoot || '.', source.cwd || '.');
  if (!location.valid) {
    blockers.push({
      code: 'LEGACY_DEPLOY_CWD_OUTSIDE_PROJECT',
      message: 'Deployment command cannot be migrated outside the project',
      cwd: text(source.cwd),
    });
  }
  return {
    deploy: {
      ...record(base),
      policy: policy || 'disabled',
      commandText: policy === 'disabled' ? '' : commandText,
      cwd: location.valid ? location.cwd : '.',
    },
    warnings,
    blockers,
  };
}

function bridgeRetainedSettings(legacyWorkflow, legacyConfig) {
  const state = legacyState(legacyWorkflow);
  return {
    preset: text(legacyConfig?.preset || legacyWorkflow?.preset),
    binding: clone(state.binding || legacyWorkflow?.binding || {}),
    watch: clone(legacyConfig?.watch || {}),
    intelligence: {
      model: text(legacyWorkflow?.intelligence?.model || legacyConfig?.automation?.turn?.model),
      effort: text(legacyWorkflow?.intelligence?.effort || legacyConfig?.automation?.turn?.effort),
    },
    remediation: clone(legacyConfig?.remediation || {}),
    attempts: {
      invalidResponse: Number(legacyConfig?.ux?.invalidResponseAttempts || 0),
      resultRepair: Number(legacyConfig?.resultProtocol?.repairAttempts || 0),
      checkCycles: Number(legacyConfig?.automation?.maxCycles || 0),
    },
    sessionExhaustion: text(legacyConfig?.ux?.sessionExhaustion),
    session: clone(legacyConfig?.ux?.session || {}),
    notifications: clone(legacyConfig?.ux?.notifications || {}),
    noProgressLimit: Number(legacyConfig?.automation?.noProgressLimit || 0),
  };
}

function targetWorkflowResource(value = {}, explicitRevision) {
  const source = record(value);
  const wrapped = record(source.workflow);
  const configured = Object.keys(wrapped).length
    ? wrapped
    : Object.keys(record(source.configuration)).length
      ? record(source.configuration)
      : source;
  const revision = explicitRevision ?? source.revision ?? source.workflowRevision ?? source.etag;
  return { workflow: clone(configured), revision };
}

function reviewIntegrityFields(review) {
  return {
    reviewVersion: review.reviewVersion,
    workflowId: review.workflowId,
    projectId: review.target?.projectId,
    expectedRevision: review.target?.expectedRevision,
    source: review.source,
    draftFingerprint: review.target?.draftFingerprint,
    blockers: review.blockers,
    warnings: review.warnings,
  };
}

export function createLegacyWorkflowMigrationReview({
  workflowId = '',
  projectId = '',
  legacyWorkflow = {},
  legacyConfig = {},
  zipflowWorkflow = {},
  targetRevision,
} = {}) {
  const id = text(workflowId || legacyWorkflow?.id);
  if (!id) throw migrationError('WORKFLOW_ID_REQUIRED', 'Workflow ID is required for migration');
  const target = targetWorkflowResource(zipflowWorkflow, targetRevision);
  const eligibility = evaluateLegacyWorkflowMigration(legacyWorkflow);
  const checks = mapChecks(legacyWorkflow, legacyConfig);
  const deployment = mapDeploy(target.workflow?.deploy, legacyConfig);
  const exclusions = uniqueStrings(
    target.workflow?.exclude,
    legacyConfig?.exclude,
    legacyConfig?.exclusions,
    legacyConfig?.apply?.protectedPaths,
    legacyWorkflow?.protectedPaths,
    legacyWorkflow?.exclusions,
  );
  const zipflowDraft = {
    ...target.workflow,
    projectPath: text(target.workflow?.projectPath || legacyConfig?.projectRoot || legacyWorkflow?.projectRoot),
    archive: {
      ...record(target.workflow?.archive),
      mode: legacyConfig?.apply?.sync === false ? 'overlay' : 'snapshot',
    },
    exclude: exclusions,
    checks: checks.checks,
    git: mapGit(target.workflow?.git, legacyConfig),
    deploy: deployment.deploy,
  };
  const blockers = [
    ...eligibility.blockers,
    ...checks.blockers,
    ...deployment.blockers,
  ];
  if (!text(projectId)) {
    blockers.push({
      code: 'ZIPFLOW_PROJECT_ID_REQUIRED',
      message: 'The canonical Zipflow project must be opened before migration',
    });
  }
  if (target.revision == null || target.revision === '') {
    blockers.push({
      code: 'ZIPFLOW_WORKFLOW_REVISION_REQUIRED',
      message: 'The current Zipflow workflow revision is required for If-Match',
    });
  }
  if (!Object.keys(record(target.workflow)).length) {
    blockers.push({
      code: 'ZIPFLOW_WORKFLOW_DRAFT_REQUIRED',
      message: 'Migration must start from the current complete Zipflow workflow',
    });
  }
  const sourceFingerprint = legacyWorkflowSourceFingerprint({
    workflowId: id,
    legacyWorkflow,
    legacyConfig,
  });
  const draftFingerprint = fingerprint(zipflowDraft);
  const migrationId = fingerprint({
    workflowId: id,
    projectId: text(projectId),
    sourceFingerprint,
    draftFingerprint,
  });
  const review = {
    reviewVersion: WORKFLOW_MIGRATION_REVIEW_VERSION,
    migrationId,
    workflowId: id,
    eligible: blockers.length === 0,
    source: {
      schemaVersion: eligibility.schemaVersion,
      revision: eligibility.revision,
      lifecycle: eligibility.lifecycle,
      fingerprint: sourceFingerprint,
    },
    target: {
      backend: 'zipflow-server-v1',
      projectId: text(projectId),
      expectedRevision: target.revision,
      draftFingerprint,
      workflow: zipflowDraft,
    },
    bridgeRetained: bridgeRetainedSettings(legacyWorkflow, legacyConfig),
    blockers,
    warnings: deployment.warnings,
    confirmation: {
      required: true,
      kind: 'explicit',
      id: '',
    },
    idempotencyKey: `bridge-migration:${migrationId}`,
  };
  review.confirmation.id = fingerprint(reviewIntegrityFields(review));
  return clone(review);
}

export function assertLegacyWorkflowMigrationReview(review = {}) {
  if (Number(review?.reviewVersion) !== WORKFLOW_MIGRATION_REVIEW_VERSION) {
    throw migrationError('MIGRATION_REVIEW_INCOMPATIBLE', 'Migration review version is unsupported');
  }
  const actualDraftFingerprint = fingerprint(review?.target?.workflow);
  if (actualDraftFingerprint !== review?.target?.draftFingerprint) {
    throw migrationError('MIGRATION_REVIEW_TAMPERED', 'The reviewed Zipflow workflow draft changed');
  }
  const migrationId = fingerprint({
    workflowId: text(review?.workflowId),
    projectId: text(review?.target?.projectId),
    sourceFingerprint: text(review?.source?.fingerprint),
    draftFingerprint: actualDraftFingerprint,
  });
  if (migrationId !== review?.migrationId
    || review?.idempotencyKey !== `bridge-migration:${migrationId}`) {
    throw migrationError('MIGRATION_REVIEW_TAMPERED', 'Migration identity no longer matches the reviewed source and target');
  }
  const confirmationId = fingerprint(reviewIntegrityFields(review));
  if (confirmationId !== review?.confirmation?.id) {
    throw migrationError('MIGRATION_REVIEW_TAMPERED', 'Migration confirmation no longer matches the review');
  }
  return clone(review);
}
