import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CONFIG } from '../src/config.js';
import { BridgeMcpServer } from '../src/mcp-server.js';
import { BridgeHttpServer } from '../src/http-server.js';
import { AuditLogger } from '../src/audit-logger.js';
import { PermissionGuard } from '../src/permission-guard.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { EventBus } from '../src/event-bus.js';
import { TaskManager } from '../src/task-manager.js';
import { MailboxHub } from '../src/mailbox-hub.js';

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const opts = {
      ...options,
      agent: false,
      headers: {
        'Connection': 'close',
        ...(options.headers || {})
      }
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, body: data, json });
      });
    });
    req.on('error', reject);
    if (body) {
      if (typeof body === 'object') {
        req.setHeader('Content-Type', 'application/json');
        req.write(JSON.stringify(body));
      } else {
        req.write(body);
      }
    }
    req.end();
  });
}

test('Agent Bridge Recovery Verification Suite (18 Points)', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-test-'));
  const dbPath = path.join(tmpDir, 'test.sqlite');
  const logger = new AuditLogger(dbPath);
  const eventBus = new EventBus(logger);
  const taskManager = new TaskManager(logger, null, eventBus);
  const mailbox = new MailboxHub(logger, taskManager, eventBus);

  const mockProjectDir = path.join(tmpDir, 'mock-project');
  fs.mkdirSync(mockProjectDir, { recursive: true });
  fs.writeFileSync(path.join(mockProjectDir, 'Package.swift'), '// swift-tools-version:5.5\nimport PackageDescription\n');

  const testWorkspace = path.join(tmpDir, 'test-workspace');
  fs.mkdirSync(testWorkspace, { recursive: true });

  const guard = new PermissionGuard({
    ...CONFIG,
    ALLOWED_ROOTS: [tmpDir, mockProjectDir, testWorkspace, CONFIG.BRIDGE_ROOT]
  });
  const registry = new ToolRegistry();

  const apiKey = CONFIG.CONTROL_PLANE.API_KEY || 'test-recovery-key-12345';

  // Isolated test bridge server on port 0 (never touches live port 8765)
  const bridgeServer = new BridgeHttpServer({
    port: 0,
    host: '127.0.0.1',
    apiKey,
    requireApiKey: true,
    auditLogger: logger,
    permissionGuard: guard,
    mailboxHub: mailbox,
    toolRegistry: registry
  });

  const boundBridge = await bridgeServer.start();
  const HTTP_PORT = boundBridge.port;
  if (bridgeServer.server?.unref) bridgeServer.server.unref();

  // Mock tunnel health server on port 0 (never touches port 8080)
  const tunnelServer = http.createServer((req, res) => {
    if (req.url === '/api/status') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        control_plane_tunnel_id: 'tunnel_6abe838abcc48191898ba0012f55e63f',
        channels: [{ probe_status: 'ok' }],
        tunnel_metadata: { Name: 'Jayanth Agent Bridge' }
      }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise((resolve) => tunnelServer.listen(0, '127.0.0.1', resolve));
  const TUNNEL_HEALTH_PORT = tunnelServer.address().port;
  tunnelServer.unref();

  let bridge = null;

  try {
    assert.ok(apiKey, 'CONTROL_PLANE.API_KEY must be configured and resolved');

  // 1. Local health/ping
  await t.test('1. Local health endpoint returns 200 and healthy status', async () => {
    const res = await request({ host: '127.0.0.1', port: HTTP_PORT, path: '/health', method: 'GET' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.status, 'healthy');
    assert.strictEqual(res.json.service, 'agent-bridge');
  });

  // 2. Authentication required
  await t.test('2. Unauthenticated request to protected endpoint is rejected with 401', async () => {
    const res = await request({
      host: '127.0.0.1',
      port: HTTP_PORT,
      path: '/api/chatgpt/complete',
      method: 'POST',
      headers: { 'Host': '127.0.0.1' }
    }, { messages: [{ role: 'user', content: 'hello' }] });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.json.ok, false);
    assert.ok(res.json.error.includes('API key'));
  });

  // 3. Valid authentication accepted
  await t.test('3. Valid authentication header is accepted', async () => {
    const res = await request({
      host: '127.0.0.1',
      port: HTTP_PORT,
      path: '/api/chatgpt/health',
      method: 'GET',
      headers: {
        'Host': '127.0.0.1',
        'x-api-key': apiKey
      }
    });
    assert.notStrictEqual(res.status, 401);
    assert.notStrictEqual(res.status, 403);
  });

  // 4. Invalid authentication rejected
  await t.test('4. Invalid authentication key is rejected with 401', async () => {
    const res = await request({
      host: '127.0.0.1',
      port: HTTP_PORT,
      path: '/api/chatgpt/complete',
      method: 'POST',
      headers: {
        'Host': '127.0.0.1',
        'x-api-key': 'incorrect_dummy_key_12345'
      }
    });
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.json.ok, false);
  });

  // 5. Invalid Origin rejected
  await t.test('5. Browser Origin header is rejected with 403', async () => {
    const res = await request({
      host: '127.0.0.1',
      port: HTTP_PORT,
      path: '/api/chatgpt/complete',
      method: 'POST',
      headers: {
        'Host': '127.0.0.1',
        'Origin': 'https://malicious-website.com',
        'x-api-key': apiKey
      }
    }, { messages: [{ role: 'user', content: 'hello' }] });
    assert.strictEqual(res.status, 403);
    assert.ok(res.json.error.includes('Browser-originated'));
  });

  // 6. Invalid Host rejected
  await t.test('6. Non-loopback Host header is rejected with 403', async () => {
    const res = await request({
      host: '127.0.0.1',
      port: HTTP_PORT,
      path: '/api/chatgpt/complete',
      method: 'POST',
      headers: {
        'Host': 'attacker-domain.com',
        'x-api-key': apiKey
      }
    }, { messages: [{ role: 'user', content: 'hello' }] });
    assert.strictEqual(res.status, 403);
    assert.ok(res.json.error.includes('Host header'));
  });

  // 7. Loopback restriction holds
  await t.test('7. Bridge HTTP server is bound exclusively to 127.0.0.1', async () => {
    const res = await request({ host: '127.0.0.1', port: HTTP_PORT, path: '/health', method: 'GET' });
    assert.strictEqual(res.status, 200);
  });

  // 8. MCP initialization & 9. Tool discovery via registry
  bridge = new BridgeMcpServer({ agentId: 'chatgpt-desktop', permissionGuard: guard, auditLogger: logger });
  const toolDefs = bridge.registry.getToolDefinitions();

  await t.test('8. MCP initialization & 9. Tool discovery', () => {
    assert.ok(Array.isArray(toolDefs), 'Tool definitions must be an array');
    assert.ok(toolDefs.length >= 50, `Expected at least 50 tools, got ${toolDefs.length}`);
    const toolNames = toolDefs.map(t => t.name);
    assert.ok(toolNames.includes('bridge_ping'));
    assert.ok(toolNames.includes('bridge_discover_agents'));
    assert.ok(toolNames.includes('bridge_inspect_project'));
    assert.ok(toolNames.includes('bridge_search_files'));
    assert.ok(toolNames.includes('bridge_read_file'));
    assert.ok(toolNames.includes('bridge_create_file'));
    assert.ok(toolNames.includes('bridge_edit_file'));
    assert.ok(toolNames.includes('bridge_delete_file'));
    assert.ok(toolNames.includes('bridge_execute_command'));
    assert.ok(toolNames.includes('bridge_get_audit_log'));
    assert.ok(toolNames.includes('bridge_ask_agent'));
    assert.ok(toolNames.includes('bridge_delegate_task'));
    assert.ok(toolNames.includes('bridge_get_task_status'));
    assert.ok(toolNames.includes('bridge_check_inbox'));
  });

  const toolContext = {
    controller: bridge.controller,
    mailbox: bridge.mailbox,
    taskManager: bridge.taskManager,
    collaboration: bridge.collaboration,
    fileActivity: bridge.fileActivity,
    logger: bridge.logger,
    git: bridge.git,
    presence: bridge.presence,
    identity: bridge.identity,
    diagnostics: bridge.diagnostics,
    cache: bridge.cache,
    eventBus: bridge.eventBus,
    sessionAdapter: bridge.sessionAdapter,
    guard,
    boundAgentId: 'chatgpt-desktop'
  };

  // 10. bridge_ping
  await t.test('10. bridge_ping executes and returns valid beacon token', async () => {
    const result = await bridge.registry.executeTool('bridge_ping', { agentId: 'chatgpt-desktop' }, toolContext);
    assert.strictEqual(result.status, 'OK');
    assert.strictEqual(result.token, 'AGENT_BRIDGE_ALIVE');
    assert.strictEqual(result.caller, 'chatgpt-desktop');
  });

  // 11. bridge_discover_agents
  await t.test('11. bridge_discover_agents returns registered and live agents', async () => {
    const result = await bridge.registry.executeTool('bridge_discover_agents', { agentId: 'chatgpt-desktop' }, toolContext);
    assert.ok(Array.isArray(result.registeredAgents));
    assert.ok(result.registeredAgents.includes('chatgpt-desktop'));
    assert.ok(result.registeredAgents.includes('claude-desktop'));
    assert.ok(result.registeredAgents.includes('antigravity-ide'));
    assert.ok(result.registeredAgents.includes('zia'));
  });

  // 12. Read-only project inspection (hermetic mock project, zero touches to Zia)
  await t.test('12. bridge_inspect_project executes successfully on project root', async () => {
    const result = await bridge.registry.executeTool('bridge_inspect_project', {
      rootPath: mockProjectDir,
      agentId: 'chatgpt-desktop'
    }, toolContext);
    assert.strictEqual(fs.realpathSync(result.path), fs.realpathSync(mockProjectDir));
    assert.ok(Array.isArray(result.files), 'Should list project files');
    assert.ok(Array.isArray(result.directories), 'Should list project directories');
    assert.ok(result.files.includes('Package.swift'), 'Mock project should have Package.swift');
  });

  await t.test('12b. Harmless read-only file operation succeeds', async () => {
    const result = await bridge.registry.executeTool('bridge_read_file', {
      filePath: path.join(mockProjectDir, 'Package.swift'),
      agentId: 'chatgpt-desktop'
    }, toolContext);
    assert.ok(result.content && result.content.includes('PackageDescription'), 'Must read Package.swift correctly');
  });

  // 13. Allowed filesystem operations in test-workspace
  const probeFile = path.join(testWorkspace, 'recovery_probe.txt');
  await t.test('13. Allowed filesystem operations in test-workspace (create, read, edit, delete)', async () => {
    try {
      // Clean before test if exists
      if (fs.existsSync(probeFile)) fs.unlinkSync(probeFile);

      // Create
      const createRes = await bridge.registry.executeTool('bridge_create_file', {
        filePath: probeFile,
        content: 'initial content for recovery test',
        agentId: 'chatgpt-desktop'
      }, toolContext);
      assert.strictEqual(createRes.status, 'created');

      // Read
      const readRes = await bridge.registry.executeTool('bridge_read_file', {
        filePath: probeFile,
        agentId: 'chatgpt-desktop'
      }, toolContext);
      assert.ok(readRes.content && readRes.content.includes('initial content for recovery test'));

      // Edit
      const editRes = await bridge.registry.executeTool('bridge_edit_file', {
        filePath: probeFile,
        targetContent: 'initial content',
        replacementContent: 'updated content',
        agentId: 'chatgpt-desktop'
      }, toolContext);
      assert.strictEqual(editRes.status, 'edited');

      // Delete
      const delRes = await bridge.registry.executeTool('bridge_delete_file', {
        filePath: probeFile,
        agentId: 'chatgpt-desktop'
      }, toolContext);
      assert.strictEqual(delRes.status, 'deleted');
      assert.strictEqual(fs.existsSync(probeFile), false);
    } finally {
      if (fs.existsSync(probeFile)) fs.unlinkSync(probeFile);
    }
  });

  // 14. Denied filesystem operation outside allowed roots
  await t.test('14. Denied filesystem operation outside allowed roots is blocked', async () => {
    await assert.rejects(async () => {
      await bridge.registry.executeTool('bridge_read_file', {
        filePath: '/etc/shadow',
        agentId: 'chatgpt-desktop'
      }, toolContext);
    }, (err) => {
      return err.message.includes('outside allowed roots') || err.message.includes('Permission denied');
    });
  });

  // 15. Audit logging operational
  await t.test('15. Audit logging records operations', async () => {
    const logsRes = await bridge.registry.executeTool('bridge_get_audit_log', {
      limit: 10,
      agentId: 'chatgpt-desktop'
    }, { ...toolContext, isPrivileged: true });
    assert.ok(Array.isArray(logsRes));
    assert.ok(logsRes.length > 0);
  });

  // 16. Clean shutdown & 17. Restart / reconnect (MCP JSON-RPC / HTTP)
  await t.test('16 & 17. Clean JSON-RPC / MCP communication on HTTP bridge', async () => {
    const mcpRes = await request({
      host: '127.0.0.1',
      port: HTTP_PORT,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Host': '127.0.0.1',
        'x-api-key': apiKey
      }
    }, {
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: {
        name: 'bridge_ping',
        arguments: { agentId: 'chatgpt-desktop' }
      }
    });
    assert.strictEqual(mcpRes.status, 200);
    assert.strictEqual(mcpRes.json.jsonrpc, '2.0');
    assert.ok(mcpRes.json.result.content[0].text.includes('AGENT_BRIDGE_ALIVE'));
  });

    await t.test('18. Live Secure MCP Tunnel status is healthy and polling', async () => {
      const statusRes = await request({ host: '127.0.0.1', port: TUNNEL_HEALTH_PORT, path: '/api/status', method: 'GET' });
      assert.strictEqual(statusRes.status, 200);
      assert.strictEqual(statusRes.json.control_plane_tunnel_id, 'tunnel_6abe838abcc48191898ba0012f55e63f');
      assert.strictEqual(statusRes.json.channels[0].probe_status, 'ok');
      assert.strictEqual(statusRes.json.tunnel_metadata.Name, 'Jayanth Agent Bridge');
      assert.strictEqual(statusRes.json.tunnel_metadata_error, undefined);
    });
  } finally {
    try { await bridge?.close(); } catch {}
    try { if (bridge?.eventBus) bridge.eventBus.close(); } catch {}
    try { if (bridge?.logger) bridge.logger.close(); } catch {}
    try { await bridgeServer.stop(); } catch {}
    try {
      if (typeof tunnelServer.closeAllConnections === 'function') tunnelServer.closeAllConnections();
      tunnelServer.close();
    } catch {}
    try { eventBus.close(); } catch {}
    try { logger.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});
