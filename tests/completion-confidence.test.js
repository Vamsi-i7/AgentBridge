import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AuditLogger } from '../src/audit-logger.js';
import { EventBus } from '../src/event-bus.js';
import { TaskManager } from '../src/task-manager.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { ResponseObserver, ObserverState, CompletionConfidence } from '../src/control-plane/response-observer.js';

function makeEnv(dbPath) {
  const logger = new AuditLogger(dbPath);
  const eventBus = new EventBus(logger, { fallbackIntervalMs: 50 });
  const tasks = new TaskManager(logger, null, eventBus);
  const mailbox = new MailboxHub(logger, tasks, eventBus);
  return { logger, eventBus, tasks, mailbox };
}

test('Stage 1 — Completion Confidence & Grace Re-check Suite', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conf-test-'));
  const dbPath = path.join(tmpDir, 'conf.sqlite');
  const env = makeEnv(dbPath);

  t.after(() => {
    try { env.eventBus.close(); } catch {}
    try { env.logger.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  await t.test('1. EXPLICIT_END_OF_TURN confidence classification and signal recording', async () => {
    const requestId = 'req_explicit_1';
    let tickCount = 0;
    const fakeProbe = async () => {
      tickCount++;
      return {
        running: true,
        textRegions: [
          { snippet: `[Agent Bridge ${requestId}] Prompt` },
          { snippet: 'Explicitly completed model answer.' }
        ],
        turnFinished: tickCount >= 2,
        isGenerating: tickCount < 2
      };
    };

    const observer = new ResponseObserver({
      probe: fakeProbe,
      pollIntervalMs: 25,
      minStableTicks: 2,
      graceRecheckIntervalMs: 0
    });

    const completionPromise = new Promise((resolve) => {
      observer.on('response_completed', resolve);
    });

    observer.startObservation({ targetApp: 'Claude', requestId });
    const completed = await completionPromise;

    assert.equal(completed.requestId, requestId);
    assert.equal(completed.response, 'Explicitly completed model answer.');
    assert.equal(completed.completionConfidence, CompletionConfidence.EXPLICIT_END_OF_TURN);
    assert.ok(completed.observedSignals.includes('EXPLICIT_END_SIGNAL'));
    assert.equal(completed.endOfTurnSignal, 'EXPLICIT_PROBE');
  });

  await t.test('2. INDICATOR_BASED confidence classification on stop-button disappearance', async () => {
    const requestId = 'req_indicator_2';
    let tickCount = 0;
    const fakeProbe = async () => {
      tickCount++;
      return {
        running: true,
        textRegions: [
          { snippet: `[Agent Bridge ${requestId}] Prompt` },
          { snippet: 'Answer finished when stop button cleared.' }
        ],
        turnFinished: false,
        hasStopButton: tickCount === 1,
        isGenerating: tickCount === 1
      };
    };

    const observer = new ResponseObserver({
      probe: fakeProbe,
      pollIntervalMs: 25,
      minStableTicks: 2,
      graceRecheckIntervalMs: 0
    });

    const completionPromise = new Promise((resolve) => {
      observer.on('response_completed', resolve);
    });

    observer.startObservation({ targetApp: 'ChatGPT', requestId });
    const completed = await completionPromise;

    assert.equal(completed.requestId, requestId);
    assert.equal(completed.completionConfidence, CompletionConfidence.INDICATOR_BASED);
    assert.ok(completed.observedSignals.includes('INDICATOR_ACTIVE'));
    assert.ok(completed.observedSignals.includes('INDICATOR_CLEARED'));
  });

  await t.test('3. STABILITY_HEURISTIC with clean post-completion grace check confirmation', async () => {
    const requestId = 'req_heuristic_3';
    let probeCalls = 0;
    const fakeProbe = async () => {
      probeCalls++;
      return {
        running: true,
        textRegions: [
          { snippet: `[Agent Bridge ${requestId}] Prompt` },
          { snippet: 'Heuristically settled answer with no UI indicators.' }
        ],
        turnFinished: false,
        hasStopButton: false,
        isGenerating: false
      };
    };

    const observer = new ResponseObserver({
      probe: fakeProbe,
      pollIntervalMs: 20,
      minStableTicks: 2,
      graceRecheckIntervalMs: 50
    });

    const completionPromise = new Promise((resolve) => {
      observer.on('response_completed', resolve);
    });

    observer.startObservation({ targetApp: 'Gemini', requestId });
    const completed = await completionPromise;

    assert.equal(completed.requestId, requestId);
    assert.equal(completed.completionConfidence, CompletionConfidence.STABILITY_HEURISTIC);
    assert.ok(completed.observedSignals.some(s => s.startsWith('STABLE_TICKS_')));
    assert.ok(completed.graceRecheck, 'Grace recheck metadata must be present');
    assert.equal(completed.graceRecheck.performed, true);
    assert.equal(completed.graceRecheck.textGrew, false);
  });

  await t.test('4. Pause-then-resume: grace check detects text growth and prevents premature settlement', async () => {
    const requestId = 'req_pause_resume_4';
    let calls = 0;
    let resumedEventFired = false;

    // Simulate pause: calls 1-3 return partial text.
    // Call 4 (grace re-check) returns the expanded full text after thinking pause.
    const fakeProbe = async () => {
      calls++;
      const text = calls <= 3
        ? 'First paragraph before pause.'
        : 'First paragraph before pause.\nSecond paragraph after thinking pause completed!';
      return {
        running: true,
        textRegions: [
          { snippet: `[Agent Bridge ${requestId}] Prompt` },
          { snippet: text }
        ],
        turnFinished: calls >= 6,
        isGenerating: false
      };
    };

    const observer = new ResponseObserver({
      probe: fakeProbe,
      pollIntervalMs: 25,
      minStableTicks: 2,
      graceRecheckIntervalMs: 40
    });

    observer.on('grace_check_resumed', (ev) => {
      if (ev.requestId === requestId) {
        resumedEventFired = true;
      }
    });

    const completionPromise = new Promise((resolve) => {
      observer.on('response_completed', resolve);
    });

    observer.startObservation({ targetApp: 'Claude', requestId });
    const completed = await completionPromise;

    assert.equal(resumedEventFired, true, 'grace_check_resumed must fire when text grows during grace check');
    assert.ok(completed.response.includes('Second paragraph after thinking pause completed!'), 'Must settle complete expanded text, never truncated text');
  });

  await t.test('5. STABILITY_HEURISTIC is REJECTED for tasks with side effects', async () => {
    const task = env.tasks.createTask({
      fromAgent: 'antigravity-ide',
      toAgent: 'freebuff',
      title: 'Write production file',
      instructions: 'Update config file on disk',
      context: { hasSideEffects: true, tool: 'bridge_edit_file' }
    });

    // Attempt to submit result with STABILITY_HEURISTIC confidence
    const result = env.mailbox.submitTaskResult({
      taskId: task.id,
      agentId: 'freebuff',
      status: 'completed',
      result: 'Finished writing file',
      completionConfidence: CompletionConfidence.STABILITY_HEURISTIC
    });

    const refreshed = env.tasks.getTask(task.id, false);
    assert.equal(refreshed.status, 'failed', 'Side-effect task must not be completed with heuristic confidence');
    assert.ok(refreshed.error.includes('INSUFFICIENT_COMPLETION_CONFIDENCE'), 'Must contain confidence rejection error');
    assert.ok(refreshed.error.includes('STABILITY_HEURISTIC completions are not accepted for tasks with side effects'));
  });

  await t.test('6. Tasks with side effects succeed with INDICATOR_BASED or EXPLICIT_END_OF_TURN confidence', async () => {
    const task = env.tasks.createTask({
      fromAgent: 'antigravity-ide',
      toAgent: 'freebuff',
      title: 'Safe effectful task',
      instructions: 'Run build command',
      context: { hasSideEffects: true }
    });

    const result = env.mailbox.submitTaskResult({
      taskId: task.id,
      agentId: 'freebuff',
      status: 'completed',
      result: 'Build succeeded cleanly',
      completionConfidence: CompletionConfidence.EXPLICIT_END_OF_TURN,
      observedSignals: ['EXPLICIT_END_SIGNAL']
    });

    const refreshed = env.tasks.getTask(task.id, false);
    assert.equal(refreshed.status, 'completed', 'Side-effect task must succeed with explicit confidence');
    assert.equal(refreshed.result, 'Build succeeded cleanly');
  });

  await t.test('7. Explicit requiredConfidence gating on direct tasks', async () => {
    const task = env.tasks.createTask({
      fromAgent: 'antigravity-ide',
      toAgent: 'freebuff',
      title: 'High confidence ask',
      instructions: 'Strict verification question',
      context: { requiredConfidence: 'EXPLICIT_END_OF_TURN' }
    });

    // Attempt with lower INDICATOR_BASED confidence
    const failedAttempt = env.mailbox.submitTaskResult({
      taskId: task.id,
      agentId: 'freebuff',
      status: 'completed',
      result: 'Answer with indicator only',
      completionConfidence: CompletionConfidence.INDICATOR_BASED
    });

    const refreshedFailed = env.tasks.getTask(task.id, false);
    assert.equal(refreshedFailed.status, 'failed');
    assert.ok(refreshedFailed.error.includes("Task requires 'EXPLICIT_END_OF_TURN' but observed confidence was 'INDICATOR_BASED'"));

    // Fresh task with matching explicit confidence
    const task2 = env.tasks.createTask({
      fromAgent: 'antigravity-ide',
      toAgent: 'freebuff',
      title: 'High confidence ask 2',
      instructions: 'Strict verification question 2',
      context: { requiredConfidence: 'EXPLICIT_END_OF_TURN' }
    });

    const successAttempt = env.mailbox.submitTaskResult({
      taskId: task2.id,
      agentId: 'freebuff',
      status: 'completed',
      result: 'Answer with verified explicit end',
      completionConfidence: CompletionConfidence.EXPLICIT_END_OF_TURN
    });

    const refreshedSuccess = env.tasks.getTask(task2.id, false);
    assert.equal(refreshedSuccess.status, 'completed');
  });

  await t.test('8. Plain asks accept STABILITY_HEURISTIC and surface flags on request and envelope', async () => {
    const ask = await env.mailbox.askAgent({
      fromAgent: 'antigravity-ide',
      toAgent: 'freebuff',
      question: 'What is the current time?',
      asyncMode: true
    });

    const answer = env.mailbox.answerRequest({
      requestId: ask.requestId,
      agentId: 'freebuff',
      response: '17:05 UTC',
      status: 'completed',
      completionConfidence: CompletionConfidence.STABILITY_HEURISTIC,
      observedSignals: ['STABLE_TICKS_3'],
      stableTicks: 3,
      graceRecheck: { performed: true, textGrew: false, intervalMs: 500 }
    });

    const req = env.mailbox.getRequest(ask.requestId);
    assert.equal(req.status, 'completed');
    assert.equal(req.completionConfidence, CompletionConfidence.STABILITY_HEURISTIC);
    assert.equal(req.isHeuristic, true);
    assert.equal(req.envelope.completionConfidence, CompletionConfidence.STABILITY_HEURISTIC);
    assert.equal(req.envelope.isHeuristic, true);
    assert.equal(req.envelope.stableTicks, 3);
    assert.equal(req.envelope.graceRecheck.performed, true);
  });
});
