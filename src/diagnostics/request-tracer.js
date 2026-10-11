import { performance } from 'node:perf_hooks';

/**
 * Request life cycle stages.
 *
 * These mirror the end-to-end path a correlated request travels:
 * caller -> bridge -> worker -> provider -> result -> caller.
 * Every stage is recorded with BOTH a wall-clock timestamp (for persisted,
 * cross-process diagnostics) and a monotonic millisecond reading (for reliable
 * duration deltas that are immune to clock adjustments).
 */
export const LifecycleStage = Object.freeze({
  // Canonical Ledger Stages
  ACCEPTED: 'ACCEPTED',
  CLAIMED: 'CLAIMED',
  DELIVERED: 'DELIVERED',
  FIRST_RESPONSE_BYTE: 'FIRST_RESPONSE_BYTE',
  COMPLETION_OBSERVED: 'COMPLETION_OBSERVED',
  COMMITTED: 'COMMITTED',
  NOTIFIED: 'NOTIFIED',
  RETRIEVED: 'RETRIEVED',
  TIMEOUT: 'TIMEOUT',
  FAILED: 'FAILED',

  // Existing Granular Stages (maintained for backward compatibility)
  REQUEST_CREATED: 'REQUEST_CREATED',
  TASK_CREATED: 'TASK_CREATED',
  WORKER_AWAKENED: 'WORKER_AWAKENED',
  TASK_CLAIMED: 'TASK_CLAIMED',
  PROVIDER_SUBMITTED: 'PROVIDER_SUBMITTED',
  PROVIDER_UNCONFIRMED: 'PROVIDER_UNCONFIRMED',
  PROGRESS_AVAILABLE: 'PROGRESS_AVAILABLE',
  PROVIDER_RESPONSE_OBSERVED: 'PROVIDER_RESPONSE_OBSERVED',
  PROVIDER_RESPONSE_COMPLETED: 'PROVIDER_RESPONSE_COMPLETED',
  RESULT_PERSISTED: 'RESULT_PERSISTED',
  COMPLETION_EVENT_COMMITTED: 'COMPLETION_EVENT_COMMITTED',
  WAITER_RESOLVED: 'WAITER_RESOLVED',
  RESPONSE_RETURNED: 'RESPONSE_RETURNED',
  DELIVERY_ACKNOWLEDGED: 'DELIVERY_ACKNOWLEDGED'
});

/**
 * RequestTracer
 *
 * Minimal, additive observability layer. It never influences control flow: a
 * failure to record a stage must never change delivery semantics, so every DB
 * write is best-effort and swallowed.
 *
 * It records stage transitions, monotonic timings, and lightweight ledger metrics.
 * Prompts and response bodies are NEVER written here.
 */
export class RequestTracer {
  constructor(auditLogger, options = {}) {
    this.logger = auditLogger;
    this.db = auditLogger?.db || options.db || null;
    this.enabled = options.enabled !== false && Boolean(this.db);
    if (this.enabled) {
      try {
        this.initTables();
      } catch {
        this.enabled = false;
      }
    }
  }

  initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS request_lifecycle (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        task_id TEXT,
        attempt_id TEXT,
        agent_id TEXT,
        route_id TEXT,
        wall_clock TEXT NOT NULL,
        monotonic_ms REAL NOT NULL,
        meta TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_request_lifecycle_req ON request_lifecycle(request_id, id);
      CREATE INDEX IF NOT EXISTS idx_request_lifecycle_wall ON request_lifecycle(wall_clock);

      CREATE TABLE IF NOT EXISTS request_ledgers (
        request_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        from_agent TEXT,
        to_agent TEXT,
        accepted_at TEXT,
        claimed_at TEXT,
        delivered_at TEXT,
        delivery_evidence TEXT,
        first_byte_at TEXT,
        completed_stage_at TEXT,
        completion_evidence TEXT,
        completion_type TEXT,
        committed_at TEXT,
        notified_at TEXT,
        retrieved_at TEXT,
        failure_stage TEXT,
        tokens_in INTEGER DEFAULT 0,
        tokens_out INTEGER DEFAULT 0,
        tool_schema_overhead_tokens INTEGER DEFAULT 0,
        body_size_bytes INTEGER DEFAULT 0,
        retry_count INTEGER DEFAULT 0,
        total_duration_ms REAL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_request_ledgers_status ON request_ledgers(status);
    `);
  }

  /**
   * Record a lifecycle stage. Best-effort and non-throwing.
   * @returns {{requestId:string,stage:string,wallClock:string,monotonicMs:number}|null}
   */
  mark({ requestId, stage, taskId = null, attemptId = null, agentId = null, routeId = null, meta = null }) {
    if (!this.enabled || !requestId || !stage) return null;

    const wallClock = new Date().toISOString();
    const monotonicMs = performance.now();

    try {
      this.db.prepare(`
        INSERT INTO request_lifecycle (
          request_id, stage, task_id, attempt_id, agent_id, route_id, wall_clock, monotonic_ms, meta
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        requestId,
        stage,
        taskId,
        attemptId,
        agentId,
        routeId,
        wallClock,
        monotonicMs,
        meta === null || meta === undefined
          ? null
          : (typeof meta === 'string' ? meta : JSON.stringify(meta))
      );

      this._updateLedger(requestId, stage, wallClock, monotonicMs, { taskId, attemptId, agentId, routeId, meta });
    } catch {
      // Observability must never break delivery.
      return null;
    }

    return { requestId, stage, wallClock, monotonicMs };
  }

  _updateLedger(requestId, stage, wallClock, monotonicMs, { taskId, attemptId, agentId, routeId, meta }) {
    if (!this.enabled || !this.db) return;
    try {
      const metaObj = meta && typeof meta === 'object'
        ? meta
        : (typeof meta === 'string' ? (() => { try { return JSON.parse(meta); } catch { return {}; } })() : {});

      const existing = this.db.prepare('SELECT * FROM request_ledgers WHERE request_id = ?').get(requestId);
      const isAccepted = stage === LifecycleStage.REQUEST_CREATED || stage === LifecycleStage.ACCEPTED || stage === LifecycleStage.TASK_CREATED;
      const isClaimed = stage === LifecycleStage.TASK_CLAIMED || stage === LifecycleStage.CLAIMED;
      const isDelivered = stage === LifecycleStage.PROVIDER_SUBMITTED || stage === LifecycleStage.DELIVERED;
      const isFirstByte = stage === LifecycleStage.PROGRESS_AVAILABLE || stage === LifecycleStage.FIRST_RESPONSE_BYTE;
      const isCompletedStage = stage === LifecycleStage.PROVIDER_RESPONSE_COMPLETED || stage === LifecycleStage.COMPLETION_OBSERVED;
      const isCommitted = stage === LifecycleStage.RESULT_PERSISTED || stage === LifecycleStage.COMMITTED;
      const isNotified = stage === LifecycleStage.COMPLETION_EVENT_COMMITTED || stage === LifecycleStage.WAITER_RESOLVED || stage === LifecycleStage.NOTIFIED;
      const isRetrieved = stage === LifecycleStage.RESPONSE_RETURNED || stage === LifecycleStage.DELIVERY_ACKNOWLEDGED || stage === LifecycleStage.RETRIEVED;
      const isTimeout = stage === LifecycleStage.TIMEOUT;
      const isFailed = stage === LifecycleStage.FAILED || stage === LifecycleStage.PROVIDER_UNCONFIRMED;

      if (!existing) {
        let initialStatus = 'accepted';
        if (isTimeout) initialStatus = 'timeout';
        else if (isFailed) initialStatus = 'failed';
        else if (isClaimed) initialStatus = 'claimed';
        else if (isDelivered) initialStatus = 'delivered';

        this.db.prepare(`
          INSERT INTO request_ledgers (
            request_id, status, from_agent, to_agent,
            accepted_at, claimed_at, delivered_at, delivery_evidence,
            first_byte_at, completed_stage_at, completion_evidence, completion_type,
            committed_at, notified_at, retrieved_at, failure_stage,
            tokens_in, tokens_out, tool_schema_overhead_tokens, body_size_bytes, retry_count,
            total_duration_ms, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          requestId,
          initialStatus,
          metaObj.fromAgent || (isAccepted ? metaObj.fromAgent : null) || null,
          metaObj.toAgent || agentId || null,
          wallClock,
          isClaimed ? wallClock : null,
          isDelivered ? wallClock : null,
          isDelivered ? (metaObj.deliveryEvidence || routeId || 'direct') : null,
          isFirstByte ? wallClock : null,
          isCompletedStage || isCommitted ? wallClock : null,
          isCompletedStage || isCommitted ? (metaObj.completionEvidence || (isCommitted ? 'mcp_submit' : null)) : null,
          isCompletedStage || isCommitted ? (metaObj.completionType || (isCommitted ? 'submit_task_result' : null)) : null,
          isCommitted ? wallClock : null,
          isNotified ? wallClock : null,
          isRetrieved ? wallClock : null,
          isTimeout || isFailed ? (metaObj.failureStage || stage) : null,
          metaObj.tokensIn || 0,
          metaObj.tokensOut || 0,
          metaObj.toolSchemaOverheadTokens || 0,
          metaObj.bodySizeBytes || 0,
          metaObj.retryCount || 0,
          0,
          wallClock,
          wallClock
        );
      } else {
        let newStatus = existing.status;
        let failureStage = existing.failure_stage;

        if (isTimeout) {
          newStatus = 'timeout';
          failureStage = metaObj.failureStage || this._deriveFailureStage(existing, stage);
        } else if (isFailed) {
          newStatus = 'failed';
          failureStage = metaObj.failureStage || this._deriveFailureStage(existing, stage);
        } else if (isRetrieved) {
          newStatus = 'completed';
        } else if (isCommitted && existing.status !== 'completed') {
          newStatus = 'committed';
        } else if (isCompletedStage && existing.status !== 'completed') {
          newStatus = 'completed_observed';
        } else if (isDelivered && existing.status === 'claimed') {
          newStatus = 'delivered';
        } else if (isClaimed && existing.status === 'accepted') {
          newStatus = 'claimed';
        }

        const tokensIn = metaObj.tokensIn || existing.tokens_in;
        const tokensOut = metaObj.tokensOut || existing.tokens_out;
        const bodySizeBytes = metaObj.bodySizeBytes || existing.body_size_bytes;
        const toolOverhead = metaObj.toolSchemaOverheadTokens || existing.tool_schema_overhead_tokens;
        const retries = metaObj.retryCount !== undefined ? metaObj.retryCount : existing.retry_count;

        this.db.prepare(`
          UPDATE request_ledgers SET
            status = ?,
            to_agent = COALESCE(to_agent, ?),
            from_agent = COALESCE(from_agent, ?),
            claimed_at = COALESCE(claimed_at, ?),
            delivered_at = COALESCE(delivered_at, ?),
            delivery_evidence = COALESCE(delivery_evidence, ?),
            first_byte_at = COALESCE(first_byte_at, ?),
            completed_stage_at = COALESCE(completed_stage_at, ?),
            completion_evidence = COALESCE(completion_evidence, ?),
            completion_type = COALESCE(completion_type, ?),
            committed_at = COALESCE(committed_at, ?),
            notified_at = COALESCE(notified_at, ?),
            retrieved_at = COALESCE(retrieved_at, ?),
            failure_stage = ?,
            tokens_in = ?,
            tokens_out = ?,
            tool_schema_overhead_tokens = ?,
            body_size_bytes = ?,
            retry_count = ?,
            updated_at = ?
          WHERE request_id = ?
        `).run(
          newStatus,
          metaObj.toAgent || agentId || null,
          metaObj.fromAgent || null,
          isClaimed ? wallClock : null,
          isDelivered ? wallClock : null,
          isDelivered ? (metaObj.deliveryEvidence || routeId || 'direct') : null,
          isFirstByte ? wallClock : null,
          isCompletedStage || isCommitted ? wallClock : null,
          isCompletedStage || isCommitted ? (metaObj.completionEvidence || (isCommitted ? 'mcp_submit' : null)) : null,
          isCompletedStage || isCommitted ? (metaObj.completionType || (isCommitted ? 'submit_task_result' : null)) : null,
          isCommitted ? wallClock : null,
          isNotified ? wallClock : null,
          isRetrieved ? wallClock : null,
          failureStage,
          tokensIn,
          tokensOut,
          toolOverhead,
          bodySizeBytes,
          retries,
          wallClock,
          requestId
        );
      }
    } catch {
      // Best-effort non-throwing
    }
  }

  _deriveFailureStage(existing, finalStage) {
    if (existing.delivered_at && !existing.first_byte_at) {
      return 'DELIVERED (stopped after delivery to recipient; no first response byte received)';
    }
    if (existing.first_byte_at && !existing.completed_stage_at) {
      return 'FIRST_RESPONSE_BYTE (response streaming stalled before turn completion)';
    }
    if (existing.claimed_at && !existing.delivered_at) {
      return 'CLAIMED (claimed by worker but dispatch did not confirm delivery)';
    }
    if (existing.accepted_at && !existing.claimed_at) {
      return 'ACCEPTED (task queued in mailbox but remained unclaimed)';
    }
    if (existing.completed_stage_at && !existing.committed_at) {
      return 'COMPLETION_OBSERVED (observed model completion but commit failed)';
    }
    return finalStage || 'UNKNOWN';
  }

  /**
   * Synthesize full lightweight per-request ledger.
   * @param {string} requestId
   * @returns {object|null}
   */
  getLedger(requestId) {
    if (!this.enabled || !requestId) return null;
    try {
      const row = this.db.prepare('SELECT * FROM request_ledgers WHERE request_id = ?').get(requestId);
      if (!row) return null;

      const timeline = this.getStageDurations(requestId);
      const firstMono = timeline.stages.length > 0 ? timeline.stages[0].monotonicMs : 0;

      const findStageDelta = (stageNames) => {
        const found = timeline.stages.find(s => stageNames.includes(s.stage));
        return found ? Number((found.monotonicMs - firstMono).toFixed(2)) : null;
      };

      return {
        requestId: row.request_id,
        status: row.status,
        fromAgent: row.from_agent,
        toAgent: row.to_agent,
        failureStage: row.failure_stage,
        stageTimestamps: {
          accepted: row.accepted_at ? { timestamp: row.accepted_at, deltaMs: 0 } : null,
          claimed: row.claimed_at ? { timestamp: row.claimed_at, deltaMs: findStageDelta(['TASK_CLAIMED', 'CLAIMED']) } : null,
          delivered: row.delivered_at ? { timestamp: row.delivered_at, deltaMs: findStageDelta(['PROVIDER_SUBMITTED', 'DELIVERED']), evidence: row.delivery_evidence } : null,
          firstResponseByte: row.first_byte_at ? { timestamp: row.first_byte_at, deltaMs: findStageDelta(['PROGRESS_AVAILABLE', 'FIRST_RESPONSE_BYTE']) } : null,
          completion: row.completed_stage_at ? { timestamp: row.completed_stage_at, deltaMs: findStageDelta(['PROVIDER_RESPONSE_COMPLETED', 'COMPLETION_OBSERVED', 'RESULT_PERSISTED', 'COMMITTED']), type: row.completion_type, evidence: row.completion_evidence } : null,
          committed: row.committed_at ? { timestamp: row.committed_at, deltaMs: findStageDelta(['RESULT_PERSISTED', 'COMMITTED']) } : null,
          notified: row.notified_at ? { timestamp: row.notified_at, deltaMs: findStageDelta(['COMPLETION_EVENT_COMMITTED', 'WAITER_RESOLVED', 'NOTIFIED']) } : null,
          retrieved: row.retrieved_at ? { timestamp: row.retrieved_at, deltaMs: findStageDelta(['RESPONSE_RETURNED', 'DELIVERY_ACKNOWLEDGED', 'RETRIEVED']) } : null
        },
        metrics: {
          tokensIn: row.tokens_in || 0,
          tokensOut: row.tokens_out || 0,
          toolSchemaOverheadTokens: row.tool_schema_overhead_tokens || 0,
          bodySizeBytes: row.body_size_bytes || 0,
          retryCount: row.retry_count || 0,
          totalDurationMs: timeline.totalMs ? Number(timeline.totalMs.toFixed(2)) : 0
        },
        timeline: timeline.stages
      };
    } catch {
      return null;
    }
  }

  /**
   * Format request ledger as human-readable CLI report.
   * @param {object} ledger
   * @returns {string}
   */
  formatLedgerText(ledger) {
    if (!ledger) return 'No ledger found.';
    const lines = [];
    lines.push('='.repeat(80));
    lines.push('AGENT BRIDGE — REQUEST LIFECYCLE LEDGER');
    lines.push('='.repeat(80));
    lines.push(`Request ID:    ${ledger.requestId}`);
    lines.push(`Status:        ${(ledger.status || '').toUpperCase()}`);
    lines.push(`Routing:       ${ledger.fromAgent || 'unknown'} -> ${ledger.toAgent || 'unknown'}`);
    if (ledger.failureStage) {
      lines.push(`Stopped At:    ${ledger.failureStage}`);
    }
    lines.push('-'.repeat(80));
    lines.push('STAGE TIMELINE:');
    const stages = [
      ['ACCEPTED', ledger.stageTimestamps.accepted],
      ['CLAIMED', ledger.stageTimestamps.claimed],
      ['DELIVERED', ledger.stageTimestamps.delivered, ledger.stageTimestamps.delivered?.evidence ? `[Evidence: ${ledger.stageTimestamps.delivered.evidence}]` : ''],
      ['FIRST RESPONSE BYTE', ledger.stageTimestamps.firstResponseByte],
      ['COMPLETION OBSERVED', ledger.stageTimestamps.completion, ledger.stageTimestamps.completion ? `[Type: ${ledger.stageTimestamps.completion.type || 'N/A'}, Evidence: ${ledger.stageTimestamps.completion.evidence || 'N/A'}]` : ''],
      ['COMMITTED', ledger.stageTimestamps.committed],
      ['NOTIFIED', ledger.stageTimestamps.notified],
      ['RETRIEVED', ledger.stageTimestamps.retrieved]
    ];
    let stepNum = 1;
    for (const [name, data, extra] of stages) {
      if (data) {
        const delta = data.deltaMs !== null ? `(+${data.deltaMs.toFixed(2)}ms)` : '';
        const note = extra ? ` ${extra}` : '';
        lines.push(`  ${stepNum++}. ${name.padEnd(22)}: ${data.timestamp} ${delta}${note}`);
      }
    }
    lines.push('-'.repeat(80));
    lines.push('METRICS & TOKENS:');
    lines.push(`  Total Duration:       ${ledger.metrics.totalDurationMs} ms`);
    lines.push(`  Tokens In (Prompt):   ${ledger.metrics.tokensIn} tokens`);
    lines.push(`  Tokens Out (Reply):   ${ledger.metrics.tokensOut} tokens`);
    lines.push(`  Tool Schema Overhead: ${ledger.metrics.toolSchemaOverheadTokens} tokens`);
    lines.push(`  Body Size:            ${ledger.metrics.bodySizeBytes} bytes`);
    lines.push(`  Retry Count:          ${ledger.metrics.retryCount}`);
    lines.push('='.repeat(80));
    return lines.join('\n');
  }

  getTimeline(requestId) {
    if (!this.enabled || !requestId) return [];
    try {
      return this.db.prepare(`
        SELECT stage, task_id, attempt_id, agent_id, route_id, wall_clock, monotonic_ms, meta
        FROM request_lifecycle
        WHERE request_id = ?
        ORDER BY id ASC
      `).all(requestId).map(r => ({
        stage: r.stage,
        taskId: r.task_id,
        attemptId: r.attempt_id,
        agentId: r.agent_id,
        routeId: r.route_id,
        wallClock: r.wall_clock,
        monotonicMs: r.monotonic_ms,
        meta: r.meta ? (() => { try { return JSON.parse(r.meta); } catch { return r.meta; } })() : null
      }));
    } catch {
      return [];
    }
  }

  /**
   * Compute stage-to-stage deltas. Deltas use the monotonic clock, which is only
   * directly comparable within a single process; the persisted wall-clock is
   * surfaced for cross-process reasoning.
   */
  getStageDurations(requestId) {
    const timeline = this.getTimeline(requestId);
    const stages = [];
    let previous = null;
    for (const entry of timeline) {
      const deltaMs = previous === null ? 0 : entry.monotonicMs - previous.monotonicMs;
      stages.push({ ...entry, deltaFromPreviousMs: deltaMs });
      previous = entry;
    }
    const totalMs = stages.length > 1
      ? stages[stages.length - 1].monotonicMs - stages[0].monotonicMs
      : 0;
    return { requestId, stages, totalMs };
  }

  /** The delta between two named stages (first occurrence each), or null. */
  stageDelta(requestId, fromStage, toStage) {
    const timeline = this.getTimeline(requestId);
    const from = timeline.find(s => s.stage === fromStage);
    const to = timeline.find(s => s.stage === toStage);
    if (!from || !to) return null;
    return to.monotonicMs - from.monotonicMs;
  }

  /**
   * Conservative retention / pruning mechanism for request lifecycle records.
   *
   * Invariants:
   *  1. Configurable retention period (default 7 days).
   *  2. Bounded batch deletion (maxBatch, default 1000) to prevent lock contention.
   *  3. Records belonging to incomplete requests (pending/in_progress in bridge_requests)
   *     or incomplete tasks in tasks are NEVER pruned, ensuring crash recovery state is preserved.
   *  4. Safe maintenance invocation returns detailed counts and continuation status.
   *
   * @param {object} options
   * @param {number} [options.retentionMs=604800000] - Cutoff age in milliseconds (default 7 days)
   * @param {number} [options.maxBatch=1000] - Maximum records to delete in one invocation
   * @param {number} [options.now=Date.now()] - Current epoch timestamp in ms
   * @returns {{pruned:number, hasMore:boolean, cutoff:string}}
   */
  prune({
    retentionMs = 7 * 24 * 60 * 60 * 1000,
    maxBatch = 1000,
    now = Date.now()
  } = {}) {
    if (!this.enabled || !this.db) return { pruned: 0, hasMore: false, cutoff: null };

    const cutoffIso = new Date(now - retentionMs).toISOString();
    const batchLimit = Math.max(1, Number.isFinite(maxBatch) ? maxBatch : 1000);

    try {
      // Find candidate record IDs older than the cutoff whose request and task are
      // terminal (or unlinked). Records needed for active/in-flight recovery are preserved.
      const candidateRows = this.db.prepare(`
        SELECT rl.id FROM request_lifecycle rl
        WHERE rl.wall_clock < ?
        AND NOT EXISTS (
          SELECT 1 FROM bridge_requests br
          WHERE br.request_id = rl.request_id
          AND br.status NOT IN ('completed', 'failed', 'cancelled')
        )
        AND NOT EXISTS (
          SELECT 1 FROM tasks t
          WHERE t.id = rl.task_id
          AND t.status NOT IN ('completed', 'failed', 'cancelled')
        )
        ORDER BY rl.id ASC
        LIMIT ?
      `).all(cutoffIso, batchLimit);

      if (!candidateRows || candidateRows.length === 0) {
        return { pruned: 0, hasMore: false, cutoff: cutoffIso };
      }

      const ids = candidateRows.map(r => r.id);
      const placeholders = ids.map(() => '?').join(',');
      const result = this.db.prepare(`
        DELETE FROM request_lifecycle WHERE id IN (${placeholders})
      `).run(...ids);

      const pruned = result.changes || ids.length;
      return {
        pruned,
        hasMore: ids.length === batchLimit,
        cutoff: cutoffIso
      };
    } catch {
      return { pruned: 0, hasMore: false, cutoff: cutoffIso };
    }
  }

  /**
   * Diagnostic statistics for request lifecycle records.
   * @returns {{totalRecords:number, oldest:string|null, newest:string|null}}
   */
  getStats() {
    if (!this.enabled || !this.db) {
      return { totalRecords: 0, oldest: null, newest: null };
    }
    try {
      const row = this.db.prepare(`
        SELECT COUNT(*) as total, MIN(wall_clock) as oldest, MAX(wall_clock) as newest
        FROM request_lifecycle
      `).get();
      return {
        totalRecords: Number(row?.total || 0),
        oldest: row?.oldest || null,
        newest: row?.newest || null
      };
    } catch {
      return { totalRecords: 0, oldest: null, newest: null };
    }
  }
}

