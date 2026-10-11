import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { SignedSkillRegistry, SkillSecurityError, CATALOG_DEFAULT_TOKEN_CEILING } from '../src/skills/skill-registry.js';
import { SkillsManager } from '../src/skills/skills-manager.js';
import { HonestTokenizer } from '../src/tokenizer/honest-tokenizer.js';

test('Mission G: Signed, Lazy-Loaded, Default-Deny Skill Registry Suite [TEST-PROVEN]', async (t) => {
  const testSkillsRoot = path.join(process.cwd(), '.agents', 'skills');
  const skillsManager = new SkillsManager({ skillsRoot: testSkillsRoot });
  const registry = new SignedSkillRegistry({ skillsManager });

  // 1. Catalog budget and profile scoping
  await t.test('1. Catalog enforces <= 200 token budget and one-line descriptions <= 20 tokens', () => {
    const catalogRes = registry.getCatalog('default');
    assert.ok(catalogRes.skills.length >= 4, 'Should contain seed skills');
    assert.ok(catalogRes.totalTokens <= CATALOG_DEFAULT_TOKEN_CEILING, `Catalog tokens (${catalogRes.totalTokens}) must be <= ${CATALOG_DEFAULT_TOKEN_CEILING}`);

    for (const skill of catalogRes.skills) {
      const descTokens = HonestTokenizer.countTokens(skill.description);
      assert.ok(descTokens <= 20, `Skill ${skill.name} description exceeds 20 tokens (${descTokens})`);
      // Crucial: body is NEVER leaked in the catalog
      assert.equal(skill.content, undefined);
    }
  });

  await t.test('2. Per-agent profile scoping restricts visible skills and access', () => {
    const researcherCatalog = registry.getCatalog('researcher');
    const skillNames = researcherCatalog.skills.map(s => s.name);
    assert.ok(skillNames.includes('structured-research'));
    assert.ok(!skillNames.includes('patch-only-response'), 'Researcher profile must not see coder skills');

    // Attempting to load unpermitted skill throws security error
    assert.throws(() => {
      registry.loadSkill('patch-only-response', { agentProfile: 'researcher' });
    }, /not permitted for agent profile/);
  });

  // 3. Lazy loading and hash cache deduplication
  await t.test('3. Lazy loading serves body on turn 1 and 0-token CACHED_UNMODIFIED on turn 2', () => {
    // Approve skill first per human approval security requirement
    registry.approveInstalledSkill('concise-review', { isHumanApproved: true, approvedBy: 'user' });
    // Turn 1: load body
    const turn1 = registry.loadSkill('concise-review', {
      agentId: 'reviewer-agent',
      agentProfile: 'reviewer',
      callerPermissions: ['read:files']
    });

    assert.equal(turn1.status, 'LOADED');
    assert.ok(turn1.content.includes('Concise Review Skill'));
    assert.ok(turn1.sha256);
    assert.ok(turn1.tokensTransferred > 0);

    // Turn 2: agent provides clientHash
    const turn2 = registry.loadSkill('concise-review', {
      agentId: 'reviewer-agent',
      agentProfile: 'reviewer',
      clientHash: turn1.sha256,
      callerPermissions: ['read:files']
    });

    assert.equal(turn2.status, 'CACHED_UNMODIFIED');
    assert.equal(turn2.content, null);
    assert.equal(turn2.tokensTransferred, 0, 'Cached skill load must transfer 0 tokens');
  });

  // 4. Tamper detection and hash pinning
  await t.test('4. Modified skill is rejected until human re-approves', () => {
    // Create a mock skills manager with a temporary skill
    const tempSkillDir = path.join(process.cwd(), 'scratch', 'tamper-test-skill');
    fs.mkdirSync(tempSkillDir, { recursive: true });
    fs.writeFileSync(path.join(tempSkillDir, 'SKILL.md'), `---
name: tamper-test-skill
description: Temporary skill to test tampering detection.
version: 1.0.0
permissions: ["read:files"]
---
Initial content.
`, 'utf8');

    // Human installs it
    const proposal = registry.proposeSkillAdd(tempSkillDir);
    registry.approveSkillAdd(proposal, { isHumanApproved: true, approvedBy: 'user' });

    // Enable for default profile
    registry.profiles.get('default').add('tamper-test-skill');

    // First load succeeds
    const loaded = registry.loadSkill('tamper-test-skill', { agentProfile: 'default', callerPermissions: ['read:files'] });
    assert.equal(loaded.status, 'LOADED');

    // Tamper with disk contents directly (simulating supply-chain or unauthorized edit)
    const installedPath = path.join(testSkillsRoot, 'inhouse', 'tamper-test-skill', 'SKILL.md');
    fs.appendFileSync(installedPath, '\nMalicious injected code.');

    // Attempting to load tampered skill MUST throw SKILL_HASH_TAMPERED
    assert.throws(() => {
      registry.loadSkill('tamper-test-skill', { agentProfile: 'default' });
    }, /content hash mismatch/);

    // Clean up
    fs.rmSync(installedPath, { recursive: true, force: true });
    fs.rmSync(tempSkillDir, { recursive: true, force: true });
  });

  // 5. Agent self-installation is strictly forbidden
  await t.test('5. Agent self-installation or promotion is rejected', () => {
    const proposal = {
      name: 'agent-exploit-skill',
      sourceDir: '/tmp/fake',
      permissions: ['execute:all'],
      sha256: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890'
    };

    // Agent attempts to approve
    assert.throws(() => {
      registry.approveSkillAdd(proposal, { isHumanApproved: true, approvedBy: 'gemini-agent' });
    }, /Agents are strictly forbidden from approving or installing skills/);

    // No approval flag
    assert.throws(() => {
      registry.approveSkillAdd(proposal, { isHumanApproved: false, approvedBy: 'user' });
    }, /Skill additions require explicit human approval/);
  });

  // 6. Permission intersection: never exceeds agent's permissions
  await t.test('6. Skill permissions are intersected with agent permissions (never widened)', () => {
    // Approve skill first per human approval security requirement
    registry.approveInstalledSkill('test-failure-triage', { isHumanApproved: true, approvedBy: 'user' });
    // test-failure-triage declares ["read:files", "execute:tests"]
    // Agent only has ["read:files"]
    const loadResult = registry.loadSkill('test-failure-triage', {
      agentId: 'sandboxed-agent',
      agentProfile: 'default',
      callerPermissions: ['read:files'] // Missing execute:tests
    });

    assert.deepEqual(loadResult.effectivePermissions, ['read:files']);
    assert.ok(!loadResult.effectivePermissions.includes('execute:tests'), 'Agent permissions must not widen');
  });

  // 7. Audit log verification
  await t.test('7. Skill registry maintains audit trail for all operations', () => {
    const events = registry.auditTrail.map(e => e.eventType);
    assert.ok(events.includes('SKILL_LOAD_SUCCESS'));
    assert.ok(events.includes('SKILL_LOAD_CACHED'));
  });
});
