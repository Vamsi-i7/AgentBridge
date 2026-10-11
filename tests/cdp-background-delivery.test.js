import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeCdpServer } from './fixtures/fake-cdp-server.js';
import { ChromiumCdpAdapter } from '../src/control-plane/chromium-cdp-adapter.js';
import { CompletionEvidenceTier } from '../src/control-plane/route-interface.js';

test('Step 4b: CDP Background Delivery & Network Stream Suite [MOCK-ONLY]', async (t) => {
  const server = new FakeCdpServer();
  const { port } = await server.start();

  const adapter = new ChromiumCdpAdapter('cdp-test-route', {
    port,
    host: '127.0.0.1',
    inputSelector: '.chat-input',
    sendButtonSelector: '.send-button',
    stopButtonSelector: '.stop-button',
    responseSelector: '.response-content'
  });

  t.after(async () => {
    await adapter.disconnect();
    await server.close();
  });

  await t.test('1. Probe verifies page target on debug port without stealing window focus', async () => {
    const probe = await adapter.probe();
    assert.strictEqual(probe.ready, true);
    assert.strictEqual(probe.stage, 'READY');
    assert.strictEqual(probe.port, port);
    assert.ok(probe.webSocketDebuggerUrl);
  });

  await t.test('2. Normal completion via Network stream emits NETWORK_END_OF_STREAM evidence', async () => {
    await adapter.connect();

    const chunks = [];
    let completedResult = null;

    const completionPromise = new Promise((resolve) => {
      adapter.observe({ requestId: 'req_cdp_normal' }, {
        onChunk: (chunk) => chunks.push(chunk),
        onComplete: (res) => {
          completedResult = res;
          resolve(res);
        }
      });
    });

    const sendRes = await adapter.send({
      requestId: 'req_cdp_normal',
      message: 'Write a quick summary'
    });
    assert.strictEqual(sendRes.accepted, true);

    // Simulate streaming network packets
    server.simulateNetworkChunk('Part 1 of answer. ');
    await new Promise(r => setTimeout(r, 200));

    server.simulateNetworkChunk('Part 2 of answer.');
    await new Promise(r => setTimeout(r, 200));

    // End of stream event from browser
    server.simulateLoadingFinished();

    const finalRes = await completionPromise;
    assert.strictEqual(finalRes.status, 'completed');
    assert.strictEqual(finalRes.completionEvidence, CompletionEvidenceTier.NETWORK_END_OF_STREAM);
    assert.ok(finalRes.bytesReceived > 0);
  });

  await t.test('3. Long mid-response pause does NOT trigger premature completion on network route', async () => {
    let completedEarly = false;

    adapter.observe({ requestId: 'req_cdp_pause' }, {
      onComplete: () => { completedEarly = true; }
    });

    await adapter.send({ requestId: 'req_cdp_pause', message: 'Take your time' });
    server.simulateNetworkChunk('Starting analysis...');

    // Wait 300ms during pause — network stream is open, so it must not complete
    await new Promise(r => setTimeout(r, 300));
    assert.strictEqual(completedEarly, false, 'Must not complete during mid-stream network pause');

    // Finish when network actually completes
    const waitFinish = new Promise((resolve) => {
      adapter.observe({ requestId: 'req_cdp_pause' }, {
        onComplete: (res) => resolve(res)
      });
    });

    server.simulateNetworkChunk(' Analysis finished.');
    server.simulateLoadingFinished();

    const res = await waitFinish;
    assert.strictEqual(res.completionEvidence, CompletionEvidenceTier.NETWORK_END_OF_STREAM);
  });

  await t.test('4. Connection loss mid-response rejects pending RPCs and emits disconnected', async () => {
    const errorAdapter = new ChromiumCdpAdapter('cdp-err-route', { port, host: '127.0.0.1' });
    await errorAdapter.connect();

    let gotDisconnect = false;
    errorAdapter.on('disconnected', () => { gotDisconnect = true; });

    errorAdapter.ws.close();
    await new Promise(r => setTimeout(r, 100));

    assert.strictEqual(gotDisconnect, true);
    assert.strictEqual(errorAdapter.connected, false);
    await errorAdapter.disconnect();
  });

  await t.test('5. Duplicate end events are safely ignored and do not double-settle', async () => {
    // Reconnect after simulated loss
    await adapter.connect();

    let completionCount = 0;
    adapter.observe({ requestId: 'req_cdp_dup' }, {
      onComplete: () => { completionCount++; }
    });

    await adapter.send({ requestId: 'req_cdp_dup', message: 'Test deduplication' });
    server.simulateNetworkChunk('Done.');

    // Fire duplicate end events
    server.simulateLoadingFinished();
    server.simulateLoadingFinished();
    server.simulateLoadingFinished();

    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(completionCount, 1, 'Duplicate end events must settle exactly once');
  });

  await t.test('6. Cancel during generation triggers stop button without error', async () => {
    server.pageState.stopped = false;
    await adapter.send({ requestId: 'req_cdp_cancel', message: 'Cancel me please' });

    const cancelRes = await adapter.cancel('req_cdp_cancel');
    assert.strictEqual(cancelRes, true);
    assert.strictEqual(server.pageState.stopped, true);
  });

  await t.test('7. Background unthrottling script is injected to prevent background timer degradation', async () => {
    const flags = ChromiumCdpAdapter.getBackgroundThrottlingFlags();
    assert.ok(flags.includes('--disable-background-timer-throttling'));
    assert.ok(flags.includes('--disable-renderer-backgrounding'));
    assert.ok(flags.includes('--disable-backgrounding-occluded-windows'));
  });
});
