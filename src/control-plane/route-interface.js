import { EventEmitter } from 'node:events';

/**
 * Standard Completion Evidence Tiers
 * Priority order:
 * 1. AUTHENTICATED_SUBMIT (bridge_submit_task_result with matching nonce/epoch)
 * 2. NETWORK_END_OF_STREAM (CDP / HTTP stream termination)
 * 3. INDICATOR_BASED (UI stop-generation element gone + idle)
 * 4. STABILITY_HEURISTIC (Stable-text fallback, marked low confidence)
 */
export const CompletionEvidenceTier = Object.freeze({
  AUTHENTICATED_SUBMIT: 'AUTHENTICATED_SUBMIT',
  NETWORK_END_OF_STREAM: 'NETWORK_END_OF_STREAM',
  INDICATOR_BASED: 'INDICATOR_BASED',
  STABILITY_HEURISTIC: 'STABILITY_HEURISTIC'
});

export const DeliveryStage = Object.freeze({
  REGISTERED: 'REGISTERED',
  CONNECTED: 'CONNECTED',
  READY: 'READY',
  CAPABLE: 'CAPABLE',
  FAILED: 'FAILED'
});

/**
 * Base Route Interface
 * All adapters (CLI process, CDP Chromium, AX Native, Stdio MCP) implement this interface.
 * Core routing selects routes via manifest data, capabilities, and proven evidence tier — NO agent-name branches.
 */
export class BaseRouteAdapter extends EventEmitter {
  constructor(routeId, options = {}) {
    super();
    this.routeId = routeId;
    this.options = options;
  }

  /**
   * Cheap route health/presence probe before delivery.
   * Fails fast if target is not ready, returning explicit stage and failure reason.
   * @returns {Promise<{ ready: boolean, stage: string, reason?: string, details?: object }>}
   */
  async probe() {
    throw new Error(`probe() not implemented on ${this.routeId}`);
  }

  /**
   * Dispatch request through this route without stealing window focus.
   * @param {object} request - { requestId, message, fromAgent, toAgent, taskId, nonce, epoch, attemptId }
   * @returns {Promise<{ accepted: boolean, routeId: string, details?: object }>}
   */
  async send(request) {
    throw new Error(`send() not implemented on ${this.routeId}`);
  }

  /**
   * Observe response stream, emitting partial deltas and exact completion evidence.
   * @param {object} request
   * @param {object} callbacks - { onChunk: (textDelta) => void, onComplete: (result) => void, onError: (err) => void }
   * @returns {{ cancel: () => Promise<void> }}
   */
  observe(request, callbacks = {}) {
    throw new Error(`observe() not implemented on ${this.routeId}`);
  }

  /**
   * Cancel in-flight generation / process tree / session.
   * @param {string} requestId
   * @returns {Promise<boolean>}
   */
  async cancel(requestId) {
    throw new Error(`cancel() not implemented on ${this.routeId}`);
  }

  /**
   * Capture telemetry / token usage reported by route.
   * @param {string} requestId
   * @returns {{ tokensIn: number, tokensOut: number, durationMs: number } | null}
   */
  usage(requestId) {
    return null;
  }
}
