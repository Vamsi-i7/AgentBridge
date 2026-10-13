import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BRIDGE_ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(BRIDGE_ROOT, 'data', 'bridge.sqlite');
const LOCKFILE_PATH = path.join(BRIDGE_ROOT, '.agents', 'skills', 'skills.lock.json');

function hashFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function getAuditCount(dbPath) {
  if (!fs.existsSync(dbPath)) return 0;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare('SELECT count(*) as cnt FROM audit_log').get();
    db.close();
    return row?.cnt || 0;
  } catch (err) {
    return null;
  }
}

function getGitLockfileDiff() {
  const res = spawnSync('git', ['diff', '--name-only', LOCKFILE_PATH], {
    cwd: BRIDGE_ROOT,
    encoding: 'utf8'
  });
  return res.stdout.trim();
}

console.log('=== Hermetic Test Verification ===');
console.log(`Checking DB: ${DB_PATH}`);
console.log(`Checking Lockfile: ${LOCKFILE_PATH}`);

const preHash = hashFile(DB_PATH);
const preAuditCount = getAuditCount(DB_PATH);
const preGitLock = getGitLockfileDiff();

console.log(`Pre-test DB hash: ${preHash}`);
console.log(`Pre-test Audit Log count: ${preAuditCount}`);
console.log(`Pre-test Lockfile dirty: ${Boolean(preGitLock)}`);

console.log('\nRunning test suite (node --test --test-concurrency=1 tests/*.test.js)...');
const testStart = Date.now();
const testResult = spawnSync('node', ['--test', '--test-concurrency=1', 'tests/*.test.js'], {
  cwd: BRIDGE_ROOT,
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    NODE_ENV: 'test'
  }
});

const durationSec = ((Date.now() - testStart) / 1000).toFixed(1);
console.log(`\nTest run finished in ${durationSec}s with exit code ${testResult.status}`);

const postHash = hashFile(DB_PATH);
const postAuditCount = getAuditCount(DB_PATH);
const postGitLock = getGitLockfileDiff();

console.log('\n=== Post-Test Verification ===');
console.log(`Post-test DB hash: ${postHash}`);
console.log(`Post-test Audit Log count: ${postAuditCount}`);
console.log(`Post-test Lockfile dirty: ${Boolean(postGitLock)}`);

let failed = false;

if (postGitLock && !preGitLock) {
  console.error('FAIL: .agents/skills/skills.lock.json was modified during tests!');
  failed = true;
}

if (testResult.status !== 0) {
  console.error(`FAIL: Test suite failed with exit code ${testResult.status}`);
  failed = true;
}

if (failed) {
  console.error('\nHermetic verification: FAILED');
  process.exit(1);
} else {
  console.log('\nHermetic verification: PASSED');
  process.exit(0);
}
