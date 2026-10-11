import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fork } from 'node:child_process';
import { AuditLogger } from '../src/audit-logger.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { TaskManager } from '../src/task-manager.js';
import { EventBus } from '../src/event-bus.js';

test('Stage 2: Recovery & Fencing under real SIGKILL worker crashes', async (t) => {
  const tmpDir = path.join(os.tmpdir(), `bridge-recov-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const dbPath = path.join(tmpDir, 'recovery_test.db');
  const logger = new AuditLogger(dbPath);
  const bus = new EventBus(logger);
  const taskMgr = new TaskManager(logger, null, bus);
  const mailbox = new MailboxHub(logger, taskMgr, bus);

  t.after(() => {
    mailbox.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  await t.test('2.1 Real worker killed with SIGKILL -> Lease recovered, epoch advances, stale response quarantined', async () => {
    // 1. Create a request
    const req = await mailbox.askAgent({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'claude-desktop',
      question: 'Calculate factorial of 10',
      asyncMode: true
    });
    assert.ok(req.requestId);

    // 2. Prepare child worker script
    const workerScript = path.join(tmpDir, 'child_worker.js');
    const workerCode = `
      import { AuditLogger } from '${path.resolve('src/audit-logger.js')}';
      import { MailboxHub } from '${path.resolve('src/mailbox-hub.js')}';

      const logger = new AuditLogger('${dbPath}');
      const mailbox = new MailboxHub(logger);

      const claim = mailbox.claimRequest({
        requestId: '${req.requestId}',
        agentId: 'claude-desktop',
        workerId: 'worker_sigkill_p1',
        leaseMs: 300 // 300ms short lease
      });

      if (process.send) {
        process.send({ status: 'claimed', attemptId: claim.attemptId, epoch: claim.epoch });
      }

      // Simulate hanging turn until killed
      setInterval(() => {}, 1000);
    `;
    fs.writeFileSync(workerScript, workerCode);

    // 3. Spawn real child process
    const child = fork(workerScript, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });

    const claimedEvent = await new Promise((resolve) => {
      child.on('message', (msg) => {
        if (msg.status === 'claimed') resolve(msg);
      });
    });

    assert.ok(claimedEvent.attemptId);
    assert.strictEqual(claimedEvent.epoch, 1);

    // Verify row in DB is in_progress
    const inProgressRow = logger.db.prepare('SELECT * FROM bridge_requests WHERE request_id = ?').get(req.requestId);
    assert.strictEqual(inProgressRow.status, 'in_progress');
    assert.strictEqual(inProgressRow.epoch, 1);
    assert.strictEqual(inProgressRow.attempt_id, claimedEvent.attemptId);

    // 4. Kill the child worker with real SIGKILL
    const exitPromise = new Promise((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }));
    });
    process.kill(child.pid, 'SIGKILL');
    const exitInfo = await exitPromise;
    assert.strictEqual(exitInfo.signal, 'SIGKILL');

    // 5. Wait for the 300ms lease to expire
    await new Promise((r) => setTimeout(r, 400));

    // 6. Recovery runs (either via timer or explicit sweep)
    const sweep = mailbox.recoverExpiredRequests();
    assert.ok(sweep.recovered.length >= 1);

    // Verify epoch advanced to 2 and status returned to pending
    const recoveredRow = logger.db.prepare('SELECT * FROM bridge_requests WHERE request_id = ?').get(req.requestId);
    assert.strictEqual(recoveredRow.status, 'pending');
    assert.strictEqual(recoveredRow.epoch, 2);
    assert.strictEqual(recoveredRow.claimed_by, null);

    // 7. Zombie late submission with old epoch 1 and dead attemptId is strictly FENCED
    const lateAttempt = mailbox.answerRequest({
      requestId: req.requestId,
      agentId: 'claude-desktop',
      response: 'Late zombie response from dead worker',
      attemptId: claimedEvent.attemptId,
      epoch: 1
    });

    assert.strictEqual(lateAttempt.status, 'quarantined');
    assert.strictEqual(lateAttempt.quarantined, true);
    assert.match(lateAttempt.error, /FENCED_ATTEMPT_ERROR/i);

    // Check quarantine table
    const qRow = logger.db.prepare('SELECT * FROM bridge_quarantined_responses WHERE request_id = ?').get(req.requestId);
    assert.ok(qRow);
    assert.strictEqual(qRow.epoch, 1);
    assert.match(qRow.reason, /FENCED_ATTEMPT_ERROR/i);

    // Ensure request remains pending (not settled by zombie!)
    const checkRow = logger.db.prepare('SELECT * FROM bridge_requests WHERE request_id = ?').get(req.requestId);
    assert.strictEqual(checkRow.status, 'pending');

    // 8. New worker claims with epoch 2 and completes
    const claim2 = mailbox.claimRequest({
      requestId: req.requestId,
      agentId: 'claude-desktop',
      workerId: 'worker_healthy_p2',
      leaseMs: 5000
    });
    assert.strictEqual(claim2.claimed, true);
    assert.strictEqual(claim2.epoch, 2);

    const validSubmission = mailbox.answerRequest({
      requestId: req.requestId,
      agentId: 'claude-desktop',
      response: 'Factorial of 10 is 3628800',
      attemptId: claim2.attemptId,
      epoch: 2
    });

    assert.strictEqual(validSubmission.status, 'completed');
    const finalRow = logger.db.prepare('SELECT * FROM bridge_requests WHERE request_id = ?').get(req.requestId);
    assert.strictEqual(finalRow.status, 'completed');
    assert.strictEqual(finalRow.response, 'Factorial of 10 is 3628800');
  });

  await t.test('2.2 DELIVERY_UNCERTAIN: Non-idempotent request does NOT blindly re-inject on worker death', async () => {
    // 1. Create a non-idempotent request
    const req = await mailbox.askAgent({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'claude-desktop',
      question: 'Execute financial transfer',
      context: { isIdempotent: false },
      asyncMode: true
    });

    // 2. Worker claims request
    const claim = mailbox.claimRequest({
      requestId: req.requestId,
      agentId: 'claude-desktop',
      workerId: 'worker_transfer_p1',
      leaseMs: 150
    });
    assert.strictEqual(claim.claimed, true);

    // 3. Worker submits prompt to provider UI before crashing
    mailbox.markPromptSubmitted(req.requestId);

    const rowBeforeCrash = logger.db.prepare('SELECT * FROM bridge_requests WHERE request_id = ?').get(req.requestId);
    assert.strictEqual(rowBeforeCrash.submitted_to_provider, 1);
    assert.strictEqual(rowBeforeCrash.delivery_state, 'PROMPT_SUBMITTED');

    // 4. Simulate lease expiry
    await new Promise((r) => setTimeout(r, 250));

    // 5. Recovery sweep executes
    const sweep = mailbox.recoverExpiredRequests();
    assert.strictEqual(sweep.uncertain.length, 1);
    assert.strictEqual(sweep.uncertain[0].requestId, req.requestId);

    // 6. Assert: Status is DELIVERY_UNCERTAIN and NOT reset to pending!
    const rowAfter = logger.db.prepare('SELECT * FROM bridge_requests WHERE request_id = ?').get(req.requestId);
    assert.strictEqual(rowAfter.status, 'delivery_uncertain');
    assert.strictEqual(rowAfter.delivery_state, 'DELIVERY_UNCERTAIN');
    assert.match(rowAfter.error, /DELIVERY_UNCERTAIN/i);
    assert.strictEqual(rowAfter.epoch, 2); // Epoch monotonically bumped to fence zombie worker

    // 7. Zombie late submission on delivery_uncertain request is quarantined
    const lateAttempt = mailbox.answerRequest({
      requestId: req.requestId,
      agentId: 'claude-desktop',
      response: 'Late transfer output',
      attemptId: claim.attemptId,
      epoch: 1
    });

    assert.strictEqual(lateAttempt.status, 'quarantined');
    assert.strictEqual(lateAttempt.quarantined, true);
  });

  await t.test('2.3 DELIVERY_UNCERTAIN: Idempotent request safely retries after prompt submission lease expiry', async () => {
    // 1. Create idempotent request
    const req = await mailbox.askAgent({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'claude-desktop',
      question: 'Fetch read-only user summary',
      context: { isIdempotent: true },
      asyncMode: true
    });

    // 2. Worker claims and submits prompt
    const claim = mailbox.claimRequest({
      requestId: req.requestId,
      agentId: 'claude-desktop',
      workerId: 'worker_fetch_p1',
      leaseMs: 150
    });
    mailbox.markPromptSubmitted(req.requestId);

    // 3. Lease expires
    await new Promise((r) => setTimeout(r, 250));

    // 4. Recovery sweep executes
    const sweep = mailbox.recoverExpiredRequests();
    assert.strictEqual(sweep.recovered.length, 1);
    assert.strictEqual(sweep.recovered[0].requestId, req.requestId);

    // 5. Assert: Idempotent request reset to pending with bumped epoch
    const rowAfter = logger.db.prepare('SELECT * FROM bridge_requests WHERE request_id = ?').get(req.requestId);
    assert.strictEqual(rowAfter.status, 'pending');
    assert.strictEqual(rowAfter.delivery_state, 'RECOVERED_PENDING');
    assert.strictEqual(rowAfter.submitted_to_provider, 0);
    assert.strictEqual(rowAfter.epoch, 2);
  });

  await t.test('2.4 Unref recovery timer in MailboxHub periodically sweeps without manual invocation', async () => {
    // Create an un-submitted request with short lease
    const req = await mailbox.askAgent({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'claude-desktop',
      question: 'Background maintenance',
      asyncMode: true
    });

    mailbox.claimRequest({
      requestId: req.requestId,
      agentId: 'claude-desktop',
      workerId: 'worker_timer_p1',
      leaseMs: 100
    });

    // We do NOT call mailbox.recoverExpiredRequests manually.
    // Instead we wait for the background timer to run.
    await new Promise((r) => setTimeout(r, 2500));

    const row = logger.db.prepare('SELECT * FROM bridge_requests WHERE request_id = ?').get(req.requestId);
    assert.strictEqual(row.status, 'pending', 'Background unref timer must recover expired lease automatically');
    assert.strictEqual(row.epoch, 2);
  });
});
