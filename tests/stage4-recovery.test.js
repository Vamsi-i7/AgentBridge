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

test('Stage 4: Recovery, Error Accounting, Dual-Process Concurrency, and Restart Survivability', async (t) => {
  const tmpDir = path.join(os.tmpdir(), `stage4-recov-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const dbPath = path.join(tmpDir, 'stage4_recovery.db');

  t.after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  await t.test('4.1.1 Recovery timer unref lifecycle and clean shutdown', async () => {
    const logger = new AuditLogger(dbPath);
    const hub = new MailboxHub(logger);

    assert.ok(hub._recoveryTimer, 'Recovery timer should be started when DB is provided');
    assert.strictEqual(typeof hub.recoverySweepErrors, 'number');
    assert.strictEqual(hub.recoverySweepErrors, 0);

    hub.close();
    assert.strictEqual(hub._recoveryTimer, null, 'Recovery timer should be cleared on close');
    logger.close();
  });

  await t.test('4.1.2 Sweep errors are audited and counted via recoverySweepErrors', async () => {
    const logger = new AuditLogger(dbPath);
    const hub = new MailboxHub(logger);

    const initialErrors = hub.recoverySweepErrors;

    // Inject a failing task recovery to simulate an unexpected error during sweep
    hub.tasks.recoverExpiredTasks = () => {
      throw new Error('Simulated task recovery failure in sweep');
    };

    assert.throws(() => {
      hub.runRecoverySweep();
    }, /Simulated task recovery failure in sweep/);

    assert.strictEqual(hub.recoverySweepErrors, initialErrors + 1);

    // Verify audit log has recorded the recovery_sweep_error
    const errorLogs = logger.db.prepare('SELECT * FROM audit_log WHERE action = ?').all('recovery_sweep_error');
    assert.ok(errorLogs.length >= 1, 'Audit log should record recovery_sweep_error');
    assert.strictEqual(errorLogs[0].status, 'error');
    const details = JSON.parse(errorLogs[0].details);
    assert.match(details.error, /Simulated task recovery failure in sweep/);

    hub.close();
    logger.close();
  });

  await t.test('4.1.3 Dual-process recovery concurrency: Two hubs sharing DB do not double-recover or double-bump epoch', async () => {
    const logger1 = new AuditLogger(dbPath);
    const hub1 = new MailboxHub(logger1);
    const logger2 = new AuditLogger(dbPath);
    const hub2 = new MailboxHub(logger2);

    // Stop background timers during the concurrency race test so we control exact sweep invocation
    hub1.stopRecoveryTimer();
    hub2.stopRecoveryTimer();

    const req = await hub1.askAgent({
      fromAgent: 'claude-code',
      toAgent: 'cursor',
      question: 'Run concurrent recovery check',
      asyncMode: true
    });
    assert.ok(req.requestId);

    // Claim with a short lease
    const claim = hub1.claimRequest({
      requestId: req.requestId,
      agentId: 'cursor',
      workerId: 'worker_concurrent_1',
      leaseMs: 50 // 50ms lease
    });
    assert.strictEqual(claim.epoch, 1);

    // Wait for lease to expire
    await new Promise((r) => setTimeout(r, 80));

    // Both hubs execute recovery sweep concurrently
    const [sweep1, sweep2] = await Promise.all([
      Promise.resolve().then(() => hub1.recoverExpiredRequests()),
      Promise.resolve().then(() => hub2.recoverExpiredRequests())
    ]);

    const totalRecovered = (sweep1.recovered?.length || 0) + (sweep2.recovered?.length || 0);
    assert.strictEqual(totalRecovered, 1, 'Exactly one hub instance should claim the recovery');

    // Verify DB state: Epoch must be exactly 2 (not double-bumped to 3)
    const row = logger1.db.prepare('SELECT status, epoch, claimed_by FROM bridge_requests WHERE request_id = ?').get(req.requestId);
    assert.strictEqual(row.status, 'pending');
    assert.strictEqual(row.epoch, 2, 'Epoch must be incremented exactly once');
    assert.strictEqual(row.claimed_by, null);

    hub1.close();
    hub2.close();
    logger1.close();
    logger2.close();
  });

  await t.test('4.2.1 Real worker SIGKILL -> recovery restores lease, fences zombie output', async () => {
    const logger = new AuditLogger(dbPath);
    const hub = new MailboxHub(logger);

    const req = await hub.askAgent({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'claude-desktop',
      question: 'Perform task with worker crash',
      asyncMode: true
    });

    // Prepare child worker
    const workerScript = path.join(tmpDir, 'stage4_worker.js');
    const workerCode = `
      import { AuditLogger } from '${path.resolve('src/audit-logger.js')}';
      import { MailboxHub } from '${path.resolve('src/mailbox-hub.js')}';

      const l = new AuditLogger('${dbPath}');
      const m = new MailboxHub(l);

      const claim = m.claimRequest({
        requestId: '${req.requestId}',
        agentId: 'claude-desktop',
        workerId: 'worker_sigkill_st4',
        leaseMs: 200
      });

      if (process.send) {
        process.send({ status: 'claimed', attemptId: claim.attemptId, epoch: claim.epoch, nonce: claim.nonce });
      }

      setInterval(() => {}, 1000);
    `;
    fs.writeFileSync(workerScript, workerCode);

    const child = fork(workerScript, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const claimMsg = await new Promise((resolve) => {
      child.on('message', (msg) => {
        if (msg.status === 'claimed') resolve(msg);
      });
    });

    assert.strictEqual(claimMsg.epoch, 1);

    // Terminate worker with SIGKILL
    const exitPromise = new Promise((resolve) => {
      child.on('exit', (code, signal) => resolve({ code, signal }));
    });
    process.kill(child.pid, 'SIGKILL');
    const exitRes = await exitPromise;
    assert.strictEqual(exitRes.signal, 'SIGKILL');

    // Wait for lease to expire
    await new Promise((r) => setTimeout(r, 250));

    // Recover expired requests
    const sweep = hub.recoverExpiredRequests();
    assert.ok(sweep.recovered.length >= 1);

    const recRow = logger.db.prepare('SELECT * FROM bridge_requests WHERE request_id = ?').get(req.requestId);
    assert.strictEqual(recRow.status, 'pending');
    assert.strictEqual(recRow.epoch, 2);

    // Stale zombie response from killed worker is strictly quarantined
    const zombieAns = hub.answerRequest({
      requestId: req.requestId,
      agentId: 'claude-desktop',
      response: 'Zombie answer from dead worker',
      attemptId: claimMsg.attemptId,
      epoch: 1,
      nonce: claimMsg.nonce
    });

    assert.strictEqual(zombieAns.status, 'quarantined');
    assert.strictEqual(zombieAns.quarantined, true);

    hub.close();
    logger.close();
  });

  await t.test('4.2.2 Bridge process crash & restart: Expired leases recover on startup; DELIVERY_UNCERTAIN non-idempotent requests never re-injected', async () => {
    // Phase 1: Original bridge process runs, creates requests, then simulates abrupt termination
    const loggerOld = new AuditLogger(dbPath);
    const hubOld = new MailboxHub(loggerOld);

    // 1. Idempotent request
    const reqIdempotent = await hubOld.askAgent({
      fromAgent: 'antigravity',
      toAgent: 'cursor',
      question: 'Read configuration file',
      context: { isIdempotent: true },
      asyncMode: true
    });

    // 2. Non-idempotent request with prompt submitted
    const reqNonIdempotent = await hubOld.askAgent({
      fromAgent: 'antigravity',
      toAgent: 'cursor',
      question: 'Execute database schema migration',
      context: { isIdempotent: false },
      asyncMode: true
    });

    // Claim both requests with short leases
    hubOld.claimRequest({
      requestId: reqIdempotent.requestId,
      agentId: 'cursor',
      workerId: 'worker_idemp',
      leaseMs: 100
    });

    hubOld.claimRequest({
      requestId: reqNonIdempotent.requestId,
      agentId: 'cursor',
      workerId: 'worker_non_idemp',
      leaseMs: 100
    });

    // Worker submits prompt for non-idempotent request before process terminates
    hubOld.markPromptSubmitted(reqNonIdempotent.requestId);

    // Simulate bridge process shutdown / crash (stop hub without waiting for lease)
    hubOld.close();
    loggerOld.close();

    // Time passes while bridge is down, leases expire
    await new Promise((r) => setTimeout(r, 200));

    // Phase 2: Bridge process restarts with fresh MailboxHub on the same SQLite DB
    const loggerNew = new AuditLogger(dbPath);
    const hubNew = new MailboxHub(loggerNew); // constructor triggers initial recovery sweep

    // Inspect database states after restart recovery
    const idempRow = loggerNew.db.prepare('SELECT * FROM bridge_requests WHERE request_id = ?').get(reqIdempotent.requestId);
    assert.strictEqual(idempRow.status, 'pending', 'Idempotent request should recover to pending');
    assert.strictEqual(idempRow.delivery_state, 'RECOVERED_PENDING');
    assert.strictEqual(idempRow.epoch, 2);

    const nonIdempRow = loggerNew.db.prepare('SELECT * FROM bridge_requests WHERE request_id = ?').get(reqNonIdempotent.requestId);
    assert.strictEqual(nonIdempRow.status, 'delivery_uncertain', 'Non-idempotent submitted request must NOT be re-injected');
    assert.strictEqual(nonIdempRow.delivery_state, 'DELIVERY_UNCERTAIN');
    assert.strictEqual(nonIdempRow.epoch, 2);
    assert.match(nonIdempRow.error, /DELIVERY_UNCERTAIN/i);

    hubNew.close();
    loggerNew.close();
  });
});
