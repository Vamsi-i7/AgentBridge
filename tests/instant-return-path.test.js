import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'os';
import { performance } from 'node:perf_hooks';

import { AuditLogger } from '../src/audit-logger.js';
import { EventBus } from '../src/event-bus.js';
import { TaskManager } from '../src/task-manager.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { LifecycleStage } from '../src/diagnostics/request-tracer.js';

function setupEnv() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'return-path-test-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  const logger = new AuditLogger(dbPath);
  const eventBus = new EventBus(logger);
  const taskManager = new TaskManager(logger, null, eventBus);
  const mailbox = new MailboxHub(logger, taskManager, eventBus);
  const registry = new ToolRegistry();
  return { tmpDir, dbPath, logger, eventBus, taskManager, mailbox, registry };
}

test('Mission C — Instant, Correct Return Path Suite', async (t) => {
  const env = setupEnv();

  t.after(() => {
    try { env.eventBus.close(); } catch {}
    try { env.logger.close(); } catch {}
    try { fs.rmSync(env.tmpDir, { recursive: true, force: true }); } catch {}
  });

  await t.test('1. Measured notify-to-wake latency is single-digit milliseconds in-process', async () => {
    const reqId = 'req_latency_test_1';
    const now = new Date().toISOString();

    env.logger.db.prepare(`
      INSERT INTO bridge_requests (request_id, conversation_id, from_agent, to_agent, question, status, created_at, updated_at)
      VALUES (?, 'conv_1', 'chatgpt-desktop', 'freebuff', 'Latency measurement', 'pending', ?, ?)
    `).run(reqId, now, now);

    const waitPromise = env.eventBus.waitForResponse({ requestId: reqId, timeoutMs: 5000 });

    let wakeTime = 0;
    const trackedPromise = waitPromise.then(res => {
      wakeTime = performance.now();
      return res;
    });

    const notifyTime = performance.now();
    env.logger.db.prepare(`
      UPDATE bridge_requests SET status = 'completed', response = 'Fast result', updated_at = ?, completed_at = ?, completion_evidence = 'MCP_AUTHENTICATED_SUBMIT'
      WHERE request_id = ?
    `).run(now, now, reqId);

    env.eventBus.publish({
      type: 'response_ready',
      agentId: '*',
      requestId: reqId,
      status: 'completed'
    });

    const res = await trackedPromise;
    const latencyMs = wakeTime - notifyTime;

    assert.strictEqual(res.status, 'completed');
    assert.strictEqual(res.response, 'Fast result');
    assert.strictEqual(res.completionEvidence, 'MCP_AUTHENTICATED_SUBMIT');
    assert.ok(latencyMs < 10, `In-process notify-to-wake latency must be < 10ms, measured ${latencyMs.toFixed(3)}ms`);
  });

  await t.test('2. Missed event race (publish before wait): precheck resolves instantly without waiting for timeout', async () => {
    const reqId = 'req_precheck_race_1';
    const now = new Date().toISOString();

    // Commit to SQLite and publish event BEFORE waiter is registered
    env.logger.db.prepare(`
      INSERT INTO bridge_requests (request_id, conversation_id, from_agent, to_agent, question, status, response, created_at, updated_at, completed_at, completion_evidence)
      VALUES (?, 'conv_race', 'antigravity-ide', 'claude-desktop', 'Race check', 'completed', 'Pre-committed result', ?, ?, ?, 'EXPLICIT_END_OF_TURN')
    `).run(reqId, now, now, now);

    env.eventBus.publish({
      type: 'response_ready',
      agentId: '*',
      requestId: reqId,
      status: 'completed'
    });

    // Register waiter AFTER event was already dispatched
    const startWait = performance.now();
    const res = await env.eventBus.waitForResponse({ requestId: reqId, timeoutMs: 10000 });
    const durationMs = performance.now() - startWait;

    assert.strictEqual(res.status, 'completed');
    assert.strictEqual(res.response, 'Pre-committed result');
    assert.strictEqual(res.completionEvidence, 'EXPLICIT_END_OF_TURN');
    assert.ok(durationMs < 20, `Precheck must resolve immediately (<20ms), took ${durationMs.toFixed(3)}ms`);
  });

  await t.test('3. Duplicate event race: duplicate events cannot double-settle or mutate terminal state', async () => {
    const reqId = 'req_dup_race_1';
    const now = new Date().toISOString();

    env.logger.db.prepare(`
      INSERT INTO bridge_requests (request_id, conversation_id, from_agent, to_agent, question, status, created_at, updated_at)
      VALUES (?, 'conv_dup', 'gemini', 'freebuff', 'Dedup check', 'pending', ?, ?)
    `).run(reqId, now, now);

    let wakeCount = 0;
    const waitPromise = env.eventBus.waitForResponse({ requestId: reqId, timeoutMs: 5000 }).then(res => {
      wakeCount++;
      return res;
    });

    // Commit terminal row
    env.logger.db.prepare(`
      UPDATE bridge_requests SET status = 'completed', response = 'First valid result', updated_at = ?, completed_at = ?, completion_evidence = 'MCP_AUTHENTICATED_SUBMIT'
      WHERE request_id = ?
    `).run(now, now, reqId);

    // Fire duplicate event 1
    env.eventBus.publish({
      type: 'response_ready',
      agentId: '*',
      requestId: reqId,
      status: 'completed',
      dedupKey: `dedup_${reqId}_1`
    });

    // Fire duplicate event 2 (same dedup key)
    env.eventBus.publish({
      type: 'response_ready',
      agentId: '*',
      requestId: reqId,
      status: 'completed',
      dedupKey: `dedup_${reqId}_1`
    });

    // Fire duplicate event 3 (different key, already terminal)
    env.eventBus.publish({
      type: 'response_ready',
      agentId: '*',
      requestId: reqId,
      status: 'completed',
      dedupKey: `dedup_${reqId}_2`
    });

    const res = await waitPromise;
    assert.strictEqual(res.status, 'completed');
    assert.strictEqual(res.response, 'First valid result');
    assert.strictEqual(wakeCount, 1, 'Waiter must be resolved exactly once');

    // Confirm DB row was not modified
    const finalRow = env.logger.db.prepare('SELECT response FROM bridge_requests WHERE request_id = ?').get(reqId);
    assert.strictEqual(finalRow.response, 'First valid result');
  });

  await t.test('4. Shutdown race: eventBus.close() cleanly releases all in-flight waiters with EVENT_BUS_CLOSED', async () => {
    const isolatedEnv = setupEnv();
    const req1 = 'req_shut_1';
    const req2 = 'req_shut_2';

    const p1 = isolatedEnv.eventBus.waitForResponse({ requestId: req1, timeoutMs: 30000 });
    const p2 = isolatedEnv.eventBus.waitForResponse({ requestId: req2, timeoutMs: 30000 });

    assert.strictEqual(isolatedEnv.eventBus.getActiveWaiterCount(req1), 1);
    assert.strictEqual(isolatedEnv.eventBus.getActiveWaiterCount(req2), 1);

    // Trigger immediate shutdown
    isolatedEnv.eventBus.close();

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.strictEqual(r1.status, 'failed');
    assert.ok(r1.error.includes('EVENT_BUS_CLOSED'));
    assert.strictEqual(r2.status, 'failed');
    assert.ok(r2.error.includes('EVENT_BUS_CLOSED'));

    assert.strictEqual(isolatedEnv.eventBus.getActiveWaiterCount(req1), 0);
    assert.strictEqual(isolatedEnv.eventBus.getActiveWaiterCount(req2), 0);

    try { isolatedEnv.logger.close(); } catch {}
    try { fs.rmSync(isolatedEnv.tmpDir, { recursive: true, force: true }); } catch {}
  });

  await t.test('5. Cancel race: cancelling a task immediately unblocks waiters with status: cancelled', async () => {
    const task = env.taskManager.createTask({
      title: 'Cancelable test task',
      fromAgent: 'chatgpt-desktop',
      toAgent: 'freebuff',
      instructions: 'Cancelable test task'
    });

    const reqId = `req_cancel_${task.id}`;
    const now = new Date().toISOString();
    env.logger.db.prepare(`
      INSERT INTO bridge_requests (request_id, conversation_id, from_agent, to_agent, question, task_id, status, created_at, updated_at)
      VALUES (?, 'conv_cancel', 'chatgpt-desktop', 'freebuff', 'Cancelable task', ?, 'pending', ?, ?)
    `).run(reqId, task.id, now, now);

    const waitPromise = env.eventBus.waitForResponse({ requestId: reqId, timeoutMs: 10000 });

    // Cancel task
    env.mailbox.cancelTask({ taskId: task.id, agentId: 'chatgpt-desktop', reason: 'User requested cancellation' });

    const res = await waitPromise;
    assert.strictEqual(res.status, 'cancelled');
    assert.strictEqual(res.error, 'User requested cancellation');
  });

  await t.test('6. 4-Tier Completion Evidence Priority: callers receive exact completion evidence type', async () => {
    // Rank 1: MCP_AUTHENTICATED_SUBMIT
    const req1 = 'req_ev_1';
    const now = new Date().toISOString();
    env.logger.db.prepare(`
      INSERT INTO bridge_requests (request_id, conversation_id, from_agent, to_agent, question, status, response, created_at, updated_at, completed_at, completion_evidence)
      VALUES (?, 'conv_1', 'gemini', 'freebuff', 'Q1', 'completed', 'Ans 1', ?, ?, ?, 'MCP_AUTHENTICATED_SUBMIT')
    `).run(req1, now, now, now);
    const res1 = await env.eventBus.waitForResponse({ requestId: req1 });
    assert.strictEqual(res1.completionEvidence, 'MCP_AUTHENTICATED_SUBMIT');

    // Rank 2: NETWORK_END_OF_STREAM
    const req2 = 'req_ev_2';
    env.logger.db.prepare(`
      INSERT INTO bridge_requests (request_id, conversation_id, from_agent, to_agent, question, status, response, created_at, updated_at, completed_at, completion_evidence)
      VALUES (?, 'conv_2', 'gemini', 'claude-desktop', 'Q2', 'completed', 'Ans 2', ?, ?, ?, 'NETWORK_END_OF_STREAM')
    `).run(req2, now, now, now);
    const res2 = await env.eventBus.waitForResponse({ requestId: req2 });
    assert.strictEqual(res2.completionEvidence, 'NETWORK_END_OF_STREAM');

    // Rank 3: UI_STOP_GENERATION_IDLE
    const req3 = 'req_ev_3';
    env.logger.db.prepare(`
      INSERT INTO bridge_requests (request_id, conversation_id, from_agent, to_agent, question, status, response, created_at, updated_at, completed_at, completion_evidence)
      VALUES (?, 'conv_3', 'gemini', 'chatgpt-desktop', 'Q3', 'completed', 'Ans 3', ?, ?, ?, 'UI_STOP_GENERATION_IDLE')
    `).run(req3, now, now, now);
    const res3 = await env.eventBus.waitForResponse({ requestId: req3 });
    assert.strictEqual(res3.completionEvidence, 'UI_STOP_GENERATION_IDLE');

    // Rank 4: STABILITY_HEURISTIC
    const req4 = 'req_ev_4';
    env.logger.db.prepare(`
      INSERT INTO bridge_requests (request_id, conversation_id, from_agent, to_agent, question, status, response, created_at, updated_at, completed_at, completion_evidence)
      VALUES (?, 'conv_4', 'gemini', 'freebuff', 'Q4', 'completed', 'Ans 4', ?, ?, ?, 'STABILITY_HEURISTIC')
    `).run(req4, now, now, now);
    const res4 = await env.eventBus.waitForResponse({ requestId: req4 });
    assert.strictEqual(res4.completionEvidence, 'STABILITY_HEURISTIC');
  });
});
