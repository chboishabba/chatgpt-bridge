import test from 'node:test';
import assert from 'node:assert/strict';
import { bootstrapExtensionContentRuntime } from './helpers/extensionContentRuntime.js';

function composerDependencies(overrides = {}) {
  return {
    CONFIG: {},
    conversationIdFromUrl() { return 'session'; },
    async delay() {},
    diagnostic() {},
    emitChatEvent() {},
    emitRequestProgress() {},
    getActiveRequest() { return null; },
    getTurnNodes() { return []; },
    isGenerating() { return false; },
    isPrimaryChatSurfaceElement() { return true; },
    isVisible() { return true; },
    normalizeComparable(value) { return String(value || '').trim(); },
    setRequestPhase() {},
    turnKey(_turn, index) { return `turn-${index}`; },
    turnRole() { return ''; },
    visibleText(node) { return String(node?.textContent || ''); },
    async waitForChatPageReady() {},
    ...overrides,
  };
}

test('composer submission uses the React keyboard path when an active steer has no send button', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime();
  let submitCount = 0;
  const events = [];
  const form = {
    tagName: 'FORM',
    matches() { return false; },
    querySelectorAll() { return []; },
    closest() { return null; },
    requestSubmit() { submitCount += 1; },
  };
  const composer = {
    tagName: 'DIV',
    disabled: false,
    readOnly: false,
    parentElement: form,
    getAttribute() { return null; },
    closest(selector) { return selector === 'form' ? form : null; },
    querySelectorAll() { return []; },
    dispatchEvent(event) { events.push(event); return true; },
  };
  sandbox.document.querySelectorAll = (selector) => selector.includes('#prompt-textarea[contenteditable]') ? [composer] : [];

  const diagnostics = [];
  const commands = sandbox.ChatGptComposerCommands.createComposerCommands(composerDependencies({
    diagnostic(name, data) { diagnostics.push({ name, data }); },
  }));

  const method = commands.submitComposer(composer, { requestId: 'steer-request' }, { kind: 'steer', attempt: 2 });
  assert.equal(method, 'keyboard_steer');
  assert.equal(submitCount, 0);
  assert.equal(events.length, 2);
  assert.deepEqual(diagnostics.map((entry) => entry.name), ['send_button.not_found_keyboard_steer_fallback']);
  assert.equal(diagnostics[0].data.kind, 'steer');
  assert.equal(diagnostics[0].data.attempt, 2);
});



test('modern plaintext-only composer and visible chat surface satisfy initial page readiness', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime();
  const hiddenMain = {
    nodeType: 1,
    tagName: 'MAIN',
    isConnected: true,
    hiddenForTest: true,
    contains() { return false; },
    querySelectorAll() { return []; },
    closest() { return null; },
    getAttribute() { return null; },
  };
  const visibleMain = {
    nodeType: 1,
    tagName: 'MAIN',
    isConnected: true,
    contains(node) { return node === composer; },
    querySelectorAll() { return []; },
    closest() { return null; },
    getAttribute() { return null; },
  };
  const composer = {
    nodeType: 1,
    tagName: 'DIV',
    isConnected: true,
    isContentEditable: true,
    disabled: false,
    readOnly: false,
    parentElement: visibleMain,
    getAttribute(name) {
      if (name === 'contenteditable') return 'plaintext-only';
      if (name === 'role') return 'textbox';
      if (name === 'id') return 'prompt-textarea';
      return null;
    },
    closest(selector) { return selector.includes('main') ? visibleMain : null; },
    querySelectorAll() { return []; },
  };
  sandbox.document.querySelectorAll = (selector) => {
    if (selector.includes('#prompt-textarea[contenteditable]')) return [composer];
    if (selector === 'main, [role="main"]') return [hiddenMain, visibleMain];
    return [];
  };

  const isVisible = (element) => element !== hiddenMain;
  const diagnostics = [];
  const commands = sandbox.ChatGptComposerCommands.createComposerCommands(composerDependencies({
    diagnostic(name, data) { diagnostics.push({ name, data }); },
    isVisible,
  }));
  assert.equal(commands.findComposer(), composer);
  assert.equal(commands.findChatMain(), visibleMain);

  const preparation = sandbox.ChatGptRequestPreparation.createRequestPreparation({
    CONFIG: { pageReadyTimeoutMs: 5_000, pageReadySettleMs: 150 },
    DOM_PARSER: {},
    INTELLIGENCE_UI_TIMING: {},
    async delay() {},
    diagnostic() {},
    emitChatEvent() {},
    findChatMain: commands.findChatMain,
    findComposer: commands.findComposer,
    isVisible,
    async openNewSession() {},
    async readIntelligenceState() { return null; },
    schedulePageStatus() {},
    async selectSessionById() {},
    send() {},
    async trySelectIntelligenceOption() { return null; },
  });
  const readiness = preparation.chatPageReadiness();
  assert.equal(readiness.ready, true);
  assert.equal(readiness.chatMainReady, true);
  assert.equal(readiness.composerReady, true);
  assert.equal(readiness.composer, composer);
  assert.equal(readiness.url, 'https://chatgpt.com/');
  assert.equal(diagnostics.some((entry) => entry.name === 'dom_schema.composer_ambiguous'), false);
});

test('turn lookup honors the recorded index and otherwise chooses the newest duplicate React key', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime();
  const turns = [
    { id: 'old', key: 'duplicate-key' },
    { id: 'middle', key: 'other-key' },
    { id: 'new', key: 'duplicate-key' },
  ];
  const commands = sandbox.ChatGptComposerCommands.createComposerCommands(composerDependencies({
    getTurnNodes() { return turns; },
    turnKey(turn) { return turn.key; },
  }));

  assert.equal(commands.findTurnByKey('duplicate-key', 0), turns[0]);
  assert.equal(commands.findTurnByKey('duplicate-key', 99), turns[2]);
  assert.equal(commands.findTurnByKey('duplicate-key'), turns[2]);
});

test('artifact source lookup forwards both the stored turn key and turn index', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime();
  const calls = [];
  const expected = { id: 'source-turn' };
  const transfer = sandbox.ChatGptArtifactTransfer.createArtifactTransfer({
    isBrowserOnlyArtifactUrl() { return false; },
    isCurrentPageNavigationUrl() { return false; },
    findTurnByKey(key, index) { calls.push({ key, index }); return expected; },
  });

  const root = transfer.artifactSourceRoot({ sourceTurnKey: 'duplicate-key', sourceTurnIndex: 17 });
  assert.equal(root, expected);
  assert.deepEqual(calls, [{ key: 'duplicate-key', index: 17 }]);
});


test('steer acknowledgement uses a longer bounded proof window than an ordinary prompt', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime();
  const commands = sandbox.ChatGptComposerCommands.createComposerCommands(composerDependencies({
    CONFIG: { promptSubmitAckTimeoutMs: 4_000, steerSubmitAckTimeoutMs: 10_000 },
  }));
  assert.equal(commands.resolveSubmissionAckTimeoutMs({ options: {} }, 'prompt'), 4_000);
  assert.equal(commands.resolveSubmissionAckTimeoutMs({ options: {} }, 'steer'), 10_000);
  assert.equal(commands.resolveSubmissionAckTimeoutMs({ options: { promptSubmitAckTimeoutMs: 12_000 } }, 'steer'), 12_000);
  assert.equal(commands.resolveSubmissionAckTimeoutMs({ options: { steerSubmitAckTimeoutMs: 8_000 } }, 'steer'), 8_000);
});
