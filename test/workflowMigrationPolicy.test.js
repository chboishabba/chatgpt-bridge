import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertLegacyWorkflowMigrationReview,
  createLegacyWorkflowMigrationReview,
  evaluateLegacyWorkflowMigration,
} from '../src/workflow/migration/legacyWorkflowMigration.js';

function legacyWorkflow(overrides = {}) {
  const execution = {
    schemaVersion: 3,
    revision: 4,
    lifecycle: 'ready',
    run: { id: '', phase: 'none' },
    binding: { clientId: 'client-1', sessionId: 'session-1', epoch: 2 },
    localEffects: {},
    ...(overrides.execution || {}),
  };
  return {
    id: 'workflow-1',
    projectRoot: '/tmp/project',
    preset: 'fix-until-pass',
    checks: ['npm test'],
    ...overrides,
    execution,
  };
}

function legacyConfig(overrides = {}) {
  return {
    projectRoot: '/tmp/project',
    preset: 'fix-until-pass',
    apply: {
      sync: true,
      protectedPaths: ['.env*', '.git/**'],
      commands: [],
      timeoutMs: 60_000,
    },
    automation: {
      steps: [{
        id: 'tests',
        name: 'Unit tests',
        command: 'npm test',
        cwd: '/tmp/project/packages/app',
        timeoutMs: 45_000,
      }],
      stepTimeoutMs: 60_000,
      maxCycles: 6,
      noProgressLimit: 2,
      turn: { model: 'gpt-5', effort: 'high' },
    },
    commit: {
      policy: {
        mode: 'automatic',
        iterationStrategy: 'checkpoint',
        completionStrategy: 'squash',
        includeOnlyWorkflowChanges: true,
      },
    },
    deployment: {
      policy: 'ask',
      commandText: 'npm run deploy',
      cwd: '/tmp/project',
    },
    remediation: { enabled: true, maxAttempts: 3 },
    resultProtocol: { repairAttempts: 2 },
    ux: {
      invalidResponseAttempts: 2,
      sessionExhaustion: 'start-new-chat',
      session: { maxTurns: 30 },
      notifications: { failedChecks: true },
    },
    ...overrides,
  };
}

function zipflowResource() {
  return {
    revision: 7,
    workflow: {
      version: 9,
      name: 'Project',
      projectPath: '/tmp/project',
      archive: { mode: 'overlay', stripSingleRootDirectory: true },
      exclude: ['.git/**', 'node_modules/**'],
      checks: [{ id: 'old', selected: true }],
      git: { checkpoint: 'ask', resultCommit: 'ask', hooks: 'disabled' },
      deploy: { policy: 'disabled', commandText: '', cwd: '.', timeoutMs: 900_000 },
      autonomy: { mode: 'manual', preserved: true },
    },
  };
}

test('migration eligibility blocks active v3 and dispatched/uncertain unsafe local effects', () => {
  const safeDispatched = evaluateLegacyWorkflowMigration(legacyWorkflow({
    execution: {
      localEffects: {
        checks: { id: 'checks', kind: 'checks', status: 'dispatched' },
        plannedApply: { id: 'plannedApply', kind: 'apply', status: 'planned' },
        completedApply: { id: 'completedApply', kind: 'apply', status: 'succeeded' },
      },
    },
  }));
  assert.equal(safeDispatched.eligible, true);

  for (const status of ['dispatched', 'uncertain']) {
    const result = evaluateLegacyWorkflowMigration(legacyWorkflow({
      execution: {
        localEffects: {
          unsafe: {
            id: `apply-${status}`,
            kind: 'apply',
            status,
            safe: true,
          },
        },
      },
    }));
    assert.equal(result.eligible, false);
    assert.deepEqual(
      result.blockers.map((item) => item.code),
      ['LEGACY_UNSAFE_LOCAL_EFFECT_UNSETTLED'],
    );
  }

  const active = evaluateLegacyWorkflowMigration(legacyWorkflow({
    execution: {
      lifecycle: 'running',
      run: { id: 'run-active', phase: 'applying' },
    },
  }));
  assert.equal(active.eligible, false);
  assert.equal(active.blockers[0].code, 'LEGACY_WORKFLOW_ACTIVE');

  const oldSchema = evaluateLegacyWorkflowMigration(legacyWorkflow({
    execution: { schemaVersion: 2 },
  }));
  assert.equal(oldSchema.eligible, false);
  assert.equal(oldSchema.blockers[0].code, 'LEGACY_WORKFLOW_SCHEMA_UNSUPPORTED');
});

test('migration review is a complete current Zipflow draft plus Bridge-owned settings', () => {
  const review = createLegacyWorkflowMigrationReview({
    workflowId: 'workflow-1',
    projectId: 'project-1',
    legacyWorkflow: legacyWorkflow(),
    legacyConfig: legacyConfig(),
    zipflowWorkflow: zipflowResource(),
  });

  assert.equal(review.eligible, true);
  assert.deepEqual(review.blockers, []);
  assert.equal(review.source.schemaVersion, 3);
  assert.equal(review.source.revision, 4);
  assert.equal(review.target.expectedRevision, 7);
  assert.equal(review.target.workflow.version, 9);
  assert.deepEqual(review.target.workflow.autonomy, { mode: 'manual', preserved: true });
  assert.equal(review.target.workflow.archive.mode, 'snapshot');
  assert.deepEqual(
    review.target.workflow.exclude,
    ['.git/**', 'node_modules/**', '.env*'],
  );
  assert.deepEqual(
    review.target.workflow.checks.map((check) => ({
      command: check.commandText,
      cwd: check.cwd,
      selected: check.selected,
      required: check.required,
    })),
    [{ command: 'npm test', cwd: 'packages/app', selected: true, required: true }],
  );
  assert.equal(review.target.workflow.git.checkpoint, 'auto');
  assert.equal(review.target.workflow.git.resultCommit, 'auto');
  assert.deepEqual(
    {
      policy: review.target.workflow.deploy.policy,
      commandText: review.target.workflow.deploy.commandText,
      cwd: review.target.workflow.deploy.cwd,
    },
    { policy: 'ask', commandText: 'npm run deploy', cwd: '.' },
  );
  assert.deepEqual(review.bridgeRetained.binding, {
    clientId: 'client-1',
    sessionId: 'session-1',
    epoch: 2,
  });
  assert.deepEqual(review.bridgeRetained.intelligence, {
    model: 'gpt-5',
    effort: 'high',
  });
  assert.equal(review.bridgeRetained.attempts.checkCycles, 6);
  assert.equal(review.bridgeRetained.noProgressLimit, 2);
  assert.equal(review.confirmation.kind, 'explicit');
  assert.match(review.confirmation.id, /^[a-f0-9]{64}$/);
  assert.doesNotThrow(() => assertLegacyWorkflowMigrationReview(review));

  const changed = structuredClone(review);
  changed.target.workflow.archive.mode = 'overlay';
  assert.throws(
    () => assertLegacyWorkflowMigrationReview(changed),
    { code: 'MIGRATION_REVIEW_TAMPERED' },
  );
});

test('migration draft fails closed for commands outside the canonical project', () => {
  const workflow = legacyWorkflow({ checks: ['npm test'] });
  const config = legacyConfig({
    automation: {
      ...legacyConfig().automation,
      steps: [{
        id: 'outside',
        command: 'npm test',
        cwd: '/tmp/unrelated-project',
      }],
    },
  });
  const review = createLegacyWorkflowMigrationReview({
    workflowId: workflow.id,
    projectId: 'project-1',
    legacyWorkflow: workflow,
    legacyConfig: config,
    zipflowWorkflow: zipflowResource(),
  });
  assert.equal(review.eligible, false);
  assert.deepEqual(
    review.blockers.map((item) => item.code),
    ['LEGACY_CHECK_CWD_OUTSIDE_PROJECT'],
  );
  assert.deepEqual(review.target.workflow.checks, []);
});
