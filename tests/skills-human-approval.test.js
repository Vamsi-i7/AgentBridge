import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SignedSkillRegistry, SkillSecurityError } from '../src/skills/skill-registry.js';
import { SkillsManager } from '../src/skills/skills-manager.js';

test('SignedSkillRegistry: Strict Human Approval & Anti-Self-Installation Invariants', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-test-'));
  const skillsRoot = path.join(tmpDir, 'skills');
  const lockfilePath = path.join(skillsRoot, 'skills.lock.json');
  fs.mkdirSync(skillsRoot, { recursive: true });

  const manager = new SkillsManager({ skillsRoot, lockfilePath });
  const registry = new SignedSkillRegistry({ skillsManager: manager });

  // Create a sample test skill directory
  const sampleDir = path.join(tmpDir, 'sample-skill');
  fs.mkdirSync(sampleDir, { recursive: true });
  fs.writeFileSync(path.join(sampleDir, 'SKILL.md'), `---
name: sample-skill
description: A sample test skill
permissions: [read:files]
---
# Sample Skill Content
`);

  t.after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  await t.test('1. Propose skill add requires human approval', () => {
    const proposal = registry.proposeSkillAdd(sampleDir);
    assert.strictEqual(proposal.name, 'sample-skill');
    assert.strictEqual(proposal.humanApprovalRequired, true);
    assert.ok(proposal.sha256);
  });

  await t.test('2. Rejects installation without explicit human approval', () => {
    const proposal = registry.proposeSkillAdd(sampleDir);
    assert.throws(() => {
      registry.approveSkillAdd(proposal, { isHumanApproved: false });
    }, (err) => {
      assert.strictEqual(err.code, 'HUMAN_APPROVAL_REQUIRED');
      return true;
    });
  });

  await t.test('3. Agents are strictly forbidden from approving or self-installing skills', () => {
    const proposal = registry.proposeSkillAdd(sampleDir);
    for (const forbiddenActor of ['agent:claude', 'agent:chatgpt', 'gemini-cli', 'claude-desktop']) {
      assert.throws(() => {
        registry.approveSkillAdd(proposal, { isHumanApproved: true, approvedBy: forbiddenActor });
      }, (err) => {
        assert.strictEqual(err.code, 'AGENT_SELF_INSTALL_FORBIDDEN');
        return true;
      });
    }
  });

  await t.test('4. Human approval installs skill successfully', () => {
    const proposal = registry.proposeSkillAdd(sampleDir);
    const result = registry.approveSkillAdd(proposal, { isHumanApproved: true, approvedBy: 'user' });
    assert.strictEqual(result.installed, true);
    assert.strictEqual(result.approvedBy, 'user');
  });

  await t.test('5. Seed skill pending approval blocks loading until approved by user', () => {
    registry.profiles.get('default').add('sample-skill');

    // Manually mark sample-skill as pending-user-approval in lockfile
    const lock = manager.readLockfile();
    const key = Object.keys(lock.skills)[0];
    lock.skills[key].approvalStatus = 'pending-user-approval';
    manager.writeLockfile(lock);

    // Loading must be blocked
    assert.throws(() => {
      registry.loadSkill('sample-skill', { agentId: 'test-agent', agentProfile: 'default' });
    }, (err) => {
      assert.strictEqual(err.code, 'SKILL_PENDING_USER_APPROVAL');
      return true;
    });

    // Agent attempt to approve must fail
    assert.throws(() => {
      registry.approveInstalledSkill('sample-skill', { isHumanApproved: true, approvedBy: 'agent:gemini' });
    }, (err) => {
      assert.strictEqual(err.code, 'AGENT_SELF_INSTALL_FORBIDDEN');
      return true;
    });

    // Human approves via CLI/dashboard
    const appRes = registry.approveInstalledSkill('sample-skill', { isHumanApproved: true, approvedBy: 'user' });
    assert.strictEqual(appRes.approved, true);

    // Now loading succeeds
    const loaded = registry.loadSkill('sample-skill', { agentId: 'test-agent', agentProfile: 'default', callerPermissions: ['read:files'] });
    assert.strictEqual(loaded.status, 'LOADED');
    assert.ok(loaded.content.includes('# Sample Skill Content'));
  });
});
