import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BRIDGE_ROOT = path.resolve(__dirname, '../..');

/**
 * Creates an isolated temporary directory and SQLite database path for hermetic tests.
 * Clean up with the returned cleanup() function.
 */
export function createHermeticTestEnv(prefix = 'ab-test-') {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}${Date.now()}-${crypto.randomBytes(4).toString('hex')}-`));
  const dbPath = path.join(tempDir, 'test_bridge.sqlite');

  const cleanup = () => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {}
  };

  return {
    tempDir,
    dbPath,
    cleanup
  };
}

/**
 * Creates an isolated skills directory and lockfile for hermetic tests.
 * Optionally copies in-house skill fixtures to preserve test coverage.
 */
export function createHermeticSkillsEnv(options = {}) {
  const { copyInhouse = false, prefix = 'ab-skills-' } = options;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}${Date.now()}-${crypto.randomBytes(4).toString('hex')}-`));
  const skillsRoot = path.join(tempDir, 'skills');
  const lockfilePath = path.join(skillsRoot, 'skills.lock.json');
  fs.mkdirSync(skillsRoot, { recursive: true });

  const originalSkillsRoot = path.join(BRIDGE_ROOT, '.agents', 'skills');
  const originalLockfile = path.join(originalSkillsRoot, 'skills.lock.json');

  if (copyInhouse && fs.existsSync(originalSkillsRoot)) {
    fs.cpSync(originalSkillsRoot, skillsRoot, { recursive: true });
  } else if (fs.existsSync(originalLockfile)) {
    fs.copyFileSync(originalLockfile, lockfilePath);
  } else {
    fs.writeFileSync(
      lockfilePath,
      JSON.stringify({ version: '1.0.0', updatedAt: new Date().toISOString(), skills: {} }, null, 2),
      'utf8'
    );
  }

  const cleanup = () => {
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {}
  };

  return {
    tempDir,
    skillsRoot,
    lockfilePath,
    cleanup
  };
}
