import { EventEmitter } from 'node:events';

/**
 * Standard Completion Evidence Tiers (Mission 4: Honest Completion Tiers)
 * Strict confidence ordering:
 * 1. AUTHENTICATED_SUBMIT: Only via bridge_submit_task_result with matching nonce, attempt and epoch
 * 2. NETWORK_END_OF_STREAM: CDP or HTTP transport-level stream closed cleanly
 * 3. PROCESS_EXIT: Headless CLI process exited with status code 0
 * 4. A2A_COMPLETION: Agent2Agent protocol task completion handshake confirmed
 * 5. UI_STOP_IDLE: Desktop UI stop-generation element disappeared and composer returned to idle
 * 6. STABILITY_HEURISTIC: Polled response text stabilized over consecutive intervals (LOW confidence, always visible)
 */
export const CompletionEvidenceTier = Object.freeze({
  AUTHENTICATED_SUBMIT: 'AUTHENTICATED_SUBMIT',
  NETWORK_END_OF_STREAM: 'NETWORK_END_OF_STREAM',
  PROCESS_EXIT: 'PROCESS_EXIT',
  A2A_COMPLETION: 'A2A_COMPLETION',
  UI_STOP_IDLE: 'UI_STOP_IDLE',
  STABILITY_HEURISTIC: 'STABILITY_HEURISTIC',
  // Backward-compatibility aliases
  INDICATOR_BASED: 'UI_STOP_IDLE',
  MCP_AUTHENTICATED_SUBMIT: 'AUTHENTICATED_SUBMIT'
});

export const CompletionTierConfidence = Object.freeze({
  AUTHENTICATED_SUBMIT: { confidence: 'high', score: 1.0, description: 'Cryptographic V2 nonce and epoch verified' },
  NETWORK_END_OF_STREAM: { confidence: 'high', score: 0.9, description: 'CDP/HTTP transport stream ended' },
  PROCESS_EXIT: { confidence: 'medium', score: 0.8, description: 'CLI process exited with code 0' },
  A2A_COMPLETION: { confidence: 'high', score: 0.85, description: 'A2A protocol completion handshake' },
  UI_STOP_IDLE: { confidence: 'medium', score: 0.7, description: 'UI stop-indicator disappeared & composer idle' },
  STABILITY_HEURISTIC: { confidence: 'low', score: 0.3, description: 'Response text stabilized (heuristic fallback)' }
});

export function getCompletionConfidence(tier) {
  const norm = tier === 'INDICATOR_BASED' ? 'UI_STOP_IDLE' : (tier === 'MCP_AUTHENTICATED_SUBMIT' ? 'AUTHENTICATED_SUBMIT' : tier);
  return CompletionTierConfidence[norm] || { confidence: 'low', score: 0.1, description: 'Unclassified evidence' };
}

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
