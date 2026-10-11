import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'os';

import { AuditLogger } from '../src/audit-logger.js';
import { EventBus } from '../src/event-bus.js';
import { TaskManager } from '../src/task-manager.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { MultiHopRouter } from '../src/control-plane/multi-hop-router.js';

function setupEnv() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'multihop-test-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  const logger = new AuditLogger(dbPath);
  const eventBus = new EventBus(logger);
  const taskManager = new TaskManager(logger, null, eventBus);
  const mailbox = new MailboxHub(logger, taskManager, eventBus);
  const router = new MultiHopRouter({ mailboxHub: mailbox, taskManager, eventBus });
  return { tmpDir, dbPath, logger, eventBus, taskManager, mailbox, router };
}

test('Mission E — Multi-Hop Routing & Parallel Fan-Out/Fan-In Suite [MOCK-ONLY]', async (t) => {
  const env = setupEnv();

  t.after(() => {
    try { env.eventBus.close(); } catch {}
    try { env.logger.close(); } catch {}
    try { fs.rmSync(env.tmpDir, { recursive: true, force: true }); } catch {}
  });

  // Register mock synchronous handlers for pipeline agents
  env.mailbox.registerAgentHandler('chatgpt-desktop', async (query) => {
    return `[ChatGPT Step]: Processed "${query}"`;
  });
  env.mailbox.registerAgentHandler('gemini', async (query) => {
    return `[Gemini Step]: Synthesized "${query}"`;
  });
  env.mailbox.registerAgentHandler('claude-desktop', async (query) => {
    return `[Claude Step]: Refined "${query}"`;
  });

  await t.test('1. End-to-end 5-hop pipeline: ChatGPT -> Gemini -> Claude -> Gemini -> ChatGPT [MOCK-ONLY]', async () => {
    const hops = [
      'chatgpt-desktop',
      'gemini',
      'claude-desktop',
      'gemini',
      'chatgpt-desktop'
    ];

    const result = await env.router.executeHopChain({
      hops,
      initialInput: 'Initial User Directive: Audit cross-agent consensus.',
      parentRequestId: 'req_hop_5_e2e'
    });

    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.totalHops, 5);
    assert.strictEqual(result.finalAgent, 'chatgpt-desktop');
    assert.ok(result.result.includes('[ChatGPT Step]: Processed "[Gemini Step]: Synthesized "[Claude Step]'));

    // Verify correlation trace at every hop
    assert.strictEqual(result.hopTrace.length, 5);
    assert.strictEqual(result.hopTrace[0].toAgent, 'chatgpt-desktop');
    assert.strictEqual(result.hopTrace[0].epoch, 1);
    assert.strictEqual(result.hopTrace[1].toAgent, 'gemini');
    assert.strictEqual(result.hopTrace[1].epoch, 2);
    assert.strictEqual(result.hopTrace[2].toAgent, 'claude-desktop');
    assert.strictEqual(result.hopTrace[2].epoch, 3);
    assert.strictEqual(result.hopTrace[3].toAgent, 'gemini');
    assert.strictEqual(result.hopTrace[3].epoch, 4);
    assert.strictEqual(result.hopTrace[4].toAgent, 'chatgpt-desktop');
    assert.strictEqual(result.hopTrace[4].epoch, 5);
  });

  await t.test('2. Hop limit prevents infinite delegation loops (maxHops guard)', async () => {
    const infiniteHops = Array(15).fill('gemini');

    await assert.rejects(async () => {
      await env.router.executeHopChain({
        hops: infiniteHops,
        initialInput: 'Loop check',
        maxHops: 10
      });
    }, (err) => {
      return err.code === 'HOP_LIMIT_EXCEEDED' && err.message.includes('exceeds max allowed hops 10');
    });
  });

  await t.test('3. Fan-out / Fan-in: parallel child tasks joined into a single wake-up for parent', async () => {
    const parentTaskId = 'task_parent_101';
    const childTasks = [
      { toAgent: 'gemini', title: 'Part A', instructions: 'Analyze AST' },
      { toAgent: 'claude-desktop', title: 'Part B', instructions: 'Generate Type Signatures' },
      { toAgent: 'chatgpt-desktop', title: 'Part C', instructions: 'Synthesize Unit Tests' }
    ];

    // Simulate concurrent child task completions
    const fanPromise = env.router.executeFanOutFanIn({
      parentTaskId,
      childTasks,
      timeoutMs: 5000
    });

    // Provide asynchronous worker completions for children
    setTimeout(() => {
      const activeChildren = Array.from(env.router.childTasksByParent.get(parentTaskId) || []);
      for (const childId of activeChildren) {
        const t = env.taskManager.getTask(childId);
        env.mailbox.submitTaskResult({
          taskId: childId,
          agentId: t.assignee || t.to_agent,
          status: 'completed',
          result: `Done for ${childId}`
        });
      }
    }, 25);

    const joinedResult = await fanPromise;
    assert.strictEqual(joinedResult.status, 'completed');
    assert.strictEqual(joinedResult.totalChildren, 3);
    assert.strictEqual(joinedResult.completedCount, 3);
    assert.strictEqual(joinedResult.failedCount, 0);
    assert.strictEqual(joinedResult.results.length, 3);
  });

  await t.test('4. Cancel propagation: cancelling parent cascades to all in-flight child tasks', async () => {
    const parentTaskId = 'task_parent_cancel_test';
    const childTasks = [
      { toAgent: 'gemini', title: 'Long task 1', instructions: 'Sleep and compute' },
      { toAgent: 'claude-desktop', title: 'Long task 2', instructions: 'Sleep and compute' }
    ];

    const fanPromise = env.router.executeFanOutFanIn({
      parentTaskId,
      childTasks,
      timeoutMs: 10000
    });

    // Verify children registered
    const children = Array.from(env.router.childTasksByParent.get(parentTaskId) || []);
    assert.strictEqual(children.length, 2);

    // Cancel parent
    const cancelRes = env.router.propagateCancel(parentTaskId, 'Parent aborted by user');
    assert.strictEqual(cancelRes.cancelledChildrenCount, 2);

    // Children are now cancelled in TaskManager
    for (const childId of children) {
      const task = env.taskManager.getTask(childId);
      assert.strictEqual(task.status, 'cancelled');
    }

    const outcome = await fanPromise;
    assert.strictEqual(outcome.status, 'partial_failure');
    assert.strictEqual(outcome.failedCount, 2);
  });
});
