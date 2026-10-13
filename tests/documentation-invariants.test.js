import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getCanonicalToolCounts, ToolRegistry } from '../src/tool-registry.js';
import { CONFIG } from '../src/config.js';
import { getBuildInfo } from '../src/utils/build-info.js';

test('STAGE 8: Documentation Invariants and Repo Hygiene (AR-09, AR-10)', async (t) => {
  const root = CONFIG.BRIDGE_ROOT;

  await t.test('1. Canonical tool counts accessor derives accurate runtime values', () => {
    const counts = getCanonicalToolCounts();
    const reg = new ToolRegistry();
    const allDefs = reg.getToolDefinitions('all');

    assert.strictEqual(counts.registeredTools, 74, 'Core registered tool count must be exactly 74');
    assert.strictEqual(counts.skillsTools, 5, 'Skills profile tool count must be exactly 5');
    assert.strictEqual(counts.communicationTools, 2, 'Communication profile additional tool count must be exactly 2');
    assert.strictEqual(counts.totalSystemTools, 81, 'Total system-wide tool surface must be exactly 81');
    assert.strictEqual(allDefs.length, 74, 'ToolRegistry default "all" profile must match registered count');

    assert.deepStrictEqual(counts.profiles, {
      communication: 5,
      skills: 6,
      minimal: 8,
      collaborator: 16,
      developer: 32,
      all: 74
    }, 'Profile tool counts must match exact specifications');
  });

  await t.test('2. IMPLEMENTATION_STATE.md reflects canonical tool counts and no stale numbers', () => {
    const content = fs.readFileSync(path.join(root, 'IMPLEMENTATION_STATE.md'), 'utf8');

    // Tool counts
    assert.ok(content.includes('74 tools registered in core `src/tool-registry.js`'), 'Must mention 74 core registered tools');
    assert.ok(content.includes('81 total tools system-wide'), 'Must mention 81 total tools system-wide');

    // Stale numbers must not appear as active state
    assert.ok(!content.includes('PID:** 48913'), 'Must not contain stale hardcoded PID 48913');
    assert.ok(!content.includes('green (687 tests'), 'Must not contain stale 687 test count');
    assert.ok(!content.includes('(registry now 64 tools)'), 'Must not contain stale 64 tools count without historical context');
    assert.ok(!content.includes('(total 73 tools)'), 'Must not contain stale 73 tools count without historical context');
  });

  await t.test('3. docs/v2/baseline.md is explicitly labeled as a historical baseline', () => {
    const content = fs.readFileSync(path.join(root, 'docs/v2/baseline.md'), 'utf8');
    assert.ok(content.includes('Historical Baseline Reference'), 'Must include historical baseline notice');
    assert.ok(content.includes('superseded by 1,156 tests at HEAD'), 'Must document supersession by modern test suite');
  });

  await t.test('4. .gitignore includes tools/macos-accessibility-helper/.build/', () => {
    const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    assert.ok(gitignore.includes('tools/macos-accessibility-helper/.build/'), 'Must ignore Swift .build directory');
  });

  await t.test('5. docs/build-artifacts-cleanup.md exists and documents cleanup command', () => {
    const cleanupDoc = path.join(root, 'docs/build-artifacts-cleanup.md');
    assert.ok(fs.existsSync(cleanupDoc), 'Cleanup doc must exist');
    const content = fs.readFileSync(cleanupDoc, 'utf8');
    assert.ok(content.includes('git rm -r --cached tools/macos-accessibility-helper/.build'), 'Must document exact removal command');
    assert.ok(content.includes('2,890 tracked files'), 'Must document tracked file count');
  });

  await t.test('6. package.json and lockfile version specs for @modelcontextprotocol/sdk are aligned', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.dependencies['@modelcontextprotocol/sdk'], '^1.6.0', 'package.json must specify ^1.6.0');

    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    assert.strictEqual(lock.packages[''].dependencies['@modelcontextprotocol/sdk'], '^1.6.0', 'package-lock.json root must match ^1.6.0');
  });

  await t.test('7. getBuildInfo provides non-empty buildId and gitShort', () => {
    const info = getBuildInfo();
    assert.ok(typeof info.buildId === 'string' && info.buildId.length > 0, 'buildId must be non-empty string');
    assert.ok(typeof info.version === 'string' && info.version.length > 0, 'version must be non-empty string');
    assert.ok(typeof info.buildTime === 'string' && info.buildTime.length > 0, 'buildTime must be ISO timestamp');
  });
});
