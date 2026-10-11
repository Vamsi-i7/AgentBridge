import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { AgentIdentityManager } from '../src/agent-identity.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { EventBus } from '../src/event-bus.js';
import { TaskManager } from '../src/task-manager.js';
import { DatabaseSync } from 'node:sqlite';

function createMockAuditLogger() {
  const db = new DatabaseSync(':memory:');
  return {
    db,
    log: () => {},
    close: () => { try { db.close(); } catch {} }
  };
}

test('Stage 1.1: Unbound caller identity confinement', async (t) => {
  const reg = new ToolRegistry();
  const logger = createMockAuditLogger();
  const identity = new AgentIdentityManager(logger, null); // Unbound identity
  const eventBus = new EventBus(logger);
  const taskManager = new TaskManager(logger);
  const mailbox = new MailboxHub(logger, taskManager, eventBus);

  const unboundCtx = {
    identity,
    mailbox,
    taskManager,
    eventBus,
    logger
  };

  t.after(() => {
    logger.close();
  });

  const spoofTargets = ['system', 'antigravity-ide', 'freebuff'];

  for (const spoof of spoofTargets) {
    await t.test(`Unbound caller passing agentId='${spoof}' stays anonymous and is denied execution`, async () => {
      await assert.rejects(
        () => reg.executeTool('bridge_execute_command', { commandLine: 'echo 1', agentId: spoof }, unboundCtx),
        /Unauthorized: anonymous callers cannot execute effectful tool 'bridge_execute_command'/i
      );
    });

    await t.test(`Unbound caller passing agentId='${spoof}' is denied inbox`, async () => {
      await assert.rejects(
        () => reg.executeTool('bridge_check_inbox', { agentId: spoof }, unboundCtx),
        /Unauthorized: no authenticated identity on this connection; cannot read inbox/i
      );
    });

    await t.test(`Unbound caller passing agentId='${spoof}' is denied events`, async () => {
      await assert.rejects(
        () => reg.executeTool('bridge_get_events', { agentId: spoof }, unboundCtx),
        /Unauthorized: no authenticated identity on this connection; cannot read event bus events/i
      );
    });

    await t.test(`Unbound caller passing agentId='${spoof}' is denied pending requests`, async () => {
      await assert.rejects(
        () => reg.executeTool('bridge_get_pending_requests', { agentId: spoof }, unboundCtx),
        /Unauthorized: no authenticated identity on this connection; cannot retrieve pending requests/i
      );
    });

    await t.test(`Unbound caller passing agentId='${spoof}' is denied responses`, async () => {
      await assert.rejects(
        () => reg.executeTool('bridge_get_response', { requestId: 'req_nonexistent', agentId: spoof }, unboundCtx),
        /Unauthorized: no authenticated identity on this connection; cannot retrieve responses/i
      );
    });

    await t.test(`Unbound caller passing agentId='${spoof}' is denied audit logs`, async () => {
      await assert.rejects(
        () => reg.executeTool('bridge_get_audit_log', { agentId: spoof }, unboundCtx),
        /Forbidden: audit logs require privileged administrative access/i
      );
    });
  }
});

test('Stage 1.1: Mismatched identity rejection for bound connections', async (t) => {
  const reg = new ToolRegistry();
  const logger = createMockAuditLogger();
  const boundCtx = {
    boundAgentId: 'claude-desktop',
    agentId: 'claude-desktop',
    logger
  };

  t.after(() => {
    logger.close();
  });

  await t.test('Bound caller passing mismatched agentId is rejected with explicit error', async () => {
    await assert.rejects(
      () => reg.executeTool('bridge_ping', { agentId: 'freebuff' }, boundCtx),
      /Unauthorized: caller 'claude-desktop' cannot impersonate or act as 'freebuff'/i
    );
  });

  await t.test('Bound caller passing mismatched fromAgent is rejected with explicit error', async () => {
    await assert.rejects(
      () => reg.executeTool('bridge_ping', { fromAgent: 'freebuff' }, boundCtx),
      /Unauthorized: caller 'claude-desktop' cannot send as 'freebuff'/i
    );
  });

  await t.test('Bound caller passing mismatched approver is rejected with explicit error', async () => {
    await assert.rejects(
      () => reg.executeTool('bridge_ping', { approver: 'freebuff' }, boundCtx),
      /Unauthorized: caller 'claude-desktop' cannot act as approver 'freebuff'/i
    );
  });

  await t.test('Bound caller passing mismatched actor is rejected with explicit error', async () => {
    await assert.rejects(
      () => reg.executeTool('bridge_ping', { actor: 'freebuff' }, boundCtx),
      /Unauthorized: caller 'claude-desktop' cannot act as 'freebuff'/i
    );
  });
});
