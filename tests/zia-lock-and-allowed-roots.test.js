import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PermissionGuard } from '../src/permission-guard.js';
import { ProjectController } from '../src/project-controller.js';
import { GitController } from '../src/git-controller.js';
import { CONFIG } from '../src/config.js';

test('Stage 1.3: ALLOWED_ROOTS and ZIA_WRITE_LOCKED enforcement', async (t) => {
  // Create temporary fixture directory for testing (NEVER touch real Zia)
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zia-fixture-test-'));
  const fakeZia = path.join(fixtureDir, 'fake-zia');
  const fakeWorkspace = path.join(fixtureDir, 'workspace');
  fs.mkdirSync(fakeZia, { recursive: true });
  fs.mkdirSync(fakeWorkspace, { recursive: true });

  const realZiaFile = path.join(fakeZia, 'target.txt');
  fs.writeFileSync(realZiaFile, 'original');

  // Create a symlink inside workspace pointing to fake Zia
  const symlinkToZia = path.join(fakeWorkspace, 'symlink-to-zia');
  fs.symlinkSync(fakeZia, symlinkToZia, 'dir');

  const symlinkedFile = path.join(symlinkToZia, 'target.txt');

  const customConfig = {
    ...CONFIG,
    ZIA_ROOT: fakeZia,
    ZIA_WRITE_LOCKED: true,
    ALLOWED_ROOTS: [fakeWorkspace, fakeZia] // Even if allowed roots includes fakeZia, write lock must hold!
  };

  const guard = new PermissionGuard(customConfig);
  const nullLogger = { log: () => {} };
  const projectController = new ProjectController(guard, nullLogger);
  const gitController = new GitController(guard, nullLogger);

  await t.test('Default CONFIG defaults ZIA_WRITE_LOCKED to true and narrows ALLOWED_ROOTS', () => {
    assert.strictEqual(CONFIG.ZIA_WRITE_LOCKED, true, 'CONFIG.ZIA_WRITE_LOCKED must default to true');
    if (!process.env.AGENT_BRIDGE_ALLOW_HOME_ROOT && !process.env.AGENT_BRIDGE_ALLOWED_ROOTS) {
      assert.ok(!CONFIG.ALLOWED_ROOTS.includes(os.homedir()), 'ALLOWED_ROOTS must not include home directory by default');
    }
  });

  await t.test('Direct path mutations in Zia are denied for all agents including system', async () => {
    const agents = ['system', 'antigravity-ide', 'claude-desktop', 'chatgpt-desktop', 'freebuff'];
    const modes = ['WRITE', 'CREATE', 'EDIT', 'DELETE'];

    for (const agent of agents) {
      for (const mode of modes) {
        const check = guard.validatePathAccess(realZiaFile, mode);
        assert.strictEqual(check.allowed, false, `Expected ${mode} for agent ${agent} in Zia to be denied`);
        assert.match(check.reason, /WRITE-LOCKED/i);
      }
    }
  });

  await t.test('Symlink-resolved path mutations into Zia are denied for all agents', async () => {
    const check = guard.validatePathAccess(symlinkedFile, 'WRITE');
    assert.strictEqual(check.allowed, false, 'Symlink into Zia must be denied for WRITE');
    assert.match(check.reason, /WRITE-LOCKED/i);
  });

  await t.test('ProjectController denies createFile, editFile, and deleteFile under Zia and symlink to Zia', async () => {
    await assert.rejects(
      async () => projectController.createFile(realZiaFile, 'system', 'content', true),
      /WRITE-LOCKED/i
    );

    await assert.rejects(
      async () => projectController.editFile(realZiaFile, 'system', 'content'),
      /WRITE-LOCKED/i
    );

    await assert.rejects(
      async () => projectController.deleteFile(realZiaFile, 'system'),
      /WRITE-LOCKED/i
    );

    await assert.rejects(
      async () => projectController.editFile(symlinkedFile, 'system', 'content'),
      /WRITE-LOCKED/i
    );
  });

  await t.test('Command execution is denied when cwd is Zia or symlink to Zia', async () => {
    const directCheck = guard.validateCommand('git status', fakeZia);
    assert.strictEqual(directCheck.allowed, false, 'Command execution with cwd in Zia must be denied');
    assert.match(directCheck.reason, /ZIA_WRITE_LOCKED/i);

    const symlinkCheck = guard.validateCommand('git status', symlinkToZia);
    assert.strictEqual(symlinkCheck.allowed, false, 'Command execution with cwd via symlink to Zia must be denied');
    assert.match(symlinkCheck.reason, /ZIA_WRITE_LOCKED/i);

    await assert.rejects(
      async () => projectController.executeCommand('git status', fakeZia, 'system'),
      /ZIA_WRITE_LOCKED/i
    );
  });

  await t.test('GitController mutation operations are denied under Zia', async () => {
    await assert.rejects(
      async () => gitController.stage(fakeZia, 'system', ['target.txt']),
      /WRITE-LOCKED/i
    );

    await assert.rejects(
      async () => gitController.commit(fakeZia, 'system', 'test commit'),
      /WRITE-LOCKED/i
    );

    await assert.rejects(
      async () => gitController.createBranch(fakeZia, 'system', 'new-branch'),
      /WRITE-LOCKED/i
    );

    await assert.rejects(
      async () => gitController.switchBranch(fakeZia, 'system', 'main'),
      /WRITE-LOCKED/i
    );

    await assert.rejects(
      async () => gitController.deleteBranch(fakeZia, 'system', 'old-branch'),
      /WRITE-LOCKED/i
    );
  });

  // Clean up fixture tree
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});
