import test from 'node:test';
import assert from 'node:assert/strict';
import { CliProcessAdapter } from '../src/control-plane/cli-process-adapter.js';
import { CompletionEvidenceTier } from '../src/control-plane/route-interface.js';

test('CliProcessAdapter: Immediate cancel and completion tiers', async (t) => {
  await t.test('1. Immediate cancel without await succeeds with zero retry loop', async () => {
    const adapter = new CliProcessAdapter('test-cli', {
      command: 'sleep',
      args: ['5']
    });

    const requestId = 'req_immediate_cancel';
    // Launch send without awaiting
    const sendPromise = adapter.send({
      requestId,
      message: 'test prompt',
      timeoutMs: 10000
    });

    // Cancel IMMEDIATELY in the same tick or next microtask
    const cancelResult = await adapter.cancel(requestId);
    assert.strictEqual(cancelResult.cancelled, true, 'Cancellation must be accepted immediately');
    assert.strictEqual(cancelResult.requestId, requestId);

    const outcome = await sendPromise;
    assert.strictEqual(outcome.outcome, 'CANCELLED');
    assert.strictEqual(adapter.activeProcesses.has(requestId), false);
  });

  await t.test('2. Successful CLI execution reports PROCESS_EXIT evidence tier', async () => {
    const adapter = new CliProcessAdapter('test-cli-echo', {
      command: 'echo',
      args: ['hello-bridge']
    });

    const requestId = 'req_normal_exit';
    const outcome = await adapter.send({
      requestId,
      message: 'test prompt'
    });

    assert.strictEqual(outcome.outcome, 'DELIVERED_CONFIRMED');
    assert.strictEqual(outcome.evidence, CompletionEvidenceTier.PROCESS_EXIT);
    assert.strictEqual(outcome.response, 'hello-bridge test prompt');
  });

  await t.test('3. F-014: Environment isolation hides bridge secrets and passes only allowlisted/declared vars', async () => {
    // Set a sentinel secret in process.env
    const secretKey = 'BRIDGE_SENTINEL_SECRET_TOKEN_XYZ';
    process.env[secretKey] = 'super-secret-value-never-leak';

    try {
      const adapter = new CliProcessAdapter('test-cli-env', {
        command: 'node',
        args: ['-e', `
          const secret = process.env['${secretKey}'] || 'NOT_FOUND';
          const custom = process.env['CUSTOM_CLI_VAR'] || 'NOT_FOUND';
          console.log(JSON.stringify({ secret, custom }));
        `],
        env: {
          CUSTOM_CLI_VAR: 'declared-allowed-value'
        }
      });

      const outcome = await adapter.send({
        requestId: 'req_env_isolation',
        message: ''
      });

      assert.strictEqual(outcome.outcome, 'DELIVERED_CONFIRMED');
      const parsed = JSON.parse(outcome.response);
      assert.strictEqual(parsed.secret, 'NOT_FOUND', 'Sentinel bridge secret must not leak to spawned CLI');
      assert.strictEqual(parsed.custom, 'declared-allowed-value', 'Explicitly declared per-CLI variables must be passed');
    } finally {
      delete process.env[secretKey];
    }
  });

  await t.test('4. F-015: Cancelling CLI terminates process group including grandchild processes', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');

    const tmpPidFile = path.join(os.tmpdir(), `grandchild-pid-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);

    // The parent spawns a grandchild process and writes the grandchild PID to tmpPidFile
    const parentScript = `
      const { spawn } = require('child_process');
      const fs = require('fs');
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore'
      });
      fs.writeFileSync(${JSON.stringify(tmpPidFile)}, String(grandchild.pid));
      setInterval(() => {}, 5000);
    `;

    const adapter = new CliProcessAdapter('test-cli-tree-cancel', {
      command: 'node',
      args: ['-e', parentScript]
    });

    const requestId = 'req_tree_cancel';
    const sendPromise = adapter.send({
      requestId,
      message: '',
      timeoutMs: 30000
    });

    // Wait until tmpPidFile is written
    let grandchildPid = null;
    for (let i = 0; i < 50; i++) {
      if (fs.existsSync(tmpPidFile)) {
        try {
          const content = fs.readFileSync(tmpPidFile, 'utf8').trim();
          if (content) {
            grandchildPid = parseInt(content, 10);
            break;
          }
        } catch {}
      }
      await new Promise(r => setTimeout(r, 50));
    }

    assert.ok(grandchildPid, 'Grandchild process must have started and written PID');

    // Verify grandchild is alive before cancellation
    let isGrandchildAlive = false;
    try {
      process.kill(grandchildPid, 0);
      isGrandchildAlive = true;
    } catch (e) {
      isGrandchildAlive = false;
    }
    assert.strictEqual(isGrandchildAlive, true, 'Grandchild must be alive before cancellation');

    // Cancel adapter
    const cancelRes = await adapter.cancel(requestId);
    assert.strictEqual(cancelRes.cancelled, true);

    await sendPromise;

    // Wait up to 1 second for process group termination signal
    let grandchildTerminated = false;
    for (let i = 0; i < 20; i++) {
      try {
        process.kill(grandchildPid, 0);
        await new Promise(r => setTimeout(r, 50));
      } catch (err) {
        if (err.code === 'ESRCH') {
          grandchildTerminated = true;
          break;
        }
      }
    }

    try { fs.unlinkSync(tmpPidFile); } catch {}

    assert.strictEqual(grandchildTerminated, true, 'Grandchild process must be terminated when CLI is cancelled');
  });
});

