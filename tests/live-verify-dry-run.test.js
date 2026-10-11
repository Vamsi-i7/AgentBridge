import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveVerificationHarness } from '../src/cli/live-verify.js';
import { EvidenceLevel } from '../src/capabilities/evidence-registry.js';
import { CompletionEvidenceTier } from '../src/control-plane/route-interface.js';

test('Live Verification Harness Dry-Run Suite [TEST-PROVEN]', async (t) => {

  await t.test('1. Dry-run harness discovers selectors without touching real apps', async () => {
    const harness = new LiveVerificationHarness({
      agentId: 'claude-desktop',
      routeId: 'chromium-cdp',
      dryRun: true
    });

    const preflight = await harness.preflightCheck();
    assert.strictEqual(preflight.allowed, true);
    assert.strictEqual(preflight.mode, 'DRY_RUN_FAKES');

    const selectors = await harness.discoverSelectors();
    assert.ok(selectors.inputSelector);
    assert.ok(selectors.sendButtonSelector);
    assert.ok(selectors.responseContainerSelector);
  });

  await t.test('2. Probe execution checks nonce echo and background focus preservation', async () => {
    const harness = new LiveVerificationHarness({
      agentId: 'chatgpt-desktop',
      routeId: 'macos-ax',
      dryRun: true
    });

    await harness.discoverSelectors();
    const result = await harness.executeProbe({
      probePrompt: 'BENIGN_TEST_PROBE'
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.nonceEchoed, true);
    assert.strictEqual(result.focusPreserved, true);
    assert.strictEqual(result.completionTier, CompletionEvidenceTier.UI_STOP_IDLE);
    assert.ok(result.responseHash.length === 64);
  });

  await t.test('3. Dry-run strictly preserves evidence level at mock-tested (never live-verified)', async () => {
    const harness = new LiveVerificationHarness({
      agentId: 'gemini',
      routeId: 'cli-process',
      dryRun: true
    });

    await harness.discoverSelectors();
    const probe = await harness.executeProbe();
    const commit = await harness.commitEvidenceRecord(probe, 'dry_run_token');

    assert.strictEqual(commit.level, EvidenceLevel.MOCK_TESTED);
    assert.strictEqual(commit.recorded, false);
    assert.ok(commit.message.includes('dry runs never write live-verified'));
  });

  await t.test('4. Live run is rejected if operator confirmation is missing (LIVE GATE)', async () => {
    const harness = new LiveVerificationHarness({
      agentId: 'claude-desktop',
      routeId: 'chromium-cdp',
      dryRun: false // Simulated live request
    });

    const preflight = await harness.preflightCheck({ confirmed: false });
    assert.strictEqual(preflight.allowed, false);
    assert.ok(preflight.reason.includes('LIVE_GATE_STOP'));
  });
});
