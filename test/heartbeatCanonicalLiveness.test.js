import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GenerationState,
  RequestDeadlineKind,
  RequestEventType,
  RequestLifecycle,
  SourceConnection,
  createRequestEvent,
} from '../src/bridge/state/requestEvents.js';
import { reduceRequestState } from '../src/bridge/state/requestMachine.js';
import { deadlineIntentsForRequest } from '../src/bridge/deadlines/requestDeadlinePolicy.js';

const options = {
  meaningfulProgressTimeoutMs: 120_000,
  postGenerationTimeoutMs: 60_000,
  hardLivenessTimeoutMs: 60_000,
  forcedSnapshotAfterMs: 90_000,
  forcedSnapshotCooldownMs: 60_000,
};

function reduce(state, event) {
  const result = reduceRequestState(state, event);
  assert.equal(result.accepted, true, JSON.stringify(result.diagnostics || []));
  return result.state;
}

test('healthy received heartbeat keeps a 30-minute active generation alive without laundering semantic progress', () => {
  const requestId = 'req-long-thinking';
  const createdAt = 1_000;
  const generationAt = createdAt + 5_000;
  const heartbeatReceivedAt = createdAt + 30 * 60_000;

  let state = reduce(null, createRequestEvent(
    RequestEventType.CREATED,
    requestId,
    {},
    { occurredAt: createdAt, receivedAt: createdAt },
  ));

  state = reduce(state, createRequestEvent(
    RequestEventType.SOURCE_BOUND,
    requestId,
    { clientId: 'tab-client', connection: SourceConnection.CONNECTED },
    { occurredAt: createdAt + 100, receivedAt: createdAt + 100 },
  ));

  state = reduce(state, createRequestEvent(
    RequestEventType.OBSERVATION_UPDATED,
    requestId,
    {
      clientId: 'tab-client',
      lifecycle: RequestLifecycle.GENERATING,
      generation: GenerationState.ACTIVE,
      meaningful: true,
    },
    { occurredAt: generationAt, receivedAt: generationAt },
  ));

  const semanticProgressAt = state.timestamps.meaningfulProgressAt;
  assert.equal(semanticProgressAt, generationAt);

  // Model a stale/untrusted source timestamp arriving through a healthy local
  // transport much later. Canonical liveness must use bridge receipt time.
  state = reduce(state, createRequestEvent(
    RequestEventType.HEARTBEAT,
    requestId,
    { clientId: 'tab-client' },
    { occurredAt: createdAt + 10_000, receivedAt: heartbeatReceivedAt },
  ));

  assert.equal(state.timestamps.heartbeatAt, heartbeatReceivedAt);
  assert.equal(state.timestamps.meaningfulProgressAt, semanticProgressAt);
  assert.equal(state.generation, GenerationState.ACTIVE);
  assert.equal(state.source.connection, SourceConnection.CONNECTED);

  const intents = deadlineIntentsForRequest(state, options);
  const hard = intents.find((item) => item.kind === RequestDeadlineKind.HARD_LIVENESS);

  assert.equal(intents.some((item) => item.kind === RequestDeadlineKind.PROGRESS_LIVENESS), false);
  assert.ok(intents.some((item) => item.kind === RequestDeadlineKind.FORCED_SNAPSHOT));
  assert.equal(hard?.dueAt, heartbeatReceivedAt + options.hardLivenessTimeoutMs);
});
