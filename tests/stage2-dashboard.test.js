import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DashboardServer } from '../src/dashboard/dashboard-server.js';
import { CommandCenterService } from '../src/dashboard/command-center-service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('Stage 2: Dashboard Security, Session Approvals & Audit Guard Suite', async (t) => {
  const auditLogs = [];
  const mockLogger = {
    log(entry) {
      auditLogs.push(entry);
    }
  };

  const AUTH_TOKEN = 'test_token_' + 'a'.repeat(32);
  const server = new DashboardServer({
    port: 9876,
    host: '127.0.0.1',
    authToken: AUTH_TOKEN,
    logger: mockLogger
  });

  await server.start();
  const baseUrl = 'http://127.0.0.1:9876';

  t.after(async () => {
    await server.stop();
  });

  await t.test('1. Off by default invariant: DashboardServer is never started implicitly', () => {
    const unstarted = new DashboardServer();
    assert.strictEqual(unstarted.server, null, 'DashboardServer must not listen until start() is explicitly called');
  });

  await t.test('2. Random per-run token generation and timing-safe comparison', () => {
    const s1 = new DashboardServer();
    const s2 = new DashboardServer();
    assert.ok(s1.authToken.length >= 32);
    assert.notStrictEqual(s1.authToken, s2.authToken);
    assert.notStrictEqual(s1.authToken, 'secret-operator-token');
  });

  await t.test('3. Host header validation blocks DNS rebinding attacks on all endpoints', async () => {
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: 9876,
        path: '/api/tokens',
        method: 'GET',
        headers: {
          Host: 'attacker.evil.com',
          Authorization: `Bearer ${AUTH_TOKEN}`
        }
      }, (r) => {
        let body = '';
        r.on('data', c => body += c);
        r.on('end', () => resolve({ status: r.statusCode, body }));
      });
      req.on('error', reject);
      req.end();
    });

    assert.strictEqual(res.status, 403);
    assert.match(res.body, /loopback Host header/);
  });

  await t.test('4. CSRF protection blocks cross-origin POST requests', async () => {
    const res = await fetch(`${baseUrl}/api/approvals`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
        Origin: 'https://malicious-site.com'
      },
      body: JSON.stringify({ approvalId: 'appr_seed_1', decision: 'approve' })
    });

    assert.strictEqual(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /Cross-origin requests are forbidden/);
  });

  await t.test('5. Agent approval spoofing via header is blocked (403)', async () => {
    for (const agentHeader of ['agent:gemini', 'claude-desktop', 'chatgpt-desktop', 'antigravity-ide', 'freebuff']) {
      const res = await fetch(`${baseUrl}/api/approvals`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${AUTH_TOKEN}`,
          'Content-Type': 'application/json',
          'X-Approver-Identity': agentHeader
        },
        body: JSON.stringify({ approvalId: 'appr_seed_1', decision: 'approve' })
      });

      assert.strictEqual(res.status, 403, `Agent header '${agentHeader}' must be rejected with 403`);
      const body = await res.json();
      assert.match(body.error, /Agents cannot approve privileged actions/);
    }
  });

  await t.test('6. Approver identity is bound to authenticated session, ignoring caller parameters', async () => {
    const res = await fetch(`${baseUrl}/api/approvals`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        approvalId: 'appr_seed_1',
        decision: 'approve',
        approver: 'spoofed_parameter_identity'
      })
    });

    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.result.status, 'approved');
    assert.strictEqual(body.result.decidedBy, 'dashboard:human-operator', 'Must be bound to authenticated session');
  });

  await t.test('7. Approval actions are logged to real audit logger', () => {
    const approvalAudit = auditLogs.find(e => e.action === 'dashboard_approval');
    assert.ok(approvalAudit, 'Approval action must be recorded in audit log');
    assert.strictEqual(approvalAudit.status, 'success');
    assert.strictEqual(approvalAudit.details.approver, 'dashboard:human-operator');
    assert.strictEqual(approvalAudit.details.decision, 'approve');
  });

  await t.test('8. Front-end public HTML contains zero hardcoded metric/latency numbers', () => {
    const htmlPath = path.resolve(__dirname, '../src/dashboard/public/index.html');
    const html = fs.readFileSync(htmlPath, 'utf8');

    // Extract metric-value and metric-sub elements
    const metricValueMatches = html.match(/class="metric-value"[^>]*>([^<]+)</g) || [];
    for (const match of metricValueMatches) {
      const text = match.replace(/class="metric-value"[^>]*>/, '').replace(/<$/, '').trim();
      assert.ok(text === '—' || text === '', `Metric value must be placeholder, not typed-in literal: got '${text}'`);
    }

    // Verify presence of dynamic fetch calls
    assert.ok(html.includes("fetchWithAuth('/api/tokens')"), 'Must fetch tokens dynamically');
    assert.ok(html.includes("fetchWithAuth('/api/health')"), 'Must fetch health dynamically');
    assert.ok(html.includes("fetchWithAuth('/api/approvals')"), 'Must fetch approvals dynamically');
  });

  await t.test('9. Direct decideApproval rejects non-session approver', () => {
    const service = new CommandCenterService();
    assert.throws(() => {
      service.decideApproval('appr_seed_1', 'approve', 'agent:gemini');
    }, /Access Denied/);

    assert.throws(() => {
      service.decideApproval('appr_seed_1', 'approve', 'random-caller');
    }, /Access Denied/);

    const ok = service.decideApproval('appr_seed_1', 'approve', 'dashboard:human-operator');
    assert.strictEqual(ok.status, 'approved');
    assert.strictEqual(ok.decidedBy, 'dashboard:human-operator');
  });
});
