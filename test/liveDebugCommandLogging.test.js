import test from 'node:test';
import assert from 'node:assert/strict';
import { mapLiveDebugEvent } from '../scripts/e2e/live-debug.js';

test('real E2E command acceptance logs identify the command and effect', () => {
  const mapped = mapLiveDebugEvent({
    type: 'command.accepted',
    requestId: 'turn-command-log',
    data: {
      name: 'command.accepted',
      commandId: 'command-log-1',
      commandType: 'prompt.send',
      commandMode: 'effect',
      commandScope: 'request',
      effectType: 'page.ready.initial',
    },
  });
  assert.deepEqual(mapped, ['info', 'browser:mand-log', 'Browser accepted command', {
    request: 'turn-command-log',
    command: 'prompt.send',
    effect: 'page.ready.initial',
    mode: 'effect',
    scope: 'request',
    commandId: 'command-log-1',
  }]);
});
