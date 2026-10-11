import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AuditLogger } from '../src/audit-logger.js';
import { EventBus } from '../src/event-bus.js';
import { TaskManager } from '../src/task-manager.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { PermissionGuard } from '../src/permission-guard.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { BridgeHttpServer } from '../src/http-server.js';
import { RequestTracer, LifecycleStage } from '../src/diagnostics/request-tracer.js';

// Invariant: an UNBOUND caller must not read another pair of agents' request
// ledger by naming one of the participants in `arguments`.

function setupEnv() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-ledger-http-'));
  const logger = new AuditLogger(path.join(tmpDir, 'test.sqlite'));
  const eventBus = new EventBus(logger);
  const taskManager = new TaskManager(logger, null, eventBus);
  const mailbox = new MailboxHub(logger, taskManager, eventBus);
  const guard = new PermissionGuard();
  const registry = new ToolRegistry();
  const tracer = new RequestTracer(logger, { db: logger.db });
  return { tmpDir, logger, eventBus, taskManager, mailbox, guard, registry, tracer };
}

function rpc(port, body) {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(async res => ({ status: res.status, json: await res.json().catch(() => null) }));
}

test('unbound caller must not read a third-party request ledger', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-ledger-authz-'));
  const logger = new AuditLogger(path.join(tmpDir, 'test.sqlite'));
  const tracer = new RequestTracer(logger, { db: logger.db });

  t.after(() => {
    try { logger.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  tracer.mark({
    requestId: 'req_victim',
    stage: LifecycleStage.REQUEST_CREATED,
    agentId: 'claude-desktop',
    meta: { fromAgent: 'claude-desktop', toAgent: 'chatgpt-desktop' }
  });

  const registry = new ToolRegistry();

  // No `identity` and no `agentId` in the context: the unauthenticated/unbound shape.
  const unboundCtx = { isPrivileged: false, tracer, logger };

  await assert.rejects(
    async () => await registry.executeTool(
      'bridge_request_ledger',
      { requestId: 'req_victim', agentId: 'claude-desktop' },
      unboundCtx
    ),
    /Unauthorized/i,
    'an unauthenticated caller that merely NAMES a participant must not receive the ledger'
  );

  // Control: a genuinely bound participant identity must still be able to read it.
  const boundCtx = { isPrivileged: false, agentId: 'claude-desktop', tracer, logger };
  const allowed = await registry.executeTool('bridge_request_ledger', { requestId: 'req_victim' }, boundCtx);
  assert.strictEqual(allowed.found, true, 'a real participant must still be able to read its own ledger');
});

test('unauthenticated loopback HTTP caller must not read a third-party request ledger', async (t) => {
  const env = setupEnv();
  const server = new BridgeHttpServer({
    port: 0,
    host: '127.0.0.1',
    apiKey: null,          // no control-plane key configured -> loopback without credentials is allowed
    auditLogger: env.logger,
    permissionGuard: env.guard,
    mailboxHub: env.mailbox,
    toolRegistry: env.registry
  });

  const bound = await server.start();
  t.after(async () => {
    try { await server.stop(); } catch {}
    try { env.eventBus.close(); } catch {}
    try { env.logger.close(); } catch {}
    try { fs.rmSync(env.tmpDir, { recursive: true, force: true }); } catch {}
  });

  env.tracer.mark({
    requestId: 'req_victim_http',
    stage: LifecycleStage.REQUEST_CREATED,
    agentId: 'claude-desktop',
    meta: { fromAgent: 'claude-desktop', toAgent: 'chatgpt-desktop' }
  });

  // No credentials and no x-agent-id header: a plain local unauthenticated client.
  const res = await rpc(bound.port, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'bridge_request_ledger',
      arguments: { requestId: 'req_victim_http', agentId: 'claude-desktop' }
    }
  });

  const text = res.json?.result?.content?.[0]?.text || '';
  // The call must fail closed (an authorization error), not return ledger data.
  const isErrorResult = res.json?.result?.isError === true || /^Error executing/.test(text);
  assert.ok(isErrorResult, `expected an authorization error, got: ${text.slice(0, 300)}`);
  assert.ok(
    !text.includes('stageTimestamps') && !text.includes('"fromAgent"'),
    `ledger body must not be disclosed to an unauthenticated caller, got: ${text.slice(0, 400)}`
  );
});
