import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { BridgeHttpServer } from '../src/http-server.js';
import { AuditLogger } from '../src/audit-logger.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { PermissionGuard } from '../src/permission-guard.js';
import { CONFIG } from '../src/config.js';

function request(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const reqOptions = {
      hostname: u.hostname,
      port: u.port,
      path: `${u.pathname}${u.search}`,
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk.toString(); });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

test('Stage 1.4: /mcp, /sse, and /health auth verification on real ephemeral server', async (t) => {
  const TEST_KEY = 'm4c_stage1_4_secret_key_987654321';
  const logger = new AuditLogger(':memory:');
  const guard = new PermissionGuard();
  const registry = new ToolRegistry();

  await t.test('1. Default value of requireApiKey', () => {
    // When no apiKey or requireApiKey is provided to an ephemeral server
    const serverDefault = new BridgeHttpServer({ port: 0, logger });
    assert.strictEqual(serverDefault.requireApiKey, false, 'Default requireApiKey on ephemeral server must be false');
    assert.strictEqual(serverDefault.apiKey, null, 'Default apiKey on ephemeral server must be null');

    // When apiKey is provided, requireApiKey defaults to true
    const serverWithKey = new BridgeHttpServer({ port: 0, apiKey: TEST_KEY, logger });
    assert.strictEqual(serverWithKey.requireApiKey, true, 'requireApiKey defaults to true when apiKey is supplied');

    // Default config object CONTROL_PLANE
    assert.strictEqual(
      typeof CONFIG.CONTROL_PLANE.REQUIRE_API_KEY,
      'boolean',
      'CONFIG.CONTROL_PLANE.REQUIRE_API_KEY is a boolean'
    );
  });

  await t.test('2. Ephemeral server auth matrix: GET/HEAD /sse and POST /mcp with no key, wrong key, valid key', async () => {
    const server = new BridgeHttpServer({
      port: 0,
      apiKey: TEST_KEY,
      requireApiKey: true,
      logger,
      permissionGuard: guard,
      toolRegistry: registry
    });

    await server.start();
    const port = server.port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // --- NO KEY ---
      // GET /sse with no key
      const getNoKey = await request(`${baseUrl}/sse`);
      assert.strictEqual(getNoKey.statusCode, 401, 'GET /sse with no key must return 401');
      assert.ok(
        !getNoKey.headers['content-type']?.includes('text/event-stream'),
        'GET /sse with no key must not return text/event-stream'
      );
      assert.ok(
        !getNoKey.body.includes('event: endpoint'),
        'GET /sse with no key must not return endpoint event'
      );
      assert.strictEqual(server.sseClients.size, 0, 'No SSE session must be created on unauthenticated GET');

      // HEAD /sse with no key
      const headNoKey = await request(`${baseUrl}/sse`, { method: 'HEAD' });
      assert.strictEqual(headNoKey.statusCode, 401, 'HEAD /sse with no key must return 401');
      assert.strictEqual(server.sseClients.size, 0, 'No SSE session must be created on unauthenticated HEAD');

      // POST /mcp with no key
      const postNoKey = await request(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' }
      }, { jsonrpc: '2.0', id: 1, method: 'ping' });
      assert.strictEqual(postNoKey.statusCode, 401, 'POST /mcp with no key must return 401');

      // --- WRONG KEY ---
      const wrongHeaders = { 'x-api-key': 'completely_wrong_key' };

      // GET /sse with wrong key
      const getWrongKey = await request(`${baseUrl}/sse`, { headers: wrongHeaders });
      assert.strictEqual(getWrongKey.statusCode, 401, 'GET /sse with wrong key must return 401');
      assert.strictEqual(server.sseClients.size, 0, 'No SSE session must be created on wrong key');

      // HEAD /sse with wrong key
      const headWrongKey = await request(`${baseUrl}/sse`, { method: 'HEAD', headers: wrongHeaders });
      assert.strictEqual(headWrongKey.statusCode, 401, 'HEAD /sse with wrong key must return 401');
      assert.strictEqual(server.sseClients.size, 0, 'No SSE session must be created on wrong key HEAD');

      // POST /mcp with wrong key
      const postWrongKey = await request(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...wrongHeaders }
      }, { jsonrpc: '2.0', id: 2, method: 'ping' });
      assert.strictEqual(postWrongKey.statusCode, 401, 'POST /mcp with wrong key must return 401');

      // --- VALID KEY ---
      const validHeaders = { 'x-api-key': TEST_KEY };

      // HEAD /sse with valid key
      const headValidKey = await request(`${baseUrl}/sse`, { method: 'HEAD', headers: validHeaders });
      assert.strictEqual(headValidKey.statusCode, 200, 'HEAD /sse with valid key must return 200');
      assert.strictEqual(headValidKey.headers['content-type'], 'text/event-stream');

      // POST /mcp with valid key (tools/list)
      const postValidKey = await request(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...validHeaders }
      }, { jsonrpc: '2.0', id: 3, method: 'tools/list' });
      assert.strictEqual(postValidKey.statusCode, 200, 'POST /mcp with valid key must return 200');
      const rpcResult = JSON.parse(postValidKey.body);
      assert.strictEqual(rpcResult.id, 3);
      assert.ok(Array.isArray(rpcResult.result?.tools), 'POST /mcp returns tool list');

      // GET /sse with valid key returns 200 text/event-stream and endpoint event
      const getValidRes = await new Promise((resolve, reject) => {
        const u = new URL(`${baseUrl}/sse`);
        const req = http.request({
          hostname: u.hostname,
          port: u.port,
          path: u.pathname,
          method: 'GET',
          headers: validHeaders
        }, (res) => {
          let chunks = '';
          res.on('data', chunk => {
            chunks += chunk.toString();
            if (chunks.includes('event: endpoint')) {
              req.destroy();
              resolve({
                statusCode: res.statusCode,
                contentType: res.headers['content-type'],
                bodySnippet: chunks
              });
            }
          });
        });
        req.on('error', (err) => {
          if (err.code === 'ECONNRESET') return; // from req.destroy()
          reject(err);
        });
        req.end();
      });

      assert.strictEqual(getValidRes.statusCode, 200, 'GET /sse with valid key returns 200');
      assert.strictEqual(getValidRes.contentType, 'text/event-stream');
      assert.ok(getValidRes.bodySnippet.includes('event: endpoint'), 'GET /sse emits endpoint event');
    } finally {
      await server.stop();
    }
  });

  await t.test('3. /health is liveness-only unauthenticated and detailed when authenticated', async () => {
    const server = new BridgeHttpServer({
      port: 0,
      apiKey: TEST_KEY,
      requireApiKey: true,
      logger,
      permissionGuard: guard,
      toolRegistry: registry
    });

    await server.start();
    const port = server.port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 3a. Unauthenticated /health (no key)
      const unauthHealth = await request(`${baseUrl}/health`);
      assert.strictEqual(unauthHealth.statusCode, 200, '/health returns 200 without key');
      const unauthBody = JSON.parse(unauthHealth.body);
      console.log('Unauthenticated /health response body:\n', JSON.stringify(unauthBody, null, 2));

      assert.strictEqual(unauthBody.status, 'healthy');
      assert.strictEqual(unauthBody.service, 'agent-bridge');
      assert.strictEqual(unauthBody.authEnabled, true);

      // Must be liveness-only: strictly NO allowedRoots, liveAgents, activeAgents, startupStamp
      assert.strictEqual(unauthBody.allowedRoots, undefined, 'Unauthenticated /health must not expose allowedRoots');
      assert.strictEqual(unauthBody.liveAgents, undefined, 'Unauthenticated /health must not expose liveAgents');
      assert.strictEqual(unauthBody.activeAgents, undefined, 'Unauthenticated /health must not expose activeAgents');
      assert.strictEqual(unauthBody.startupStamp, undefined, 'Unauthenticated /health must not expose startupStamp');
      assert.strictEqual(unauthBody.ziaWriteLocked, undefined, 'Unauthenticated /health must not expose ziaWriteLocked');

      // 3b. Authenticated /health (with valid key)
      const authHealth = await request(`${baseUrl}/health`, {
        headers: { 'x-api-key': TEST_KEY }
      });
      assert.strictEqual(authHealth.statusCode, 200, 'Authenticated /health returns 200');
      const authBody = JSON.parse(authHealth.body);

      assert.strictEqual(authBody.status, 'healthy');
      assert.strictEqual(authBody.service, 'agent-bridge');
      assert.ok(Array.isArray(authBody.allowedRoots), 'Authenticated /health exposes allowedRoots');
      assert.ok(Array.isArray(authBody.activeAgents), 'Authenticated /health exposes activeAgents');
      assert.ok(authBody.startupStamp !== undefined, 'Authenticated /health exposes startupStamp');
    } finally {
      await server.stop();
      try { logger.close(); } catch {}
    }
  });
});
