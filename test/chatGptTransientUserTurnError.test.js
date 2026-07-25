import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createAssistantFixtureParser } from './helpers/offlineChatDom.js';

const root = new URL('./fixtures/chat-dom/captured/transient-user-turn-error/', import.meta.url);

test('captured ChatGPT user-turn error keeps prompt text separate and is retryable', async () => {
  const contract = JSON.parse(await fs.readFile(new URL('observation-contract.json', root), 'utf8'));
  const html = await fs.readFile(new URL(contract.source.html, root), 'utf8');
  const parser = await createAssistantFixtureParser();
  const parsed = parser.parseUserTurn(html);
  assert.equal(parsed.prompt, contract.expected.prompt);
  assert.equal(parsed.prompt.includes(contract.expected.errorText), false);
  assert.equal(parsed.error.hasError, true);
  assert.equal(parsed.error.text, contract.expected.errorText);
  assert.equal(parsed.error.code, contract.expected.errorCode);
  assert.equal(parsed.error.kind, contract.expected.errorKind);
  assert.equal(parsed.error.retryable, true);
  assert.equal(parsed.error.userTurnKey, contract.expected.userTurnKey);
});

test('request snapshot reports a submitted-user error without inventing an assistant turn', async () => {
  const contract = JSON.parse(await fs.readFile(new URL('observation-contract.json', root), 'utf8'));
  const html = await fs.readFile(new URL(contract.source.html, root), 'utf8');
  const parser = await createAssistantFixtureParser();
  const snapshot = parser.parseRequestWithoutAssistant(html, {
    submittedUserTurnKey: contract.expected.userTurnKey,
    options: {},
  });
  assert.equal(snapshot.answer, '');
  assert.equal(snapshot.hasError, true);
  assert.equal(snapshot.errorCode, contract.expected.errorCode);
  assert.equal(snapshot.errorRetryable, true);
  assert.equal(snapshot.errorUserTurnKey, contract.expected.userTurnKey);
  assert.equal(snapshot.reason, 'submitted_user_turn_error');
});

test('English ChatGPT user-turn transient error maps to the same typed retryable state', async () => {
  const contract = JSON.parse(await fs.readFile(new URL('observation-contract.json', root), 'utf8'));
  const captured = await fs.readFile(new URL(contract.source.html, root), 'utf8');
  const html = captured.replace(
    'Что-то пошло не так. Попробуйте еще раз.',
    'Something went wrong. Please try again.',
  );
  const parser = await createAssistantFixtureParser();
  const parsed = parser.parseUserTurn(html);
  assert.equal(parsed.prompt, contract.expected.prompt);
  assert.equal(parsed.error.text, 'Something went wrong. Please try again.');
  assert.equal(parsed.error.code, contract.expected.errorCode);
  assert.equal(parsed.error.kind, contract.expected.errorKind);
  assert.equal(parsed.error.retryable, true);
});
