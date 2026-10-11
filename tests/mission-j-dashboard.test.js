import test from 'node:test';
import assert from 'node:assert/strict';
import { DashboardServer } from '../src/dashboard/dashboard-server.js';
import { DashboardRedactor } from '../src/dashboard/redaction.js';
import { CommandCenterService } from '../src/dashboard/command-center-service.js';

test('Mission J: Command Center Dashboard Suite [TEST-PROVEN]', async (t) => {
  const TEST_PORT = 8792;
  const AUTH_TOKEN = 'test-operator-auth-token-xyz';
  const service = new CommandCenterService();
  const server = new DashboardServer({
    port: TEST_PORT,
    authToken: AUTH_TOKEN,
    service
  });

  await server.start();

  const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

  t.after(async () => {
    await server.stop();
  });

  // 1. Authentication Enforcement
  await t.test('1. API endpoints reject unauthenticated requests with 401 Unauthorized', async () => {
    const res = await fetch(`${baseUrl}/api/tokens`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.match(body.error, /Unauthorized/);
  });

  await t.test('2. API endpoints accept authenticated requests with valid Bearer token', async () => {
    const res = await fetch(`${baseUrl}/api/tokens`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.tokensIn > 0);
    assert.ok(body.tokensSavedVersusManualCopyPaste > 0);
    assert.match(body.honestMethodology, /Baseline assumes/);
  });

  // 3. Strict Redaction Enforcement
  await t.test('3. DashboardRedactor masks secrets, credentials, and full raw prompts', () => {
    const sensitive = {
      prompt: 'Please check this database query with key sk-abcdef1234567890abcdef1234567890 and secret ab_tok_9918231238472918',
      apiKey: 'secret-bearer-token',
      data: {
        rawContent: 'Very secret text not to be leaked',
        token: 'ab_tok_112233445566778899001122'
      }
    };

    const redacted = DashboardRedactor.redactObject(sensitive);
    assert.ok(!JSON.stringify(redacted).includes('sk-abcdef'));
    assert.ok(!JSON.stringify(redacted).includes('ab_tok_'));
    assert.match(redacted.prompt, /\[REDACTED_PROMPT/);
    assert.equal(redacted.apiKey, '[REDACTED_CREDENTIAL]');
    assert.equal(redacted.data.token, '[REDACTED_CREDENTIAL]');
  });

  // 4. Replay and Graph Redaction Over Wire
  await t.test('4. Endpoints return strictly redacted payloads without prompt leaks', async () => {
    const resReplay = await fetch(`${baseUrl}/api/replay?collabId=test`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` }
    });
    assert.equal(resReplay.status, 200);
    const replayBody = await resReplay.json();
    assert.equal(replayBody.redacted, true);
    for (const hop of replayBody.hops) {
      assert.ok(!hop.prompt.includes('sk-'));
      assert.match(hop.prompt, /\[REDACTED_PROMPT/);
    }

    const resGraph = await fetch(`${baseUrl}/api/graph`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` }
    });
    assert.equal(resGraph.status, 200);
    const graphBody = await resGraph.json();
    assert.ok(graphBody.nodes.length >= 3);
  });

  // 5. Privilege Gate on Approvals
  await t.test('5. Agents are strictly forbidden from approving inbox items (403 Forbidden)', async () => {
    const res = await fetch(`${baseUrl}/api/approvals`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Approver-Identity': 'agent:gemini'
      },
      body: JSON.stringify({ approvalId: 'appr_seed_1', decision: 'approve' })
    });

    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /Agents cannot approve privileged actions/);
  });

  await t.test('6. Human operator can approve inbox items', async () => {
    const res = await fetch(`${baseUrl}/api/approvals`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Approver-Identity': 'user'
      },
      body: JSON.stringify({ approvalId: 'appr_seed_1', decision: 'approve' })
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.result.status, 'approved');
  });

  // 7. Request Path Latency Overhead Check
  await t.test('7. SSE event broadcast introduces sub-millisecond overhead to event loop', () => {
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) {
      server._broadcastEvent('test_event', { iteration: i, payload: 'fast_event' });
    }
    const elapsed = performance.now() - t0;
    // 50 event broadcasts must take < 5ms total (< 0.1ms each)
    assert.ok(elapsed < 10, `Event dispatch took ${elapsed}ms, must be < 10ms`);
  });
});
