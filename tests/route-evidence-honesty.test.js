import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { RouteEvidenceRegistry, UnverifiedClaimError } from '../src/capabilities/evidence-registry.js';
import { RouteEvidence, RouteType, AGENT_MANIFESTS } from '../src/capabilities/agent-manifest.js';

test('Route Evidence Honesty & Single Source of Truth Suite', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-honesty-'));
  const registry = new RouteEvidenceRegistry({ evidenceDir: tmpDir, secret: 'test-secret-key-12345' });

  t.after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  await t.test('1. Baseline routes top out at mock-tested when no live evidence exists', () => {
    const claudeMcp = registry.getRouteEvidence('claude-desktop', 'mcp-stdio');
    assert.strictEqual(claudeMcp.tier, RouteEvidence.MOCK_TESTED);
    assert.strictEqual(claudeMcp.isLiveVerified, false);
    assert.strictEqual(claudeMcp.record, null);

    const chatgptAx = registry.getRouteEvidence('chatgpt-desktop', 'desktop-ui-ax');
    assert.strictEqual(chatgptAx.tier, RouteEvidence.MOCK_TESTED);
    assert.strictEqual(chatgptAx.isLiveVerified, false);
  });

  await t.test('2. ChatGPT desktop CDP route is declared only (native AppKit, not Electron)', () => {
    const chatgptCdp = registry.getRouteEvidence('chatgpt-desktop', 'cdp-unverified');
    assert.strictEqual(chatgptCdp.tier, RouteEvidence.DECLARED);
    assert.strictEqual(chatgptCdp.isLiveVerified, false);
  });

  await t.test('3. Asserting live-verified without signed evidence file throws UnverifiedClaimError', () => {
    assert.throws(
      () => registry.assertHonestTier(RouteEvidence.LIVE_VERIFIED, 'claude-desktop', 'mcp-stdio'),
      UnverifiedClaimError,
      'Must reject live-verified claim when evidence file is absent'
    );
  });

  await t.test('4. Signed evidence record elevates route to live-verified', () => {
    const sampleRecord = {
      agentId: 'claude-desktop',
      routeId: 'mcp-stdio',
      userConfirmationId: 'usr_conf_test_user_signoff_001',
      resultHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      appVersion: '0.9.1',
      osVersion: 'Darwin 24.1.0',
      completionEvidence: 'AUTHENTICATED_SUBMIT',
      measuredLatencyMs: 35,
      focusPreserved: true
    };

    const recorded = registry.recordLiveVerification(sampleRecord);
    assert.ok(recorded.signature, 'Signature must be generated');

    const check = registry.getRouteEvidence('claude-desktop', 'mcp-stdio');
    assert.strictEqual(check.tier, RouteEvidence.LIVE_VERIFIED);
    assert.strictEqual(check.isLiveVerified, true);
    assert.strictEqual(check.record.userConfirmationId, 'usr_conf_test_user_signoff_001');

    // Assertion must now pass
    assert.doesNotThrow(() => {
      registry.assertHonestTier(RouteEvidence.LIVE_VERIFIED, 'claude-desktop', 'mcp-stdio');
    });
  });

  await t.test('5. Tampering with evidence record invalidates it and downgrades to mock-tested', () => {
    const filePath = path.join(tmpDir, 'claude-desktop__mcp-stdio.json');
    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    // Tamper with the result hash
    content.resultHash = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    fs.writeFileSync(filePath, JSON.stringify(content));

    const check = registry.getRouteEvidence('claude-desktop', 'mcp-stdio');
    assert.strictEqual(check.tier, RouteEvidence.MOCK_TESTED, 'Tampered record must downgrade');
    assert.strictEqual(check.isLiveVerified, false);

    assert.throws(
      () => registry.assertHonestTier(RouteEvidence.LIVE_VERIFIED, 'claude-desktop', 'mcp-stdio'),
      UnverifiedClaimError
    );
  });
});
