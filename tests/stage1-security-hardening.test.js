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
    const unconfiguredServer = new BridgeMcpServer();
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
