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

test('composer steering refuses to synthesize Enter while ChatGPT exposes only the stop control', async () => {
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

  assert.throws(() => commands.submitComposer(composer, { requestId: 'steer-request' }, { kind: 'steer', attempt: 2 }), (error) => {
    assert.equal(error.code, 'STEER_SUBMIT_NOT_READY');
    assert.equal(error.provenNotExecuted, true);
    return true;
  });
  assert.equal(submitCount, 0);
  assert.equal(events.length, 0);
  assert.deepEqual(diagnostics.map((entry) => entry.name), ['send_button.not_found_steer_blocked']);
  assert.equal(diagnostics[0].data.kind, 'steer');
  assert.equal(diagnostics[0].data.attempt, 2);
});


test('composer steering waits for a real enabled send control before clicking once', async () => {
  const { sandbox } = await bootstrapExtensionContentRuntime();
  let delayCount = 0;
  let clickCount = 0;
  const sendButton = {
    disabled: false,
    isConnected: true,
    getAttribute(name) { return name === 'data-testid' ? 'send-button' : null; },
    click() { clickCount += 1; },
  };
  const stopButton = {
    disabled: false,
    isConnected: true,
    getAttribute(name) {
      if (name === 'data-testid') return 'stop-button';
      if (name === 'aria-label') return 'Stop generating';
      return null;
    },
  };
  const form = {
    tagName: 'FORM',
    matches() { return false; },
    closest() { return null; },
    querySelectorAll(selector) {
      if (selector.includes('send') || selector.includes('Send')) return delayCount >= 2 ? [sendButton] : [];
      if (selector.includes('stop') || selector.includes('Stop')) return delayCount < 2 ? [stopButton] : [];
      if (selector === 'button, [role="button"]') return delayCount >= 2 ? [sendButton] : [stopButton];
      return [];
    },
  };
  const composer = {
    tagName: 'DIV', isConnected: true, isContentEditable: true, disabled: false, readOnly: false,
    parentElement: form,
    getAttribute(name) { if (name === 'contenteditable') return 'plaintext-only'; if (name === 'id') return 'prompt-textarea'; return null; },
    closest(selector) { return selector === 'form' ? form : null; },
    querySelectorAll() { return []; },
  };
  sandbox.document.querySelectorAll = (selector) => selector.includes('#prompt-textarea[contenteditable]') ? [composer] : [];
  const diagnostics = [];
  const commands = sandbox.ChatGptComposerCommands.createComposerCommands(composerDependencies({
    CONFIG: { steerSubmitReadyTimeoutMs: 5_000 },
    async delay() { delayCount += 1; },
    diagnostic(name, data) { diagnostics.push({ name, data }); },
  }));

  const ready = await commands.waitForSteerSubmitButton({ requestId: 'steer-wait', options: {} });
  assert.equal(ready.button, sendButton);
  const method = commands.submitComposer(composer, { requestId: 'steer-wait' }, { kind: 'steer', button: ready.button });
  assert.equal(method, 'button');
  assert.equal(clickCount, 1);
  assert.equal(diagnostics.some((entry) => entry.name === 'steer.submit.waiting'), true);
  assert.equal(diagnostics.some((entry) => entry.name === 'steer.submit.ready'), true);
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
    CONFIG: { promptSubmitAckTimeoutMs: 4_000, steerSubmitAckTimeoutMs: 30_000, steerSubmitReadyTimeoutMs: 90_000 },
  }));
  assert.equal(commands.resolveSubmissionAckTimeoutMs({ options: {} }, 'prompt'), 4_000);
  assert.equal(commands.resolveSubmissionAckTimeoutMs({ options: {} }, 'steer'), 30_000);
  assert.equal(commands.resolveSubmissionAckTimeoutMs({ options: { promptSubmitAckTimeoutMs: 12_000 } }, 'steer'), 30_000);
  assert.equal(commands.resolveSubmissionAckTimeoutMs({ options: { steerSubmitAckTimeoutMs: 8_000 } }, 'steer'), 8_000);
});
