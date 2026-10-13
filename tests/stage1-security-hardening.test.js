import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { ToolRegistry } from '../src/tool-registry.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { TaskManager } from '../src/task-manager.js';
import { EventBus } from '../src/event-bus.js';
import { AuditLogger } from '../src/audit-logger.js';
import { ArtifactStore } from '../src/artifacts/artifact-store.js';
import { BridgeMcpServer } from '../src/mcp-server.js';
import { RequestTracer, LifecycleStage } from '../src/diagnostics/request-tracer.js';
import { validateTargetApp, escapeJxaString, isAllowedTargetApp } from '../src/utils/jxa-sanitizer.js';
import { AXEngine } from '../src/control-plane/ax-engine.js';
import { ConversationLocator } from '../src/control-plane/conversation-locator.js';
import { DesktopUIAdapter } from '../src/session-adapters/desktop-ui-adapter.js';
import { BridgeHttpServer } from '../src/http-server.js';
import { runBridgeDoctor } from '../src/diagnostics/doctor.js';

function setupFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage1-security-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  const logger = new AuditLogger(dbPath);
  const taskManager = new TaskManager(logger);
  const eventBus = new EventBus(logger);
  const mailbox = new MailboxHub(logger, taskManager, eventBus);
  const artifactStore = new ArtifactStore(logger);
  const registry = new ToolRegistry();
  const tracer = new RequestTracer(logger, { db: logger.db });

  return { tmpDir, dbPath, logger, taskManager, eventBus, mailbox, artifactStore, registry, tracer };
}

test('STAGE 1.1 & 1.2: Unauthenticated / Anonymous callers must not access cross-agent data or effectful tools', async (t) => {
  const { tmpDir, logger, taskManager, eventBus, mailbox, artifactStore, registry, tracer } = setupFixture();
  t.after(() => {
    try { eventBus.close(); } catch {}
    try { mailbox.close(); } catch {}
    try { logger.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  const requestId = 'req_victim_confidential';
  const now = new Date().toISOString();

  // Directly seed the request row
  logger.db.prepare(`
    INSERT INTO bridge_requests (request_id, conversation_id, from_agent, to_agent, question, status, response, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(requestId, 'conv_123', 'claude-desktop', 'chatgpt-desktop', 'Classified inter-agent query', 'completed', 'Secret response text', now, now);

  // Directly seed a message in messages table
  logger.db.prepare(`
    INSERT INTO messages (id, timestamp, from_agent, to_agent, subject, content, reply_to_id, read_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('msg_victim_1', now, 'chatgpt-desktop', 'claude-desktop', 'Private Message', 'Classified inbox contents', null, null);

  tracer.mark({
    requestId,
    stage: LifecycleStage.REQUEST_CREATED,
    agentId: 'claude-desktop',
    meta: { fromAgent: 'claude-desktop', toAgent: 'chatgpt-desktop' }
  });

  const unboundCtx = {
    isPrivileged: false,
    mailbox,
    taskManager,
    eventBus,
    artifactStore,
    tracer,
    logger,
    db: logger.db
  };

  await t.test('1. Unbound / Anonymous caller cannot read request status by passing agentId in args', async () => {
    await assert.rejects(
      () => registry.executeTool('bridge_get_request_status', { requestId, agentId: 'claude-desktop' }, unboundCtx),
      /Unauthorized/i,
      'Unbound caller naming the owner must be rejected from reading request status'
    );
  });

  await t.test('2. Unbound / Anonymous caller cannot read response by passing agentId in args', async () => {
    await assert.rejects(
      () => registry.executeTool('bridge_get_response', { requestId, agentId: 'claude-desktop' }, unboundCtx),
      /Unauthorized/i,
      'Unbound caller naming the owner must be rejected from reading response'
    );
  });

  await t.test('3. Unbound / Anonymous caller cannot read an agent inbox by passing agentId in args', async () => {
    await assert.rejects(
      () => registry.executeTool('bridge_check_inbox', { agentId: 'claude-desktop' }, unboundCtx),
      /Unauthorized/i,
      'Unbound caller naming victim must be rejected from reading inbox'
    );
  });

  await t.test('4. Unbound / Anonymous caller cannot read pending requests by passing agentId in args', async () => {
    await assert.rejects(
      () => registry.executeTool('bridge_get_pending_requests', { agentId: 'chatgpt-desktop' }, unboundCtx),
      /Unauthorized/i,
      'Unbound caller naming victim must be rejected from reading pending requests'
    );
  });

  await t.test('5. Unbound / Anonymous caller cannot read cross-agent events', async () => {
    await assert.rejects(
      () => registry.executeTool('bridge_get_events', {}, unboundCtx),
      /Unauthorized/i,
      'Unbound caller must be rejected from dumping event bus'
    );
  });

  await t.test('6. Unbound / Anonymous caller cannot explain request lifecycle', async () => {
    await assert.rejects(
      () => registry.executeTool('bridge_explain_request', { requestId, agentId: 'claude-desktop' }, unboundCtx),
      /Unauthorized/i,
      'Unbound caller naming victim must be rejected from explaining request'
    );
  });

  await t.test('7. Unconfigured BridgeMcpServer defaults to anonymous identity', async () => {
    const unconfiguredServer = new BridgeMcpServer({ auditLogger: logger });
    try {
      assert.strictEqual(unconfiguredServer.agentId, 'anonymous', 'Unconfigured server must have agentId "anonymous" not "freebuff"');
    } finally {
      try { unconfiguredServer.eventBus?.close(); } catch {}
      try { unconfiguredServer.logger?.close(); } catch {}
    }
  });

  await t.test('8. Anonymous caller cannot execute effectful tools', async () => {
    const anonCtx = {
      isPrivileged: false,
      agentId: 'anonymous',
      mailbox,
      logger
    };

    await assert.rejects(
      () => registry.executeTool('bridge_create_file', { path: path.join(tmpDir, 'test.txt'), content: 'hello' }, anonCtx),
      /Unauthorized|anonymous callers cannot execute effectful/i,
      'Anonymous caller must not execute effectful file mutations'
    );
  });
});

test('STAGE 7: Security Hardening of Latent Injection Surfaces (AR-11, AR-12)', async (t) => {
  await t.test('1. validateTargetApp neutralizes quote, command injection, and script-breakout payloads', () => {
    const hostilePayloads = [
      'Claude"; doShellScript("rm -rf /")',
      'ChatGPT" || id',
      'Claude`whoami`',
      'ChatGPT$(whoami)',
      'Claude${process.env}',
      'Claude\nmaliciousCode()',
      'Claude\r\nmalicious()',
      'Claude\u2028malicious()',
      'Claude\u2029malicious()',
      'Claude; alert(1)',
      'Claude<script>',
      'Claude{evil:1}',
      ''
    ];

    for (const payload of hostilePayloads) {
      assert.throws(
        () => validateTargetApp(payload),
        TypeError,
        `Hostile payload must be rejected: ${payload}`
      );
      assert.strictEqual(isAllowedTargetApp(payload), false);
    }
  });

  await t.test('2. validateTargetApp permits valid standard application names', () => {
    const validApps = ['ChatGPT', 'Claude', 'Gemini', 'Google Chrome', 'Safari', 'Slack', 'Terminal', 'iTerm2'];
    for (const app of validApps) {
      assert.strictEqual(validateTargetApp(app), app);
      assert.strictEqual(isAllowedTargetApp(app), true);
    }
  });

  await t.test('3. AXEngine.buildInspectScript neutralizes hostile payloads and builds safe JXA AST', () => {
    assert.throws(
      () => AXEngine.buildInspectScript('Claude"; doShellScript("rm -rf /")'),
      TypeError,
      'buildInspectScript must throw on hostile injection payload'
    );

    const safeScript = AXEngine.buildInspectScript('Claude');
    assert.ok(safeScript.includes('whose({name: "Claude"})'), 'Must embed safe stringified app name');
    assert.ok(!safeScript.includes('whose({name: "${targetApp}"})'), 'Must not contain raw template interpolation');
  });

  await t.test('4. AXEngine.buildSubmissionScript safely neutralizes hostile inputs and escapes fields', () => {
    assert.throws(
      () => AXEngine.buildSubmissionScript({
        targetApp: 'Claude"; alert(1)',
        escaped: 'hello',
        requestId: 'req_123'
      }),
      TypeError
    );

    const safeSub = AXEngine.buildSubmissionScript({
      targetApp: 'ChatGPT',
      escaped: JSON.stringify('safe text\nwith newlines'),
      requestId: 'req_test_001'
    });
    assert.ok(safeSub.includes('byName("ChatGPT")'), 'App name safely stringified');
    assert.ok(safeSub.includes('indexOf("req_test_001")'), 'RequestId safely stringified');
  });

  await t.test('5. ConversationLocator.buildLocateScript neutralizes hostile payloads', () => {
    assert.throws(
      () => ConversationLocator.buildLocateScript('Claude\u2028breakout'),
      TypeError
    );

    const script = ConversationLocator.buildLocateScript('Claude');
    assert.ok(script.includes('whose({name: "Claude"})'));
  });

  await t.test('6. DesktopUIAdapter.buildInsertScript neutralizes hostile payloads', () => {
    assert.throws(
      () => DesktopUIAdapter.buildInsertScript('ChatGPT`whoami`', 'hello'),
      TypeError
    );

    const script = DesktopUIAdapter.buildInsertScript('Claude', 'hello\u2028world');
    assert.ok(script.includes('whose({name: "Claude"})'));
    assert.ok(!script.includes('\u2028'), 'Must escape Unicode line separators');
  });

  await t.test('7. BridgeHttpServer /health exposes auth status', async () => {
    const unauthServer = new BridgeHttpServer({ port: 0, requireApiKey: false });
    await unauthServer.start();
    const port = unauthServer.port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.status, 'healthy');
      assert.strictEqual(body.auth, 'none-loopback');
      assert.strictEqual(body.authEnabled, false);
    } finally {
      await unauthServer.stop();
    }
  });

  await t.test('8. BridgeDoctor diagnostic reports auth status', async () => {
    const docResult = await runBridgeDoctor();
    assert.ok(['api-key', 'none-loopback'].includes(docResult.auth), 'Doctor must report auth mode');
  });

  await t.test('9. BridgeHttpServer rejects browser Origin on control endpoints', async () => {
    const server = new BridgeHttpServer({ port: 0 });
    await server.start();
    const port = server.port;

    try {
      // Browser Origin rejection
      const originRes = await fetch(`http://127.0.0.1:${port}/api/task`, {
        method: 'POST',
        headers: { 'Origin': 'http://evil.com', 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'test' })
      });
      assert.strictEqual(originRes.status, 403, 'Browser origin must be rejected with 403');
    } finally {
      await server.stop();
    }
  });
});
