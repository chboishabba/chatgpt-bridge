import { isWorkflowActive } from './state/workflowState.js';
import { WORKFLOW_SERVER_BACKEND } from './server/workflowServerState.js';

export const LEGACY_WORKFLOW_BACKEND = 'bridge-legacy-v3';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function routerError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details: clone(details) });
}

function executionState(workflow = {}) {
  return workflow?.execution && typeof workflow.execution === 'object'
    ? workflow.execution
    : workflow;
}

function validBackend(value) {
  return [LEGACY_WORKFLOW_BACKEND, WORKFLOW_SERVER_BACKEND].includes(value);
}

export class WorkflowBackendRouter {
  constructor({
    legacyBackend,
    serverBackend,
    serverStore,
    readLegacy = null,
    defaultBackend = WORKFLOW_SERVER_BACKEND,
  } = {}) {
    if (!legacyBackend || !serverBackend || legacyBackend === serverBackend) {
      throw new TypeError('Workflow backend router requires distinct legacy and server backends');
    }
    if (!serverStore?.get) {
      throw new TypeError('Workflow backend router requires the workflow server state store');
    }
    if (!validBackend(defaultBackend)) {
      throw new TypeError(`Unsupported default workflow backend: ${defaultBackend}`);
    }
    const legacyReader = readLegacy
      || (typeof legacyBackend.get === 'function'
        ? (workflowId) => legacyBackend.get(workflowId)
        : typeof legacyBackend.getWorkflow === 'function'
          ? (workflowId) => legacyBackend.getWorkflow(workflowId)
          : null);
    if (!legacyReader) {
      throw new TypeError('Workflow backend router requires a read-only legacy workflow lookup');
    }
    this.legacyBackend = legacyBackend;
    this.serverBackend = serverBackend;
    this.serverStore = serverStore;
    this.readLegacy = legacyReader;
    this.defaultBackend = defaultBackend;
  }

  async #route(workflowId, { create = false } = {}) {
    const id = text(workflowId);
    if (!id) throw routerError('WORKFLOW_ID_REQUIRED', 'Workflow ID is required');

    const serverState = await this.serverStore.get(id);
    if (serverState?.localWorkflow?.backend === WORKFLOW_SERVER_BACKEND) {
      return {
        workflowId: id,
        backend: WORKFLOW_SERVER_BACKEND,
        reason: 'persisted_server_v4',
        serverState,
        legacyWorkflow: null,
        target: this.serverBackend,
      };
    }

    const legacyWorkflow = await this.readLegacy(id);
    if (legacyWorkflow) {
      return {
        workflowId: id,
        backend: LEGACY_WORKFLOW_BACKEND,
        reason: isWorkflowActive(executionState(legacyWorkflow))
          ? 'active_legacy_run_settles'
          : 'legacy_migration_required',
        serverState: null,
        legacyWorkflow,
        target: this.legacyBackend,
      };
    }

    if (!create) {
      throw routerError(
        'WORKFLOW_BACKEND_NOT_FOUND',
        `No persisted workflow backend exists for ${id}`,
        { workflowId: id },
      );
    }
    const backend = this.defaultBackend;
    return {
      workflowId: id,
      backend,
      reason: backend === WORKFLOW_SERVER_BACKEND
        ? 'new_workflow_server_default'
        : 'new_workflow_legacy_default',
      serverState: null,
      legacyWorkflow: null,
      target: backend === WORKFLOW_SERVER_BACKEND ? this.serverBackend : this.legacyBackend,
    };
  }

  async resolve(workflowId, options = {}) {
    const route = await this.#route(workflowId, options);
    return {
      workflowId: route.workflowId,
      backend: route.backend,
      reason: route.reason,
      serverState: clone(route.serverState),
      legacyWorkflow: clone(route.legacyWorkflow),
    };
  }

  async dispatch(workflowId, operation, args = [], options = {}) {
    const method = text(operation);
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(method)) {
      throw routerError(
        'WORKFLOW_BACKEND_OPERATION_INVALID',
        `Invalid workflow backend operation: ${method || '<missing>'}`,
      );
    }
    if (!Array.isArray(args)) {
      throw new TypeError('Workflow backend operation arguments must be an array');
    }
    const route = await this.#route(workflowId, options);
    const handler = route.target?.[method];
    if (typeof handler !== 'function') {
      throw routerError(
        'WORKFLOW_BACKEND_OPERATION_UNSUPPORTED',
        `${route.backend} does not support ${method}()`,
        { workflowId: route.workflowId, backend: route.backend, operation: method },
      );
    }
    // There is intentionally no cross-backend fallback here. In particular, a
    // failed server call can never enter WorkflowManager's local mutation path.
    return await handler.call(route.target, route.workflowId, ...args);
  }
}
