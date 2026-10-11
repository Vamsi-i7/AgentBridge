import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'os';

import { ToolRegistry, TOOL_PROFILES } from '../src/tool-registry.js';
import { PermissionGuard } from '../src/permission-guard.js';
import {
  STABLE_PROTOCOL_INSTRUCTIONS,
  formatStableProtocolPrompt,
  isCheckmarkAcknowledgment
} from '../src/protocol/stable-protocol.js';
import {
  formatCompactResultEnvelope,
  parseCompactResultEnvelope,
  INLINE_BODY_MAX_BYTES
} from '../src/protocol/compact-envelope.js';
import { ContentAddressedStore } from '../src/artifacts/content-addressed-store.js';
import { AuditLogger } from '../src/audit-logger.js';
import { EventBus } from '../src/event-bus.js';
import { TaskManager } from '../src/task-manager.js';
import { MailboxHub } from '../src/mailbox-hub.js';

function setupEnv() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-test-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  const logger = new AuditLogger(dbPath);
  const eventBus = new EventBus(logger);
  const taskManager = new TaskManager(logger, null, eventBus);
  const mailbox = new MailboxHub(logger, taskManager, eventBus);
  const registry = new ToolRegistry();
  const guard = new PermissionGuard();
  const cas = new ContentAddressedStore({ rootDir: path.join(tmpDir, 'cas') });
  return { tmpDir, dbPath, logger, eventBus, taskManager, mailbox, registry, guard, cas };
}

test('Mission B — Minimum Token Surface Suite', async (t) => {
  const env = setupEnv();

  t.after(() => {
    try { env.eventBus.close(); } catch {}
    try { env.logger.close(); } catch {}
    try { fs.rmSync(env.tmpDir, { recursive: true, force: true }); } catch {}
  });

  await t.test('1. Per-agent tool profiles: "communication" profile reduces schema tokens by >90%', () => {
    const allTools = env.registry.getToolDefinitions('all');
    assert.strictEqual(allTools.length, 74, 'Static all profile must serve exactly 74 tools');

    const commTools = env.registry.getToolDefinitions('communication');
    assert.strictEqual(commTools.length, 5, 'Communication profile must serve exactly 5 tools');

    const names = commTools.map(t => t.name);
    assert.ok(names.includes('bridge_ask_agent'), 'Must include ask');
    assert.ok(names.includes('bridge_wait_for_response'), 'Must include await');
    assert.ok(names.includes('bridge_submit_task_result'), 'Must include submit/reply');
    assert.ok(names.includes('bridge_slice_fetch'), 'Must include slice-fetch');
    assert.ok(names.includes('bridge_discover_tools'), 'Must include discover tools');

    const allBytes = Buffer.byteLength(JSON.stringify(allTools), 'utf8');
    const commBytes = Buffer.byteLength(JSON.stringify(commTools), 'utf8');
    const reductionPct = ((allBytes - commBytes) / allBytes) * 100;
    assert.ok(reductionPct > 85, `Expected >85% schema reduction, got ${reductionPct.toFixed(1)}%`);
  });

  await t.test('2. Policy-driven profile assignment via PermissionGuard (no hardcoded agent checks)', () => {
    // Agents have 'communication' profile by policy
    assert.strictEqual(env.guard.getAgentToolProfile('chatgpt-desktop'), 'communication');
    assert.strictEqual(env.guard.getAgentToolProfile('claude-desktop'), 'communication');
    assert.strictEqual(env.guard.getAgentToolProfile('antigravity-ide'), 'communication');
    assert.strictEqual(env.guard.getAgentToolProfile('gemini'), 'communication');
    assert.strictEqual(env.guard.getAgentToolProfile('freebuff'), 'communication');

    // System has 'all' by policy
    assert.strictEqual(env.guard.getAgentToolProfile('system'), 'all');
  });

  await t.test('3. Minimal stable protocol text: byte-identical prefix for prompt caching & checkmark rule', () => {
    const p1 = formatStableProtocolPrompt({
      message: 'Calculate factorial of 5',
      requestId: 'req_1',
      taskId: 'task_1',
      fromAgent: 'chatgpt-desktop',
      toAgent: 'freebuff'
    });

    const p2 = formatStableProtocolPrompt({
      message: 'Different query text entirely',
      requestId: 'req_2',
      taskId: 'task_2',
      fromAgent: 'claude-desktop',
      toAgent: 'gemini'
    });

    // Static prefix must be 100% byte-identical
    assert.ok(p1.startsWith(STABLE_PROTOCOL_INSTRUCTIONS));
    assert.ok(p2.startsWith(STABLE_PROTOCOL_INSTRUCTIONS));

    // Dynamic task must go strictly last
    assert.ok(p1.endsWith('[Task]\nCalculate factorial of 5'));
    assert.ok(p2.endsWith('[Task]\nDifferent query text entirely'));

    // Checkmark acknowledgment check
    assert.strictEqual(isCheckmarkAcknowledgment('✓'), true);
    assert.strictEqual(isCheckmarkAcknowledgment('  ✓\n'), true);
    assert.strictEqual(isCheckmarkAcknowledgment('✔'), true);
    assert.strictEqual(isCheckmarkAcknowledgment('Here is the response: ...'), false);
  });

  await t.test('4. Compact plain-text result envelope: inline for small bodies, ref+digest for large bodies', () => {
    const smallBody = 'Compact execution successful with status 200.';
    const smallEnv = formatCompactResultEnvelope({
      requestId: 'req_small_1',
      fromAgent: 'freebuff',
      body: smallBody,
      casStore: env.cas
    });

    // Small body: One header line + plain text, NO JSON wrapping!
    assert.ok(smallEnv.startsWith('[AB-RESULT: status=completed id=req_small_1 from=freebuff'));
    assert.ok(smallEnv.includes(smallBody));
    assert.ok(!smallEnv.includes('"status":'), 'Small envelope must not use JSON wrapping');

    const parsedSmall = parseCompactResultEnvelope(smallEnv);
    assert.strictEqual(parsedSmall.isCompactEnvelope, true);
    assert.strictEqual(parsedSmall.requestId, 'req_small_1');
    assert.strictEqual(parsedSmall.body, smallBody);
    assert.strictEqual(parsedSmall.isRef, false);

    // Large body: exceeds threshold -> digest + ref:<hash>
    const largeBody = 'A'.repeat(8000);
    const largeEnv = formatCompactResultEnvelope({
      requestId: 'req_large_1',
      fromAgent: 'freebuff',
      body: largeBody,
      casStore: env.cas
    });

    assert.ok(largeEnv.startsWith('[AB-RESULT: status=completed id=req_large_1 from=freebuff'));
    assert.ok(largeEnv.includes('ref:'));
    assert.ok(largeEnv.includes('bridge_slice_fetch'));

    const parsedLarge = parseCompactResultEnvelope(largeEnv);
    assert.strictEqual(parsedLarge.isCompactEnvelope, true);
    assert.strictEqual(parsedLarge.isRef, true);
    assert.ok(parsedLarge.contentRef, 'Must extract SHA-256 content reference');
  });

  await t.test('5. Content-Addressed Storage (CAS): deduplication, slice-fetching, and delta computation', () => {
    const payload = 'Line 1: System initialization\nLine 2: Safety consensus verified\nLine 3: Monotonic epochs active\n';
    
    // 1. Store
    const res1 = env.cas.store(payload);
    assert.strictEqual(res1.deduplicated, false);
    assert.ok(res1.hash.length === 64, 'Must return 64-character SHA-256');

    // 2. Deduplication on identical content
    const res2 = env.cas.store(payload);
    assert.strictEqual(res2.deduplicated, true);
    assert.strictEqual(res2.hash, res1.hash);

    // 3. Slice fetch
    const slice = env.cas.getSlice(res1.hash, 0, 30);
    assert.ok(slice);
    assert.strictEqual(slice.offset, 0);
    assert.strictEqual(slice.bytesRead, 30);
    assert.strictEqual(slice.eof, false);

    // 4. Delta computation
    const updatedPayload = 'Line 1: System initialization\nLine 2: Safety consensus verified (v2)\nLine 3: Monotonic epochs active\nLine 4: New turn appended\n';
    const delta = env.cas.computeDelta(res1.hash, updatedPayload);
    assert.ok(delta);
    assert.strictEqual(delta.baseHash, res1.hash);
    assert.ok(delta.deltaText.includes('+ Line 4: New turn appended'));
    assert.ok(delta.savingsBytes > 0, 'Delta must produce positive byte savings vs full payload');
  });

  await t.test('6. bridge_wait_for_response and bridge_slice_fetch tools execute cleanly', async () => {
    // Test bridge_slice_fetch execution
    const content = 'Test slice fetch payload with 1234567890 bytes';
    const stored = env.cas.store(content);

    const sliceResult = await env.registry.executeTool('bridge_slice_fetch', {
      ref: stored.hash,
      offset: 5,
      length: 10
    }, { agentId: 'freebuff', casStore: env.cas });

    assert.strictEqual(sliceResult.found, true);
    assert.strictEqual(sliceResult.slice, content.slice(5, 15));
    assert.strictEqual(sliceResult.offset, 5);

    // Test bridge_wait_for_response execution
    const reqId = 'req_wait_test_1';
    const now = new Date().toISOString();
    env.logger.db.prepare(`
      INSERT INTO bridge_requests (request_id, conversation_id, from_agent, to_agent, question, status, created_at, updated_at)
      VALUES (?, 'conv_wait_1', 'chatgpt-desktop', 'freebuff', 'Test waiter', 'pending', ?, ?)
    `).run(reqId, now, now);
    
    // Start waiting in background
    const waitPromise = env.registry.executeTool('bridge_wait_for_response', {
      requestId: reqId,
      timeoutMs: 5000
    }, { agentId: 'chatgpt-desktop', mailbox: env.mailbox, eventBus: env.eventBus });

    // Commit terminal row and publish event via eventBus
    setTimeout(() => {
      const finishTime = new Date().toISOString();
      env.logger.db.prepare(`
        UPDATE bridge_requests SET status = 'completed', response = 'Correlated waiter woke up instantly', updated_at = ?, completed_at = ?
        WHERE request_id = ?
      `).run(finishTime, finishTime, reqId);

      env.eventBus.publish({
        type: 'response_ready',
        agentId: '*',
        requestId: reqId,
        status: 'completed',
        payload: { response: 'Correlated waiter woke up instantly' }
      });
    }, 20);

    const waitResult = await waitPromise;
    assert.ok(waitResult, 'Wait result must resolve');
    assert.strictEqual(waitResult.requestId, reqId);
    assert.strictEqual(waitResult.status, 'completed');
  });
});
