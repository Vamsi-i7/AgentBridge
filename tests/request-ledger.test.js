import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

import { AuditLogger } from '../src/audit-logger.js';
import { EventBus } from '../src/event-bus.js';
import { TaskManager } from '../src/task-manager.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { RequestTracer, LifecycleStage } from '../src/diagnostics/request-tracer.js';
import { RequestExplainer } from '../src/diagnostics/request-explainer.js';
import { ToolRegistry } from '../src/tool-registry.js';

function setupEnv() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  const logger = new AuditLogger(dbPath);
  const eventBus = new EventBus(logger);
  const taskManager = new TaskManager(logger, null, eventBus);
  const mailbox = new MailboxHub(logger, taskManager, eventBus);
  const tracer = mailbox.tracer;
  const explainer = new RequestExplainer(logger);
  const registry = new ToolRegistry();
  return { tmpDir, dbPath, logger, eventBus, taskManager, mailbox, tracer, explainer, registry };
}

test('Mission A — Lightweight Per-Request Ledger Suite', async (t) => {
  const env = setupEnv();

  t.after(() => {
    try { env.eventBus.close(); } catch {}
    try { env.logger.close(); } catch {}
    try { fs.rmSync(env.tmpDir, { recursive: true, force: true }); } catch {}
  });

  await t.test('1. Full end-to-end stage progression records all stage timestamps and metrics', async () => {
    const reqId = 'req_full_success_1';
    
    // 1. Accepted (askAgent)
    const askPromise = env.mailbox.askAgent({
      fromAgent: 'antigravity-ide',
      toAgent: 'freebuff',
      question: 'Verify consensus invariants for Mission A',
      requestId: reqId
    });

    // 2. Claimed
    const claimed = env.mailbox.claimNextTask('freebuff');
    assert.ok(claimed, 'Task should be claimed');

    // 3. Delivered (mock delivery evidence)
    env.tracer.mark({
      requestId: reqId,
      stage: LifecycleStage.DELIVERED,
      taskId: claimed.id,
      agentId: 'freebuff',
      routeId: 'mcp-stdio',
      meta: { deliveryEvidence: 'mcp-stdio:pid_77697' }
    });

    // 4. First Response Byte
    env.tracer.mark({
      requestId: reqId,
      stage: LifecycleStage.FIRST_RESPONSE_BYTE,
      taskId: claimed.id,
      agentId: 'freebuff'
    });

    // 5. Completion Observed & 6. Committed & 7. Notified
    env.mailbox.submitTaskResult({
      taskId: claimed.id,
      agentId: 'freebuff',
      status: 'completed',
      result: 'Invariants verified successfully.',
      completionConfidence: 'EXPLICIT_END_OF_TURN',
      observedSignals: ['EXPLICIT_PROBE', 'TURN_END'],
      attemptId: claimed.attemptId,
      epoch: claimed.epoch
    });

    // 8. Retrieved (askPromise resolves)
    const result = await askPromise;
    assert.equal(result.status, 'completed');

    // Verify Ledger contents
    const ledger = env.tracer.getLedger(reqId);
    assert.ok(ledger, 'Ledger must exist for request');
    assert.equal(ledger.requestId, reqId);
    assert.equal(ledger.status, 'completed');
    assert.equal(ledger.fromAgent, 'antigravity-ide');
    assert.equal(ledger.toAgent, 'freebuff');
    assert.equal(ledger.failureStage, null, 'Successful request must have no failureStage');

    // Verify all stage timestamps exist
    const ts = ledger.stageTimestamps;
    assert.ok(ts.accepted, 'accepted timestamp must exist');
    assert.ok(ts.claimed, 'claimed timestamp must exist');
    assert.ok(ts.delivered, 'delivered timestamp must exist');
    assert.equal(ts.delivered.evidence, 'mcp-stdio:pid_77697');
    assert.ok(ts.firstResponseByte, 'firstResponseByte timestamp must exist');
    assert.ok(ts.completion, 'completion timestamp must exist');
    assert.equal(ts.completion.type, 'EXPLICIT_END_OF_TURN');
    assert.ok(ts.completion.evidence.includes('EXPLICIT_PROBE'));
    assert.ok(ts.committed, 'committed timestamp must exist');
    assert.ok(ts.notified, 'notified timestamp must exist');
    assert.ok(ts.retrieved, 'retrieved timestamp must exist');

    // Verify metrics
    assert.ok(ledger.metrics.tokensIn > 0, 'tokensIn should be tracked');
    assert.ok(ledger.metrics.tokensOut > 0, 'tokensOut should be tracked');
    assert.equal(ledger.metrics.toolSchemaOverheadTokens, 6740);
    assert.ok(ledger.metrics.bodySizeBytes > 0, 'bodySizeBytes should be tracked');
    assert.ok(ledger.metrics.totalDurationMs >= 0, 'totalDurationMs should be non-negative');
  });

  await t.test('2. Failed request attributes failure to the exact stage where chain stopped (DELIVERED)', async () => {
    const reqId = 'req_timeout_after_deliver';

    // Accepted
    env.tracer.mark({
      requestId: reqId,
      stage: LifecycleStage.ACCEPTED,
      agentId: 'claude-desktop',
      meta: { fromAgent: 'antigravity-ide', toAgent: 'claude-desktop', bodySizeBytes: 120 }
    });

    // Claimed
    env.tracer.mark({
      requestId: reqId,
      stage: LifecycleStage.CLAIMED,
      agentId: 'claude-desktop'
    });

    // Delivered
    env.tracer.mark({
      requestId: reqId,
      stage: LifecycleStage.DELIVERED,
      agentId: 'claude-desktop',
      routeId: 'cdp-electron',
      meta: { deliveryEvidence: 'cdp:ws_debugger_active' }
    });

    // Recipient stalled: never sent first byte! Timeout triggered
    env.tracer.mark({
      requestId: reqId,
      stage: LifecycleStage.TIMEOUT,
      agentId: 'claude-desktop',
      meta: { timeoutMs: 30000, error: 'Request timed out after 30000ms' }
    });

    const ledger = env.tracer.getLedger(reqId);
    assert.ok(ledger);
    assert.equal(ledger.status, 'timeout');
    // Must attribute failure to DELIVERED stage, not generic timeout!
    assert.ok(ledger.failureStage.includes('DELIVERED'), `Expected failure stage to name DELIVERED, got: ${ledger.failureStage}`);
    assert.ok(ledger.failureStage.includes('no first response byte received'));
  });

  await t.test('3. Failed request attributes failure to ACCEPTED if unclaimed in mailbox', async () => {
    const reqId = 'req_unclaimed_timeout';

    // Accepted but never claimed
    env.tracer.mark({
      requestId: reqId,
      stage: LifecycleStage.ACCEPTED,
      agentId: 'gemini',
      meta: { fromAgent: 'antigravity-ide', toAgent: 'gemini', bodySizeBytes: 85 }
    });

    // Timeout
    env.tracer.mark({
      requestId: reqId,
      stage: LifecycleStage.TIMEOUT,
      agentId: 'gemini',
      meta: { timeoutMs: 15000 }
    });

    const ledger = env.tracer.getLedger(reqId);
    assert.ok(ledger);
    assert.equal(ledger.status, 'timeout');
    assert.ok(ledger.failureStage.includes('ACCEPTED'), `Expected failure stage to name ACCEPTED, got: ${ledger.failureStage}`);
    assert.ok(ledger.failureStage.includes('remained unclaimed'));
  });

  await t.test('4. bridge_request_ledger and bridge_explain_request tools return ledger', async () => {
    const reqId = 'req_tool_inspect_1';
    const now = new Date().toISOString();
    env.logger.db.prepare(`
      INSERT INTO bridge_requests (request_id, conversation_id, from_agent, to_agent, question, status, created_at, updated_at)
      VALUES (?, 'conv_1', 'chatgpt-desktop', 'freebuff', 'Audit token accounting', 'completed', ?, ?)
    `).run(reqId, now, now);

    env.tracer.mark({
      requestId: reqId,
      stage: LifecycleStage.ACCEPTED,
      agentId: 'freebuff',
      meta: { fromAgent: 'chatgpt-desktop', toAgent: 'freebuff' }
    });
    env.tracer.mark({
      requestId: reqId,
      stage: LifecycleStage.COMMITTED,
      agentId: 'freebuff'
    });
    env.tracer.mark({
      requestId: reqId,
      stage: LifecycleStage.RETRIEVED,
      agentId: 'chatgpt-desktop'
    });

    // Execute via bridge_request_ledger
    const ledgerToolResult = await env.registry.executeTool('bridge_request_ledger', { requestId: reqId }, {
      mailbox: env.mailbox,
      tracer: env.tracer,
      isPrivileged: true
    });

    assert.equal(ledgerToolResult.found, true);
    assert.equal(ledgerToolResult.requestId, reqId);
    assert.ok(ledgerToolResult.ledger);
    assert.ok(ledgerToolResult.formatted.includes('AGENT BRIDGE — REQUEST LIFECYCLE LEDGER'));

    // Execute via bridge_explain_request
    const explainToolResult = await env.registry.executeTool('bridge_explain_request', { requestId: reqId }, {
      mailbox: env.mailbox,
      tracer: env.tracer,
      isPrivileged: true
    });

    assert.equal(explainToolResult.found, true);
    assert.ok(explainToolResult.ledger);
    assert.ok(explainToolResult.formattedLedger);
  });

  await t.test('5. Standalone CLI script scripts/bench/request-ledger.js prints formatted report', () => {
    const reqId = 'req_cli_test_1';
    env.tracer.mark({
      requestId: reqId,
      stage: LifecycleStage.ACCEPTED,
      agentId: 'freebuff',
      meta: { fromAgent: 'antigravity-ide', toAgent: 'freebuff', bodySizeBytes: 250, tokensIn: 62 }
    });
    env.tracer.mark({
      requestId: reqId,
      stage: LifecycleStage.RETRIEVED,
      agentId: 'antigravity-ide',
      meta: { tokensOut: 110 }
    });

    const output = execFileSync('node', [
      path.join(process.cwd(), 'scripts/bench/request-ledger.js'),
      reqId
    ], {
      env: { ...process.env, AGENT_BRIDGE_DB_PATH: env.dbPath },
      encoding: 'utf8'
    });

    assert.ok(output.includes('AGENT BRIDGE — REQUEST LIFECYCLE LEDGER'));
    assert.ok(output.includes(reqId));
    assert.ok(output.includes('STAGE TIMELINE:'));
    assert.ok(output.includes('METRICS & TOKENS:'));
  });
});
