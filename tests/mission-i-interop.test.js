import test from 'node:test';
import assert from 'node:assert/strict';
import { A2AAdapter } from '../src/interop/a2a-adapter.js';
import { ConformanceSuite } from '../src/interop/conformance-suite.js';
import { AgentAddFlow } from '../src/cli/agent-add-flow.js';
import { HotManifestReloader } from '../src/interop/hot-manifest-reloader.js';
import { SKILLS_TOOL_DEFINITIONS, COMMUNICATION_TOOL_DEFINITIONS } from '../src/tool-registry.js';
import { HonestTokenizer } from '../src/tokenizer/honest-tokenizer.js';

test('Mission I: Interoperability, A2A Protocol, and Conformance Matrix Suite [TEST-PROVEN]', async (t) => {

  // 1. A2A Adapter - Agent Card Generation
  await t.test('1. A2AAdapter generates standard Agent Card matching Linux Foundation spec', () => {
    const adapter = new A2AAdapter({ baseUrl: 'http://127.0.0.1:8765' });
    const manifest = {
      id: 'gemini',
      displayName: 'Google Gemini',
      version: '2.5.0',
      description: 'Advanced multimodal and reasoning agent',
      routeType: 'mcp',
      capabilities: { readFiles: true, editFiles: true, git: true }
    };

    const card = adapter.generateAgentCard(manifest);
    assert.equal(card.protocol, 'a2a/1.0');
    assert.equal(card.id, 'gemini');
    assert.equal(card.endpoints.card, 'http://127.0.0.1:8765/.well-known/agent.json');
    assert.ok(card.capabilities.includes('files.read'));
    assert.ok(card.capabilities.includes('git.vcs'));
    assert.equal(card.metadata.bridgeCorrelationVersion, '2.0');
  });

  // 2. A2A Adapter - JSON-RPC Task Operations
  await t.test('2. A2AAdapter handles JSON-RPC 2.0 task operations with V2 correlation and nonces', async () => {
    const adapter = new A2AAdapter();

    // Valid task.create
    const reqCreate = {
      jsonrpc: '2.0',
      id: 'req_1',
      method: 'task.create',
      params: { targetAgent: 'claude-desktop', prompt: 'Review locking implementation' }
    };

    const resCreate = await adapter.handleA2ARequest(reqCreate, { agentId: 'gemini' });
    assert.equal(resCreate.jsonrpc, '2.0');
    assert.equal(resCreate.id, 'req_1');
    assert.equal(resCreate.result.status, 'SUBMITTED');
    assert.ok(resCreate.result.taskId);
    assert.ok(resCreate.result.correlationId.startsWith('a2a_corr_'));
    assert.ok(resCreate.result.nonce.startsWith('nonce_'));

    // Malformed JSON-RPC
    const badReq = { method: 'foo' };
    const badRes = await adapter.handleA2ARequest(badReq);
    assert.equal(badRes.error.code, -32600);
  });

  // 3. Conformance Suite & Fake Agent Onboarding from Manifest Only
  await t.test('3. ConformanceSuite executes 8-point matrix on fake agent from manifest only', async () => {
    const suite = new ConformanceSuite();
    const fakeManifest = {
      id: 'fake-test-agent',
      routeType: 'mock',
      isMock: true
    };

    const scorecard = await suite.runSuite(fakeManifest);
    assert.equal(scorecard.agentId, 'fake-test-agent');
    assert.equal(scorecard.passed, true);
    assert.equal(scorecard.evidenceLevel, 'MOCK-ONLY');

    // Matrix checks
    assert.equal(scorecard.matrix.nonceEcho.status, 'PASS');
    assert.equal(scorecard.matrix.identityBinding.status, 'PASS');
    assert.equal(scorecard.matrix.timeout.status, 'PASS');
    assert.equal(scorecard.matrix.cancel.status, 'PASS');
    assert.equal(scorecard.matrix.duplicateCompletion.status, 'PASS');
    assert.equal(scorecard.matrix.lateResponse.status, 'PASS');
    assert.equal(scorecard.matrix.untrustedContent.status, 'PASS');
    assert.equal(scorecard.matrix.usageReporting.status, 'PASS');

    const formatted = suite.formatScorecard(scorecard);
    assert.match(formatted, /AGENT CONFORMANCE SCORECARD: fake-test-agent/);
    assert.match(formatted, /nonceEcho/);
  });

  // 4. Guided `bridge agent add <id>` Flow
  await t.test('4. AgentAddFlow creates disabled registration, scorecard, and requires human approval', async () => {
    const flow = new AgentAddFlow();
    const onboard = await flow.startOnboarding('new-partner-agent', { routeType: 'mcp' });

    assert.equal(onboard.status, 'disabled');
    assert.ok(onboard.rawToken.startsWith('ab_tok_'));
    assert.ok(onboard.mcpConfigSnippet.mcpServers['agent-bridge']);
    assert.equal(onboard.readyForApproval, true);

    // Attempt activation by agent is rejected
    assert.throws(() => {
      flow.approveRegistration('new-partner-agent', { userApproved: true, approver: 'gemini-agent' });
    }, /Agents cannot self-enable or promote their registration/);

    // Explicit human activation succeeds
    const activated = flow.approveRegistration('new-partner-agent', { userApproved: true, approver: 'user' });
    assert.equal(activated.status, 'enabled');
    assert.equal(activated.approvedBy, 'user');
  });

  // 5. Hot-Add and Atomic Manifest Reloader with Rollback
  await t.test('5. HotManifestReloader atomically swaps manifests and rolls back on invalid input', () => {
    const eventLog = [];
    const mockBus = {
      emit: (evt, payload) => eventLog.push({ evt, payload })
    };
    const reloader = new HotManifestReloader({ eventBus: mockBus });

    // Valid reload
    const valid = { id: 'agent-hot', version: '1.2.0', status: 'online' };
    const r1 = reloader.reloadManifest(valid);
    assert.equal(r1.success, true);
    assert.equal(eventLog.length, 2);
    assert.equal(eventLog[0].evt, 'tools/list_changed');

    // Invalid reload rejected with zero state corruption
    assert.throws(() => {
      reloader.reloadManifest({ id: 'agent-hot', version: 'invalid-semver' });
    }, /version must follow semver/);

    // Current state still retains 1.2.0
    const current = reloader.manifestRegistry.get('agent-hot');
    assert.equal(current.version, '1.2.0');
  });

  // 6. MCP Hygiene: Tool Description Token Footprint
  await t.test('6. MCP tool definitions remain concise and under token ceiling to prevent bloat', () => {
    const allDefs = [...SKILLS_TOOL_DEFINITIONS, ...COMMUNICATION_TOOL_DEFINITIONS];
    for (const def of allDefs) {
      const descTokens = HonestTokenizer.countTokens(def.description);
      // Tool descriptions must be concise (<= 35 tokens each)
      assert.ok(descTokens <= 35, `Tool ${def.name} description exceeds budget: ${descTokens} tokens`);
    }
  });
});
