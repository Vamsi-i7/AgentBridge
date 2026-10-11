import crypto from 'node:crypto';

/**
 * Semantic Read-Only Query Cache (Mission H.6)
 *
 * Caches deterministic, idempotent read-only queries (e.g. static code questions,
 * architecture inquiries, symbol queries) to avoid redundant model turns.
 *
 * Invariants:
 * 1. STRICTLY READ-ONLY: Never caches mutations, file writes, git operations, or side effects.
 * 2. Explicit Invalidation: Any file modification or context change invalidates affected entries.
 * 3. Transparent Accounting: Cached results are ALWAYS flagged with `cached: true` in the envelope.
 */
export class SemanticCache {
  constructor(options = {}) {
    this.enabled = Boolean(options.enabled); // Opt-in only, false by default (P4 remediation)
    this.entries = new Map(); // cacheKey -> { response, cachedAt, fileHashes, hitCount }
    this.maxEntries = options.maxEntries || 200;
  }

  /**
   * Compute normalized key for read-only query.
   */
  _computeKey(query, fileContexts = {}) {
    const normQuery = String(query).toLowerCase().replace(/\s+/g, ' ').trim();
    const hasher = crypto.createHash('sha256').update(normQuery);

    // Bind file context hashes so any change in underlying files invalidates key
    const sortedFileKeys = Object.keys(fileContexts).sort();
    for (const f of sortedFileKeys) {
      hasher.update(`${f}:${fileContexts[f]}`);
    }

    return hasher.digest('hex');
  }

  /**
   * Check if request is safe to cache (read-only and idempotent).
   */
  isCacheable(operationType, queryText = '') {
    if (!this.enabled) return false;
    const MUTATION_VERBS = [
      'write', 'create', 'edit', 'delete', 'patch', 'modify', 'update',
      'git push', 'commit', 'exec', 'execute', 'run', 'touch', 'rm'
    ];
    if (['WRITE', 'CREATE', 'EDIT', 'DELETE', 'EXECUTE', 'GIT_WRITE', 'PUSH'].includes(operationType)) {
      return false;
    }
    const lower = String(queryText).toLowerCase();
    for (const verb of MUTATION_VERBS) {
      if (lower.startsWith(verb + ' ') || lower.includes(' ' + verb + ' ')) {
        return false;
      }
    }
    return true;
  }

  /**
   * Lookup cached result.
   */
  get(query, fileContexts = {}) {
    if (!this.enabled) return null;
    const key = this._computeKey(query, fileContexts);
    const entry = this.entries.get(key);
    if (!entry) return null;

    entry.hitCount++;
    return {
      hit: true,
      cached: true, // Transparent accounting guarantee
      response: entry.response,
      cachedAt: entry.cachedAt,
      hitCount: entry.hitCount
    };
  }

  /**
   * Store response in cache.
   */
  put(query, response, fileContexts = {}) {
    if (!this.enabled) return;
    const key = this._computeKey(query, fileContexts);
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
    this.entries.set(key, {
      response,
      cachedAt: Date.now(),
      fileContexts,
      hitCount: 0
    });
  }

  /**
   * Invalidate entries referencing specific files.
   */
  invalidateFiles(filePaths = []) {
    const pathSet = new Set(filePaths);
    for (const [key, entry] of Array.from(this.entries.entries())) {
      const hasModifiedFile = Object.keys(entry.fileContexts || {}).some(f => pathSet.has(f));
      if (hasModifiedFile) {
        this.entries.delete(key);
      }
    }
  }

  clear() {
    this.entries.clear();
  }
}
