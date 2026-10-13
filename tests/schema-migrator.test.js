import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { SchemaMigrator, TARGET_SCHEMA_VERSION, MIGRATIONS } from '../src/storage/schema-migrator.js';
import { AuditLogger } from '../src/audit-logger.js';
import { CONFIG } from '../src/config.js';

test('Stage 2 — Schema Migrator & Versioning Engine Suite (AR-01)', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-migrator-test-'));

  t.after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // (a) Fresh DB reaches user_version == TARGET
  await t.test('(a) Fresh database migrates to TARGET_SCHEMA_VERSION', () => {
    const dbPath = path.join(tmpDir, 'fresh.sqlite');
    const db = new DatabaseSync(dbPath);
    const migrator = new SchemaMigrator(db);

    assert.equal(migrator.getCurrentVersion(), 0);
    const res = migrator.migrateToLatest();
    assert.equal(res.status, 'MIGRATED');
    assert.equal(res.currentVersion, TARGET_SCHEMA_VERSION);
    assert.equal(migrator.getCurrentVersion(), TARGET_SCHEMA_VERSION);

    // Verify sanity checks pass
    const sanity = migrator.validateRuntimeSchema();
    assert.equal(sanity.valid, true);

    // Verify second run is a no-op
    const secondRes = migrator.migrateToLatest();
    assert.equal(secondRes.status, 'UP_TO_DATE');
    assert.equal(secondRes.migratedSteps, 0);

    db.close();
  });

  // (b) Copy of real live DB migrates cleanly, preserves row counts, reaches TARGET, second run is no-op
  await t.test('(b) Live DB copy migrates cleanly, preserves all rows, reaches TARGET idempotently', () => {
    const liveDbPath = path.join(CONFIG.BRIDGE_ROOT, 'data', 'bridge.sqlite');
    const baselineFixture = '/tmp/ab-mission-baseline/pre-migration-bridge.sqlite';
    const sourceDbPath = fs.existsSync(baselineFixture) ? baselineFixture : liveDbPath;
    assert.ok(fs.existsSync(sourceDbPath), 'Database file must exist for copy verification');

    const copyDir = path.join(tmpDir, 'live-copy');
    fs.mkdirSync(copyDir, { recursive: true });
    const copyDbPath = path.join(copyDir, 'bridge.sqlite');

    // Copy database safely
    fs.copyFileSync(sourceDbPath, copyDbPath);
    if (sourceDbPath === liveDbPath) {
      if (fs.existsSync(`${liveDbPath}-wal`)) fs.copyFileSync(`${liveDbPath}-wal`, `${copyDbPath}-wal`);
      if (fs.existsSync(`${liveDbPath}-shm`)) fs.copyFileSync(`${liveDbPath}-shm`, `${copyDbPath}-shm`);
    }

    const copyDb = new DatabaseSync(copyDbPath);

    // Snapshot pre-migration row counts of all tables that exist
    const tablesQuery = copyDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    const preCounts = new Map();
    for (const { name } of tablesQuery) {
      const cnt = copyDb.prepare(`SELECT count(*) as c FROM ${name}`).get();
      preCounts.set(name, cnt.c);
    }

    const initialVersion = copyDb.prepare('PRAGMA user_version').get()['user_version'];

    // Run migration on copy
    const migrator = new SchemaMigrator(copyDb);
    const migrateResult = migrator.migrateToLatest();
    if (initialVersion < TARGET_SCHEMA_VERSION) {
      assert.equal(migrateResult.status, 'MIGRATED');
      assert.equal(migrateResult.currentVersion, TARGET_SCHEMA_VERSION);
    } else {
      assert.equal(migrateResult.status, 'UP_TO_DATE');
    }
    assert.equal(migrator.getCurrentVersion(), TARGET_SCHEMA_VERSION);

    // Verify all pre-existing table row counts were strictly preserved
    for (const [tableName, expectedCount] of preCounts.entries()) {
      const postCount = copyDb.prepare(`SELECT count(*) as c FROM ${tableName}`).get().c;
      assert.equal(postCount, expectedCount, `Row count for table ${tableName} must remain strictly unchanged after migration`);
    }

    // Verify newly added tables exist
    assert.ok(copyDb.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='task_leases'").get().c > 0);
    assert.ok(copyDb.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='semantic_cache'").get().c > 0);
    assert.ok(copyDb.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='artifact_manifests'").get().c > 0);

    // Second run must be an idempotent no-op
    const noopResult = migrator.migrateToLatest();
    assert.equal(noopResult.status, 'UP_TO_DATE');
    assert.equal(noopResult.migratedSteps, 0);
    assert.equal(migrator.getCurrentVersion(), TARGET_SCHEMA_VERSION);

    copyDb.close();
  });

  // (c) Deliberately failing migration rolls back and leaves user_version unchanged
  await t.test('(c) Deliberately failing migration rolls back and leaves user_version unchanged', () => {
    const dbPath = path.join(tmpDir, 'rollback.sqlite');
    const db = new DatabaseSync(dbPath);
    const migrator = new SchemaMigrator(db);

    // Run migration step 1 manually
    migrator.migrate(1);
    assert.equal(migrator.getCurrentVersion(), 1);

    // Temporarily inject a failing migration step 2
    const originalStep2 = MIGRATIONS[1];
    MIGRATIONS[1] = {
      version: 2,
      name: 'failing_step_2',
      up: (d) => {
        d.exec('CREATE TABLE temp_rollback_test (id INTEGER);');
        throw new Error('INJECTED_MIGRATION_FAILURE');
      }
    };

    try {
      assert.throws(() => {
        migrator.migrate(2);
      }, /INJECTED_MIGRATION_FAILURE/);

      // Verify user_version was NOT advanced
      assert.equal(migrator.getCurrentVersion(), 1);

      // Verify temp_rollback_test was rolled back and does not exist
      const tbl = db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='temp_rollback_test'").get();
      assert.equal(tbl.c, 0, 'Table created inside failed migration must be rolled back');
    } finally {
      MIGRATIONS[1] = originalStep2;
    }

    db.close();
  });

  // (d) Legacy-shaped DB missing newer columns upgrades correctly
  await t.test('(d) Legacy-shaped DB missing newer columns upgrades correctly', () => {
    const dbPath = path.join(tmpDir, 'legacy.sqlite');
    const db = new DatabaseSync(dbPath);

    // Create legacy tables with minimal columns
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        title TEXT NOT NULL,
        instructions TEXT NOT NULL,
        status TEXT NOT NULL
      );
      INSERT INTO tasks VALUES ('task_old_1', '2026-01-01', '2026-01-01', 'agent1', 'agent2', 'Old Task', 'Do work', 'completed');

      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        action TEXT NOT NULL,
        status TEXT NOT NULL
      );
      INSERT INTO audit_log VALUES (1, '2026-01-01', 'system', 'boot', 'success');
    `);

    assert.equal(db.prepare('PRAGMA user_version').get()['user_version'], 0);

    const migrator = new SchemaMigrator(db);
    migrator.migrateToLatest();

    assert.equal(migrator.getCurrentVersion(), TARGET_SCHEMA_VERSION);

    // Verify legacy rows are preserved
    const taskRow = db.prepare("SELECT * FROM tasks WHERE id = 'task_old_1'").get();
    assert.equal(taskRow.title, 'Old Task');
    assert.equal(taskRow.retry_count, 0); // Default applied from column add

    const auditRow = db.prepare('SELECT * FROM audit_log WHERE id = 1').get();
    assert.equal(auditRow.action, 'boot');

    db.close();
  });

  // (e) Swallowed-error regression: construct AuditLogger against temp DB and assert migration errors surface
  await t.test('(e) Swallowed-error regression: migration errors surface loudly through AuditLogger', () => {
    const dbPath = path.join(tmpDir, 'audit-swallowed-reg.sqlite');

    // Corrupt the schema or inject a failing migration step
    const originalStep1 = MIGRATIONS[0];
    MIGRATIONS[0] = {
      version: 1,
      name: 'corrupted_step_1',
      up: () => {
        throw new Error('FATAL_SCHEMA_CORRUPTION_INJECTION');
      }
    };

    try {
      assert.throws(() => {
        new AuditLogger(dbPath);
      }, /FATAL_SCHEMA_CORRUPTION_INJECTION/);
    } finally {
      MIGRATIONS[0] = originalStep1;
    }
  });
});
