import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function workflowFixture({ id, configPath, projectRoot, sessionId, clientId }) {
  return {
    id,
    preset: 'guided-task',
    label: 'Work through a task',
    projectRoot,
    configPath,
    lifecycle: 'ready',
    binding: { sessionId, clientId, epoch: 1 },
    execution: { subscription: { enabled: true } },
  };
}

test('interactive workflow wizard opens and binds a dedicated fresh tab for Start a new chat', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-wizard-new-chat-'));
  const dataDir = path.join(root, 'data');
  const projectRoot = path.join(root, 'project');
  await fs.mkdir(projectRoot, { recursive: true });
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;

  try {
    const [{ WorkflowWizardController }, { loadGlobalWorkflowConfig }] = await Promise.all([
      import('../src/workflow/ux/workflowWizard.js'),
      import('../src/workflow/ux/globalConfig.js'),
    ]);
    const calls = [];
    const concreteSessionId = 'conversation-wizard-302';
    const freshClientId = 'ext-cloned-content:tab:302';
    const loadedById = new Map();
    const bridge = {
      health() { return { clients: [], activeClient: null }; },
      async newSession() { throw new Error('interactive new-chat workflow must not use sessions.new'); },
      async openBrowserTab(options) {
        calls.push(['openBrowserTab', options]);
        return {
          launchToken: options.launchToken,
          openedBy: 'extension',
          client: {
            id: freshClientId,
            browserTabId: 302,
            url: 'https://chatgpt.com/',
            session: { id: 'new' },
          },
        };
      },
      async sendRequest(options) {
        calls.push(['sendRequest', options]);
        return {
          answer: 'Ready.',
          sourceClientId: freshClientId,
          session: { id: concreteSessionId, url: `https://chatgpt.com/c/${concreteSessionId}` },
        };
      },
    };
    const fileStore = {
      async importLocalPath(options) {
        calls.push(['importLocalPath', options]);
        return { id: 'workflow-instructions', name: options.name };
      },
    };
    const projectService = {
      async pack() {
        calls.push(['pack']);
        return {
          file: { id: 'project-snapshot-file' },
          project: { id: 'project-wizard' },
          snapshotId: 'snapshot-wizard',
          sha256: 'sha-wizard',
        };
      },
      async markSnapshotUploaded(options) { calls.push(['markSnapshotUploaded', options]); },
    };
    const workflowManager = {
      async load(configPath) {
        const workflow = workflowFixture({
          id: 'project-guided-task', configPath, projectRoot,
          sessionId: concreteSessionId, clientId: freshClientId,
        });
        loadedById.set(workflow.id, workflow);
        calls.push(['load', configPath]);
        return workflow;
      },
      get(id) { return loadedById.get(id) || null; },
      async assumeProjectContext(id, sessionId) { calls.push(['assumeProjectContext', id, sessionId]); },
      async start(id) { calls.push(['start', id]); return loadedById.get(id); },
      async runAutomation() { throw new Error('guided workflow must not start automation'); },
    };
    const transcript = [];
    const runtime = {
      state: { projectRoot, model: '', effort: 'auto', focusedWorkflowId: '' },
      options: { bridge, fileStore, projectService, workflowManager, projectPath: projectRoot },
      invalidate() {},
      pushEntry(entry) { transcript.push(entry); },
      async saveState() { calls.push(['saveState']); },
    };
    const controller = new WorkflowWizardController(runtime);
    controller.opened = true;
    controller.global = await loadGlobalWorkflowConfig({ dataDir });
    controller.global.firstRun = false;
    controller.draft = {
      preset: 'guided-task',
      chat: { mode: 'new', clientId: 'selected-control-tab', sessionId: '', sendInstructions: false },
      projectRoot,
      checks: [],
      checksInitialized: true,
      profileName: '',
      profile: null,
      overrides: {},
    };

    await controller.startWorkflow();
    assert.equal(controller.lastSetupError, null);
    const openIndex = calls.findIndex(([name]) => name === 'openBrowserTab');
    const sendIndex = calls.findIndex(([name]) => name === 'sendRequest');
    assert.ok(openIndex >= 0, 'wizard did not open a fresh tab');
    assert.ok(sendIndex > openIndex, 'wizard sent the bootstrap prompt before opening the fresh tab');
    const openOptions = calls[openIndex][1];
    assert.equal(openOptions.url, 'https://chatgpt.com/');
    assert.equal(openOptions.active, true);
    assert.equal(openOptions.sourceClientId, 'selected-control-tab');
    assert.match(openOptions.launchToken, /^bridge-workflow-/);
    const sendOptions = calls[sendIndex][1];
    assert.equal(sendOptions.sourceClientId, freshClientId);
    assert.equal(sendOptions.sessionId, '');
    assert.equal(sendOptions.newSession, false);
    assert.equal(sendOptions.autoOpenTab, false);
    assert.deepEqual(sendOptions.attachments, ['project-snapshot-file', 'workflow-instructions']);
    assert.ok(calls.some((entry) => entry[0] === 'assumeProjectContext' && entry[2] === concreteSessionId));
    assert.equal(runtime.state.focusedWorkflowId, 'project-guided-task');
    assert.ok(transcript.some((entry) => entry.title === 'Workflow started'));
  } finally {
    if (previousDataDir == null) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    await fs.rm(root, { recursive: true, force: true });
  }
});
