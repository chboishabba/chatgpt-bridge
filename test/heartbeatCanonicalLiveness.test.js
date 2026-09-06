import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GenerationState,
  RequestDeadlineKind,
  SourceConnection,
} from '../src/bridge/state/requestEvents.js';
import { createInitialRequestState } from '../src/bridge/state/requestPolicy.js';
import { deadlineIntentsForRequest } from '../src/bridge/deadlines/requestDeadlinePolicy.js';

const options = {
  meaningfulProgressTimeoutMs: 120_000,
  postGenerationTimeoutMs: 60_000,
  hardLivenessTimeoutMs: 60_000,
  forcedSnapshotAfterMs: 90_000,
  forcedSnapshotCooldownMs: 60_000,
};

test('healthy heartbeat keeps a 30-minute active generation alive independently of meaningful progress age', () => {
  const createdAt = 1_000;
  const heartbeatAt = createdAt + 30 * 60_000;
  const base = createInitialRequestState({ requestId: 'req-long-thinking', at: createdAt });
  const state = {
    ...base,
    revision: 9,
    generation: GenerationState.ACTIVE,
    source: {
      ...base.source,
      clientId: 'tab-client',
      connection: SourceConnection.CONNECTED,
    },
    timestamps: {
      ...base.timestamps,
      meaningfulProgressAt: createdAt,
      heartbeatAt,
    },
  };

  const intents = deadlineIntentsForRequest(state, options);
  const hard = intents.find((item) => item.kind === RequestDeadlineKind.HARD_LIVENESS);

  assert.equal(intents.some((item) => item.kind === RequestDeadlineKind.PROGRESS_LIVENESS), false);
  assert.ok(intents.some((item) => item.kind === RequestDeadlineKind.FORCED_SNAPSHOT));
  assert.equal(hard?.dueAt, heartbeatAt + options.hardLivenessTimeoutMs);
});
