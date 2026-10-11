import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { ProjectController } from '../src/project-controller.js';
import { CliProcessAdapter } from '../src/control-plane/cli-process-adapter.js';
import { PermissionGuard } from '../src/permission-guard.js';
import { AuditLogger } from '../src/audit-logger.js';
import { ConcurrencyManager } from '../src/concurrency-manager.js';
import { CacheManager } from '../src/cache-manager.js';
import { FileActivityManager } from '../src/file-activity-manager.js';
import { CONFIG } from '../src/config.js';

test('Stage 1.5: Spawned process scrubbed environment and process group cancellation', async (t) => {
  const SENTINEL_KEY = 'BRIDGE_SECRET_SENTINEL_TOKEN_XYZ';
  const SENTINEL_VAL = 'TOP_SECRET_BRIDGE_KEY_987654321';
  process.env[SENTINEL_KEY] = SENTINEL_VAL;

  const logger = new AuditLogger(':memory:');
  const guard = new PermissionGuard();
  const concurrency = new ConcurrencyManager();
  const cache = new CacheManager();
  const fileActivity = new FileActivityManager(logger);
  const controller = new ProjectController(guard, logger, concurrency, fileActivity, cache, null);

  t.after(() => {
    delete process.env[SENTINEL_KEY];
    try { logger.close(); } catch {}
  });

  await t.test('1. ProjectController.executeCommand scrubs environment: child does not see sentinel secret', async () => {
    // Run node -e to output process.env via executeCommand
    const res = await controller.executeCommand(
      'node -e "console.log(JSON.stringify(process.env))"',
      CONFIG.TEST_WORKSPACE,
      'system'
    );
    assert.ok(res.stdout, 'Must produce stdout');
    const childEnv = JSON.parse(res.stdout);

    assert.strictEqual(
      childEnv[SENTINEL_KEY],
      undefined,
      `Child process must NOT see sentinel secret name ${SENTINEL_KEY}`
    );
    assert.strictEqual(
      JSON.stringify(childEnv).includes(SENTINEL_VAL),
      false,
      `Child process must NOT see sentinel secret value ${SENTINEL_VAL}`
    );
    assert.ok(childEnv.PATH, 'PATH must be present in child environment');
    assert.ok(childEnv.HOME, 'HOME must be present in child environment');
  });

  await t.test('2. CliProcessAdapter scrubs environment: child does not see sentinel secret', async () => {
    const adapter = new CliProcessAdapter('test-env-adapter', {
      command: process.execPath,
      args: ['-e', 'console.log(JSON.stringify(process.env))'],
      inputMode: 'arg',
      env: { CUSTOM_DECLARED_CLI_VAR: 'declared_ok' }
    });

    const turnResult = await adapter.send({
      requestId: 'req_env_test_1',
      prompt: ''
    });
    assert.strictEqual(turnResult.outcome, 'DELIVERED_CONFIRMED');
    const childEnv = JSON.parse(turnResult.response);

    assert.strictEqual(
      childEnv[SENTINEL_KEY],
      undefined,
      `CliProcessAdapter child must NOT see sentinel secret name ${SENTINEL_KEY}`
    );
    assert.strictEqual(
      JSON.stringify(childEnv).includes(SENTINEL_VAL),
      false,
      `CliProcessAdapter child must NOT see sentinel secret value ${SENTINEL_VAL}`
    );
    assert.strictEqual(
      childEnv.CUSTOM_DECLARED_CLI_VAR,
      'declared_ok',
      'Declared per-CLI variable is preserved'
    );
    assert.ok(childEnv.PATH, 'PATH is preserved');
  });

  await t.test('3. Cancelling a CLI process kills the entire process group including grandchildren', async () => {
    const ws = CONFIG.TEST_WORKSPACE;
    if (!fs.existsSync(ws)) fs.mkdirSync(ws, { recursive: true });
    const pidFile = path.join(ws, `grandchild_${Date.now()}.pid`);

    // Node script spawns a grandchild process and writes grandchild PID to pidFile
    const parentScript = path.join(ws, `parent_runner_${Date.now()}.mjs`);
    const parentContent = `
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const child = spawn('sleep', ['60'], {
  stdio: 'ignore'
});
fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));

// Keep parent alive
setInterval(() => {}, 1000);
`;
    fs.writeFileSync(parentScript, parentContent);

    const adapter = new CliProcessAdapter('test-group-kill', {
      command: process.execPath,
      args: [parentScript],
      inputMode: 'arg'
    });

    try {
      const reqId = `req_group_kill_${Date.now()}`;
      const executePromise = adapter.send({
        requestId: reqId,
        prompt: ''
      });

      // Wait until grandchild PID file is written
      let grandchildPid = null;
      for (let i = 0; i < 50; i++) {
        await new Promise(r => setTimeout(r, 100));
        if (fs.existsSync(pidFile)) {
          const content = fs.readFileSync(pidFile, 'utf8').trim();
          if (content) {
            grandchildPid = parseInt(content, 10);
            break;
          }
        }
      }

      assert.ok(grandchildPid, 'Grandchild PID file must be populated');

      // Verify grandchild is alive before cancel
      let isGrandchildAlive = false;
      try {
        process.kill(grandchildPid, 0);
        isGrandchildAlive = true;
      } catch (err) {
        isGrandchildAlive = false;
      }
      assert.strictEqual(isGrandchildAlive, true, 'Grandchild must be alive before cancel');

      // Cancel the turn via CliProcessAdapter
      const cancelRes = await adapter.cancel(reqId);
      assert.strictEqual(cancelRes.cancelled, true, 'Turn must be reported cancelled');

      // Wait for process group signals (SIGTERM/SIGKILL) to kill grandchild
      let grandchildDied = false;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 100));
        try {
          process.kill(grandchildPid, 0);
        } catch (err) {
          if (err.code === 'ESRCH') {
            grandchildDied = true;
            break;
          }
        }
      }

      assert.strictEqual(grandchildDied, true, 'Grandchild process must be dead after cancelling the CLI process group');
      await executePromise;
    } finally {
      try { fs.unlinkSync(parentScript); } catch {}
      try { fs.unlinkSync(pidFile); } catch {}
    }
  });
});
