import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';

import { AuditLogger } from '../src/audit-logger.js';
import { EventBus } from '../src/event-bus.js';
import { TaskManager } from '../src/task-manager.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { AttemptLedger } from '../src/attempts/attempt-ledger.js';
import { DesktopAgentWorker, DesktopAgentWorkerStatus } from '../src/control-plane/desktop-agent-worker.js';
import { ResponseObserver, ObserverState } from '../src/control-plane/response-observer.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { BridgeHttpServer } from '../src/http-server.js';
import { ArtifactStore, ArtifactError } from '../src/artifacts/artifact-store.js';
import { ResponseCorrelatorV2, CorrelationTier, CorrelationConfidence } from '../src/correlation/response-correlator-v2.js';
import { ModelOrchestrator } from '../src/control-plane/model-orchestrator.js';
import { DesktopControlPlane } from '../src/control-plane/desktop-control-plane.js';

function createTempDb() {
  const dbPath = path.join(os.tmpdir(), `test_verify_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.db`);
  const logger = new AuditLogger(dbPath);
  return { dbPath, logger };
}

function cleanupDb(dbPath) {
  try { if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath); } catch {}
  try { if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal'); } catch {}
  try { if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm'); } catch {}
}

function httpRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: data, json });
      });
    });
    req.on('error', reject);
    if (body) {
      if (typeof body === 'object') {
        req.setHeader('Content-Type', 'application/json');
        req.write(JSON.stringify(body));
      } else {
        req.write(body);
      }
    }
    req.end();
  });
}

test('CRITICAL VERIFICATION A — ATTEMPT FENCING', async (t) => {
  await t.test('A.1 Reproduce exact race: Worker A claims attempt A, expires/fenced, Worker B claims B; Worker A late success cannot overwrite B', async () => {
    const { dbPath, logger } = createTempDb();
    const taskManager = new TaskManager(logger);
    const eventBus = new EventBus(logger);
    const mailbox = new MailboxHub(logger, taskManager, eventBus);

    // Create a task
    const task = taskManager.createTask({
      title: 'Attempt Fencing Race Task',
      description: 'Test attempt fencing with expired worker A and active worker B',
      instructions: 'Execute instructions under fencing',
      fromAgent: 'freebuff',
      toAgent: 'chatgpt-desktop',
      routeId: 'ui_automation'
    });
    assert.ok(task && task.id);

    // Worker A claims attempt A (epoch 1)
    const claimA = taskManager.claimTask(task.id, 'chatgpt-desktop');
    assert.equal(claimA.epoch, 1);
    const attemptA = claimA.attemptId;
    assert.ok(attemptA);

    // Simulate attempt A lease expiration: set task and attempt to past timestamp
    const pastTime = new Date(Date.now() - 120000).toISOString();
    taskManager.db.prepare(`
      UPDATE tasks SET updated_at = ?, started_at = ? WHERE id = ?
    `).run(pastTime, pastTime, task.id);
    taskManager.db.prepare(`
      UPDATE bridge_attempts SET lease_expires_at = ? WHERE attempt_id = ?
    `).run(pastTime, attemptA);

    // Lease recovery resets task to pending
    const recovered = taskManager.recoverExpiredTasks('chatgpt-desktop');
    assert.ok(recovered.length >= 1, 'Task must be recovered after lease expiry');
    assert.equal(recovered[0].taskId, task.id);
    assert.equal(recovered[0].status, 'pending');

    // Worker B claims attempt B (epoch 2)
    const claimB = taskManager.claimTask(task.id, 'chatgpt-desktop');
    assert.equal(claimB.epoch, 2);
    const attemptB = claimB.attemptId;
    assert.ok(attemptB);
    assert.notEqual(attemptA, attemptB);

    // Worker A returns late success with attempt A (epoch 1)
    let lateSuccessError = null;
    try {
      taskManager.updateTaskStatus({
        taskId: task.id,
        agentId: 'chatgpt-desktop',
        status: 'completed',
        result: 'Late result from Worker A',
        attemptId: attemptA,
        epoch: 1
      });
    } catch (err) {
      lateSuccessError = err;
    }
    assert.ok(lateSuccessError, 'Worker A late submission must throw FENCED_ATTEMPT_ERROR');
    assert.match(lateSuccessError.message, /FENCED_ATTEMPT_ERROR/);

    // Verify task is NOT completed by Worker A
    const currentTaskAfterLateA = taskManager.getTask(task.id, false);
    assert.notEqual(currentTaskAfterLateA.status, 'completed');
    assert.equal(currentTaskAfterLateA.status, 'claimed');

    // Verify late result from Worker A was quarantined in AttemptLedger
    const quarantinedLogs = taskManager.attempts.getQuarantinedResponses(task.id);
    assert.ok(quarantinedLogs.length >= 1, 'Worker A response must be recorded in quarantine');
    assert.equal(quarantinedLogs[0].attempt_id, attemptA);

    // Worker B returns correct success with attempt B (epoch 2)
    const settleB = taskManager.updateTaskStatus({
      taskId: task.id,
      agentId: 'chatgpt-desktop',
      status: 'completed',
      result: 'Correct result from Worker B',
      attemptId: attemptB,
      epoch: 2
    });
    assert.equal(settleB.status, 'completed');
    assert.equal(settleB.result, 'Correct result from Worker B');

    // Task is now settled by B
    const finalTask = taskManager.getTask(task.id);
    assert.equal(finalTask.status, 'completed');
    assert.equal(finalTask.result, 'Correct result from Worker B');

    eventBus.close();
    cleanupDb(dbPath);
  });

  await t.test('A.2 Submission with missing epoch or mismatched attemptId is rejected and quarantined', async () => {
    const { dbPath, logger } = createTempDb();
    const taskManager = new TaskManager(logger);
    const mailbox = new MailboxHub(logger, taskManager);

    const task = taskManager.createTask({
      title: 'Strict Fencing Test',
      instructions: 'Run test instructions',
      fromAgent: 'freebuff',
      toAgent: 'chatgpt-desktop'
    });
    const claim = taskManager.claimTask(task.id, 'chatgpt-desktop');
    assert.equal(claim.epoch, 1);

    // Try submitting with wrong epoch
    assert.throws(() => {
      taskManager.updateTaskStatus({
        taskId: task.id,
        agentId: 'chatgpt-desktop',
        status: 'completed',
        result: 'Stale epoch submission',
        attemptId: claim.attemptId,
        epoch: 999
      });
    }, /FENCED_ATTEMPT_ERROR/);

    // Try submitting with wrong attemptId
    assert.throws(() => {
      taskManager.updateTaskStatus({
        taskId: task.id,
        agentId: 'chatgpt-desktop',
        status: 'completed',
        result: 'Bogus attempt submission',
        attemptId: 'bogus_attempt_xyz',
        epoch: 1
      });
    }, /FENCED_ATTEMPT_ERROR/);

    cleanupDb(dbPath);
  });

  await t.test('A.3 DesktopAgentWorker passes attemptId and epoch tokens through to settlement', async () => {
    const { dbPath, logger } = createTempDb();
    const taskManager = new TaskManager(logger);
    const mailbox = new MailboxHub(logger, taskManager);

    const task = taskManager.createTask({
      title: 'Worker Token Propagation Test',
      fromAgent: 'freebuff',
      toAgent: 'chatgpt-desktop',
      instructions: 'Return token test response'
    });

    const session = {
      async send({ text, requestId }) {
        return { success: true, status: 'COMPLETED', response: 'Worker computed answer' };
      },
      async capabilities() { return {}; }
    };

    const worker = new DesktopAgentWorker({
      agentId: 'chatgpt-desktop',
      mailboxHub: mailbox,
      session
    });

    // Handle the task via worker
    const deliverResult = await worker.handleRequest(`req_task_${task.id}`);
    assert.equal(deliverResult.handled, true);
    assert.equal(deliverResult.status, 'COMPLETED');

    const completedTask = taskManager.getTask(task.id);
    assert.equal(completedTask.status, 'completed');
    assert.equal(completedTask.result, 'Worker computed answer');

    cleanupDb(dbPath);
  });
});

test('CRITICAL VERIFICATION B — DURABLE DELIVERY CLAIMS', async (t) => {
  await t.test('B.1 Two independent workers against same store: only 1 invokes model turn', async () => {
    const { dbPath, logger } = createTempDb();
    const taskManager = new TaskManager(logger);
    const mailbox = new MailboxHub(logger, taskManager);

    // Create a standalone request
    const now = new Date().toISOString();
    mailbox.db.prepare(`
      INSERT INTO bridge_requests (request_id, conversation_id, from_agent, to_agent, question, status, timeout_ms, created_at, updated_at)
      VALUES ('req_concurrent_delivery', 'conv_b1', 'freebuff', 'chatgpt-desktop', 'question for worker', 'pending', 60000, ?, ?)
    `).run(now, now);

    let worker1ModelInvocations = 0;
    let worker2ModelInvocations = 0;

    const session1 = {
      async send() {
        worker1ModelInvocations++;
        await new Promise(r => setTimeout(r, 40));
        return { success: true, status: 'COMPLETED', response: 'Answer from worker 1' };
      },
      async capabilities() { return {}; }
    };

    const session2 = {
      async send() {
        worker2ModelInvocations++;
        await new Promise(r => setTimeout(r, 40));
        return { success: true, status: 'COMPLETED', response: 'Answer from worker 2' };
      },
      async capabilities() { return {}; }
    };

    const worker1 = new DesktopAgentWorker({ agentId: 'chatgpt-desktop', workerId: 'worker_proc_1', mailboxHub: mailbox, session: session1 });
    const worker2 = new DesktopAgentWorker({ agentId: 'chatgpt-desktop', workerId: 'worker_proc_2', mailboxHub: mailbox, session: session2 });

    // Race both workers concurrently on the same pending request
    const [res1, res2] = await Promise.all([
      worker1.handleRequest('req_concurrent_delivery'),
      worker2.handleRequest('req_concurrent_delivery')
    ]);

    const totalModelInvocations = worker1ModelInvocations + worker2ModelInvocations;
    assert.equal(totalModelInvocations, 1, 'Exactly ONE worker must initiate model/UI turn');

    // One must have handled it, the other was denied claim
    const handledCount = (res1.handled ? 1 : 0) + (res2.handled ? 1 : 0);
    assert.equal(handledCount, 1, 'Only the authorized claimant handles delivery');

    const denied = res1.handled ? res2 : res1;
    assert.equal(denied.handled, false);
    assert.equal(denied.error, 'CLAIM_DENIED');

    cleanupDb(dbPath);
  });

  await t.test('B.2 Crash simulation: lease expiry, recovery, and fence enforcement', async () => {
    const { dbPath, logger } = createTempDb();
    const taskManager = new TaskManager(logger);
    const mailbox = new MailboxHub(logger, taskManager);

    const now = new Date().toISOString();
    mailbox.db.prepare(`
      INSERT INTO bridge_requests (request_id, conversation_id, from_agent, to_agent, question, status, timeout_ms, created_at, updated_at)
      VALUES ('req_crash_sim', 'conv_crash', 'freebuff', 'chatgpt-desktop', 'crash question', 'pending', 60000, ?, ?)
    `).run(now, now);

    // 1. Crash after claim acquisition, before model invocation: Worker 1 acquires lease with short duration
    const claim1 = mailbox.claimRequest({
      requestId: 'req_crash_sim',
      agentId: 'chatgpt-desktop',
      workerId: 'worker_crash_1',
      leaseMs: 30 // 30ms lease
    });
    assert.equal(claim1.claimed, true);
    assert.equal(claim1.epoch, 1);

    // Worker 2 attempts immediate claim while lease active -> denied
    const claimTooSoon = mailbox.claimRequest({
      requestId: 'req_crash_sim',
      agentId: 'chatgpt-desktop',
      workerId: 'worker_crash_2',
      leaseMs: 30000
    });
    assert.equal(claimTooSoon.claimed, false);
    assert.equal(claimTooSoon.error, 'LEASE_ACTIVE');

    // Wait for lease to expire
    await new Promise(r => setTimeout(r, 40));

    // Worker 2 reclaims after lease expiry -> succeeds with bumped epoch
    const claimRecovered = mailbox.claimRequest({
      requestId: 'req_crash_sim',
      agentId: 'chatgpt-desktop',
      workerId: 'worker_crash_2',
      leaseMs: 30000
    });
    assert.equal(claimRecovered.claimed, true);
    assert.equal(claimRecovered.epoch, 2);

    // 2. Worker 1 now wakes up from crash and tries to answer with epoch 1
    const lateAnswerFromWorker1 = mailbox.answerRequest({
      requestId: 'req_crash_sim',
      agentId: 'chatgpt-desktop',
      response: 'Late answer from crashed worker 1',
      status: 'completed',
      attemptId: claim1.attemptId,
      epoch: 1
    });
    assert.equal(lateAnswerFromWorker1.status, 'quarantined');
    assert.equal(lateAnswerFromWorker1.quarantined, true);

    // 3. Worker 2 answers with epoch 2 -> succeeds
    const goodAnswerFromWorker2 = mailbox.answerRequest({
      requestId: 'req_crash_sim',
      agentId: 'chatgpt-desktop',
      response: 'Legitimate answer from recovered worker 2',
      status: 'completed',
      attemptId: claimRecovered.attemptId,
      epoch: 2
    });
    assert.equal(goodAnswerFromWorker2.status, 'success');

    const finalReq = mailbox.getRequest('req_crash_sim');
    assert.equal(finalReq.status, 'completed');
    assert.equal(finalReq.response, 'Legitimate answer from recovered worker 2');

    cleanupDb(dbPath);
  });

  await t.test('B.3 Legacy database migration safety: alters schema without data loss', async () => {
    const { dbPath, logger } = createTempDb();
    // Simulate legacy table without new lease columns
    logger.db.exec(`
      CREATE TABLE IF NOT EXISTS bridge_requests_legacy (
        request_id TEXT PRIMARY KEY,
        conversation_id TEXT,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        question TEXT NOT NULL,
        status TEXT NOT NULL,
        timeout_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO bridge_requests (request_id, conversation_id, from_agent, to_agent, question, status, timeout_ms, created_at, updated_at)
      VALUES ('legacy_req_1', 'conv_leg', 'freebuff', 'chatgpt-desktop', 'legacy prompt', 'pending', 60000, datetime('now'), datetime('now'));
    `);

    // Instantiate MailboxHub which triggers _ensureRequestColumns()
    const mailbox = new MailboxHub(logger);
    const cols = logger.db.prepare(`PRAGMA table_info(bridge_requests)`).all().map(c => c.name);
    assert.ok(cols.includes('claimed_by'), 'Migration must add claimed_by column');
    assert.ok(cols.includes('lease_expires_at'), 'Migration must add lease_expires_at column');
    assert.ok(cols.includes('attempt_id'), 'Migration must add attempt_id column');
    assert.ok(cols.includes('epoch'), 'Migration must add epoch column');

    // Existing rows are preserved and claimable
    const claim = mailbox.claimRequest({
      requestId: 'legacy_req_1',
      agentId: 'chatgpt-desktop',
      workerId: 'worker_migration_1'
    });
    assert.equal(claim.claimed, true);
    assert.equal(claim.epoch, 1);

    cleanupDb(dbPath);
  });
});

test('CRITICAL VERIFICATION C — CANCELLATION AND RETRIES', async (t) => {
  await t.test('C.1 Task cancellation racing against late success and late failure', async () => {
    const { dbPath, logger } = createTempDb();
    const taskManager = new TaskManager(logger);

    const task = taskManager.createTask({
      title: 'Cancellation Race Task',
      instructions: 'Do cancellation test work',
      fromAgent: 'freebuff',
      toAgent: 'chatgpt-desktop'
    });
    const claim = taskManager.claimTask(task.id, 'chatgpt-desktop');

    // Task is cancelled by requester
    const cancelled = taskManager.cancelTask({ taskId: task.id, agentId: 'freebuff', reason: 'User aborted' });
    assert.equal(cancelled.status, 'cancelled');

    // Late success racing against cancellation -> quarantined, cannot overwrite cancelled status
    taskManager.updateTaskStatus({
      taskId: task.id,
      agentId: 'chatgpt-desktop',
      status: 'completed',
      result: 'Late completion after cancel',
      attemptId: claim.attemptId,
      epoch: claim.epoch
    });

    // Task remains cancelled
    const taskAfterLateSuccess = taskManager.getTask(task.id);
    assert.equal(taskAfterLateSuccess.status, 'cancelled');
    assert.equal(taskAfterLateSuccess.result, null);

    // Late failure racing against cancellation -> ignored, does not change status
    const failRes = taskManager.failTask({
      taskId: task.id,
      agentId: 'chatgpt-desktop',
      error: 'Late failure after cancel',
      attemptId: claim.attemptId,
      epoch: claim.epoch
    });
    assert.equal(failRes.status, 'cancelled');
    assert.equal(taskManager.getTask(task.id).status, 'cancelled');

    cleanupDb(dbPath);
  });

  await t.test('C.2 Retry counter accounting and recovery idempotency', async () => {
    const { dbPath, logger } = createTempDb();
    const taskManager = new TaskManager(logger);

    const task = taskManager.createTask({
      title: 'Retry Accounting Task',
      instructions: 'Do retry accounting work',
      fromAgent: 'freebuff',
      toAgent: 'chatgpt-desktop',
      maxRetries: 2
    });
    const initialTask = taskManager.getTask(task.id, false);
    assert.equal(initialTask.retryCount, 0);

    // Attempt 1 fails -> retry 1
    const claim1 = taskManager.claimTask(task.id, 'chatgpt-desktop');
    const fail1 = taskManager.failTask({
      taskId: task.id,
      agentId: 'chatgpt-desktop',
      error: 'Temporary error 1',
      attemptId: claim1.attemptId,
      epoch: claim1.epoch
    });
    assert.equal(fail1.retryCount, 1);
    assert.equal(fail1.status, 'pending');

    // Attempting same failure again with stale token does NOT increment retry count
    const staleFail = taskManager.failTask({
      taskId: task.id,
      agentId: 'chatgpt-desktop',
      error: 'Duplicate failure callback',
      attemptId: claim1.attemptId,
      epoch: claim1.epoch
    });
    const currentTask = taskManager.getTask(task.id, false);
    assert.equal(currentTask.retryCount, 1, 'Retry count must NOT be incremented twice by stale attempt');

    // Run recovery repeatedly and verify idempotency
    const rec1 = taskManager.recoverExpiredTasks();
    const rec2 = taskManager.recoverExpiredTasks();
    const afterRecTask = taskManager.getTask(task.id, false);
    assert.equal(afterRecTask.retryCount, 1, 'Recovery runs must be idempotent and not inflate retries');

    cleanupDb(dbPath);
  });
});

test('CRITICAL VERIFICATION D — SECURITY: MCP ROUTES & PRIVILEGED TOOL MATRIX', async (t) => {
  const { dbPath, logger } = createTempDb();
  const taskManager = new TaskManager(logger);
  const eventBus = new EventBus(logger);
  const mailbox = new MailboxHub(logger, taskManager, eventBus);
  const registry = new ToolRegistry();

  const TEST_API_KEY = 'test_super_secret_bridge_key_123';
  const server = new BridgeHttpServer({
    port: 0, // ephemeral port
    host: '127.0.0.1',
    apiKey: TEST_API_KEY,
    requireApiKey: true,
    auditLogger: logger,
    taskManager,
    mailboxHub: mailbox,
    toolRegistry: registry
  });
  await server.start();
  const port = server.port;

  try {
    // D.1 No credentials on protected REST endpoint -> 401
    const resNoCreds = await httpRequest({
      host: '127.0.0.1',
      port,
      path: '/api/task',
      method: 'POST'
    }, { title: 'Hack Task', instructions: 'steal keys' });
    assert.equal(resNoCreds.status, 401, 'No credentials must return 401');

    // D.2 Invalid credentials -> 401
    const resBadCreds = await httpRequest({
      host: '127.0.0.1',
      port,
      path: '/api/task',
      method: 'POST',
      headers: { 'Authorization': 'Bearer wrong_key' }
    }, { title: 'Hack Task', instructions: 'steal keys' });
    assert.equal(resBadCreds.status, 401, 'Invalid credentials must return 401');

    // D.3 Valid credentials -> 200/accepted
    const resValidCreds = await httpRequest({
      host: '127.0.0.1',
      port,
      path: '/api/task',
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TEST_API_KEY}` }
    }, {
      title: 'Authorized Task',
      instructions: 'Perform verified work',
      fromAgent: 'freebuff',
      toAgent: 'chatgpt-desktop'
    });
    assert.equal(resValidCreds.status, 200, 'Valid credentials must succeed');

    // D.4 Forged x-agent-id without valid credentials -> 401
    const resForgedNoKey = await httpRequest({
      host: '127.0.0.1',
      port,
      path: '/api/task',
      method: 'POST',
      headers: { 'x-agent-id': 'system' }
    }, { title: 'Forged Task', instructions: 'fake system task' });
    assert.equal(resForgedNoKey.status, 401, 'Forged x-agent-id without key must return 401');

    // D.5 System identity escalation via x-agent-id
    const resSystemEscalation = await httpRequest({
      host: '127.0.0.1',
      port,
      path: '/api/audit',
      method: 'GET',
      headers: { 'x-agent-id': 'system' }
    });
    assert.equal(resSystemEscalation.status, 401, 'Unauthenticated system identity escalation must be blocked');

    // D.6 Ordinary agent accessing audit logs -> 403 Forbidden
    let auditLogBlocked = false;
    try {
      await registry.executeTool('bridge_get_audit_log', { limit: 10 }, {
        auditLogger: logger,
        callerAgentId: 'ordinary-agent',
        isPrivileged: false
      });
    } catch (err) {
      auditLogBlocked = true;
      assert.match(err.message, /Forbidden.*privileged/);
    }
    assert.equal(auditLogBlocked, true, 'Ordinary agent must be forbidden from reading audit logs');

    // D.7 Unauthorized artifact access
    const artifactStore = new ArtifactStore(logger);
    const storedPng = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
    const art = artifactStore.put({
      agentId: 'agent_alice',
      authorizedAgents: ['agent_alice', 'agent_bob'],
      bytes: storedPng,
      mimeType: 'image/png'
    });
    assert.ok(art.artifactId);

    // Agent Charlie tries to read it -> unauthorized
    assert.throws(() => {
      artifactStore.readChunk(art.artifactId, { agentId: 'agent_charlie' });
    }, (err) => err instanceof ArtifactError && err.code === 'ARTIFACT_UNAUTHORIZED');

    // D.8 Alternate routes and browser Origin protection: Origin header rejected
    const resBrowserOrigin = await httpRequest({
      host: '127.0.0.1',
      port,
      path: '/api/chatgpt/complete',
      method: 'POST',
      headers: {
        'Origin': 'https://evil.attacker.com',
        'Authorization': `Bearer ${TEST_API_KEY}`
      }
    }, { messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(resBrowserOrigin.status, 403, 'Browser origin header must be blocked with 403');

  } finally {
    await server.stop();
    eventBus.close();
    cleanupDb(dbPath);
  }
});

test('CRITICAL VERIFICATION E — RESPONSE COMPLETION & STABILITY', async (t) => {
  await t.test('E.1 ResponseObserver: assistant response pausing temporarily is NOT reported as complete', async () => {
    let tickCount = 0;
    const mockProbe = async (targetApp) => {
      tickCount++;
      const baseRegions = [{ snippet: 'Prompt marker [Agent Bridge req_stability_test]' }];
      if (tickCount === 1) {
        return { running: true, isGenerating: true, textRegions: [...baseRegions, { snippet: 'Hello ' }] };
      }
      if (tickCount === 2) {
        return { running: true, isGenerating: true, textRegions: [...baseRegions, { snippet: 'Hello world ' }] };
      }
      if (tickCount === 3 || tickCount === 4) {
        // Paused temporarily!
        return { running: true, isGenerating: true, textRegions: [...baseRegions, { snippet: 'Hello world ' }] };
      }
      if (tickCount === 5) {
        return { running: true, isGenerating: true, textRegions: [...baseRegions, { snippet: 'Hello world, how can I help you today?' }] };
      }
      // Ticks 6, 7, 8: generation finished, text stable
      return {
        running: true,
        isGenerating: false,
        textRegions: [...baseRegions, { snippet: 'Hello world, how can I help you today?' }]
      };
    };

    const observer = new ResponseObserver({
      pollIntervalMs: 15,
      deltaAggregationThreshold: 1,
      minStableTicks: 3,
      probe: mockProbe
    });

    const completionPromise = new Promise((resolve) => {
      observer.on('response_completed', resolve);
    });

    observer.startObservation({ targetApp: 'ChatGPT', requestId: 'req_stability_test' });

    const completionEvent = await completionPromise;
    assert.equal(completionEvent.requestId, 'req_stability_test');
    assert.equal(completionEvent.response, 'Hello world, how can I help you today?');
    assert.ok(tickCount >= 8, `Expected at least 8 ticks to accommodate pause; actual: ${tickCount}`);
  });

  await t.test('E.2 Explicit end-of-turn signal completes without waiting for conservative timeout', async () => {
    let ticks = 0;
    const mockProbe = async () => {
      ticks++;
      return {
        running: true,
        isGenerating: false,
        turnFinished: true, // explicit signal!
        textRegions: [
          { snippet: 'Prompt [Agent Bridge req_explicit_turn]' },
          { snippet: 'Final answer text' }
        ]
      };
    };

    const observer = new ResponseObserver({
      pollIntervalMs: 15,
      minStableTicks: 5, // high conservative threshold
      probe: mockProbe
    });

    const completionPromise = new Promise((resolve) => {
      observer.on('response_completed', resolve);
    });

    observer.startObservation({ targetApp: 'Claude', requestId: 'req_explicit_turn' });
    const completion = await completionPromise;
    assert.equal(completion.response, 'Final answer text');
    assert.equal(completion.endOfTurnSignal, 'EXPLICIT_PROBE');
    assert.ok(ticks <= 2, `Explicit end-of-turn completes quickly (ticks=${ticks}) without waiting for 5 conservative ticks`);
  });
});

test('CRITICAL VERIFICATION F — OTHER CLAIMS', async (t) => {
  await t.test('F.1 EventBus shutdown waiter rejection', async () => {
    const { dbPath, logger } = createTempDb();
    const eventBus = new EventBus(logger);

    eventBus.close();
    assert.equal(eventBus.isClosed, true);

    const waitResult = await eventBus.waitForResponse('conv_closed', 'agent_x', 1000);
    assert.equal(waitResult.code, 'EVENT_BUS_CLOSED');
    assert.equal(waitResult.status, 'failed');

    cleanupDb(dbPath);
  });

  await t.test('F.2 EventBus drains > 100 events cleanly', async () => {
    const { dbPath, logger } = createTempDb();
    const eventBus = new EventBus(logger);

    const receivedEvents = [];
    eventBus.subscribe('agent_drain_test', (evt) => {
      receivedEvents.push(evt);
    });

    for (let i = 0; i < 150; i++) {
      eventBus.publish({
        type: 'test_burst_event',
        agentId: 'agent_drain_test',
        payload: { index: i },
        dedupKey: `burst_event_${i}`
      });
    }

    eventBus.drainEventsForAgent('agent_drain_test');
    assert.equal(receivedEvents.length, 150, 'All 150 published events must be drained without truncation');

    eventBus.close();
    cleanupDb(dbPath);
  });

  await t.test('F.3 Nonce consumption and replay rejection', async () => {
    const correlator = new ResponseCorrelatorV2({ nonceTtlMs: 2000 });
    const taggedPrompt = correlator.tagMessage('Hello world', 'req_nonce_test', null, {
      attemptId: 'att_1',
      epoch: 1,
      agentId: 'agent_a'
    });
    const nonce = correlator.extractNonce(taggedPrompt);
    assert.ok(nonce);

    // First consumption succeeds
    const result1 = correlator.correlateTurn({
      rawResponse: `Echoing prompt answer with ${nonce}`,
      expectedRequestId: 'req_nonce_test',
      nonce,
      agentId: 'agent_a',
      attemptId: 'att_1',
      epoch: 1
    });
    assert.equal(result1.confidence, CorrelationConfidence.VERIFIED);
    assert.equal(result1.tier, CorrelationTier.TIER_3_NONCE_TOKEN_ECHO);

    // Second consumption (replay attack) fails
    const result2 = correlator.correlateTurn({
      rawResponse: `Replaying previous response with ${nonce}`,
      expectedRequestId: 'req_nonce_test',
      nonce,
      agentId: 'agent_a',
      attemptId: 'att_1',
      epoch: 1
    });
    assert.equal(result2.isReplayed, true);
    assert.notEqual(result2.confidence, CorrelationConfidence.VERIFIED);
    assert.match(result2.evidence, /REPLAY_REJECTED/);
  });

  await t.test('F.4 Production use of ResponseCorrelatorV2', () => {
    const orchestrator = new ModelOrchestrator();
    assert.ok(orchestrator.correlator instanceof ResponseCorrelatorV2, 'ModelOrchestrator must default to ResponseCorrelatorV2');

    const controlPlane = new DesktopControlPlane();
    assert.ok(controlPlane.correlator instanceof ResponseCorrelatorV2, 'DesktopControlPlane must default to ResponseCorrelatorV2');
  });

  await t.test('F.5 ArtifactStore chunk integrity, ownership, and large file handling', () => {
    const { dbPath, logger } = createTempDb();
    const artifactStore = new ArtifactStore(logger);

    // Create 12MB simulated file buffer (plain text / binary)
    const largeBuf = Buffer.alloc(12 * 1024 * 1024, 'A');
    const stored = artifactStore.put({
      agentId: 'worker_uploader',
      authorizedAgents: ['worker_uploader', 'worker_downloader'],
      bytes: largeBuf,
      mimeType: 'text/plain'
    });
    assert.ok(stored.artifactId);
    assert.equal(stored.sizeBytes, 12 * 1024 * 1024);

    // Read in 8MB chunks
    const chunk1 = artifactStore.readChunk(stored.artifactId, {
      agentId: 'worker_downloader',
      offset: 0,
      length: 8 * 1024 * 1024
    });
    assert.equal(chunk1.bytes.length, 8 * 1024 * 1024);
    assert.equal(chunk1.eof, false);

    const chunk2 = artifactStore.readChunk(stored.artifactId, {
      agentId: 'worker_downloader',
      offset: 8 * 1024 * 1024,
      length: 8 * 1024 * 1024
    });
    assert.equal(chunk2.bytes.length, 4 * 1024 * 1024);
    assert.equal(chunk2.eof, true);

    // Reconstruct and verify SHA-256
    const combined = Buffer.concat([chunk1.bytes, chunk2.bytes]);
    const computedSha = crypto.createHash('sha256').update(combined).digest('hex');
    assert.equal(computedSha, stored.sha256, 'Reconstructed chunks must exactly match stored SHA-256');

    cleanupDb(dbPath);
  });

  await t.test('F.6 Synthetic handlers are strictly test-only gated in DesktopAgentWorker', async () => {
    const { dbPath, logger } = createTempDb();
    const mailbox = new MailboxHub(logger);

    let realSessionCalled = false;
    const session = {
      async send() {
        realSessionCalled = true;
        return { success: true, status: 'COMPLETED', response: 'real model turn' };
      },
      async capabilities() { return {}; }
    };

    // By default, allowSyntheticHandlers is false
    const worker = new DesktopAgentWorker({
      agentId: 'chatgpt-desktop',
      mailboxHub: mailbox,
      session
    });
    worker.registerHandler('mock_keyword', async () => 'synthetic response');

    // Insert request containing 'mock_keyword'
    const now = new Date().toISOString();
    mailbox.db.prepare(`
      INSERT INTO bridge_requests (request_id, conversation_id, from_agent, to_agent, question, status, timeout_ms, created_at, updated_at)
      VALUES ('req_synthetic_test', 'conv_syn', 'freebuff', 'chatgpt-desktop', 'Please run mock_keyword test', 'pending', 60000, ?, ?)
    `).run(now, now);

    const res = await worker.handleRequest('req_synthetic_test');
    assert.equal(res.handled, true);
    assert.equal(realSessionCalled, true, 'Synthetic handler must NOT replace real model turn when allowSyntheticHandlers is false');
    assert.equal(res.response, 'real model turn');

    cleanupDb(dbPath);
  });
});
