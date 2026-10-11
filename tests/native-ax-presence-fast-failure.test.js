import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeAxAdapter } from '../src/control-plane/native-ax-adapter.js';
import { CompletionEvidenceTier, DeliveryStage } from '../src/control-plane/route-interface.js';
import { PresenceManager } from '../src/presence-manager.js';
import { DatabaseSync } from 'node:sqlite';

function makeMockSwiftBridge(overrides = {}) {
  const calls = [];
  return {
    calls,
    isBinaryAvailable: () => true,
    inspectApp: async (app) => ({ ok: true, running: true, windowCount: 1, accessibilityGranted: true }),
    sendPrompt: async (app, text, requestId) => {
      calls.push({ op: 'sendPrompt', app, text, requestId });
      return { ok: true, status: 'SUBMITTED' };
    },
    observeResponse: async (app, requestId, timeoutMs) => {
      return { ok: true, status: 'COMPLETED', response: 'Observed AX Response text', isGenerating: false, stopButtonPresent: false };
    },
    pressChatGPTButton: async (btn) => {
      calls.push({ op: 'pressButton', btn });
      return { ok: true };
    },
    ...overrides
  };
}

test('Step 4d & 4e: Native AX Route & Presence Fast-Failure Suite [MOCK-ONLY]', async (t) => {
  await t.test('1. AX Probe fails fast with specific stages and reasons', async () => {
    // 1a. Helper binary missing
    const missingHelperBridge = makeMockSwiftBridge({ isBinaryAvailable: () => false });
    const adapter1 = new NativeAxAdapter({ swiftBridge: missingHelperBridge });
    const probe1 = await adapter1.probe();
    assert.equal(probe1.ready, false);
    assert.equal(probe1.stage, DeliveryStage.FAILED);
    assert.equal(probe1.reason, 'ACCESSIBILITY_HELPER_MISSING');

    // 1b. App not running
    const notRunningBridge = makeMockSwiftBridge({ inspectApp: async () => ({ ok: false, running: false }) });
    const adapter2 = new NativeAxAdapter({ swiftBridge: notRunningBridge });
    const probe2 = await adapter2.probe();
    assert.equal(probe2.ready, false);
    assert.equal(probe2.stage, DeliveryStage.CONNECTED);
    assert.equal(probe2.reason, 'APP_NOT_RUNNING');

    // 1c. Window missing
    const noWindowBridge = makeMockSwiftBridge({ inspectApp: async () => ({ ok: true, running: true, windowCount: 0 }) });
    const adapter3 = new NativeAxAdapter({ swiftBridge: noWindowBridge });
    const probe3 = await adapter3.probe();
    assert.equal(probe3.ready, false);
    assert.equal(probe3.stage, DeliveryStage.READY);
    assert.equal(probe3.reason, 'WINDOW_MISSING');

    // 1d. Accessibility denied
    const axDeniedBridge = makeMockSwiftBridge({ inspectApp: async () => ({ ok: true, running: true, windowCount: 1, accessibilityGranted: false }) });
    const adapter4 = new NativeAxAdapter({ swiftBridge: axDeniedBridge });
    const probe4 = await adapter4.probe();
    assert.equal(probe4.ready, false);
    assert.equal(probe4.stage, DeliveryStage.CAPABLE);
    assert.equal(probe4.reason, 'ACCESSIBILITY_DENIED');

    // 1e. Healthy
    const healthyAdapter = new NativeAxAdapter({ swiftBridge: makeMockSwiftBridge() });
    const probe5 = await healthyAdapter.probe();
    assert.equal(probe5.ready, true);
    assert.equal(probe5.stage, DeliveryStage.CAPABLE);
  });

  await t.test('2. AX Send tags prompt with correlation marker and verifies readiness', async () => {
    const mockBridge = makeMockSwiftBridge();
    const adapter = new NativeAxAdapter({ swiftBridge: mockBridge });

    const sendRes = await adapter.send({
      requestId: 'req_ax_test_1',
      text: 'Calculate the factorial of 5'
    });

    assert.equal(sendRes.accepted, true);
    assert.equal(sendRes.routeId, 'desktop-ui-ax');
    assert.equal(mockBridge.calls.length, 1);
    assert.equal(mockBridge.calls[0].op, 'sendPrompt');
    assert.match(mockBridge.calls[0].text, /\[AB:req_ax_test_1\]/);
  });

  await t.test('3. Exact completion signal: Stop button disappearance + idle produces INDICATOR_BASED evidence', async () => {
    let callCount = 0;
    const mockBridge = makeMockSwiftBridge({
      observeResponse: async () => {
        callCount++;
        if (callCount === 1) {
          // In progress: generating with stop button present
          return { ok: true, response: 'Partial response...', isGenerating: true, stopButtonPresent: true };
        }
        // Completed: stop button gone, idle
        return { ok: true, response: 'Full factorial is 120.', isGenerating: false, stopButtonPresent: false, status: 'COMPLETED' };
      }
    });

    const adapter = new NativeAxAdapter({ swiftBridge: mockBridge, pollIntervalMs: 10 });
    await adapter.send({ requestId: 'req_ax_test_2', text: 'Factorial of 5' });

    const chunks = [];
    const result = await new Promise((resolve, reject) => {
      adapter.observe(
        { requestId: 'req_ax_test_2' },
        {
          onChunk: (chunk) => chunks.push(chunk),
          onComplete: (res) => resolve(res),
          onError: (err) => reject(err)
        }
      );
    });

    assert.equal(result.success, true);
    assert.equal(result.evidenceTier, CompletionEvidenceTier.INDICATOR_BASED);
    assert.equal(result.confidence, 'high');
    assert.equal(result.signal, 'STOP_BUTTON_GONE_AND_IDLE');
    assert.equal(result.response, 'Full factorial is 120.');
    assert.ok(chunks.length >= 1);
  });

  await t.test('4. Stable-tick fallback produces STABILITY_HEURISTIC marked low confidence', async () => {
    const mockBridge = makeMockSwiftBridge({
      observeResponse: async () => {
        // No explicit stop indicator exposed, text unchanged
        return { ok: true, response: 'Stable fallback text', isGenerating: undefined, stopButtonPresent: undefined };
      }
    });

    const adapter = new NativeAxAdapter({ swiftBridge: mockBridge, pollIntervalMs: 10 });
    await adapter.send({ requestId: 'req_ax_test_3', text: 'Stable query' });

    const result = await new Promise((resolve, reject) => {
      adapter.observe(
        { requestId: 'req_ax_test_3' },
        {
          onComplete: (res) => resolve(res),
          onError: (err) => reject(err)
        }
      );
    });

    assert.equal(result.success, true);
    assert.equal(result.evidenceTier, CompletionEvidenceTier.STABILITY_HEURISTIC);
    assert.equal(result.confidence, 'low');
    assert.equal(result.signal, 'STABLE_TEXT_FALLBACK');
    assert.equal(result.response, 'Stable fallback text');
  });

  await t.test('5. Cancel presses Stop button without window focus theft', async () => {
    const mockBridge = makeMockSwiftBridge();
    const adapter = new NativeAxAdapter({ swiftBridge: mockBridge });
    await adapter.send({ requestId: 'req_ax_test_4', text: 'Long query' });

    let errorThrown = null;
    const observation = adapter.observe(
      { requestId: 'req_ax_test_4' },
      {
        onError: (err) => { errorThrown = err; }
      }
    );

    await observation.cancel();
    assert.equal(errorThrown?.message, 'CANCELLED');
    const stopCall = mockBridge.calls.find(c => c.op === 'pressButton' && c.btn === 'Stop');
    assert.ok(stopCall, 'Stop button must be pressed on cancel');
  });

  await t.test('6. PresenceManager separates stages and provides canary route tracking', async () => {
    const memDb = new DatabaseSync(':memory:');
    const mockLogger = { db: memDb, log: () => {} };
    const presence = new PresenceManager(mockLogger);

    // 6a. Unknown agent
    const pUnknown = presence.getDetailedPresence('unknown-agent-xyz');
    assert.equal(pUnknown.stage, 'FAILED');
    assert.equal(pUnknown.failureReason, 'UNKNOWN_AGENT');

    // 6b. Known agent disconnected
    const pDisconnected = presence.getDetailedPresence('chatgpt-desktop');
    assert.equal(pDisconnected.stage, 'REGISTERED');
    assert.equal(pDisconnected.failureReason, 'DISCONNECTED');

    // 6c. Connected and capable
    presence.heartbeat({
      agentId: 'chatgpt-desktop',
      transport: 'desktop-ui-ax',
      health: 'healthy',
      capabilities: ['chat', 'reasoning']
    });

    const pCapable = presence.getDetailedPresence('chatgpt-desktop');
    assert.equal(pCapable.stage, 'CAPABLE');
    assert.equal(pCapable.failureReason, null);

    // 6d. Canary check detects and tracks degraded route
    const brokenAdapter = new NativeAxAdapter({
      swiftBridge: makeMockSwiftBridge({ inspectApp: async () => ({ ok: false, running: false }) })
    });

    const canaryRes = await presence.canaryCheck('chatgpt-desktop', brokenAdapter);
    assert.equal(canaryRes.healthy, false);
    assert.equal(canaryRes.reason, 'APP_NOT_RUNNING');

    const degraded = presence.getDegradedRoutes();
    assert.equal(degraded.length, 1);
    assert.equal(degraded[0].agentId, 'chatgpt-desktop');
    assert.equal(degraded[0].reason, 'APP_NOT_RUNNING');

    // 6e. Canary recovers when route becomes healthy
    const healthyAdapter = new NativeAxAdapter({ swiftBridge: makeMockSwiftBridge() });
    const recoveryRes = await presence.canaryCheck('chatgpt-desktop', healthyAdapter);
    assert.equal(recoveryRes.healthy, true);
    assert.equal(presence.getDegradedRoutes().length, 0);

    memDb.close();
  });
});
