/**
 * Schema Migrator & Versioning Engine (Hardened v2)
 *
 * Provides transactional forward migrations with version tracking:
 * - Version 1: Baseline core schema aligned with live runtime tables
 * - Version 2: Monotonic ledgers, attempt tracking, task leases, and pending recovery indexes
 * - Version 3: Semantic cache, artifact manifests, and verified capability registries
 *
 * Guarantees:
 * - All forward migrations run inside an atomic transaction.
 * - If a migration step fails, the transaction rolls back cleanly leaving user_version unchanged.
 * - Idempotent: re-running migrations is safe and produces zero side-effects.
 * - Non-destructive: never drops tables or clobbers runtime columns.
 */

export const TARGET_SCHEMA_VERSION = 3;

/**
 * Returns column names for a given table as a Set.
 */
export function getTableColumns(db, tableName) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${tableName})`).all();
    return new Set(rows.map(r => r.name));
  } catch {
    return new Set();
  }
}

/**
 * Checks whether a table exists in the database.
 */
export function tableExists(db, tableName) {
  try {
    const row = db.prepare("SELECT count(*) as cnt FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
    return Boolean(row && row.cnt > 0);
  } catch {
    return false;
  }
}

/**
 * Adds a column to a table if it does not already exist.
 */
export function ensureColumn(db, tableName, colName, colDefinition) {
  if (!tableExists(db, tableName)) return;
  const cols = getTableColumns(db, tableName);
  if (!cols.has(colName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${colName} ${colDefinition};`);
  }
}

export const MIGRATIONS = [
  {
    version: 1,
    name: 'baseline_live_schema',
    up: (db) => {
      // 1. Audit Log
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          action TEXT NOT NULL,
          target_path TEXT,
          status TEXT NOT NULL,
          details TEXT,
          error_message TEXT
        );
      `);
      ensureColumn(db, 'audit_log', 'error_message', 'TEXT');

      // 2. Tasks (Real runtime schema with from_agent / to_agent)
      db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          from_agent TEXT NOT NULL,
          to_agent TEXT NOT NULL,
          title TEXT NOT NULL,
          instructions TEXT NOT NULL,
          context TEXT,
          status TEXT NOT NULL,
          result TEXT,
          parent_task_id TEXT,
          priority TEXT DEFAULT "normal",
          started_at TEXT,
          completed_at TEXT,
          retry_count INTEGER DEFAULT 0,
          max_retries INTEGER DEFAULT 3,
          timeout_ms INTEGER DEFAULT 60000,
          error TEXT,
          dependencies TEXT,
          dedup_key TEXT
        );
      `);
      ensureColumn(db, 'tasks', 'parent_task_id', 'TEXT');
      ensureColumn(db, 'tasks', 'priority', 'TEXT DEFAULT "normal"');
      ensureColumn(db, 'tasks', 'started_at', 'TEXT');
      ensureColumn(db, 'tasks', 'completed_at', 'TEXT');
      ensureColumn(db, 'tasks', 'retry_count', 'INTEGER DEFAULT 0');
      ensureColumn(db, 'tasks', 'max_retries', 'INTEGER DEFAULT 3');
      ensureColumn(db, 'tasks', 'timeout_ms', 'INTEGER DEFAULT 60000');
      ensureColumn(db, 'tasks', 'error', 'TEXT');
      ensureColumn(db, 'tasks', 'dependencies', 'TEXT');
      ensureColumn(db, 'tasks', 'dedup_key', 'TEXT');
      ensureColumn(db, 'tasks', 'from_agent', 'TEXT');
      ensureColumn(db, 'tasks', 'to_agent', 'TEXT');

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tasks_to_agent_status ON tasks(to_agent, status);
        CREATE INDEX IF NOT EXISTS idx_tasks_parent_id ON tasks(parent_task_id);
      `);

      // 3. Messages
      db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          timestamp TEXT NOT NULL,
          from_agent TEXT NOT NULL,
          to_agent TEXT NOT NULL,
          subject TEXT NOT NULL,
          content TEXT NOT NULL,
          reply_to_id TEXT,
          read_at TEXT
        );
      `);

      // 4. Bridge Events (Real runtime schema with agent_id, from_agent, type)
      db.exec(`
        CREATE TABLE IF NOT EXISTS bridge_events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          type TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          from_agent TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          request_id TEXT,
          task_id TEXT,
          status TEXT,
          payload TEXT,
          dedup_key TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_bridge_events_agent_id ON bridge_events(agent_id, event_id);
        CREATE INDEX IF NOT EXISTS idx_bridge_events_req_id ON bridge_events(request_id);
      `);

      // 5. Bridge Requests (Real runtime schema)
      db.exec(`
        CREATE TABLE IF NOT EXISTS bridge_requests (
          request_id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          from_agent TEXT NOT NULL,
          to_agent TEXT NOT NULL,
          question TEXT NOT NULL,
          context TEXT,
          task_id TEXT,
          status TEXT NOT NULL,
          response TEXT,
          error TEXT,
          timeout_ms INTEGER DEFAULT 30000,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          delivery_acknowledged_at TEXT,
          claimed_by TEXT,
          lease_expires_at TEXT,
          attempt_id TEXT,
          epoch INTEGER,
          completion_evidence TEXT,
          submitted_to_provider INTEGER DEFAULT 0,
          delivery_state TEXT,
          is_idempotent INTEGER DEFAULT 0,
          nonce TEXT
        );
      `);
      ensureColumn(db, 'bridge_requests', 'delivery_acknowledged_at', 'TEXT');
      ensureColumn(db, 'bridge_requests', 'claimed_by', 'TEXT');
      ensureColumn(db, 'bridge_requests', 'lease_expires_at', 'TEXT');
      ensureColumn(db, 'bridge_requests', 'attempt_id', 'TEXT');
      ensureColumn(db, 'bridge_requests', 'epoch', 'INTEGER');
      ensureColumn(db, 'bridge_requests', 'completion_evidence', 'TEXT');
      ensureColumn(db, 'bridge_requests', 'submitted_to_provider', 'INTEGER DEFAULT 0');
      ensureColumn(db, 'bridge_requests', 'delivery_state', 'TEXT');
      ensureColumn(db, 'bridge_requests', 'is_idempotent', 'INTEGER DEFAULT 0');
      ensureColumn(db, 'bridge_requests', 'nonce', 'TEXT');

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_bridge_requests_to_status ON bridge_requests(to_agent, status);
      `);

      // 6. Bridge Outbox (Exact runtime schema)
      db.exec(`
        CREATE TABLE IF NOT EXISTS bridge_outbox (
          outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id INTEGER,
          timestamp TEXT NOT NULL,
          type TEXT NOT NULL,
          agent_id TEXT NOT NULL,
          from_agent TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          request_id TEXT,
          task_id TEXT,
          status TEXT,
          payload TEXT,
          dedup_key TEXT,
          published_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_outbox_pending ON bridge_outbox(published_at) WHERE published_at IS NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_dedup ON bridge_outbox(dedup_key) WHERE dedup_key IS NOT NULL;
      `);
      ensureColumn(db, 'bridge_outbox', 'dedup_key', 'TEXT');

      // 7. Agent Presence
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_presence (
          agent_id TEXT NOT NULL,
          transport TEXT NOT NULL DEFAULT 'mcp-stdio',
          connected INTEGER DEFAULT 1,
          pid INTEGER,
          session_id TEXT,
          state TEXT DEFAULT 'IDLE',
          current_task_id TEXT,
          capabilities TEXT,
          health TEXT DEFAULT 'healthy',
          last_heartbeat TEXT NOT NULL,
          started_at TEXT NOT NULL,
          metadata TEXT,
          PRIMARY KEY (agent_id, transport)
        );
      `);

      // 8. Agent Event Cursors
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_event_cursors (
          agent_id TEXT PRIMARY KEY,
          last_seen_event_id INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );
      `);
    }
  },
  {
    version: 2,
    name: 'monotonic_ledgers_and_fencing',
    up: (db) => {
      // 1. Task Epochs (Real runtime schema matching AttemptLedger)
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_epochs (
          task_id TEXT PRIMARY KEY,
          current_epoch INTEGER NOT NULL DEFAULT 0,
          active_attempt_id TEXT,
          updated_at TEXT NOT NULL
        );
      `);
      ensureColumn(db, 'task_epochs', 'current_epoch', 'INTEGER NOT NULL DEFAULT 0');
      ensureColumn(db, 'task_epochs', 'active_attempt_id', 'TEXT');

      // 2. Bridge Attempts (Real runtime schema)
      db.exec(`
        CREATE TABLE IF NOT EXISTS bridge_attempts (
          attempt_id TEXT PRIMARY KEY,
          request_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          attempt_number INTEGER NOT NULL,
          agent_id TEXT NOT NULL,
          route_id TEXT NOT NULL,
          epoch INTEGER NOT NULL,
          nonce TEXT NOT NULL,
          grant TEXT,
          worktree_path TEXT,
          state TEXT NOT NULL,
          lease_timeout_ms INTEGER NOT NULL DEFAULT 60000,
          lease_expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          started_at TEXT,
          heartbeat_at TEXT,
          completed_at TEXT,
          result TEXT,
          error TEXT,
          correlation_info TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_attempts_task ON bridge_attempts(task_id, attempt_number);
        CREATE INDEX IF NOT EXISTS idx_attempts_req ON bridge_attempts(request_id);
        CREATE INDEX IF NOT EXISTS idx_attempts_state ON bridge_attempts(state);
      `);

      // 3. Quarantined Responses (Real runtime schema)
      db.exec(`
        CREATE TABLE IF NOT EXISTS bridge_quarantined_responses (
          quarantine_id TEXT PRIMARY KEY,
          attempt_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          epoch INTEGER NOT NULL,
          payload TEXT NOT NULL,
          reason TEXT NOT NULL,
          quarantined_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_quarantined_req ON bridge_quarantined_responses(request_id);
      `);

      // 4. Task Leases (Satisfies retention-pruner pruneExpiredLeases)
      db.exec(`
        CREATE TABLE IF NOT EXISTS task_leases (
          task_id TEXT PRIMARY KEY,
          agent_id TEXT NOT NULL,
          lease_token TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          fencing_token INTEGER DEFAULT 1
        );
      `);

      // 5. Index for pending-work recovery queries
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_bridge_requests_status_created ON bridge_requests(status, created_at);
        CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at);
      `);
    }
  },
  {
    version: 3,
    name: 'semantic_cache_and_artifacts',
    up: (db) => {
      // 1. Semantic Cache (Satisfies retention-pruner pruneSemanticCache)
      db.exec(`
        CREATE TABLE IF NOT EXISTS semantic_cache (
          cache_key TEXT PRIMARY KEY,
          query_hash TEXT NOT NULL,
          response_json TEXT NOT NULL,
          referenced_files TEXT,
          created_at INTEGER NOT NULL,
          ttl_ms INTEGER NOT NULL
        );
      `);

      // 2. Artifact Manifests
      db.exec(`
        CREATE TABLE IF NOT EXISTS artifact_manifests (
          artifact_hash TEXT PRIMARY KEY,
          size_bytes INTEGER NOT NULL,
          mime_type TEXT,
          created_at TEXT NOT NULL,
          ref_count INTEGER DEFAULT 1
        );
      `);

      // 3. Bridge Artifacts (Real runtime schema)
      db.exec(`
        CREATE TABLE IF NOT EXISTS bridge_artifacts (
          artifact_id TEXT PRIMARY KEY,
          task_id TEXT,
          attempt_id TEXT,
          agent_id TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          media_type TEXT NOT NULL,
          filename TEXT,
          size_bytes INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          storage_backend TEXT NOT NULL,
          retrieval_method TEXT NOT NULL,
          storage_path TEXT NOT NULL,
          authorized_agents TEXT,
          transfer_status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT,
          metadata TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_bridge_artifacts_task ON bridge_artifacts(task_id);
        CREATE INDEX IF NOT EXISTS idx_bridge_artifacts_status ON bridge_artifacts(transfer_status, expires_at);
      `);

      // 4. Bridge Capabilities (Real runtime schema)
      db.exec(`
        CREATE TABLE IF NOT EXISTS bridge_capabilities (
          agent_id TEXT NOT NULL,
          route_id TEXT NOT NULL,
          trust_tier INTEGER NOT NULL,
          dimension TEXT NOT NULL,
          state TEXT NOT NULL,
          evidence TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (agent_id, route_id, dimension)
        );
        CREATE INDEX IF NOT EXISTS idx_bridge_cap_agent_route ON bridge_capabilities(agent_id, route_id);
      `);
    }
  }
];

export class SchemaMigrator {
  constructor(db) {
    this.db = db;
  }

  getCurrentVersion() {
    const row = this.db.prepare('PRAGMA user_version').get();
    return row ? Object.values(row)[0] : 0;
  }

  setVersion(version) {
    this.db.exec(`PRAGMA user_version = ${version};`);
  }

  /**
   * Run migrations up to targetVersion inside individual transactions.
   */
  migrate(targetVersion = TARGET_SCHEMA_VERSION) {
    let current = this.getCurrentVersion();
    if (current >= targetVersion) {
      return { currentVersion: current, targetVersion, migratedSteps: 0, status: 'UP_TO_DATE' };
    }

    let stepsRun = 0;
    for (const mig of MIGRATIONS) {
      if (mig.version > current && mig.version <= targetVersion) {
        // Execute inside transaction for atomicity
        this.db.exec('BEGIN TRANSACTION;');
        try {
          mig.up(this.db);
          this.setVersion(mig.version);
          this.db.exec('COMMIT;');
          current = mig.version;
          stepsRun++;
        } catch (err) {
          try { this.db.exec('ROLLBACK;'); } catch  {
      // swallow-ok: transaction may already be resolved or closed
    }
          throw new Error(`Migration failed at step ${mig.version} (${mig.name}): ${err.message}`);
        }
      }
    }

    return {
      currentVersion: current,
      targetVersion,
      migratedSteps: stepsRun,
      status: 'MIGRATED'
    };
  }

  /**
   * Migrate to latest TARGET_SCHEMA_VERSION.
   */
  migrateToLatest() {
    return this.migrate(TARGET_SCHEMA_VERSION);
  }

  /**
   * Validates that all required runtime tables and columns exist.
   */
  validateRuntimeSchema() {
    const requiredTables = ['audit_log', 'tasks', 'bridge_requests', 'messages', 'bridge_events'];
    for (const t of requiredTables) {
      if (!tableExists(this.db, t)) {
        throw new Error(`SchemaSanityError: Required runtime table '${t}' is missing from database.`);
      }
    }

    const taskCols = getTableColumns(this.db, 'tasks');
    if (!taskCols.has('from_agent') || !taskCols.has('to_agent')) {
      throw new Error("SchemaSanityError: Table 'tasks' is missing required agent columns (from_agent, to_agent).");
    }

    const reqCols = getTableColumns(this.db, 'bridge_requests');
    if (!reqCols.has('status') || !reqCols.has('to_agent')) {
      throw new Error("SchemaSanityError: Table 'bridge_requests' is missing required columns (status, to_agent).");
    }

    return { valid: true };
  }
}
