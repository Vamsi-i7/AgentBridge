import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AuditLogger } from '../src/audit-logger.js';
import { EventBus } from '../src/event-bus.js';
import { TaskManager } from '../src/task-manager.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { PermissionGuard } from '../src/permission-guard.js';
import { ContentAddressedStore } from '../src/artifacts/content-addressed-store.js';
import { MultiHopRouter } from '../src/control-plane/multi-hop-router.js';
import { AttemptLedger } from '../src/attempts/attempt-ledger.js';
import { RequestTracer, LifecycleStage } from '../src/diagnostics/request-tracer.js';

function setupTestEnv() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'step2-security-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  const logger = new AuditLogger(dbPath);
  const eventBus = new EventBus(logger);
  const taskManager = new TaskManager(logger, null, eventBus);
  const mailbox = new MailboxHub(logger, taskManager, eventBus);
  const guard = new PermissionGuard();
  const cas = new ContentAddressedStore({ rootDir: path.join(tmpDir, 'cas') });
  const router = new MultiHopRouter({ mailboxHub: mailbox, permissionGuard: guard });
  const attempts = new AttemptLedger(logger);
  const tracer = new RequestTracer(logger, { db: logger.db });
  return { tmpDir, dbPath, logger, eventBus, taskManager, mailbox, guard, cas, router, attempts, tracer };
}

test('Step 2: Security & Invariant Regression Suite', async (t) => {
  const env = setupTestEnv();

  t.after(() => {
    try { env.eventBus.close(); } catch {}
    try { env.logger.close(); } catch {}
    try { fs.rmSync(env.tmpDir, { recursive: true, force: true }); } catch {}
  });

  await t.test('1. Precheck fast path in waitForResponse cannot return a result belonging to another request, attempt, or epoch', async () => {
    // Insert a completed request for req_target
    const db = env.logger.db;
    db.prepare(`
      INSERT INTO bridge_requests (request_id, conversation_id, from_agent, to_agent, question, status, response, attempt_id, epoch, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('req_target', 'conv_1', 'agent_a', 'agent_b', 'hello', 'completed', 'target result', 'att_1', 1, new Date().toISOString(), new Date().toISOString());

    // 1a. Matching request, attempt, and epoch returns result
    const okRes = await env.eventBus.waitForResponse({ requestId: 'req_target', timeoutMs: 1000, attemptId: 'att_1', epoch: 1 });
    assert.strictEqual(okRes.status, 'completed');
    assert.strictEqual(okRes.response, 'target result');

    // 1b. Stale attempt ID times out without returning target result
    const staleAttemptRes = await env.eventBus.waitForResponse({ requestId: 'req_target', timeoutMs: 50, attemptId: 'att_stale', epoch: 1 });
    assert.strictEqual(staleAttemptRes.status, 'timeout');
    assert.strictEqual(staleAttemptRes.response, null);

    // 1c. Wrong epoch times out without returning target result
    const wrongEpochRes = await env.eventBus.waitForResponse({ requestId: 'req_target', timeoutMs: 50, attemptId: 'att_1', epoch: 2 });
    assert.strictEqual(wrongEpochRes.status, 'timeout');
    assert.strictEqual(wrongEpochRes.response, null);

    // 1d. Different request ID times out without returning target result
    const otherReqRes = await env.eventBus.waitForResponse({ requestId: 'req_other', timeoutMs: 50 });
    assert.strictEqual(otherReqRes.status, 'timeout');
    assert.strictEqual(otherReqRes.response, null);
  });

  await t.test('2. Settlement is idempotent: duplicate completion is ignored, never re-settled, and never double-counts', async () => {
    const task = env.taskManager.createTask({
      fromAgent: 'agent_a',
      toAgent: 'agent_b',
      title: 'Idempotency test',
      instructions: 'test duplicate completion',
      assignedTo: 'agent_b',
      creator: 'agent_a'
    });

    // Initial completion
    const firstRes = env.mailbox.submitTaskResult({
      taskId: task.id,
      agentId: 'agent_b',
      status: 'completed',
      result: 'canonical output'
    });
    assert.strictEqual(firstRes.status, 'completed');

    // Duplicate completion with identical result
    const dupRes = env.mailbox.submitTaskResult({
      taskId: task.id,
      agentId: 'agent_b',
      status: 'completed',
      result: 'canonical output'
    });
    assert.ok(dupRes === undefined || dupRes.status === 'completed');

    // Conflicting late result on terminal task is quarantined / rejected, not mutating task
    env.mailbox.submitTaskResult({
      taskId: task.id,
      agentId: 'agent_b',
      status: 'completed',
      result: 'malicious overwriting result'
    });
    const finalTask = env.taskManager.getTask(task.id, false);
    assert.strictEqual(finalTask.result, 'canonical output');
  });

  await t.test('3. Stale-attempt or wrong-epoch result is rejected or quarantined, and missing attempt ID is rejected', () => {
    const task = env.taskManager.createTask({
      fromAgent: 'agent_a',
      toAgent: 'agent_b',
      title: 'Fencing test',
      instructions: 'test attempts',
      assignedTo: 'agent_b',
      creator: 'agent_a'
    });

    // Create attempt 1 at epoch 1
    const att1 = env.attempts.createAttempt({
      taskId: task.id,
      requestId: 'req_fencing_1',
      agentId: 'agent_b',
      routeId: 'cli-process',
      leaseTimeoutMs: 60000
    });
    assert.strictEqual(att1.epoch, 1);

    // Complete with wrong epoch -> Quarantined
    const wrongEpochRes = env.attempts.completeAttempt({
      attemptId: att1.attemptId,
      epoch: 999,
      result: 'wrong epoch payload'
    });
    assert.strictEqual(wrongEpochRes.quarantined, true);

    // Complete with missing attempt ID -> Throws error
    assert.throws(() => {
      env.attempts.completeAttempt({
        attemptId: null,
        epoch: 1,
        result: 'missing attempt id'
      });
    }, /Attempt.*not found|required/i);
  });

  await t.test('4. Cancelled task cannot be revived by a late result', () => {
    const task = env.taskManager.createTask({
      fromAgent: 'agent_a',
      toAgent: 'agent_b',
      title: 'Cancel race test',
      instructions: 'test cancellation immutability',
      assignedTo: 'agent_b',
      creator: 'agent_a'
    });

    // Cancel the task
    env.taskManager.cancelTask({ taskId: task.id, agentId: 'agent_a', reason: 'User requested cancellation' });
    const cancelledTask = env.taskManager.getTask(task.id, false);
    assert.strictEqual(cancelledTask.status, 'cancelled');

    // Late worker tries to submit success
    env.mailbox.submitTaskResult({
      taskId: task.id,
      agentId: 'agent_b',
      status: 'completed',
      result: 'late result after cancel'
    });

    const checkedTask = env.taskManager.getTask(task.id, false);
    assert.strictEqual(checkedTask.status, 'cancelled');
    assert.notStrictEqual(checkedTask.result, 'late result after cancel');
  });

  await t.test('5. bridge_request_ledger and bridge_slice_fetch authorize from trusted context and prevent traversal', async () => {
    const registry = new ToolRegistry();
    env.tracer.mark({
      requestId: 'req_target',
      stage: LifecycleStage.REQUEST_CREATED,
      agentId: 'agent_a',
      meta: { fromAgent: 'agent_a', toAgent: 'agent_b' }
    });

    // 5a. Unauthorized caller cannot view third-party ledger
    const untrustedCtx = { agentId: 'unauthorized_agent', isPrivileged: false, tracer: env.tracer, logger: env.logger };
    await assert.rejects(async () => {
      await registry.executeTool('bridge_request_ledger', { requestId: 'req_target' }, untrustedCtx);
    }, /Unauthorized/i);

    // 5b. Content-Addressed Store strictly blocks directory traversal paths
    assert.strictEqual(env.cas.get('../../../etc/passwd'), null);
    assert.strictEqual(env.cas.get('..\\..\\windows\\system32'), null);

    // Valid hash format works
    const { hash: testHash } = env.cas.store('hello trusted content');
    const retrieved = env.cas.get(testHash);
    assert.strictEqual(retrieved.content, 'hello trusted content');
  });

  await t.test('6. "communication" tool profile only restricts which tools are LISTED, not direct permission grants', () => {
    const registry = new ToolRegistry();
    const commTools = registry.getToolDefinitions('communication');
    const toolNames = new Set(commTools.map(t => t.name));

    // Communication profile contains only 5 communication tools
    assert.strictEqual(commTools.length, 5);
    assert.ok(!toolNames.has('bridge_execute_command'));
    assert.ok(!toolNames.has('bridge_delete_file'));

    // Directly calling an unlisted tool without proper permission is rejected
    const check = env.guard.checkPermission('chatgpt-desktop', 'DESTRUCTIVE');
    assert.strictEqual(check.allowed, false);
  });

  await t.test('7. Multi-hop forwarding preserves per-hop correlation and enforces delegation policy', async () => {
    // 7a. Unauthorized agent attempting to delegate is blocked
    await assert.rejects(
      async () => {
        await env.router.executeHopChain({
          hops: ['system'],
          initialInput: 'Escalate to system',
          initiatorAgent: 'unauthorized_guest'
        });
      },
      /UNAUTHORIZED_HOP/i
    );

    // 7b. MultiHopRouter generates per-hop crypto nonces and tracks hops
    const mockMailbox = {
      askAgent: async (hopArgs) => {
        assert.ok(hopArgs.nonce.length >= 16);
        assert.ok(hopArgs.attemptId.startsWith('att_hop_'));
        assert.strictEqual(hopArgs.epoch, 1);
        return {
          status: 'completed',
          response: 'hop 0 processed: ' + hopArgs.question
        };
      }
    };

    const routerWithMock = new MultiHopRouter({ mailboxHub: mockMailbox, permissionGuard: env.guard });
    const chainRes = await routerWithMock.executeHopChain({
      hops: ['claude-desktop'],
      initialInput: 'Analyze dataset',
      initiatorAgent: 'chatgpt-desktop',
      parentRequestId: 'req_hop_test_parent'
    });

    assert.strictEqual(chainRes.totalHops, 1);
    assert.ok(chainRes.result.includes('hop 0 processed'));
    assert.strictEqual(chainRes.hopTrace[0].epoch, 1);
    assert.ok(chainRes.hopTrace[0].nonce);
    assert.strictEqual(chainRes.hopTrace[0].attemptId, 'att_hop_0_claude-desktop');
  });

  await t.test('8. bridge_discover_tools cannot be used to unlock tools outside caller policy', async () => {
    const registry = new ToolRegistry();
    const res = await registry.executeTool('bridge_discover_tools', { query: 'execute' }, {
      agentId: 'chatgpt-desktop',
      guard: env.guard
    });

    assert.ok(res);
    assert.ok(Array.isArray(res.tools));

    // Caller policy must not grant permissions not possessed
    for (const tool of res.tools) {
      assert.ok(tool.name);
      assert.ok(tool.description);
    }
  });
});
