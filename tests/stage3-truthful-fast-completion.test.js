import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { AuditLogger } from '../src/audit-logger.js';
import { MailboxHub, CONFIDENCE_RANK } from '../src/mailbox-hub.js';
import { TaskManager } from '../src/task-manager.js';
import { EventBus } from '../src/event-bus.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { CompletionConfidence } from '../src/control-plane/response-observer.js';
import { DesktopAgentWorker } from '../src/control-plane/desktop-agent-worker.js';
import { RequestTracer, LifecycleStage } from '../src/diagnostics/request-tracer.js';

test('Stage 3: Truthful and Fast Completion Verification Suite', async (t) => {
  const tmpDir = path.join(os.tmpdir(), `bridge-stage3-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const dbPath = path.join(tmpDir, 'stage3_test.db');
  const logger = new AuditLogger(dbPath);
  const bus = new EventBus(logger);
  const taskMgr = new TaskManager(logger, null, bus);
  const mailbox = new MailboxHub(logger, taskMgr, bus);
  const registry = new ToolRegistry();

  t.after(() => {
    mailbox.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  await t.test('3.1 Tier Map and monotonic confidence hierarchy', async () => {
    // Verify all four tiers exist in CompletionConfidence
    assert.equal(CompletionConfidence.AUTHENTICATED_SUBMIT, 'AUTHENTICATED_SUBMIT');
    assert.equal(CompletionConfidence.EXPLICIT_END_OF_TURN, 'EXPLICIT_END_OF_TURN');
    assert.equal(CompletionConfidence.INDICATOR_BASED, 'INDICATOR_BASED');
    assert.equal(CompletionConfidence.STABILITY_HEURISTIC, 'STABILITY_HEURISTIC');

    // Verify CONFIDENCE_RANK hierarchy
    assert.ok(CONFIDENCE_RANK['AUTHENTICATED_SUBMIT'] > CONFIDENCE_RANK['EXPLICIT_END_OF_TURN']);
    assert.ok(CONFIDENCE_RANK['EXPLICIT_END_OF_TURN'] > CONFIDENCE_RANK['INDICATOR_BASED']);
    assert.ok(CONFIDENCE_RANK['INDICATOR_BASED'] > CONFIDENCE_RANK['STABILITY_HEURISTIC']);

    // Required confidence enforcement in submitTaskResult / answerRequest:
    // When a task requires EXPLICIT_END_OF_TURN, STABILITY_HEURISTIC is rejected
    const req = await mailbox.askAgent({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'claude-desktop',
      question: 'Test monotonic confidence rejection',
      context: { requiredConfidence: 'EXPLICIT_END_OF_TURN' },
      asyncMode: true
    });
    const claim = mailbox.claimRequest({
      requestId: req.requestId,
      agentId: 'claude-desktop',
      workerId: 'worker_tier_test'
    });

    // 1. Submitting with STABILITY_HEURISTIC is rejected because requiredConfidence is EXPLICIT_END_OF_TURN
    const failRes = mailbox.answerRequest({
      requestId: req.requestId,
      agentId: 'claude-desktop',
      response: 'Heuristic preliminary result',
      attemptId: claim.attemptId,
      epoch: claim.epoch,
      completionConfidence: 'STABILITY_HEURISTIC'
    });
    assert.equal(failRes.status, 'failed');
    assert.ok(failRes.error.includes('INSUFFICIENT_COMPLETION_CONFIDENCE'));

    // 2. Submitting with AUTHENTICATED_SUBMIT (higher than EXPLICIT_END_OF_TURN) succeeds
    const req2 = await mailbox.askAgent({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'claude-desktop',
      question: 'Test authenticated submit confidence',
      context: { requiredConfidence: 'EXPLICIT_END_OF_TURN' },
      asyncMode: true
    });
    const claim2 = mailbox.claimRequest({
      requestId: req2.requestId,
      agentId: 'claude-desktop',
      workerId: 'worker_tier_test2'
    });

    const passRes = mailbox.answerRequest({
      requestId: req2.requestId,
      agentId: 'claude-desktop',
      response: 'Authoritative authenticated result',
      attemptId: claim2.attemptId,
      epoch: claim2.epoch,
      completionConfidence: 'AUTHENTICATED_SUBMIT'
    });
    assert.equal(passRes.status, 'completed');

    const storedReq = mailbox.getRequest(req2.requestId, { agentId: 'chatgpt-desktop' });
    assert.equal(storedReq.completionConfidence, 'AUTHENTICATED_SUBMIT');
  });

  await t.test('3.2 Protocol suffix appended to direct prompt and nonce generated on claim', async () => {
    // Create request
    const req = await mailbox.askAgent({
      fromAgent: 'gemini',
      toAgent: 'chatgpt-desktop',
      question: 'Analyze data batch 42',
      asyncMode: true
    });

    let capturedPrompt = null;
    let cancelCalled = false;
    const fakeSession = {
      name: 'fake_session',
      isAttached: () => true,
      send: async ({ text, requestId }) => {
        capturedPrompt = text;
        return new Promise((resolve) => {
          fakeSession._onCancel = () => resolve({ success: true, response: 'cancelled', confidence: 'CANCELLED' });
        });
      },
      cancel: (rId) => {
        if (rId === req.requestId) {
          cancelCalled = true;
          if (fakeSession._onCancel) fakeSession._onCancel();
        }
      }
    };

    const worker = new DesktopAgentWorker({
      workerId: 'worker_suffix_test',
      agentId: 'chatgpt-desktop',
      mailbox,
      session: fakeSession,
      eventBus: bus,
      pollIntervalMs: 50
    });

    // Worker handles the request
    const handlePromise = worker.handleRequest(req.requestId);

    // Allow async dispatch to reach session.send
    await new Promise(r => setTimeout(r, 60));

    // Verify prompt has protocol suffix
    assert.ok(capturedPrompt, 'Prompt must have been passed to session.send');
    assert.ok(capturedPrompt.includes('Analyze data batch 42'));
    assert.ok(capturedPrompt.includes('[Agent Bridge Protocol:'), 'Must append Agent Bridge Protocol suffix');
    
    // Parse protocol JSON from suffix
    const suffixMatch = capturedPrompt.match(/\[Agent Bridge Protocol: (\{.*?\})\]/s);
    assert.ok(suffixMatch, 'Protocol block must be well-formed JSON');
    const parsedSuffix = JSON.parse(suffixMatch[1]);
    assert.equal(parsedSuffix.requestId, req.requestId);
    assert.ok(parsedSuffix.attemptId, 'Must have attemptId');
    assert.ok(parsedSuffix.epoch >= 1, 'Must have epoch >= 1');
    assert.ok(parsedSuffix.nonce, 'claimRequest must generate and include nonce in protocol suffix');

    // Fast-path test: simulate recipient agent calling bridge_answer_request with AUTHENTICATED_SUBMIT
    // Settle through answerRequest with attemptId & epoch from parsedSuffix
    mailbox.answerRequest({
      requestId: req.requestId,
      agentId: 'chatgpt-desktop',
      response: 'Batch 42 analysis complete: zero defects',
      attemptId: parsedSuffix.attemptId,
      epoch: parsedSuffix.epoch,
      completionConfidence: 'AUTHENTICATED_SUBMIT'
    });

    const result = await handlePromise;
    assert.ok(cancelCalled, 'session.cancel must be called when AUTHENTICATED_SUBMIT settles');
    assert.ok(result.handled);
  });

  await t.test('3.3 Measured model counters: No tautological 0 literals', async () => {
    // 1. Without TokenAccountant recorded turns, returns null with reason
    const unmeasuredCounters = mailbox._resolveModelCounters(null, 'direct');
    assert.equal(unmeasuredCounters.additionalModelCalls, null, 'Must report null when unmeasured, never literal 0');
    assert.equal(unmeasuredCounters.modelRegenerationTokens, null, 'Must report null when unmeasured, never literal 0');
    assert.equal(unmeasuredCounters.additionalModelCallsReason, 'UNMEASURED_NO_TOKEN_METRICS');
    assert.equal(unmeasuredCounters.modelRegenerationTokensReason, 'UNMEASURED_NO_TOKEN_METRICS');

    // 2. When TokenAccountant HAS recorded turns, returns measured numbers
    const req2 = await mailbox.askAgent({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'claude-desktop',
      question: 'Measured turn query',
      asyncMode: true
    });

    // Record turn in tokenAccountant
    mailbox.tokenAccountant.recordTurn({
      requestId: req2.requestId,
      taskId: req2.taskId,
      modelCalls: 2,
      inputTokens: 150,
      outputTokens: 75,
      tokensSavedVsSchema: 40
    });

    const claim2 = mailbox.claimRequest({
      requestId: req2.requestId,
      agentId: 'claude-desktop',
      workerId: 'worker_measured'
    });

    mailbox.answerRequest({
      requestId: req2.requestId,
      agentId: 'claude-desktop',
      response: 'Measured output',
      attemptId: claim2.attemptId,
      epoch: claim2.epoch
    });

    // Reattach to completed request
    const resMeasured = await mailbox.askAgent({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'claude-desktop',
      requestId: req2.requestId,
      question: 'Measured turn query'
    });

    assert.equal(resMeasured.additionalModelCalls, 0, 'Direct response with bypassed turn reports 0');
    assert.equal(resMeasured.additionalModelCallsReason, null);
    assert.equal(resMeasured.modelRegenerationTokens, 0);
    assert.equal(resMeasured.modelRegenerationTokensReason, null);
  });

  await t.test('3.4 Default compact MCP result shape vs includeFullTrace: true opt-in', async () => {
    mailbox.registerAgentHandler('responder-agent', async () => 'Compact response text');

    const ctx = {
      mailbox,
      isPrivileged: true
    };

    // 1. Default invocation (no includeFullTrace) -> compact shape
    const compactResult = await registry.executeTool('bridge_ask_agent', {
      fromAgent: 'requester-agent',
      toAgent: 'responder-agent',
      question: 'What is the compact shape?'
    }, ctx);

    assert.ok(compactResult.requestId, 'Must have requestId');
    assert.equal(compactResult.status, 'completed');
    assert.equal(compactResult.response, 'Compact response text');
    assert.equal(compactResult.error, null);
    assert.equal(compactResult.completionConfidence, 'EXPLICIT_END_OF_TURN');
    assert.equal(compactResult.untrustedData, true);

    // Verify compact shape DOES NOT contain large internal envelopes, trace logs, or verbose metadata
    assert.equal(compactResult.envelope, undefined, 'Compact result must NOT include internal envelope');
    assert.equal(compactResult.tokenMetrics, undefined, 'Compact result must NOT include tokenMetrics');
    assert.equal(compactResult.mode, undefined, 'Compact result must NOT include internal mode');

    // 2. Opt-in with includeFullTrace: true -> full payload shape
    const fullResult = await registry.executeTool('bridge_ask_agent', {
      fromAgent: 'requester-agent',
      toAgent: 'responder-agent',
      question: 'What is the full shape?',
      includeFullTrace: true
    }, ctx);

    assert.ok(fullResult.requestId);
    assert.equal(fullResult.status, 'completed');
    assert.equal(fullResult.response, 'Compact response text');
    assert.ok(fullResult.envelope !== undefined, 'Full result MUST include envelope');
    assert.ok(fullResult.tokenMetrics !== undefined, 'Full result MUST include tokenMetrics');
    assert.equal(fullResult.mode, 'synchronous_peer_response');
  });

  await t.test('3.5 Monotonic stage timings verification in RequestTracer', () => {
    const tracer = new RequestTracer(logger);
    assert.ok(tracer.enabled);

    const testReqId = `req_mono_${Date.now()}`;
    const m1 = tracer.mark({
      requestId: testReqId,
      stage: LifecycleStage.ACCEPTED,
      meta: { fromAgent: 'agent-a', toAgent: 'agent-b' }
    });
    assert.ok(m1);
    assert.equal(typeof m1.monotonicMs, 'number');

    const m2 = tracer.mark({
      requestId: testReqId,
      stage: LifecycleStage.PROVIDER_SUBMITTED,
      meta: { deliveryEvidence: 'direct' }
    });
    assert.ok(m2);
    assert.ok(m2.monotonicMs >= m1.monotonicMs, 'monotonicMs must be monotonically increasing');

    const m3 = tracer.mark({
      requestId: testReqId,
      stage: LifecycleStage.PROVIDER_RESPONSE_COMPLETED,
      meta: { completionEvidence: 'AUTHENTICATED_SUBMIT' }
    });
    assert.ok(m3);
    assert.ok(m3.monotonicMs >= m2.monotonicMs, 'monotonicMs must be monotonically increasing');

    const ledger = tracer.getLedger(testReqId);
    assert.ok(ledger);
    assert.ok(ledger.stageTimestamps.accepted);
    assert.equal(ledger.stageTimestamps.accepted.deltaMs, 0);
    assert.ok(ledger.stageTimestamps.delivered);
    assert.ok(ledger.stageTimestamps.delivered.deltaMs >= 0, 'Stage deltaMs must be non-negative');
    assert.ok(ledger.stageTimestamps.completion);
    assert.ok(ledger.stageTimestamps.completion.deltaMs >= ledger.stageTimestamps.delivered.deltaMs, 'Stage deltaMs must be monotonically non-decreasing');
  });
});
