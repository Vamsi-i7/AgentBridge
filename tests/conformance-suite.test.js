import test from 'node:test';
import assert from 'node:assert';
import { runConformanceSuite } from '../src/testing/conformance-suite.js';

test('Agent Conformance Suite runs successfully on registered agents', async (t) => {
  await t.test('passes on registered agent (freebuff)', async () => {
    const result = await runConformanceSuite('freebuff');
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.agentId, 'freebuff');
    assert.ok(result.summary.includes('✅ PASSED'));
  });

  await t.test('fails on unregistered agent', async () => {
    const result = await runConformanceSuite('nonexistent-rogue-agent');
    assert.strictEqual(result.passed, false);
    assert.ok(result.summary.includes('❌ FAILED'));
    const idCheck = result.checks.find(c => c.test === 'Identity Registration');
    assert.strictEqual(idCheck.passed, false);
  });
});
