import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function request(options) {
  return new Promise((resolve, reject) => {
    const req = http.request({ ...options, agent: false }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('Graceful Shutdown on SIGTERM Suite [TEST-PROVEN]', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-shutdown-test-'));
  const runnerScript = path.join(tmpDir, 'shutdown-runner.js');
  const port = 9815;

  fs.writeFileSync(runnerScript, `
    import { BridgeHttpServer } from '${path.resolve('src/http-server.js')}';
    import { AuditLogger } from '${path.resolve('src/audit-logger.js')}';

    const dbPath = '${path.join(tmpDir, 'test.db')}';
    const logger = new AuditLogger(dbPath);
    const server = new BridgeHttpServer({
      port: ${port},
      host: '127.0.0.1',
      auditLogger: logger
    });

    server.start().then(() => {
      console.log('SERVER_STARTED');
    });

    process.on('SIGTERM', async () => {
      console.log('RECEIVED_SIGTERM');
      await server.stop();
      logger.close();
      console.log('CLEANUP_COMPLETE');
      process.exit(0);
    });
  `, 'utf8');

  let child = null;
  try {
    child = spawn(process.execPath, [runnerScript], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // Wait for server ready
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout starting server')), 5000);
      child.stdout.on('data', chunk => {
        if (chunk.toString().includes('SERVER_STARTED')) {
          clearTimeout(timeout);
          resolve();
        }
      });
      child.on('error', reject);
    });

    // Verify it is responding
    const res = await request({ host: '127.0.0.1', port, path: '/health', method: 'GET' });
    assert.strictEqual(res.status, 200);

    // Send SIGTERM
    const startTime = Date.now();
    child.kill('SIGTERM');

    // Verify bounded exit within 2000ms
    const exitCode = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Process did not terminate within bounded time')), 2500);
      child.on('exit', (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    const elapsed = Date.now() - startTime;
    assert.strictEqual(exitCode, 0, 'Exit code on SIGTERM must be 0');
    assert.ok(elapsed < 2000, `Process must exit within 2000ms (took ${elapsed}ms)`);

    // Verify port is released
    let refused = false;
    try {
      await request({ host: '127.0.0.1', port, path: '/health', method: 'GET' });
    } catch {
      refused = true;
    }
    assert.strictEqual(refused, true, 'Port must be released immediately after graceful shutdown');

  } finally {
    if (child && !child.killed) {
      try { child.kill('SIGKILL'); } catch {}
    }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});
