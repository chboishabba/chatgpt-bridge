import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { MockChatGptStateMachine } from '../scripts/e2e/mock-chatgpt/state-machine.js';
import { MockExtensionTab } from '../scripts/e2e/mock-chatgpt/extension-client.js';

const fixtureUrl = new URL('./fixtures/e2e-real/artifact-materialization-e2e45.json', import.meta.url);

async function fixture() {
  return JSON.parse(await fs.readFile(fixtureUrl, 'utf8'));
}

test('mock artifact response matches the terminal shape captured by real E2E 45', async () => {
  const expected = await fixture();
  const marker = 'BRIDGE_E2E_MOCK_ARTIFACT_PARITY';
  const prompt = `Create and attach three separate downloadable files, not code blocks: parity.txt containing the single line ${marker}_ONE; parity.json containing valid JSON {"marker":"${marker}_TWO"}; and parity.csv containing the CSV rows key,value and marker,${marker}_THREE. Attach all three files in one response.`;
  const state = new MockChatGptStateMachine({ tabId: 451 });
  state.appendUser(prompt);
  await state.generate(prompt);
  const output = state.outputSnapshot();

  assert.equal(output.answer, expected.terminalOutput.answer);
  assert.deepEqual(output.progressItems.map((item) => item.kind), expected.terminalOutput.progressKinds);
  assert.deepEqual(output.progressItems.map((item) => item.state), expected.terminalOutput.progressStates);
  assert.equal(output.artifacts.length, expected.terminalOutput.artifactCount);
  assert.deepEqual(output.artifacts.map((item) => item.materializationSource), expected.artifacts.map((item) => item.materializationSource));
  assert.deepEqual(output.artifacts.map((item) => item.name.slice(item.name.lastIndexOf('.'))), expected.artifacts.map((item) => item.extension));
});

test('active mock tab can be visible while the browser window is unfocused', async () => {
  const expected = await fixture();
  const tab = new MockExtensionTab({
    bridgeUrl: 'http://127.0.0.1:1',
    tabId: 452,
    registry: {},
    active: true,
    focused: false,
  });
  const hello = tab.helloBody();
  const observation = tab.createObservation();
  assert.equal(hello.visibilityState, expected.tab.visibility);
  assert.equal(hello.focused, expected.tab.focused);
  assert.equal(observation.visibility, expected.tab.visibility);
  assert.equal(observation.focused, expected.tab.focused);
});
