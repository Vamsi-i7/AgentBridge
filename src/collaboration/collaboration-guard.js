import crypto from 'node:crypto';

/**
 * Collaboration Budgets & Loop Guard (Mission H.7)
 *
 * Enforces strict per-collaboration boundaries to prevent infinite loops,
 * runaway recursion, and token consumption spikes.
 *
 * Guarantees:
 * - Structured stop reasons with exact metrics (never generic crashes).
 * - Ping-pong cycle detection across agent hops (e.g. A -> B -> A -> B).
 * - Near-identical query repetition detection via normalized query fingerprinting.
 */

export const BudgetStopReason = Object.freeze({
  BUDGET_EXCEEDED_TOKENS: 'BUDGET_EXCEEDED_TOKENS',
  BUDGET_EXCEEDED_HOPS: 'BUDGET_EXCEEDED_HOPS',
  BUDGET_EXCEEDED_TIME: 'BUDGET_EXCEEDED_TIME',
  BUDGET_EXCEEDED_COST: 'BUDGET_EXCEEDED_COST',
  LOOP_DETECTED_PING_PONG: 'LOOP_DETECTED_PING_PONG',
  LOOP_DETECTED_REPEATED_QUERY: 'LOOP_DETECTED_REPEATED_QUERY'
});

export class CollaborationGuard {
  constructor(options = {}) {
    this.defaultMaxHops = options.maxHops || 10;
    this.defaultMaxTokens = options.maxTokens || 50000;
    this.defaultMaxDurationMs = options.maxDurationMs || 120000; // 2 minutes
    this.defaultMaxCost = options.maxCost || 1.00; // $1.00 estimated ceiling
    this.collaborations = new Map(); // collabId -> tracking record
  }

  /**
   * Initialize a collaboration budget tracker.
   */
  initCollaboration(collabId, limits = {}) {
    const record = {
      collabId,
      maxHops: limits.maxHops || this.defaultMaxHops,
      maxTokens: limits.maxTokens || this.defaultMaxTokens,
      maxDurationMs: limits.maxDurationMs || this.defaultMaxDurationMs,
      maxCost: limits.maxCost || this.defaultMaxCost,
      startedAt: Date.now(),
      hopsCount: 0,
      totalTokens: 0,
      estimatedCost: 0,
      agentSequence: [], // [agentA, agentB, agentA, ...]
      queryHashes: new Set()
    };
    this.collaborations.set(collabId, record);
    return record;
  }

  /**
   * Check before executing a hop. Fails fast with structured stop reason if budget or loop is violated.
   * @param {string} collabId
   * @param {string} fromAgent
   * @param {string} toAgent
   * @param {string} queryText
   * @param {number} [estimatedTokens=0]
   * @returns {{ allowed: boolean, stopReason?: string, details?: object }}
   */
  checkHop(collabId, fromAgent, toAgent, queryText = '', estimatedTokens = 0) {
    let record = this.collaborations.get(collabId);
    if (!record) {
      record = this.initCollaboration(collabId);
    }

    const elapsedMs = Date.now() - record.startedAt;

    // 1. Check Wall-Clock Time Budget
    if (elapsedMs > record.maxDurationMs) {
      return {
        allowed: false,
        stopReason: BudgetStopReason.BUDGET_EXCEEDED_TIME,
        details: { elapsedMs, maxDurationMs: record.maxDurationMs }
      };
    }

    // 2. Check Hop Count Budget
    if (record.hopsCount >= record.maxHops) {
      return {
        allowed: false,
        stopReason: BudgetStopReason.BUDGET_EXCEEDED_HOPS,
        details: { hopsCount: record.hopsCount, maxHops: record.maxHops }
      };
    }

    // 3. Check Token Budget
    if (record.totalTokens + estimatedTokens > record.maxTokens) {
      return {
        allowed: false,
        stopReason: BudgetStopReason.BUDGET_EXCEEDED_TOKENS,
        details: { currentTokens: record.totalTokens, addedTokens: estimatedTokens, maxTokens: record.maxTokens }
      };
    }

    // 4. Ping-Pong Loop Detection
    // Detect repeating alternating pair: A -> B -> A -> B
    const seq = record.agentSequence;
    if (seq.length >= 3) {
      const last = seq[seq.length - 1];
      const prev = seq[seq.length - 2];
      const prevPrev = seq[seq.length - 3];
      if (toAgent === prev && fromAgent === last && last === prevPrev) {
        return {
          allowed: false,
          stopReason: BudgetStopReason.LOOP_DETECTED_PING_PONG,
          details: { pattern: `${fromAgent} <-> ${toAgent}`, sequence: seq.concat(toAgent) }
        };
      }
    }

    // 5. Repeated Query Detection (normalized whitespace and lowercase hash)
    if (queryText && queryText.length > 20) {
      const normalized = queryText.toLowerCase().replace(/\s+/g, ' ').trim();
      const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
      if (record.queryHashes.has(hash)) {
        return {
          allowed: false,
          stopReason: BudgetStopReason.LOOP_DETECTED_REPEATED_QUERY,
          details: { querySnippet: queryText.slice(0, 100), hash }
        };
      }
      record.queryHashes.add(hash);
    }

    // Record hop intent
    record.hopsCount++;
    record.totalTokens += estimatedTokens;
    record.agentSequence.push(toAgent);

    return { allowed: true };
  }

  /**
   * Record actual token consumption and cost from turn result.
   */
  recordTurnUsage(collabId, tokensIn, tokensOut, costUsd = 0) {
    const record = this.collaborations.get(collabId);
    if (!record) return;
    record.totalTokens += (tokensIn + tokensOut);
    record.estimatedCost += costUsd;
  }
}
