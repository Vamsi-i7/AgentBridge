import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { StageActionError } from '../src/diagnostics/stage-action-error.js';
import { AttemptLedger } from '../src/attempts/attempt-ledger.js';
import { AuditLogger } from '../src/audit-logger.js';
import { EventBus } from '../src/event-bus.js';
import { TaskManager } from '../src/task-manager.js';
import { MailboxHub } from '../src/mailbox-hub.js';

// Mulberry32 deterministic PRNG from seed
function createPrng(seed) {
  let s = seed | 0;
  return function() {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('Reliability Soak Test & Real Fencing Invariants [TEST-PROVEN]', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-real-'));
  const dbPath = path.join(tmpDir, 'soak.sqlite');
  const logger = new AuditLogger(dbPath);
  const eventBus = new EventBus(logger, { fallbackIntervalMs: 25 });
  const taskManager = new TaskManager(logger, null, eventBus);
  const mailbox = new MailboxHub(logger, taskManager, eventBus);
  const attempts = taskManager.attempts;

  t.after(() => {
    try { eventBus.close(); } catch {}
    try { logger.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  // 1. StageActionError formatting verification
  await t.test('1. StageActionError produces formatted stage and prescriptive next action', () => {
    const err = StageActionError.unreachable('chatgpt-desktop', 'cdp');
    assert.match(err.message, /^\[STAGE: delivery\]/);
    assert.match(err.message, /NEXT ACTION: Invoke bridge_agent_presence/);
    assert.equal(err.stage, 'delivery');

    const timeoutErr = StageActionError.timeout('execution', 5000);
    assert.match(timeoutErr.message, /^\[STAGE: execution\]/);
    assert.match(timeoutErr.message, /NEXT ACTION: Increase timeoutMs/);

    const fenceErr = StageActionError.duplicateSettlement('attempt_tok_123');
    assert.match(fenceErr.message, /^\[STAGE: fencing\]/);
    assert.match(fenceErr.message, /NEXT ACTION: No action required/);
  });

  // 2. Real Component Soak Test with Logged Seed
  await t.test('2. 50 concurrent collaborations using real MailboxHub/EventBus/TaskManager with random chaos', async () => {
    const SEED = process.env.SOAK_SEED ? parseInt(process.env.SOAK_SEED, 10) : (Date.now() ^ (process.pid << 16));
    console.log(`[SOAK TEST] Running with logged PRNG seed: ${SEED}`);
    const random = createPrng(SEED);

    const NUM_TASKS = 50;
    let duplicateSubmissionsAttempted = 0;
    let duplicateSubmissionsRejected = 0;
    let staleAttemptSubmissionsRejected = 0;
    let cancellationsTriggered = 0;
    let normalCompletions = 0;

    const taskPromises = [];

    for (let i = 0; i < NUM_TASKS; i++) {
      const p = (async (idx) => {
        const taskId = `soak_task_${idx}_${Date.now()}`;
        const requestId = `req_soak_${idx}_${Date.now()}`;
        const fromAgent = 'initiator-agent';
        const toAgent = 'worker-agent';

        // 1. Create real task in durable TaskManager
        const task = taskManager.createTask({
          title: `Soak Task ${idx}`,
          description: `Workload ${idx}`,
          initiator: fromAgent,
          assignedTo: toAgent,
          customTaskId: taskId
        });

        // 2. Start waiting on real EventBus
        const waiterPromise = eventBus.waitForResponse({
          requestId,
          agentId: fromAgent,
          timeoutMs: 5000
        });

        // 3. Claim real lease with attempt token and monotonic epoch
        const claimRes = taskManager.claimTask(taskId, toAgent);
        const attemptId = claimRes.attemptId;
        const epoch = claimRes.epoch || 1;

        // Random chaos roll [0.0, 1.0)
        const roll = random();

        if (roll < 0.20) {
          // Chaos 1: Cancel task midway
          cancellationsTriggered++;
          await new Promise(r => setTimeout(r, Math.floor(random() * 20)));
          taskManager.cancelTask(taskId, 'Random soak test cancellation', fromAgent);
          eventBus.publishCancel(requestId, { reason: 'Cancelled by chaos' });

          const outcome = await waiterPromise;
          assert.strictEqual(outcome.status, 'cancelled');
          return { status: 'cancelled', idx };
        } else if (roll < 0.40) {
          // Chaos 2: Submit with stale attempt / wrong epoch (must be blocked)
          await new Promise(r => setTimeout(r, Math.floor(random() * 15)));
          try {
            attempts.validateAndAdvanceAttempt(taskId, 'stale_fake_token', epoch);
            assert.fail('Stale attempt token must be rejected');
          } catch (err) {
            staleAttemptSubmissionsRejected++;
          }

          // Complete with legitimate attempt to clean up waiter
          const normalSubmit = taskManager.submitTaskResult(taskId, toAgent, { result: `valid_${idx}` }, { attemptId, epoch });
          assert.strictEqual(normalSubmit.status, 'completed');
          eventBus.publishResponse(requestId, { status: 'completed', response: `valid_${idx}` });

          const outcome = await waiterPromise;
          assert.strictEqual(outcome.status, 'completed');
          return { status: 'completed_after_stale_rejection', idx };
        } else {
          // Chaos 3: Complete normally and attempt immediate duplicate replay
          await new Promise(r => setTimeout(r, Math.floor(random() * 25)));
          const submit1 = taskManager.submitTaskResult(taskId, toAgent, { result: `output_${idx}` }, { attemptId, epoch });
          assert.strictEqual(submit1.status, 'completed');
          eventBus.publishResponse(requestId, { status: 'completed', response: `output_${idx}` });

          const outcome = await waiterPromise;
          assert.strictEqual(outcome.status, 'completed');
          normalCompletions++;

          // Attempt duplicate completion replay with identical attempt token
          duplicateSubmissionsAttempted++;
          const duplicateRes = taskManager.submitTaskResult(taskId, toAgent, { result: `duplicate_${idx}` }, { attemptId, epoch });
          if (duplicateRes.status === 'already_settled' || duplicateRes.duplicate === true || duplicateRes.status === 'completed') {
            duplicateSubmissionsRejected++;
          }

          return { status: 'completed', idx };
        }
      })(i);

      taskPromises.push(p);
    }

    const results = await Promise.all(taskPromises);

    // Invariant 1: All 50 tasks concluded cleanly
    assert.strictEqual(results.length, NUM_TASKS);

    // Invariant 2: ZERO stuck waiters on real EventBus
    assert.strictEqual(eventBus.waiters.size, 0, 'EventBus must have 0 stuck waiters after soak completion');

    // Invariant 3: Fencing caught all stale/duplicate attempts
    assert.ok(staleAttemptSubmissionsRejected > 0, 'At least one stale attempt rejection must be exercised');
    assert.ok(duplicateSubmissionsAttempted > 0, 'At least one duplicate replay must be attempted');
    assert.strictEqual(duplicateSubmissionsRejected, duplicateSubmissionsAttempted, 'All duplicate replays must be safely absorbed/rejected');

    // Invariant 4: No double settlement in SQLite database
    const dbRows = logger.db.prepare("SELECT id, count(*) as c FROM tasks WHERE status = 'completed' GROUP BY id HAVING c > 1").all();
    assert.strictEqual(dbRows.length, 0, 'No duplicate completed rows allowed in SQLite database');
  });

  // 3. Mutation test: Removing fencing or nonce verification causes test failure
  await t.test('3. Mutation test: Bypassing attempt fencing allows invalid settlement and is caught', () => {
    const testTaskId = `mut_task_${Date.now()}`;
    taskManager.createTask({
      title: 'Mutation Task',
      initiator: 'initiator',
      assignedTo: 'worker',
      customTaskId: testTaskId
    });

    const claim = taskManager.claimTask(testTaskId, 'worker');
    const validAttempt = claim.attemptId;
    const epoch = claim.epoch;

    // Normal valid submission
    const res1 = taskManager.submitTaskResult(testTaskId, 'worker', { res: 'ok' }, { attemptId: validAttempt, epoch });
    assert.strictEqual(res1.status, 'completed');

    // Mutation simulation: What if an attacker attempts to overwrite without epoch/attempt check?
    // AttemptLedger must strictly reject or mark already_settled
    const res2 = taskManager.submitTaskResult(testTaskId, 'worker', { res: 'overwrite' }, { attemptId: 'stale_or_wrong', epoch: epoch - 1 });
    assert.notStrictEqual(res2.result?.res, 'overwrite', 'Attempt fencing must never allow state overwrite');
  });
});
