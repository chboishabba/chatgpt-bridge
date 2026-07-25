import { config } from '../../config.js';
import { makeEvent } from '../requestState.js';
import { createPromptResponseRetryPlan } from '../requestExecutionPlan.js';

/**
 * Owns bounded response-epoch retries after an exact, retryable ChatGPT
 * user-turn error. The retry stays inside the existing lease and conversation;
 * it never re-applies session routing or repeats an unconfirmed write.
 */
export class RequestResponseRetryCoordinator {
  constructor(owner) {
    if (!owner) throw new TypeError('RequestResponseRetryCoordinator requires an owner');
    this.owner = owner;
  }

  async execute(state, effect = {}) {
    const owner = this.owner;
    if (!owner.resumePrompt) throw new Error('Prompt response retry is unavailable');
    if (!state.promptPayload) throw new Error(`Request ${state.requestId} has no persisted prompt payload for retry`);

    const canonical = owner.requestState.store.get(state.requestId);
    const previousResponseEpoch = Math.max(
      0,
      Number(effect.data?.previousResponseEpoch ?? canonical?.response?.epoch) || 0,
    );
    const targetResponseEpoch = Math.max(
      0,
      Number(effect.data?.targetResponseEpoch ?? (previousResponseEpoch + 1)) || 0,
    );
    if (targetResponseEpoch !== previousResponseEpoch + 1
        || previousResponseEpoch !== Math.max(0, Number(canonical?.response?.epoch) || 0)) {
      const error = new Error(
        `Cannot retry response epoch ${previousResponseEpoch}->${targetResponseEpoch}; active epoch is ${canonical?.response?.epoch || 0}`,
      );
      error.code = 'PROMPT_RESPONSE_RETRY_EPOCH_MISMATCH';
      throw error;
    }

    const request = owner.requestIdentity(state, targetResponseEpoch);
    const executionPlan = createPromptResponseRetryPlan({
      request,
      message: String(state.promptPayload.message || ''),
      options: state.promptPayload.options || {},
      attachments: state.promptPayload.attachments || [],
    });
    const attempt = Math.max(1, Number(effect.data?.attempt) || 1);
    const payload = {
      ...state.promptPayload,
      requestId: state.requestId,
      leaseId: request.leaseId,
      ownerServerInstanceId: request.ownerServerInstanceId,
      responseEpoch: targetResponseEpoch,
      executionPlan,
      executionStepOnly: true,
      continuationOfEffectId: String(effect.id || ''),
      continuationReason: 'chatgpt_transient_error_retry',
      responseRetry: {
        attempt,
        previousResponseEpoch,
        targetResponseEpoch,
        failedUserTurnKey: String(effect.data?.failedUserTurnKey || ''),
        errorCode: String(effect.data?.errorCode || 'CHATGPT_TRANSIENT_REQUEST_ERROR'),
      },
    };

    state.promptPayload = payload;
    owner.emitRequestEvent(state, makeEvent('request.retry.dispatched', {
      requestId: state.requestId,
      attempt,
      previousResponseEpoch,
      targetResponseEpoch,
      failedUserTurnKey: payload.responseRetry.failedUserTurnKey,
      sourceClientId: state.clientId || '',
    }));

    return await owner.runRequestEffect(state, {
      id: effect.id,
      type: effect.type,
      data: effect.data || {},
      execute: async () => await owner.resumePrompt(
        state.clientId,
        payload,
        { timeoutMs: config.promptDeliveryTimeoutMs },
      ),
    });
  }

  emitScheduled(state, outcome) {
    const retryScheduled = outcome?.diagnostics?.find?.(
      (item) => item?.code === 'chatgpt_transient_error_retry_scheduled',
    );
    if (!retryScheduled) return;
    this.owner.emitRequestEvent(state, makeEvent('request.retry.scheduled', {
      requestId: state.requestId,
      ...(retryScheduled.data || {}),
    }), { canonical: false });
  }
}
