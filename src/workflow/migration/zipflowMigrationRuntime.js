import { createHash } from 'node:crypto';
import { loadWorkflowConfig } from '../config.js';
import { WorkflowMigrationCoordinator } from './workflowMigrationCoordinator.js';
import { WorkflowMigrationReceiptStore } from './migrationReceiptStore.js';
import { LegacyWorkflowArchiveStore } from './legacyWorkflowArchiveStore.js';

function previewWorkflowId(workflowId) {
  const hash = createHash('sha256').update(String(workflowId || '')).digest('hex').slice(0, 20);
  return `migration-preview-${hash}`;
}

export class ZipflowMigrationRuntime {
  constructor({
    runtime,
    workflowManager,
    dataDir,
    receiptStore = null,
    archiveStore = null,
  } = {}) {
    if (!runtime) throw new TypeError('Migration runtime requires the server workflow runtime');
    if (!workflowManager?.get) throw new TypeError('Migration runtime requires the legacy workflow manager');
    this.runtime = runtime;
    this.workflowManager = workflowManager;
    this.receiptStore = receiptStore || new WorkflowMigrationReceiptStore(dataDir);
    this.archiveStore = archiveStore || new LegacyWorkflowArchiveStore(dataDir);
    this.coordinator = null;
  }

  async #readLegacy(workflowId) {
    const workflow = this.workflowManager.get(workflowId);
    if (!workflow) return null;
    const config = workflow.configPath
      ? await loadWorkflowConfig(workflow.configPath)
      : {};
    return { workflow, config };
  }

  async #coordinator() {
    if (this.coordinator) return this.coordinator;
    if (!this.runtime.client) {
      throw Object.assign(new Error('Open the migration project before creating the coordinator'), {
        code: 'WORKFLOW_NOT_CONNECTED',
      });
    }
    this.coordinator = new WorkflowMigrationCoordinator({
      client: this.runtime.client,
      serverStore: this.runtime.store,
      receiptStore: this.receiptStore,
      readLegacy: (workflowId) => this.#readLegacy(workflowId),
      archiveLegacyReadOnly: async ({
        workflowId,
        sourceFingerprint,
        receipt,
      }) => {
        const legacy = await this.#readLegacy(workflowId);
        return await this.archiveStore.archive({
          workflowId,
          sourceFingerprint,
          receipt,
          legacyWorkflow: legacy?.workflow || {},
          legacyConfig: legacy?.config || {},
        });
      },
    });
    return this.coordinator;
  }

  async prepare(workflowId) {
    const legacy = await this.#readLegacy(workflowId);
    if (!legacy?.workflow) {
      throw Object.assign(new Error(`Legacy workflow was not found: ${workflowId}`), {
        code: 'LEGACY_WORKFLOW_NOT_FOUND',
      });
    }
    const projectPath = legacy.config.projectRoot || legacy.workflow.projectRoot;
    const opened = await this.runtime.openProject(projectPath, {
      workflowId: previewWorkflowId(workflowId),
    });
    const coordinator = await this.#coordinator();
    return await coordinator.prepare(workflowId, {
      projectId: opened.state.localWorkflow.projectId,
    });
  }

  async migrate(review, confirmation) {
    const coordinator = await this.#coordinator();
    const result = await coordinator.migrate(review, { confirmation });
    if (review.bridgeRetained) {
      await this.runtime.orchestrationStore.set(
        review.workflowId,
        {
          ...review.bridgeRetained,
        },
      );
    }
    return result;
  }

  async close() {
    await this.receiptStore.close();
  }
}
