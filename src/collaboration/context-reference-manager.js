import { ContextCache } from '../artifacts/context-cache.js';
import { ContentAddressedStore } from '../artifacts/content-addressed-store.js';

/**
 * Context Reference & Delta Passing Manager (Mission H.2)
 *
 * Replaces repetitive full-file/full-document transmissions across agent hops:
 * - Turn 1: Stores immutable document/file in CAS and establishes base context reference.
 * - Turn 2+: Emits only lightweight line deltas (+/-) or compact reference tokens.
 *
 * Savings:
 * For multi-hop review of a 10KB file, saves ~2,500 tokens on EVERY hop after the first.
 */
export class ContextReferenceManager {
  constructor(options = {}) {
    this.contextCache = options.contextCache || new ContextCache(options.logger || null);
    this.cas = options.casStore || new ContentAddressedStore();
    this.agentContextState = new Map(); // agentId:fileKey -> { lastRef, lastContent }
  }

  /**
   * Prepare payload for dispatch to an agent:
   * Returns compact delta if the agent has already received a prior version of this context,
   * otherwise stores the base and sends full content with context reference.
   *
   * @param {string} agentId - Target agent receiving the payload
   * @param {string} contextKey - Logical identifier (e.g. filename or document ID)
   * @param {string} content - Current content
   * @returns {{ payload: string, isDelta: boolean, contextRef: string, tokensSavedEstimate: number }}
   */
  prepareContextPayload(agentId, contextKey, content) {
    if (!content || typeof content !== 'string') {
      return { payload: content, isDelta: false, contextRef: null, tokensSavedEstimate: 0 };
    }

    const stateKey = `${agentId}:${contextKey}`;
    const previous = this.agentContextState.get(stateKey);

    if (previous && previous.lastContent) {
      // Compute delta against what this agent previously saw
      const deltaResult = this.contextCache.computeDelta(previous.lastContent, content);
      if (deltaResult.identical) {
        return {
          payload: `[CONTEXT-UNCHANGED key=${contextKey} ref=${previous.lastRef}]`,
          isDelta: true,
          contextRef: previous.lastRef,
          tokensSavedEstimate: Math.max(1, Math.ceil(content.length / 4) - 5)
        };
      }

      // If delta is much smaller than full content, send delta
      const deltaText = `[CONTEXT-DELTA key=${contextKey} base=${previous.lastRef} +${deltaResult.linesAdded} -${deltaResult.linesRemoved}]\n` +
        deltaResult.diffLines.slice(0, 100).join('\n');

      if (deltaText.length < content.length * 0.7) {
        const storedNew = this.cas.store(content);
        const refStr = storedNew.hash ? `ref:${storedNew.hash}` : (storedNew.ref || 'none');
        this.agentContextState.set(stateKey, { lastRef: refStr, lastContent: content });
        return {
          payload: deltaText,
          isDelta: true,
          contextRef: refStr,
          tokensSavedEstimate: Math.max(0, Math.ceil((content.length - deltaText.length) / 4))
        };
      }
    }

    // First time or delta is large: store in CAS and send with reference header
    const stored = this.cas.store(content);
    const refStr = stored.hash ? `ref:${stored.hash}` : (stored.ref || 'none');
    this.agentContextState.set(stateKey, { lastRef: refStr, lastContent: content });

    return {
      payload: `[CONTEXT-BASE key=${contextKey} ref=${refStr}]\n${content}`,
      isDelta: false,
      contextRef: refStr,
      tokensSavedEstimate: 0
    };
  }

  /**
   * Reset context state (e.g. when session ends).
   */
  clear(agentId = null) {
    if (agentId) {
      for (const key of Array.from(this.agentContextState.keys())) {
        if (key.startsWith(`${agentId}:`)) this.agentContextState.delete(key);
      }
    } else {
      this.agentContextState.clear();
    }
  }
}
