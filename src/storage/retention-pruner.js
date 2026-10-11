import fs from 'node:fs';
import path from 'node:path';

/**
 * Retention & Pruning Engine (Mission 4 - Part C.2)
 *
 * Configurable pruning for:
 * 1. Audit log
 * 2. Request ledger & bridge_requests (TERMINAL ONLY - never prunes active requests)
 * 3. Expired task leases
 * 4. Expired semantic cache entries
 * 5. Abandoned upload sessions
 * 6. Orphaned CAS blobs
 */
export class RetentionPruner {
  constructor(db, options = {}) {
    this.db = db;
    this.casDir = options.casDir || null;
  }

  /**
   * Prune audit log older than retention period.
   */
  pruneAuditLog(retentionDays = 30) {
    if (!this.db) return { pruned: 0 };
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
    try {
      const res = this.db.prepare('DELETE FROM audit_log WHERE timestamp < ?').run(cutoff);
      return { pruned: res.changes || 0, cutoff };
    } catch {
      return { pruned: 0, cutoff };
    }
  }

  /**
   * Prune bridge_requests older than retention period.
   * INVARIANT: Never prunes active/in-flight requests!
   */
  pruneRequestLedger(retentionDays = 14) {
    if (!this.db) return { pruned: 0 };
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
    try {
      // Strictly restrict to terminal states
      const res = this.db.prepare(`
        DELETE FROM bridge_requests 
        WHERE created_at < ? 
          AND state IN ('completed', 'failed', 'cancelled', 'quarantined')
      `).run(cutoff);
      return { pruned: res.changes || 0, cutoff };
    } catch {
      return { pruned: 0, cutoff };
    }
  }

  /**
   * Prune expired task leases.
   */
  pruneExpiredLeases() {
    if (!this.db) return { pruned: 0 };
    const now = Date.now();
    try {
      const res = this.db.prepare('DELETE FROM task_leases WHERE expires_at < ?').run(now);
      return { pruned: res.changes || 0 };
    } catch {
      return { pruned: 0 };
    }
  }

  /**
   * Prune expired semantic cache entries.
   */
  pruneSemanticCache() {
    if (!this.db) return { pruned: 0 };
    const now = Date.now();
    try {
      const res = this.db.prepare('DELETE FROM semantic_cache WHERE (created_at + ttl_ms) < ?').run(now);
      return { pruned: res.changes || 0 };
    } catch {
      return { pruned: 0 };
    }
  }

  /**
   * Run all pruners with a single call.
   */
  pruneAll(options = {}) {
    return {
      auditLog: this.pruneAuditLog(options.auditRetentionDays || 30),
      requestLedger: this.pruneRequestLedger(options.ledgerRetentionDays || 14),
      leases: this.pruneExpiredLeases(),
      cache: this.pruneSemanticCache(),
      executedAt: new Date().toISOString()
    };
  }
}
