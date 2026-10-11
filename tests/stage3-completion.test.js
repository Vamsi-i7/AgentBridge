import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { AuditLogger } from '../src/audit-logger.js';
import { MailboxHub, CONFIDENCE_RANK } from '../src/mailbox-hub.js';
import { TaskManager } from '../src/task-manager.js';
import { EventBus } from '../src/event-bus.js';
import { ResponsePreserver } from '../src/artifacts/response-preserver.js';
import { ResponseObserver, ObserverState, CompletionConfidence } from '../src/control-plane/response-observer.js';
import { RequestTracer, LifecycleStage } from '../src/diagnostics/request-tracer.js';
import { RequestExplainer } from '../src/diagnostics/request-explainer.js';

test('Stage 3: Completion Confidence, Recipient-Submit, and Timings Suite', async (t) => {
  const tmpDir = path.join(os.tmpdir(), `bridge-stage3-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const dbPath = path.join(tmpDir, 'stage3_test.db');
  const logger = new AuditLogger(dbPath);
  const bus = new EventBus(logger);
  const taskMgr = new TaskManager(logger, null, bus);
  const mailbox = new MailboxHub(logger, taskMgr, bus);
  const preserver = new ResponsePreserver(logger.db);

  t.after(() => {
    mailbox.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  await t.test('3.1 Missing completionConfidence defaults to UNKNOWN, not EXPLICIT_END_OF_TURN', async () => {
    // 1. In ResponsePreserver
    const artifact = {
      requestId: 'req_test_unknown',
      responseText: 'Some unlabelled output',
      respondingAgentId: 'claude-desktop',
      requestingAgentId: 'chatgpt-desktop',
      contentType: 'text/plain',
      payloadSize: 23,
      contentHash: 'hash123'
      // executionMetadata is intentionally omitted
    };
    const metadata = preserver.createCompactEnvelope(artifact);
    assert.equal(metadata.completionConfidence, 'UNKNOWN', 'Missing executionMetadata.completionConfidence must default to UNKNOWN');

    // 2. In CONFIDENCE_RANK
    assert.equal(CONFIDENCE_RANK['UNKNOWN'], 0, 'UNKNOWN must be rank 0');
    assert.ok(CONFIDENCE_RANK['STABILITY_HEURISTIC'] > CONFIDENCE_RANK['UNKNOWN'], 'STABILITY_HEURISTIC must rank higher than UNKNOWN');

    // 3. In MailboxHub.answerRequest without confidence
    const req = await mailbox.askAgent({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'claude-desktop',
      question: 'Question without specified confidence',
      asyncMode: true
    });
    const claim = mailbox.claimRequest({
      requestId: req.requestId,
      agentId: 'claude-desktop'
    });

    mailbox.answerRequest({
      requestId: req.requestId,
      agentId: 'claude-desktop',
      response: 'Unspecified confidence answer',
      attemptId: claim.attemptId,
      epoch: claim.epoch
      // completionConfidence intentionally omitted
    });

    const stored = mailbox.getRequest(req.requestId, { agentId: 'chatgpt-desktop' });
    assert.equal(stored.completionConfidence, 'UNKNOWN', 'Omitted completionConfidence in answerRequest must be recorded as UNKNOWN');
  });

  await t.test('3.2 Side-effects gating rejects UNKNOWN and STABILITY_HEURISTIC; UI re-read grace recheck works', async () => {
    // 1. Task with side effects fails when submitted with UNKNOWN
    const task1 = taskMgr.createTask({
      fromAgent: 'gemini',
      toAgent: 'chatgpt-desktop',
      title: 'Effectful task',
      description: 'Run tool with side effect',
      context: JSON.stringify({ hasSideEffects: true })
    });
    const claim1 = taskMgr.claimTask(task1.id, 'chatgpt-desktop');

    const resUnknown = mailbox.submitTaskResult({
      taskId: task1.id,
      agentId: 'chatgpt-desktop',
      result: 'Ran dangerous command',
      attemptId: claim1.attemptId,
      epoch: claim1.epoch,
      completionConfidence: 'UNKNOWN'
    });
    assert.equal(resUnknown.status, 'failed');
    assert.ok(resUnknown.error.includes('INSUFFICIENT_COMPLETION_CONFIDENCE'), 'Must reject UNKNOWN confidence for side-effect task');

    // 2. Direct request with side effects fails when submitted with STABILITY_HEURISTIC
    const req2 = await mailbox.askAgent({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'claude-desktop',
      question: 'Delete a file',
      context: { hasSideEffects: true },
      asyncMode: true
    });
    const claim2 = mailbox.claimRequest({
      requestId: req2.requestId,
      agentId: 'claude-desktop'
    });

    const resHeuristic = mailbox.answerRequest({
      requestId: req2.requestId,
      agentId: 'claude-desktop',
      response: 'File deleted maybe',
      attemptId: claim2.attemptId,
      epoch: claim2.epoch,
      completionConfidence: 'STABILITY_HEURISTIC'
    });
    assert.equal(resHeuristic.status, 'failed');
    assert.ok(resHeuristic.error.includes('INSUFFICIENT_COMPLETION_CONFIDENCE'), 'Must reject STABILITY_HEURISTIC for side-effect request');

    // 3. UI re-read grace check: if text grew, do not settle shorter text
    let probeCallCount = 0;
    const fakeProbe = async () => {
      probeCallCount++;
      if (probeCallCount <= 2) {
        // Initial probe (call 1) and stable check (call 2): stable candidate text
        return {
          running: true,
          isGenerating: false,
          textRegions: [
            { snippet: 'req_grace_test' },
            { snippet: 'Short candidate text' }
          ]
        };
      }
      // Call 3 (grace recheck probe) and beyond: text grew!
      return {
        running: true,
        isGenerating: false,
        textRegions: [
          { snippet: 'req_grace_test' },
          { snippet: 'Short candidate text has now grown much longer' }
        ]
      };
    };

    const obs = new ResponseObserver({
      probe: fakeProbe,
      pollIntervalMs: 50,
      graceRecheckIntervalMs: 80,
      alwaysGraceCheck: true
    });

    let resumedEmitted = false;
    obs.on('grace_check_resumed', (ev) => {
      resumedEmitted = true;
      assert.ok(ev.newLength > ev.previousLength);
    });

    const completionPromise = new Promise((resolve) => {
      obs.on('response_completed', (ev) => resolve(ev));
    });

    obs.startObservation({
      targetApp: 'fake_app',
      requestId: 'req_grace_test',
      minStableTicks: 1
    });

    const finalEv = await completionPromise;
    assert.ok(resumedEmitted, 'Must emit grace_check_resumed when text grew during grace recheck');
    assert.equal(finalEv.response, 'Short candidate text has now grown much longer', 'Must settle the longer text, never the shorter candidate');
  });

  await t.test('3.3 Recipient-submit: nonce, attempt, epoch invariants and duplicate/replay protection', async () => {
    // Setup request
    const req = await mailbox.askAgent({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'claude-desktop',
      question: 'Compute hash',
      asyncMode: true
    });
    const claim = mailbox.claimRequest({
      requestId: req.requestId,
      agentId: 'claude-desktop'
    });
    assert.ok(claim.nonce, 'Claim must generate cryptographic nonce');

    // Test 1: Wrong nonce rejected
    const wrongNonceRes = mailbox.answerRequest({
      requestId: req.requestId,
      agentId: 'claude-desktop',
      response: 'Hash 123',
      attemptId: claim.attemptId,
      epoch: claim.epoch,
      nonce: 'wrong_nonce_value',
      completionConfidence: 'AUTHENTICATED_SUBMIT'
    });
    assert.ok(wrongNonceRes.status === 'quarantined' || wrongNonceRes.status === 'failed', 'Wrong nonce must be rejected/quarantined');

    // Test 2: Stale epoch rejected
    const staleEpochRes = mailbox.answerRequest({
      requestId: req.requestId,
      agentId: 'claude-desktop',
      response: 'Hash 123',
      attemptId: claim.attemptId,
      epoch: claim.epoch - 1,
      nonce: claim.nonce,
      completionConfidence: 'AUTHENTICATED_SUBMIT'
    });
    assert.ok(staleEpochRes.status === 'quarantined' || staleEpochRes.status === 'failed', 'Stale epoch must be rejected/quarantined');

    // Test 3: Valid AUTHENTICATED_SUBMIT succeeds (first valid commit wins)
    const validRes = mailbox.answerRequest({
      requestId: req.requestId,
      agentId: 'claude-desktop',
      response: 'Authoritative hash output',
      attemptId: claim.attemptId,
      epoch: claim.epoch,
      nonce: claim.nonce,
      completionConfidence: 'AUTHENTICATED_SUBMIT'
    });
    assert.ok(validRes.status === 'completed' || validRes.status === 'success', 'Valid submission must complete successfully');

    // Test 4: Duplicate submit / replayed nonce on terminal request is quarantined, does not change state
    const duplicateRes = mailbox.answerRequest({
      requestId: req.requestId,
      agentId: 'claude-desktop',
      response: 'Overwriting hash output',
      attemptId: claim.attemptId,
      epoch: claim.epoch,
      nonce: claim.nonce,
      completionConfidence: 'AUTHENTICATED_SUBMIT'
    });
    assert.equal(duplicateRes.status, 'quarantined');
    assert.ok(duplicateRes.quarantined);

    // Verify terminal request was not mutated
    const postReq = mailbox.getRequest(req.requestId, { agentId: 'chatgpt-desktop' });
    assert.equal(postReq.status, 'completed');
    assert.equal(postReq.response, 'Authoritative hash output');
    assert.equal(postReq.completionConfidence, 'AUTHENTICATED_SUBMIT');

    // Test 5: Cancelled request rejects recipient submit
    const reqCancel = await mailbox.askAgent({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'claude-desktop',
      question: 'To be cancelled',
      asyncMode: true
    });
    const claimCancel = mailbox.claimRequest({
      requestId: reqCancel.requestId,
      agentId: 'claude-desktop'
    });
    mailbox.cancelRequest(reqCancel.requestId, 'chatgpt-desktop');

    const submitCancelled = mailbox.answerRequest({
      requestId: reqCancel.requestId,
      agentId: 'claude-desktop',
      response: 'Late result for cancelled',
      attemptId: claimCancel.attemptId,
      epoch: claimCancel.epoch,
      nonce: claimCancel.nonce,
      completionConfidence: 'AUTHENTICATED_SUBMIT'
    });
    assert.equal(submitCancelled.status, 'quarantined');
    const finalCancelReq = mailbox.getRequest(reqCancel.requestId, { agentId: 'chatgpt-desktop' });
    assert.equal(finalCancelReq.status, 'cancelled');
  });

  await t.test('3.4 Monotonic per-request stage timestamps in RequestTracer & diagnostics', async () => {
    const tracer = new RequestTracer(logger);
    const testReqId = `req_stage_mono_${Date.now()}`;

    const stages = [
      LifecycleStage.ACCEPTED,
      LifecycleStage.CLAIMED,
      LifecycleStage.DELIVERED,
      LifecycleStage.FIRST_RESPONSE_BYTE,
      LifecycleStage.COMPLETION_OBSERVED,
      LifecycleStage.COMMITTED,
      LifecycleStage.NOTIFIED
    ];

    let lastMono = 0;
    for (const stage of stages) {
      const mark = tracer.mark({
        requestId: testReqId,
        stage,
        meta: { test: true }
      });
      assert.ok(mark.monotonicMs >= lastMono, `Monotonic timestamp for stage ${stage} must be non-decreasing`);
      lastMono = mark.monotonicMs;
    }

    const ledger = tracer.getLedger(testReqId);
    assert.ok(ledger);
    assert.ok(ledger.stageTimestamps.accepted);
    assert.ok(ledger.stageTimestamps.claimed);
    assert.ok(ledger.stageTimestamps.delivered);

    // Diagnostics explainRequest reports timeline
    const explainer = new RequestExplainer(logger.db);
    // Insert a dummy row in bridge_requests for explainer
    logger.db.prepare(`
      INSERT INTO bridge_requests (request_id, conversation_id, from_agent, to_agent, question, status, created_at, updated_at)
      VALUES (?, 'conv_explainer', 'chatgpt-desktop', 'claude-desktop', 'Testing timeline', 'pending', datetime('now'), datetime('now'))
    `).run(testReqId);

    const expl = explainer.explainRequest(testReqId, { agentId: 'chatgpt-desktop', isPrivileged: true });
    assert.ok(expl.found);
    assert.ok(expl.timeline.length >= stages.length);
  });

  await t.test('3.5 askAgent compact vs full trace and unmeasured counter truthfulness', async () => {
    // 1. Direct mode byte exactness
    mailbox.registerAgentHandler('exact-responder', async (q) => `EXACT_OUTPUT: ${q}`);
    const directRes = await mailbox.askAgent({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'exact-responder',
      question: 'Binary payload \x00\x01\x02 test\nnewlines\t\t'
    });
    assert.equal(directRes.response, 'EXACT_OUTPUT: Binary payload \x00\x01\x02 test\nnewlines\t\t');
    assert.equal(directRes.bridgeUnaltered, true);

    // 2. Unmeasured counters truthfulness
    const unmeasured = mailbox._resolveModelCounters(null, 'direct');
    assert.equal(unmeasured.additionalModelCalls, null, 'Must report null, not literal 0');
    assert.equal(unmeasured.additionalModelCallsReason, 'UNMEASURED_NO_TOKEN_METRICS');
  });
});
