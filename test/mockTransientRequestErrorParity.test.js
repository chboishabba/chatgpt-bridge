import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { MockChatGptStateMachine } from '../scripts/e2e/mock-chatgpt/state-machine.js';
import { renderMockChatPage } from '../scripts/e2e/mock-chatgpt/render.js';
import { createAssistantFixtureParser } from './helpers/offlineChatDom.js';

const fixtureRoot = new URL('./fixtures/chat-dom/captured/transient-user-turn-error/', import.meta.url);

test('mock user-turn transient error matches the reviewed real DOM contract', async () => {
  const contract = JSON.parse(await fs.readFile(new URL('observation-contract.json', fixtureRoot), 'utf8'));
  const state = new MockChatGptStateMachine({ tabId: 7, origin: 'https://chatgpt.com' });
  const userKey = state.appendUser(contract.expected.prompt, {
    requestId: 'retry-parity',
    leaseId: 'lease-parity',
    ownerServerInstanceId: 'server-parity',
    responseEpoch: 0,
  });
  const userTurn = state.turns.find((turn) => turn.key === userKey);
  userTurn.errorText = contract.expected.errorText;
  userTurn.errorCode = contract.expected.errorCode;
  userTurn.errorKind = contract.expected.errorKind;
  userTurn.errorRetryable = true;
  const html = renderMockChatPage(state.publicState());
  const parser = await createAssistantFixtureParser();
  const parsed = parser.parseUserTurn(html);
  assert.equal(parsed.prompt, contract.expected.prompt);
  assert.equal(parsed.error.text, contract.expected.errorText);
  assert.equal(parsed.error.code, contract.expected.errorCode);
  assert.equal(parsed.error.retryable, true);
  assert.equal(parsed.error.userTurnKey, userKey);
});
