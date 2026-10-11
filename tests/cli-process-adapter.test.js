import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CliProcessAdapter } from '../src/control-plane/cli-process-adapter.js';
import { RouteEvidence } from '../src/capabilities/agent-manifest.js';
import { CompletionEvidenceTier } from '../src/control-plane/route-interface.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOCK_CLI = path.join(__dirname, 'fixtures', 'mock-cli.js');

test('Step 4c: Headless CLI Process Adapter Suite', async (t) => {
  const adapter = new CliProcessAdapter({
    command: process.execPath,
    defaultArgs: [MOCK_CLI],
    agentId: 'mock-cli-agent',
    passPromptViaStdin: false
  });

  await t.test('1. Probe verifies executable exists and returns ready status', async () => {
    const probeRes = await adapter.probe();
    assert.strictEqual(probeRes.ready, true);
    assert.strictEqual(probeRes.backgroundCapable, true);
    assert.strictEqual(probeRes.evidence, RouteEvidence.MOCK_TESTED);
    assert.ok(probeRes.version);
  });

  await t.test('2. Execute turn with prompt args, streaming chunks, and exact exit completion', async () => {
    const chunks = [];
    const streamObserver = adapter.observe({
      onPartialText: (chunk) => chunks.push(chunk)
    });

    const result = await adapter.send({
      requestId: 'req_cli_1',
      prompt: 'Hello from test',
      args: ['echo', 'Hello from test'],
      observer: streamObserver
    });

    assert.strictEqual(result.outcome, 'DELIVERED_CONFIRMED');
    assert.strictEqual(result.evidence, CompletionEvidenceTier.PROCESS_EXIT);
    assert.ok(result.response.includes('CLI Response to:'));
    assert.ok(result.usage.tokensIn > 0);
    assert.ok(result.usage.tokensOut > 0);
    assert.ok(chunks.length > 0);
  });

  await t.test('3. Execute turn via stdin streaming', async () => {
    const stdinAdapter = new CliProcessAdapter({
      command: process.execPath,
      defaultArgs: [MOCK_CLI, 'stdin'],
      agentId: 'mock-stdin-agent',
      passPromptViaStdin: true
    });

    const result = await stdinAdapter.send({
      requestId: 'req_cli_stdin',
      prompt: 'Piped input content'
    });

    assert.strictEqual(result.outcome, 'DELIVERED_CONFIRMED');
    assert.ok(result.response.includes('Processed stdin: Piped input content'));
    assert.strictEqual(result.usage.tokensIn, 10);
    assert.strictEqual(result.usage.tokensOut, 10);
  });

  await t.test('4. Streaming multi-chunk delivery receives partial text in real-time', async () => {
    const streamAdapter = new CliProcessAdapter({
      command: process.execPath,
      defaultArgs: [MOCK_CLI, 'stream'],
      agentId: 'mock-stream-agent'
    });

    const partials = [];
    const obs = streamAdapter.observe({
      onPartialText: (text) => partials.push(text)
    });

    const result = await streamAdapter.send({
      requestId: 'req_cli_stream',
      observer: obs
    });

    assert.strictEqual(result.outcome, 'DELIVERED_CONFIRMED');
    assert.ok(partials.length >= 3);
    assert.ok(partials.some(p => p.includes('Chunk 1')));
    assert.ok(partials.some(p => p.includes('Chunk 2')));
    assert.ok(partials.some(p => p.includes('Chunk 3')));
  });

  await t.test('5. Cancellation kills the process tree cleanly', async () => {
    const pauseAdapter = new CliProcessAdapter({
      command: process.execPath,
      defaultArgs: [MOCK_CLI, 'pause', '10000'],
      agentId: 'mock-pause-agent'
    });

    const sendPromise = pauseAdapter.send({
      requestId: 'req_cli_cancel'
    });

    // Give child process 50ms to spawn and start
    await new Promise(r => setTimeout(r, 50));

    const cancelRes = await pauseAdapter.cancel('req_cli_cancel');
    assert.strictEqual(cancelRes.cancelled, true);

    const result = await sendPromise;
    assert.strictEqual(result.outcome, 'CANCELLED');
    assert.strictEqual(result.exitCode, null);
  });

  await t.test('6. Non-zero exit code surfaces error truthfully without synthetic output', async () => {
    const errorAdapter = new CliProcessAdapter({
      command: process.execPath,
      defaultArgs: [MOCK_CLI, 'error'],
      agentId: 'mock-error-agent'
    });

    const result = await errorAdapter.send({
      requestId: 'req_cli_err'
    });

    assert.strictEqual(result.outcome, 'FAILED');
    assert.ok(result.error.includes('Fatal CLI error occurred') || result.exitCode === 1);
  });

  await t.test('7. Probe detects presence of installed safe system CLI (read-only)', async () => {
    // Non-destructive probe of node runtime or git
    const gitAdapter = new CliProcessAdapter({
      command: 'git',
      defaultArgs: ['--version'],
      agentId: 'git-cli'
    });

    const probe = await gitAdapter.probe();
    assert.strictEqual(probe.ready, true);
    assert.ok(probe.version.toLowerCase().includes('git version'));
  });
});
