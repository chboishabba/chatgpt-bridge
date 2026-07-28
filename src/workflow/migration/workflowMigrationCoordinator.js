import {
  assertLegacyWorkflowMigrationReview,
  createLegacyWorkflowMigrationReview,
  evaluateLegacyWorkflowMigration,
  legacyWorkflowSourceFingerprint,
} from './legacyWorkflowMigration.js';
import { WORKFLOW_SERVER_BACKEND } from '../server/workflowServerState.js';

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function migrationError(code, message, details = {}, cause = null) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), {
    code,
    details: clone(details),
  });
}

function legacyResource(value = {}) {
  const source = record(value);
  const workflow = Object.keys(record(source.workflow)).length
    ? record(source.workflow)
    : Object.keys(record(source.snapshot)).length
      ? record(source.snapshot)
      : source;
  return {
    workflow: clone(workflow),
    config: clone(record(source.config || source.workflowConfig)),
  };
}

function serverRevision(response = {}) {
  const source = record(response);
  return source.revision
    ?? source.workflowRevision
    ?? source.etag
    ?? source.workflow?.revision
    ?? source.receipt?.revision;
}

function serverReceiptId(response = {}) {
  const source = record(response);
  return text(
    source.receiptId
      || source.receipt?.id
      || source.idempotencyReceipt?.id,
  );
}

function intentFromReview(review, at) {
  return {
    migrationId: review.migrationId,
    workflowId: review.workflowId,
    createdAt: at,
    source: clone(review.source),
    target: {
      backend: WORKFLOW_SERVER_BACKEND,
      projectId: review.target.projectId,
      expectedRevision: clone(review.target.expectedRevision),
      draftFingerprint: review.target.draftFingerprint,
      workflow: clone(review.target.workflow),
    },
    confirmation: {
      explicit: true,
      id: review.confirmation.id,
      confirmedAt: at,
    },
    idempotencyKey: review.idempotencyKey,
  };
}

function receiptFromResult(intent, response, at) {
  const revision = serverRevision(response);
  if (revision == null || revision === '') {
    throw migrationError(
      'MIGRATION_SERVER_REVISION_REQUIRED',
      'Zipflow did not return the saved workflow revision',
    );
  }
  return {
    receiptId: `bridge-migration:${intent.migrationId}`,
    migrationId: intent.migrationId,
    workflowId: intent.workflowId,
    completedAt: at,
    source: clone(intent.source),
    target: {
      backend: WORKFLOW_SERVER_BACKEND,
      projectId: intent.target.projectId,
      workflowRevision: clone(revision),
      serverReceiptId: serverReceiptId(response),
      idempotencyKey: intent.idempotencyKey,
    },
    confirmation: {
      explicit: true,
      id: intent.confirmation.id,
    },
  };
}

function intentMatchesReview(intent, review) {
  return intent.migrationId === review.migrationId
    && intent.workflowId === review.workflowId
    && intent.source.fingerprint === review.source.fingerprint
    && intent.target.projectId === review.target.projectId
    && intent.target.expectedRevision === review.target.expectedRevision
    && intent.target.draftFingerprint === review.target.draftFingerprint
    && intent.confirmation.id === review.confirmation.id
    && intent.idempotencyKey === review.idempotencyKey;
}

export class WorkflowMigrationCoordinator {
  constructor({
    client,
    serverStore,
    receiptStore,
    readLegacy,
    archiveLegacyReadOnly = null,
    clock = () => new Date().toISOString(),
  } = {}) {
    if (!client?.getWorkflow || !client?.putWorkflow) {
      throw new TypeError('Workflow migration coordinator requires a Zipflow workflow client');
    }
    if (!serverStore?.get || (!serverStore?.update && !serverStore?.set)) {
      throw new TypeError('Workflow migration coordinator requires the workflow server state store');
    }
    if (!receiptStore?.begin || !receiptStore?.commit
      || !receiptStore?.getIntent || !receiptStore?.getReceipt) {
      throw new TypeError('Workflow migration coordinator requires a migration receipt store');
    }
    if (typeof readLegacy !== 'function') {
      throw new TypeError('Workflow migration coordinator requires a legacy snapshot reader');
    }
    this.client = client;
    this.serverStore = serverStore;
    this.receiptStore = receiptStore;
    this.readLegacy = readLegacy;
    this.archiveLegacyReadOnly = typeof archiveLegacyReadOnly === 'function'
      ? archiveLegacyReadOnly
      : null;
    this.clock = clock;
  }

  async #legacy(workflowId) {
    const resource = legacyResource(await this.readLegacy(workflowId));
    if (!Object.keys(record(resource.workflow)).length) {
      throw migrationError(
        'LEGACY_WORKFLOW_NOT_FOUND',
        `Legacy workflow was not found: ${workflowId}`,
      );
    }
    return resource;
  }

  async prepare(workflowId, {
    projectId,
    zipflowWorkflow = null,
    targetRevision,
  } = {}) {
    const id = text(workflowId);
    if (!id) throw migrationError('WORKFLOW_ID_REQUIRED', 'Workflow ID is required');
    const [legacy, target] = await Promise.all([
      this.#legacy(id),
      zipflowWorkflow == null
        ? this.client.getWorkflow(projectId)
        : Promise.resolve(zipflowWorkflow),
    ]);
    return createLegacyWorkflowMigrationReview({
      workflowId: id,
      projectId,
      legacyWorkflow: legacy.workflow,
      legacyConfig: legacy.config,
      zipflowWorkflow: target,
      targetRevision,
    });
  }

  async #assertCurrentSource(intent) {
    const legacy = await this.#legacy(intent.workflowId);
    const eligibility = evaluateLegacyWorkflowMigration(legacy.workflow);
    if (!eligibility.eligible) {
      throw migrationError(
        'MIGRATION_NOT_ELIGIBLE',
        'Legacy workflow is not safe to migrate',
        { blockers: eligibility.blockers },
      );
    }
    const fingerprint = legacyWorkflowSourceFingerprint({
      workflowId: intent.workflowId,
      legacyWorkflow: legacy.workflow,
      legacyConfig: legacy.config,
    });
    if (fingerprint !== intent.source.fingerprint) {
      throw migrationError(
        'MIGRATION_SOURCE_CHANGED',
        'Legacy workflow changed after migration confirmation',
        {
          expectedFingerprint: intent.source.fingerprint,
          currentFingerprint: fingerprint,
        },
      );
    }
    return legacy;
  }

  async #persistServerCutover(intent) {
    const patch = {
      localWorkflow: {
        backend: WORKFLOW_SERVER_BACKEND,
        projectId: intent.target.projectId,
      },
    };
    if (typeof this.serverStore.update === 'function') {
      return await this.serverStore.update(intent.workflowId, patch);
    }
    return await this.serverStore.set(intent.workflowId, patch);
  }

  async #archive(intent, receipt) {
    if (!this.archiveLegacyReadOnly) return false;
    try {
      await this.archiveLegacyReadOnly({
        workflowId: intent.workflowId,
        sourceFingerprint: intent.source.fingerprint,
        receipt: clone(receipt),
        readOnly: true,
      });
      return true;
    } catch (error) {
      throw migrationError(
        'LEGACY_ARCHIVE_FAILED',
        'Server cutover is durable, but the legacy read-only archive failed',
        { migrationId: intent.migrationId, cutoverCommitted: true },
        error,
      );
    }
  }

  async #finishExisting(intent, receipt) {
    const state = await this.#persistServerCutover(intent);
    const archived = await this.#archive(intent, receipt);
    return { migrated: true, resumed: true, state, receipt: clone(receipt), archived };
  }

  async #execute(intent) {
    const existingReceipt = await this.receiptStore.getReceipt(intent.migrationId);
    if (existingReceipt) return await this.#finishExisting(intent, existingReceipt);

    // This is deliberately the last local gate before the confirmed server PUT.
    // A new legacy run/effect or configuration edit invalidates the intent.
    await this.#assertCurrentSource(intent);
    const response = await this.client.putWorkflow(
      intent.target.projectId,
      clone(intent.target.workflow),
      {
        ifMatch: clone(intent.target.expectedRevision),
        idempotencyKey: intent.idempotencyKey,
        confirmation: 'explicit',
        confirmationId: intent.confirmation.id,
      },
    );
    const alreadyCommitted = await this.receiptStore.getReceipt(intent.migrationId);
    const receipt = alreadyCommitted || await this.receiptStore.commit(
      receiptFromResult(intent, response, this.clock()),
    );
    const durableReceipt = await this.receiptStore.getReceipt(intent.migrationId);
    if (!durableReceipt) {
      throw migrationError(
        'MIGRATION_RECEIPT_NOT_DURABLE',
        'Migration receipt was not readable after commit',
      );
    }
    const state = await this.#persistServerCutover(intent);
    const archived = await this.#archive(intent, durableReceipt);
    return { migrated: true, resumed: false, state, receipt, archived };
  }

  async migrate(review, { confirmation } = {}) {
    const checked = assertLegacyWorkflowMigrationReview(review);
    if (!checked.eligible || checked.blockers.length) {
      throw migrationError(
        'MIGRATION_NOT_ELIGIBLE',
        'Migration review contains blocking gates',
        { blockers: checked.blockers },
      );
    }
    if (confirmation?.explicit !== true
      || text(confirmation.id) !== checked.confirmation.id) {
      throw migrationError(
        'MIGRATION_CONFIRMATION_REQUIRED',
        'Migration requires the exact explicit confirmation shown with the draft',
      );
    }

    const existing = await this.receiptStore.getIntent(checked.migrationId);
    let intent;
    if (existing) {
      if (!intentMatchesReview(existing, checked)) {
        throw migrationError(
          'MIGRATION_INTENT_CONFLICT',
          'The durable migration intent does not match this review',
        );
      }
      intent = existing;
    } else {
      const at = this.clock();
      intent = await this.receiptStore.begin(intentFromReview(checked, at));
    }
    return await this.#execute(intent);
  }

  async resume(migrationId) {
    const id = text(migrationId);
    const intent = await this.receiptStore.getIntent(id);
    if (!intent) {
      throw migrationError(
        'MIGRATION_INTENT_NOT_FOUND',
        `Migration intent was not found: ${id}`,
      );
    }
    return await this.#execute(intent);
  }
}
