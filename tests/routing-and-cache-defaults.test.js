import test from 'node:test';
import assert from 'node:assert/strict';
import { CheapFirstRouter, TaskComplexity } from '../src/routing/cheap-first-router.js';
import { SemanticCache } from '../src/cache/semantic-cache.js';

test('Routing and Semantic Cache Defaults & Guarantees (P4)', async (t) => {
  await t.test('1. CheapFirstRouter NEVER substitutes an explicitly named target', () => {
    const router = new CheapFirstRouter({ enabled: true, cheapAgentId: 'gemini', frontierAgentId: 'claude-desktop' });

    // Lightweight task, but caller explicitly asked for claude-desktop
    const result = router.selectAgent({
      toAgent: 'claude-desktop',
      type: 'relay',
      message: 'simple ping'
    }, ['gemini', 'claude-desktop']);

    assert.strictEqual(result.selectedAgent, 'claude-desktop');
    assert.strictEqual(result.substituted, false);
    assert.match(result.reason, /Explicit caller target preserved/);
  });

  await t.test('2. CheapFirstRouter is disabled by default (opt-in)', () => {
    const router = new CheapFirstRouter(); // default enabled: false
    assert.strictEqual(router.enabled, false);

    const result = router.selectAgent({
      type: 'format',
      message: 'format code'
    }, ['claude-desktop', 'gemini']);

    assert.strictEqual(result.substituted, false);
    assert.strictEqual(result.tier, 'default_disabled');
    assert.strictEqual(result.selectedAgent, 'claude-desktop');
  });

  await t.test('3. Opt-in CheapFirstRouter routes when no target is declared', () => {
    const auditLogs = [];
    const mockAudit = { log: (ev, det) => auditLogs.push({ ev, det }) };

    const router = new CheapFirstRouter({
      enabled: true,
      cheapAgentId: 'gemini',
      frontierAgentId: 'claude-desktop',
      auditLogger: mockAudit
    });

    const lightResult = router.selectAgent({ type: 'lint' }, ['claude-desktop', 'gemini']);
    assert.strictEqual(lightResult.selectedAgent, 'gemini');
    assert.strictEqual(lightResult.tier, 'cheap');
    assert.strictEqual(lightResult.substituted, true);

    const deepResult = router.selectAgent({ type: 'security_audit' }, ['gemini', 'claude-desktop']);
    assert.strictEqual(deepResult.selectedAgent, 'claude-desktop');
    assert.strictEqual(deepResult.tier, 'frontier');
    assert.strictEqual(deepResult.substituted, true);

    assert.ok(auditLogs.length >= 2, 'Decisions must be audited');
  });

  await t.test('4. SemanticCache is disabled by default (opt-in)', () => {
    const cache = new SemanticCache(); // default enabled: false
    assert.strictEqual(cache.enabled, false);

    cache.put('what is the epoch?', 'Monotonic counter', {});
    assert.strictEqual(cache.get('what is the epoch?', {}), null);
    assert.strictEqual(cache.isCacheable('READ', 'what is the epoch?'), false);
  });

  await t.test('5. Opt-in SemanticCache caches read-only queries and returns cached: true', () => {
    const cache = new SemanticCache({ enabled: true });
    assert.strictEqual(cache.isCacheable('WRITE', 'write to disk'), false);
    assert.strictEqual(cache.isCacheable('READ', 'what is the epoch?'), true);

    const fileCtx = { 'src/epoch.js': 'hash_abc123' };
    cache.put('what is the epoch?', 'Monotonic counter', fileCtx);

    const hit = cache.get('what is the epoch?', fileCtx);
    assert.ok(hit);
    assert.strictEqual(hit.cached, true);
    assert.strictEqual(hit.response, 'Monotonic counter');

    // Invalidation when file context changes
    cache.invalidateFiles(['src/epoch.js']);
    assert.strictEqual(cache.get('what is the epoch?', fileCtx), null);
  });
});
