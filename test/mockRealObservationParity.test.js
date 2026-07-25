import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { MockExtensionTab } from '../scripts/e2e/mock-chatgpt/extension-client.js';
import { MockChatGptStateMachine } from '../scripts/e2e/mock-chatgpt/state-machine.js';
import { renderMockChatPage } from '../scripts/e2e/mock-chatgpt/render.js';

const contractUrl = new URL('./fixtures/chat-dom/captured/quarantine-hidden-final/observation-contract.json', import.meta.url);

async function contract() {
  return JSON.parse(await fs.readFile(contractUrl, 'utf8'));
}

const hiddenLifecycleUrl = new URL('./fixtures/e2e-real/hidden-tab-submit-release-e2e46.json', import.meta.url);

async function hiddenLifecycleContract() {
  return JSON.parse(await fs.readFile(hiddenLifecycleUrl, 'utf8'));
}

test('inactive mock tabs reproduce the hidden final-observation contract recorded by real E2E', async () => {
  const recorded = await contract();
  const state = new MockChatGptStateMachine({ tabId: 404, origin: 'https://chatgpt.com' });
  const prompt = 'Acknowledge this request briefly. The exact wording is not part of the isolation test.';
  state.appendUser(prompt, { requestId: 'request-hidden', leaseId: 'lease-hidden', ownerServerInstanceId: 'server-hidden', responseEpoch: 0 });
  await state.generate(prompt);
  const tab = new MockExtensionTab({
    bridgeUrl: 'http://127.0.0.1:1',
    tabId: 404,
    active: false,
    state,
  });
  const observation = tab.createObservation();
  const expected = recorded.expected;
  assert.equal(observation.visibility, expected.visibility);
  assert.equal(observation.focused, expected.focused);
  assert.equal(observation.document.state, expected.documentState);
  assert.equal(observation.composer.state, expected.composerState);
  assert.equal(observation.turn.state, expected.turnState);
  assert.equal(observation.generation.state, expected.generationState);
  assert.equal(observation.output.state, expected.outputState);
  assert.equal(observation.output.actionBarVisible, expected.actionBarVisible);
  assert.equal(Boolean(observation.output.answer), expected.answerNonEmpty);
  assert.equal(observation.turn.userPrompt, prompt);
});

test('mock final response controls mirror the current live ChatGPT action-bar test IDs', async () => {
  const recorded = await contract();
  const state = new MockChatGptStateMachine({ tabId: 405 });
  state.appendUser('hello');
  await state.generate('hello');
  const html = renderMockChatPage(state.publicState());
  for (const testId of recorded.expected.responseActionTestIds) {
    assert.match(html, new RegExp(`data-testid=["']${testId}["']`));
  }
});

test('quarantine scenario validates client isolation instead of exact model wording', async () => {
  const source = await fs.readFile(new URL('../scripts/e2e/scenarios/quarantine.js', import.meta.url), 'utf8');
  assert.match(source, /response\.sourceClientId === safeClient\.id/);
  assert.match(source, /answer\.length > 0/);
  assert.doesNotMatch(source, /Reply exactly QSAFE|Unexpected quarantine isolation answer|normalizeAnswer\([^)]*\) ===/);
});

test('mock lifecycle retains a physical release interval after content clears the active request', async () => {
  const recorded = await hiddenLifecycleContract();
  const tab = new MockExtensionTab({
    bridgeUrl: 'http://127.0.0.1:1',
    tabId: 406,
    active: true,
    focused: false,
  });
  assert.equal(recorded.tab.visibility, 'hidden');
  assert.equal(recorded.tab.focused, false);
  assert.equal(recorded.promptSubmission.timerPollingOutcome, 'submission_ack_timeout');
  assert.equal(recorded.release.activeRequestClearedBeforeTerminal, true);
  assert.equal(recorded.release.terminalOutcome, 'quarantined');
  assert.ok(tab.releaseDelayMs > 0, 'the mock must not collapse content cleanup and physical lease release into one instant');
});
