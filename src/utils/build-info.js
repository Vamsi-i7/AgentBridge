import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { CONFIG } from '../config.js';
import { getScrubbedEnv } from './scrubbed-env.js';

let cachedBuildInfo = null;

/**
 * Returns build metadata (git short hash, package version, build timestamp, buildId).
 * Used by /health, bridge doctor, and diagnostics.
 */
export function getBuildInfo() {
  if (cachedBuildInfo) return cachedBuildInfo;

  let version = 'unknown';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(CONFIG.BRIDGE_ROOT, 'package.json'), 'utf8'));
    version = pkg.version || 'unknown';
  } catch {
    // swallow-ok: fallback when package.json unreadable in isolated env
  }

  let gitShort = 'unknown';
  try {
    gitShort = execSync('git rev-parse --short HEAD', {
      cwd: CONFIG.BRIDGE_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: getScrubbedEnv()
    }).trim();
  } catch {
    // swallow-ok: fallback when running outside git repo
  }

  const buildTime = new Date().toISOString();
  const buildId = `${gitShort}-v${version}`;

  cachedBuildInfo = {
    buildId,
    version,
    gitShort,
    buildTime
  };
  return cachedBuildInfo;
}
