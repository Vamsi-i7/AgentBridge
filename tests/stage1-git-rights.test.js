import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { ToolRegistry } from '../src/tool-registry.js';
import { GitController } from '../src/git-controller.js';
import { PermissionGuard } from '../src/permission-guard.js';
import { AuditLogger } from '../src/audit-logger.js';
import { CONFIG } from '../src/config.js';

function createTempGitRepoWithBareRemote() {
  const ws = path.join(CONFIG.BRIDGE_ROOT, 'test-workspace');
  if (!fs.existsSync(ws)) fs.mkdirSync(ws, { recursive: true });
  const tmpBase = fs.mkdtempSync(path.join(ws, 'git-rights-'));
  const bareDir = path.join(tmpBase, 'bare.git');
  const workDir = path.join(tmpBase, 'work');

  execSync(`git init --bare "${bareDir}"`, { stdio: 'ignore' });
  execSync(`git clone "${bareDir}" "${workDir}"`, { stdio: 'ignore' });

  // Initial seed commit
  execSync('git checkout -B main', { cwd: workDir, stdio: 'ignore' });
  fs.writeFileSync(path.join(workDir, 'README.md'), '# Test\n');
  execSync('git config user.email "test@agent-bridge.local"', { cwd: workDir });
  execSync('git config user.name "Bridge Test"', { cwd: workDir });
  execSync('git add README.md && git commit -m "initial commit"', { cwd: workDir });
  execSync('git push -u origin main', { cwd: workDir, stdio: 'ignore' });

  return {
    tmpBase,
    bareDir,
    workDir,
    cleanup: () => {
      try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch {}
    }
  };
}

test('Stage 1.3: Default-deny Git mutation policy and allowlist gating', async (t) => {
  const registry = new ToolRegistry();
  const originalAllowed = CONFIG.GIT_MUTATION_ALLOWED_AGENTS;

  t.after(() => {
    CONFIG.GIT_MUTATION_ALLOWED_AGENTS = originalAllowed;
  });

  await t.test('1. Tool description does not advertise lack of human confirmation', () => {
    const pushDef = registry.getToolDefinitions().find(t => t.name === 'bridge_git_push');
    assert.ok(pushDef, 'bridge_git_push must exist');
    assert.ok(
      !pushDef.description.includes('Does NOT require human confirmation'),
      'bridge_git_push description must not advertise that it does not require human confirmation'
    );
  });

  await t.test('2. Default-deny git mutation for un-allowlisted agents', async () => {
    const { workDir, cleanup } = createTempGitRepoWithBareRemote();
    const logger = new AuditLogger(':memory:');
    const guard = new PermissionGuard();
    const git = new GitController(guard, logger);

    const ctx = {
      git,
      logger,
      guard,
      boundAgentId: 'claude-desktop',
      agentId: 'claude-desktop'
    };

    try {
      // Ensure allowlist is empty by default
      CONFIG.GIT_MUTATION_ALLOWED_AGENTS = [];

      // Commit should be default-denied
      await assert.rejects(
        () => registry.executeTool('bridge_git_commit', {
          repoPath: workDir,
          message: 'unauthorized commit',
          stageAll: true,
          agentId: 'claude-desktop'
        }, ctx),
        /Unauthorized.*not permitted to mutate git state/i
      );

      // Push should be default-denied
      await assert.rejects(
        () => registry.executeTool('bridge_git_push', {
          repoPath: workDir,
          remote: 'origin',
          branch: 'feature',
          agentId: 'claude-desktop'
        }, ctx),
        /Unauthorized.*not permitted to mutate git state/i
      );

      // Branch creation should be default-denied
      await assert.rejects(
        () => registry.executeTool('bridge_git_create_branch', {
          repoPath: workDir,
          branchName: 'feature-unauthorized',
          agentId: 'claude-desktop'
        }, ctx),
        /Unauthorized.*not permitted to mutate git state/i
      );
    } finally {
      cleanup();
      try { logger.close(); } catch {}
    }
  });

  await t.test('3. Explicitly allowlisted agent can commit and push to non-protected branch', async () => {
    const { workDir, cleanup } = createTempGitRepoWithBareRemote();
    const logger = new AuditLogger(':memory:');
    const guard = new PermissionGuard();
    const git = new GitController(guard, logger);

    const ctx = {
      git,
      logger,
      guard,
      boundAgentId: 'claude-desktop',
      agentId: 'claude-desktop'
    };

    try {
      CONFIG.GIT_MUTATION_ALLOWED_AGENTS = ['claude-desktop'];

      // Create branch
      const branchRes = await registry.executeTool('bridge_git_create_branch', {
        repoPath: workDir,
        branchName: 'feature-allowed',
        agentId: 'claude-desktop'
      }, ctx);
      assert.strictEqual(branchRes.success, true);

      // Switch branch
      await registry.executeTool('bridge_git_switch_branch', {
        repoPath: workDir,
        branchName: 'feature-allowed',
        agentId: 'claude-desktop'
      }, ctx);

      // Stage & Commit
      fs.writeFileSync(path.join(workDir, 'file.txt'), 'hello\n');
      const commitRes = await registry.executeTool('bridge_git_commit', {
        repoPath: workDir,
        message: 'allowed commit',
        stageAll: true,
        agentId: 'claude-desktop'
      }, ctx);
      assert.strictEqual(commitRes.success, true);

      // Push
      const pushRes = await registry.executeTool('bridge_git_push', {
        repoPath: workDir,
        remote: 'origin',
        branch: 'feature-allowed',
        agentId: 'claude-desktop'
      }, ctx);
      assert.strictEqual(pushRes.success, true);
    } finally {
      cleanup();
      try { logger.close(); } catch {}
    }
  });

  await t.test('4. Non-privileged caller cannot bypass protected branch push via allowProtected: true', async () => {
    const { workDir, cleanup } = createTempGitRepoWithBareRemote();
    const logger = new AuditLogger(':memory:');
    const guard = new PermissionGuard();
    const git = new GitController(guard, logger);

    const ctx = {
      git,
      logger,
      guard,
      boundAgentId: 'claude-desktop',
      agentId: 'claude-desktop',
      isPrivileged: false
    };

    try {
      CONFIG.GIT_MUTATION_ALLOWED_AGENTS = ['claude-desktop'];
      CONFIG.ALLOW_AUTONOMOUS_PROTECTED_PUSH = false;

      // Make a change on main
      fs.writeFileSync(path.join(workDir, 'main-change.txt'), 'main\n');
      await registry.executeTool('bridge_git_commit', {
        repoPath: workDir,
        message: 'main change',
        stageAll: true,
        agentId: 'claude-desktop'
      }, ctx);

      // Attempt push with allowProtected: true as a non-privileged agent
      await assert.rejects(
        () => registry.executeTool('bridge_git_push', {
          repoPath: workDir,
          remote: 'origin',
          branch: 'main',
          allowProtected: true,
          agentId: 'claude-desktop'
        }, ctx),
        /ProtectedBranchBlocked/
      );
    } finally {
      cleanup();
      try { logger.close(); } catch {}
    }
  });
});
