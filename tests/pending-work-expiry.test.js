import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createHermeticTestEnv } from './helpers/hermetic.js';
import { AuditLogger } from '../src/audit-logger.js';
import { TaskManager } from '../src/task-manager.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { EventBus } from '../src/event-bus.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_PATH = path.resolve(__dirname, '..', 'scripts', 'expire-stale-pending.js');

test('Stage 4 — Pending-Work Expiry and Dead-Letter Suite (AR-03)', async (t) => {
  let env;
  let logger;
  let eventBus;
  let taskManager;
  let mailbox;

  t.beforeEach(() => {
    env = createHermeticTestEnv('stage4-pending-expiry-');
    logger = new AuditLogger(env.dbPath);
    eventBus = new EventBus(logger);
    taskManager = new TaskManager(logger, null, eventBus);
    mailbox = new MailboxHub(logger, taskManager, eventBus);
  });

  t.afterEach(() => {
    mailbox.stopRecoveryTimer();
    env.cleanup();
  });

  await t.test('1. Stale pending request past maxPendingAge transitions to failed with TARGET_UNREACHABLE', async () => {
    const staleTime = new Date(Date.now() - 3600 * 1000).toISOString(); // 1 hour ago
    const reqId = 'req_stale_1';

    logger.db.prepare(`
      INSERT INTO bridge_requests (
        request_id, conversation_id, from_agent, to_agent, question,
        status, delivery_state, created_at, updated_at
      ) VALUES (?, 'conv_1', 'claude-desktop', 'chatgpt-desktop', 'Stale Question', 'pending', 'ENQUEUED', ?, ?)
    `).run(reqId, staleTime, staleTime);

    // Run sweep with maxPendingAgeMs = 1800000 (30 minutes)
    const sweep = mailbox.recoverExpiredRequests({ maxPendingAgeMs: 1800 * 1000 });
    assert.strictEqual(sweep.expiredPending.length, 1);
    assert.strictEqual(sweep.expiredPending[0].requestId, reqId);

    const row = logger.db.prepare('SELECT status, delivery_state, error FROM bridge_requests WHERE request_id = ?').get(reqId);
    assert.strictEqual(row.status, 'failed');
    assert.strictEqual(row.delivery_state, 'PENDING_EXPIRED');
    assert.ok(row.error.includes('TARGET_UNREACHABLE'));
  });

  await t.test('2. Recent pending request within maxPendingAge is preserved as pending', async () => {
    const recentTime = new Date(Date.now() - 60 * 1000).toISOString(); // 1 minute ago
    const reqId = 'req_recent_1';

    logger.db.prepare(`
      INSERT INTO bridge_requests (
        request_id, conversation_id, from_agent, to_agent, question,
        status, delivery_state, created_at, updated_at
      ) VALUES (?, 'conv_1', 'claude-desktop', 'chatgpt-desktop', 'Recent Question', 'pending', 'ENQUEUED', ?, ?)
    `).run(reqId, recentTime, recentTime);

    const sweep = mailbox.recoverExpiredRequests({ maxPendingAgeMs: 1800 * 1000 });
    assert.strictEqual(sweep.expiredPending.length, 0);

    const row = logger.db.prepare('SELECT status, delivery_state FROM bridge_requests WHERE request_id = ?').get(reqId);
    assert.strictEqual(row.status, 'pending');
    assert.strictEqual(row.delivery_state, 'ENQUEUED');
  });

  await t.test('3. Stale pending task past maxPendingAge transitions to failed and emits lifecycle events', async () => {
    const staleTime = new Date(Date.now() - 7200 * 1000).toISOString(); // 2 hours ago
    const taskId = 'task_stale_1';

    logger.db.prepare(`
      INSERT INTO tasks (
        id, from_agent, to_agent, title, instructions,
        status, created_at, updated_at
      ) VALUES (?, 'claude-desktop', 'chatgpt-desktop', 'Stale Task', 'Execute work', 'pending', ?, ?)
    `).run(taskId, staleTime, staleTime);

    let failedEventReceived = false;
    let expiredEventReceived = false;
    taskManager.on('task:failed', (evt) => {
      if (evt.taskId === taskId && evt.errorCode === 'TARGET_UNREACHABLE') {
        failedEventReceived = true;
      }
    });
    taskManager.on('task:expired', (evt) => {
      if (evt.taskId === taskId && evt.reason === 'PENDING_EXPIRED') {
        expiredEventReceived = true;
      }
    });

    const recovered = taskManager.recoverExpiredTasks({ maxPendingAgeMs: 3600 * 1000 });
    assert.strictEqual(recovered.length, 1);
    assert.strictEqual(recovered[0].taskId, taskId);
    assert.strictEqual(recovered[0].status, 'failed');
    assert.strictEqual(recovered[0].reason, 'PENDING_EXPIRED');

    assert.strictEqual(failedEventReceived, true, 'Must emit task:failed');
    assert.strictEqual(expiredEventReceived, true, 'Must emit task:expired');

    const row = logger.db.prepare('SELECT status, error, completed_at FROM tasks WHERE id = ?').get(taskId);
    assert.strictEqual(row.status, 'failed');
    assert.ok(row.error.includes('TARGET_UNREACHABLE'));
    assert.ok(row.completed_at);
  });

  await t.test('4. Blocked tasks with status=blocked are NEVER expired by pending sweep', async () => {
    const staleTime = new Date(Date.now() - 10000 * 1000).toISOString();
    const taskId = 'task_blocked_1';

    logger.db.prepare(`
      INSERT INTO tasks (
        id, from_agent, to_agent, title, instructions,
        status, created_at, updated_at
      ) VALUES (?, 'claude-desktop', 'chatgpt-desktop', 'Blocked Task', 'Waiting for dep', 'blocked', ?, ?)
    `).run(taskId, staleTime, staleTime);

    const recovered = taskManager.recoverExpiredTasks({ maxPendingAgeMs: 1000 });
    assert.strictEqual(recovered.length, 0);

    const row = logger.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId);
    assert.strictEqual(row.status, 'blocked', 'Blocked task must not be mutated by pending expiry sweep');
  });

  await t.test('5. Re-running recovery sweep is idempotent: second pass changes 0 rows', async () => {
    const staleTime = new Date(Date.now() - 3600 * 1000).toISOString();
    const reqId = 'req_idemp_1';
    const taskId = 'task_idemp_1';

    logger.db.prepare(`
      INSERT INTO bridge_requests (request_id, conversation_id, from_agent, to_agent, question, status, created_at, updated_at)
      VALUES (?, 'c1', 'a', 'b', 'q', 'pending', ?, ?)
    `).run(reqId, staleTime, staleTime);

    logger.db.prepare(`
      INSERT INTO tasks (id, from_agent, to_agent, title, instructions, status, created_at, updated_at)
      VALUES (?, 'a', 'b', 't', 'i', 'pending', ?, ?)
    `).run(taskId, staleTime, staleTime);

    // Pass 1
    const sweep1 = mailbox.runRecoverySweep();
    const taskSweep1 = taskManager.recoverExpiredTasks({ maxPendingAgeMs: 1000 });

    // Pass 2
    const sweep2 = mailbox.runRecoverySweep();
    const taskSweep2 = taskManager.recoverExpiredTasks({ maxPendingAgeMs: 1000 });

    assert.strictEqual(taskSweep2.length, 0, 'Second task sweep must make 0 changes');
    assert.strictEqual(sweep2.requests.expiredPending.length, 0, 'Second request sweep must make 0 changes');
  });

  await t.test('6. EventBus receives request:failed event upon pending request expiry', async () => {
    const staleTime = new Date(Date.now() - 3600 * 1000).toISOString();
    const reqId = 'req_evt_1';

    logger.db.prepare(`
      INSERT INTO bridge_requests (request_id, conversation_id, from_agent, to_agent, question, status, created_at, updated_at)
      VALUES (?, 'c1', 'initiator', 'worker', 'test evt', 'pending', ?, ?)
    `).run(reqId, staleTime, staleTime);

    let publishedEvent = null;
    eventBus.publish = (evt) => {
      if (evt.requestId === reqId) {
        publishedEvent = evt;
      }
    };

    mailbox.recoverExpiredRequests({ maxPendingAgeMs: 1000 });
    assert.ok(publishedEvent, 'Must publish event upon pending request expiry');
    assert.strictEqual(publishedEvent.status, 'failed');
    assert.strictEqual(publishedEvent.errorCode, 'TARGET_UNREACHABLE');
  });

  await t.test('7. scripts/expire-stale-pending.js CLI dry-run and apply on temporary database', () => {
    const staleTime = new Date(Date.now() - 48 * 3600 * 1000).toISOString(); // 48h ago
    const recentTime = new Date().toISOString();

    logger.db.prepare(`
      INSERT INTO bridge_requests (request_id, conversation_id, from_agent, to_agent, question, status, created_at, updated_at)
      VALUES ('cli_req_stale', 'c1', 'a', 'b', 'q', 'pending', ?, ?)
    `).run(staleTime, staleTime);
    logger.db.prepare(`
      INSERT INTO bridge_requests (request_id, conversation_id, from_agent, to_agent, question, status, created_at, updated_at)
      VALUES ('cli_req_recent', 'c1', 'a', 'b', 'q', 'pending', ?, ?)
    `).run(recentTime, recentTime);

    logger.db.prepare(`
      INSERT INTO tasks (id, from_agent, to_agent, title, instructions, status, created_at, updated_at)
      VALUES ('cli_task_stale', 'a', 'b', 't', 'i', 'pending', ?, ?)
    `).run(staleTime, staleTime);
    logger.db.prepare(`
      INSERT INTO tasks (id, from_agent, to_agent, title, instructions, status, created_at, updated_at)
      VALUES ('cli_task_recent', 'a', 'b', 't', 'i', 'pending', ?, ?)
    `).run(recentTime, recentTime);

    // 1. Dry run via JSON
    const dryRun = spawnSync('node', [SCRIPT_PATH, '--db', env.dbPath, '--max-age-hours', '24', '--json'], {
      encoding: 'utf8'
    });
    assert.strictEqual(dryRun.status, 0);
    const dryReport = JSON.parse(dryRun.stdout);
    assert.strictEqual(dryReport.requestsCount, 1);
    assert.strictEqual(dryReport.tasksCount, 1);
    assert.strictEqual(dryReport.requests[0].requestId, 'cli_req_stale');
    assert.strictEqual(dryReport.tasks[0].taskId, 'cli_task_stale');

    // Confirm rows are still pending after dry-run
    const preCheckReq = logger.db.prepare("SELECT status FROM bridge_requests WHERE request_id = 'cli_req_stale'").get();
    assert.strictEqual(preCheckReq.status, 'pending');

    // 2. Apply on temporary DB
    const applyRun = spawnSync('node', [SCRIPT_PATH, '--db', env.dbPath, '--max-age-hours', '24', '--apply', '--json'], {
      encoding: 'utf8'
    });
    assert.strictEqual(applyRun.status, 0);
    const applyReport = JSON.parse(applyRun.stdout);
    assert.strictEqual(applyReport.applied.updatedRequests, 1);
    assert.strictEqual(applyReport.applied.updatedTasks, 1);

    // Confirm stale rows are failed, recent rows remain pending
    const postReqStale = logger.db.prepare("SELECT status, delivery_state FROM bridge_requests WHERE request_id = 'cli_req_stale'").get();
    assert.strictEqual(postReqStale.status, 'failed');
    assert.strictEqual(postReqStale.delivery_state, 'PENDING_EXPIRED');

    const postReqRecent = logger.db.prepare("SELECT status FROM bridge_requests WHERE request_id = 'cli_req_recent'").get();
    assert.strictEqual(postReqRecent.status, 'pending');

    const postTaskStale = logger.db.prepare("SELECT status FROM tasks WHERE id = 'cli_task_stale'").get();
    assert.strictEqual(postTaskStale.status, 'failed');

    const postTaskRecent = logger.db.prepare("SELECT status FROM tasks WHERE id = 'cli_task_recent'").get();
    assert.strictEqual(postTaskRecent.status, 'pending');
  });
});
