// Safe in-lease retry proof for explicit ChatGPT submission failures.
// Loaded before requestPromptCommands.js.
(() => {
  'use strict';

  function createRequestResponseRetry(deps = {}) {
    const { diagnostic, getAssistantNodes, getTurnNodes, readSubmittedUserTurnError, settleEffectCommandWithoutExecution, simpleHash, turnKey } = deps;

    function prepare(activeRequest, payload, context = {}) {
      const retry = payload?.responseRetry && typeof payload.responseRetry === 'object'
        ? payload.responseRetry
        : null;
      const currentStepKind = String(context.currentStepKind || '');
      const startAtIndex = Number(context.startAtIndex);
      const applies = Boolean(activeRequest && retry && payload.executionStepOnly === true
        && currentStepKind === 'page.ready.initial' && startAtIndex === 0);
      if (!applies) return { applies: false, accepted: false, retry: null };

      const previousResponseEpoch = Math.max(0, Number(retry.previousResponseEpoch) || 0);
      const targetResponseEpoch = Math.max(0, Number(retry.targetResponseEpoch) || 0);
      const failedUserTurnKey = String(retry.failedUserTurnKey || '');
      const exactError = readSubmittedUserTurnError(activeRequest);
      const evidence = {
        previousResponseEpoch,
        activeResponseEpoch: Math.max(0, Number(activeRequest.responseEpoch) || 0),
        targetResponseEpoch,
        failedUserTurnKey,
        activeSubmittedUserTurnKey: String(activeRequest.submittedUserTurnKey || ''),
        observedErrorCode: String(exactError?.code || ''),
      };
      const accepted = previousResponseEpoch === evidence.activeResponseEpoch
        && targetResponseEpoch === previousResponseEpoch + 1
        && Number(payload.responseEpoch) === targetResponseEpoch
        && failedUserTurnKey
        && failedUserTurnKey === evidence.activeSubmittedUserTurnKey
        && exactError?.retryable === true
        && exactError?.code === 'CHATGPT_TRANSIENT_REQUEST_ERROR'
        && String(exactError.userTurnKey || '') === failedUserTurnKey;
      if (!accepted) return { applies: true, accepted: false, retry, evidence };

      activeRequest.update('request.identity_updated', { commandId: String(context.commandId || '') });
      activeRequest.update('request.anchor_updated', {
        responseEpoch: targetResponseEpoch,
        baselineAssistantCount: getAssistantNodes().length,
        baselineTurnKeys: new Set(getTurnNodes().map((turn, index) => turnKey(turn, index)).filter(Boolean)),
        turnBaselineReady: false,
        turnCaptureArmed: false,
        promptSubmissionStartedAt: 0,
        submittedUserTurnKey: '',
        submittedUserTurnIndex: -1,
        submittedUserTurnLogged: false,
        assistantTurnKey: '',
        assistantTurnIndex: -1,
        pendingSubmittedTurnBaseline: null,
        pendingSubmittedTurnKind: '',
        pendingSubmittedTurnExpectedText: '',
        promptHash: simpleHash(String(context.message || '')),
        promptPreview: String(context.message || '').slice(0, 160),
        sentAt: 0,
      });
      activeRequest.update('request.executor_updated', { phase: 'response_retry_preparing', recovering: false });
      activeRequest.update('request.diagnostic_updated', {
        lastUserTurnMismatchSignature: '', assistantTurnLogged: false,
        assistantTurnMissingLogged: false, assistantTurnMissingSince: 0,
      });
      return {
        applies: true,
        accepted: true,
        retry,
        evidence,
        retryAttempt: Math.max(1, Number(retry.attempt) || 1),
      };
    }

    async function prepareCommand(activeRequest, payload, context = {}) {
      const result = prepare(activeRequest, payload, context);
      if (!result.applies || result.accepted) return result;
      const error = Object.assign(new Error('ChatGPT response retry preconditions are no longer proven by the submitted user turn'), {
        code: 'PROMPT_RESPONSE_RETRY_PRECONDITION_FAILED', provenNotExecuted: true,
        cancellationEvidence: { source: 'content_response_retry_precondition', ...result.evidence },
      });
      await settleEffectCommandWithoutExecution(payload, context.currentStepKind, context.currentStep, error, {
        request: activeRequest, evidence: error.cancellationEvidence,
      });
      diagnostic('prompt.response_retry.precondition_failed', {
        requestId: String(context.requestId || ''), commandId: String(context.commandId || ''), ...error.cancellationEvidence,
      });
      return { ...result, rejected: true };
    }

    return Object.freeze({ prepare, prepareCommand });
  }

  globalThis.ChatGptRequestResponseRetry = Object.freeze({ createRequestResponseRetry });
})();
