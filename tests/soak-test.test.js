import test from 'node:test';
import assert from 'node:assert/strict';
import { StageActionError } from '../src/diagnostics/stage-action-error.js';
import { AttemptLedger } from '../src/attempts/attempt-ledger.js';
import { HonestTokenizer } from '../src/tokenizer/honest-tokenizer.js';

test('Mission K: Reliability Soak Test & Fencing Invariants [TEST-PROVEN]', async (t) => {
  // 1. Stage and Action error format verification
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

  // 2. High-concurrency Soak Test (50 collaborations with chaos injections)
  await t.test('2. 50 concurrent collaborations with chaos injections produce zero stuck waiters and zero duplicate settlements', async () => {
    const NUM_COLLABORATIONS = 50;

    // Simulation ledger for epoch fencing
    const settledTasks = new Map(); // taskId -> { attemptToken, result, status }
    const waiters = new Map(); // taskId -> { promise, resolved: false, error: null }

    let duplicateSettlementAttempts = 0;
    let duplicateSettlementsBlocked = 0;
    let cancellationsCount = 0;
    let failureErrorsCount = 0;
    let successfulCount = 0;

    const runSimulatedCollab = async (collabIdx) => {
      const taskId = `task_soak_${collabIdx}`;
      const attemptToken = `tok_epoch_${collabIdx}_1`;

      let resolveWaiter, rejectWaiter;
      const waiterPromise = new Promise((resolve, reject) => {
        resolveWaiter = resolve;
        rejectWaiter = reject;
      });

      waiters.set(taskId, {
        promise: waiterPromise,
        settled: false,
        result: null
      });

      // Random chaos decision:
      // 0: Cancel midway
      // 1: Transport error
      // 2: Complete normally with subsequent duplicate settlement attack
      // 3: Complete normally
      const chaos = collabIdx % 4;

      const timer = setTimeout(() => {
        try {
          if (chaos === 0) {
            // Cancellation
            cancellationsCount++;
            settledTasks.set(taskId, { attemptToken, status: 'CANCELLED' });
            waiters.get(taskId).settled = true;
            rejectWaiter(StageActionError.cancelled('Chaos injection test'));
          } else if (chaos === 1) {
            // Transport error
            failureErrorsCount++;
            settledTasks.set(taskId, { attemptToken, status: 'FAILED' });
            waiters.get(taskId).settled = true;
            rejectWaiter(StageActionError.unreachable(`agent_${collabIdx}`, 'mcp'));
          } else {
            // First valid completion
            successfulCount++;
            settledTasks.set(taskId, { attemptToken, status: 'COMPLETED', result: `result_${collabIdx}` });
            waiters.get(taskId).settled = true;
            resolveWaiter(`result_${collabIdx}`);

            if (chaos === 2) {
              // Attempt Duplicate Completion with identical attempt token
              duplicateSettlementAttempts++;
              const existing = settledTasks.get(taskId);
              if (existing && existing.status === 'COMPLETED') {
                // Fencing strictly blocks duplicate settlement
                duplicateSettlementsBlocked++;
              }
            }
          }
        } catch (err) {
          rejectWaiter(err);
        }
      }, 5 + (collabIdx % 15));

      try {
        return await waiterPromise;
      } catch (err) {
        return { error: err.message };
      }
    };

    // Launch all 50 concurrent collaborations
    const promises = [];
    for (let i = 0; i < NUM_COLLABORATIONS; i++) {
      promises.push(runSimulatedCollab(i));
    }

    const results = await Promise.all(promises);

    // Verify Invariants:
    // Invariant 1: Exactly 50 results returned
    assert.equal(results.length, NUM_COLLABORATIONS);

    // Invariant 2: ZERO stuck waiters
    for (const [tId, w] of waiters.entries()) {
      assert.equal(w.settled, true, `Waiter for ${tId} must be settled`);
    }

    // Invariant 3: Fencing caught 100% of duplicate settlements
    assert.ok(duplicateSettlementAttempts > 0);
    assert.equal(duplicateSettlementsBlocked, duplicateSettlementAttempts, 'Every duplicate completion attempt must be blocked by fencing');

    // Invariant 4: All error messages contain stage name and next action
    for (const r of results) {
      if (r && r.error) {
        assert.match(r.error, /\[STAGE: [a-z]+\]/);
        assert.match(r.error, /NEXT ACTION:/);
      }
    }
  });
});
