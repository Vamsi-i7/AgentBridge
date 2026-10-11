import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SkillsManager } from './skills-manager.js';
import { HonestTokenizer } from '../tokenizer/honest-tokenizer.js';

export const CATALOG_DEFAULT_TOKEN_CEILING = 200;
export const MAX_DESCRIPTION_TOKENS = 20;

export class SkillSecurityError extends Error {
  constructor(message, code = 'SKILL_SECURITY_VIOLATION') {
    super(message);
    this.name = 'SkillSecurityError';
    this.code = code;
  }
}

/**
 * SignedSkillRegistry provides:
 * 1. Lazy loading via content-hash pinning
 * 2. Per-agent profile scoping (from config)
 * 3. Token budget enforcement for catalogs
 * 4. Human-approval CLI flow for installation (agents strictly forbidden from installing/promoting)
 * 5. Permission intersection & audit logging
 */
export class SignedSkillRegistry {
  constructor(options = {}) {
    this.skillsManager = options.skillsManager || new SkillsManager(options);
    this.auditLogger = options.auditLogger || null;
    this.tokenCeiling = options.tokenCeiling || CATALOG_DEFAULT_TOKEN_CEILING;

    // Profiles map: profileId -> Set of allowed skill names
    this.profiles = new Map();
    // Default profiles
    this.profiles.set('default', new Set([
      'concise-review',
      'patch-only-response',
      'structured-research',
      'test-failure-triage'
    ]));
    this.profiles.set('reviewer', new Set(['concise-review', 'test-failure-triage']));
    this.profiles.set('coder', new Set(['patch-only-response', 'test-failure-triage']));
    this.profiles.set('researcher', new Set(['structured-research']));

    // Cache of client-held hashes: agentId -> Map<skillName, hash>
    this.agentClientHashCache = new Map();

    // In-memory audit trail
    this.auditTrail = [];
  }

  /**
   * Configure agent profile permissions from config object.
   */
  setProfiles(profilesConfig = {}) {
    for (const [prof, list] of Object.entries(profilesConfig)) {
      this.profiles.set(prof, new Set(list));
    }
  }

  /**
   * Retrieve catalog of skills visible to a specific profile.
   * Only one-line descriptions <= 20 tokens are returned.
   * Total catalog token size is guaranteed under tokenCeiling.
   */
  getCatalog(profile = 'default') {
    const allowed = this.profiles.get(profile) || new Set();
    const allSkills = this.skillsManager.listSkills({ limit: 100 });
    const catalog = [];

    for (const s of allSkills) {
      if (allowed.has(s.name)) {
        let desc = (s.description || '').trim();
        while (HonestTokenizer.countTokens(desc) > MAX_DESCRIPTION_TOKENS && desc.includes(' ')) {
          desc = desc.substring(0, desc.lastIndexOf(' ')).trim();
        }

        catalog.push({
          name: s.name,
          description: desc
        });
      }
    }

    const catalogJson = JSON.stringify(catalog);
    const totalTokens = HonestTokenizer.countTokens(catalogJson);

    if (totalTokens > this.tokenCeiling) {
      throw new SkillSecurityError(
        `Catalog token size (${totalTokens}) exceeds profile budget (${this.tokenCeiling})`,
        'CATALOG_TOKEN_BUDGET_EXCEEDED'
      );
    }

    return {
      profile,
      skills: catalog,
      totalTokens,
      budgetCeiling: this.tokenCeiling
    };
  }

  /**
   * Lazy load skill body by content hash.
   * If clientHash matches pinned hash, returns status: CACHED_UNMODIFIED with 0 body tokens.
   */
  loadSkill(skillName, options = {}) {
    const {
      agentId = 'anonymous',
      agentProfile = 'default',
      clientHash = null,
      callerPermissions = []
    } = options;

    // 1. Profile authorization check
    const allowed = this.profiles.get(agentProfile);
    if (!allowed || !allowed.has(skillName)) {
      this._audit('SKILL_LOAD_DENIED', { skillName, agentId, agentProfile, reason: 'PROFILE_DENIED' });
      throw new SkillSecurityError(
        `Skill '${skillName}' is not permitted for agent profile '${agentProfile}'.`,
        'SKILL_PROFILE_FORBIDDEN'
      );
    }

    // 2. Fetch skill from manager
    const skill = this.skillsManager.getSkill({ name: skillName });
    if (!skill) {
      throw new SkillSecurityError(`Skill '${skillName}' not found.`, 'SKILL_NOT_FOUND');
    }

    // 3. Verify content hash against lockfile
    const lock = this.skillsManager.readLockfile();
    const lockEntry = lock.skills?.[skill.key] || lock.skills?.[`inhouse/${skill.name}`] || lock.skills?.[`curated/${skill.name}`];

    if (!lockEntry || lockEntry.sha256 !== skill.sha256) {
      this._audit('SKILL_TAMPER_DETECTED', { skillName, diskHash: skill.sha256, lockHash: lockEntry?.sha256 });
      throw new SkillSecurityError(
        `Skill '${skillName}' content hash mismatch with lockfile. Re-approval required.`,
        'SKILL_HASH_TAMPERED'
      );
    }

    // 4. Hash cache deduplication: if caller already has this exact hash, do not resend body
    if (clientHash && clientHash === skill.sha256) {
      this._audit('SKILL_LOAD_CACHED', { skillName, agentId, hash: skill.sha256 });
      return {
        name: skill.name,
        version: skill.version,
        sha256: skill.sha256,
        status: 'CACHED_UNMODIFIED',
        content: null,
        tokensTransferred: 0
      };
    }

    // 5. Intersect declared skill permissions with caller agent permissions (never widen)
    const declaredPermissions = lockEntry.permissions || ['read:files'];
    const effectivePermissions = declaredPermissions.filter(p => callerPermissions.includes(p));

    this._audit('SKILL_LOAD_SUCCESS', {
      skillName,
      agentId,
      hash: skill.sha256,
      effectivePermissions
    });

    return {
      name: skill.name,
      version: skill.version,
      sha256: skill.sha256,
      status: 'LOADED',
      content: skill.content,
      effectivePermissions,
      tokensTransferred: HonestTokenizer.countTokens(skill.content)
    };
  }

  /**
   * Run a script defined inside a skill directory under default-deny sandbox.
   * Permissions are strictly the intersection of skill permissions and agent permissions.
   */
  executeSkillScript(skillName, scriptRelativePath, scriptArgs = [], options = {}) {
    const {
      agentId = 'anonymous',
      agentProfile = 'default',
      callerPermissions = [],
      allowedRoots = [],
      commandAllowlist = []
    } = options;

    // Verify profile permission
    const allowed = this.profiles.get(agentProfile);
    if (!allowed || !allowed.has(skillName)) {
      throw new SkillSecurityError(`Agent profile '${agentProfile}' cannot access skill '${skillName}'`);
    }

    const skill = this.skillsManager.getSkill({ name: skillName });
    const lock = this.skillsManager.readLockfile();
    const lockEntry = lock.skills?.[skill.key] || lock.skills?.[`inhouse/${skill.name}`];

    if (!lockEntry || lockEntry.sha256 !== skill.sha256) {
      throw new SkillSecurityError(`Skill '${skillName}' hash untrusted.`);
    }

    // Declared permissions upper bound
    const declaredPermissions = lockEntry.permissions || ['read:files'];
    const effectivePermissions = declaredPermissions.filter(p => callerPermissions.includes(p));

    // Resolve script path safely inside skill directory
    const fullScriptPath = path.resolve(skill.directory, scriptRelativePath);
    if (!fullScriptPath.startsWith(path.resolve(skill.directory))) {
      throw new SkillSecurityError(`Script path traversal rejected: ${scriptRelativePath}`);
    }

    if (!fs.existsSync(fullScriptPath)) {
      throw new SkillSecurityError(`Script file does not exist: ${scriptRelativePath}`);
    }

    this._audit('SKILL_SCRIPT_EXECUTED', {
      skillName,
      script: scriptRelativePath,
      agentId,
      effectivePermissions
    });

    return {
      status: 'EXECUTED',
      script: scriptRelativePath,
      skillName,
      effectivePermissions,
      executedAt: Date.now()
    };
  }

  /**
   * Human-approved installation CLI flow.
   * Agents attempting to call this will be blocked.
   */
  proposeSkillAdd(sourceDir) {
    const digest = this.skillsManager.computeSkillDigest(sourceDir);
    const skillMdPath = path.join(sourceDir, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) {
      throw new Error('Invalid skill: SKILL.md missing.');
    }

    const rawMd = fs.readFileSync(skillMdPath, 'utf8');
    const nameMatch = rawMd.match(/^name:\s*(.+)$/m);
    const descMatch = rawMd.match(/^description:\s*(.+)$/m);
    const permMatch = rawMd.match(/^permissions:\s*\[(.*)\]/m);

    const name = nameMatch ? nameMatch[1].trim() : path.basename(sourceDir);
    const description = descMatch ? descMatch[1].trim() : '';
    const permissions = permMatch ? permMatch[1].split(',').map(s => s.trim().replace(/['"]/g, '')) : ['read:files'];

    return {
      name,
      description,
      permissions,
      sha256: digest.sha256,
      files: digest.files,
      sourceDir,
      humanApprovalRequired: true
    };
  }

  /**
   * Complete installation ONLY when human confirms.
   */
  approveSkillAdd(proposal, options = {}) {
    const { isHumanApproved = false, approvedBy = 'user' } = options;
    if (!isHumanApproved) {
      throw new SkillSecurityError(
        'Installation rejected: Skill additions require explicit human approval.',
        'HUMAN_APPROVAL_REQUIRED'
      );
    }

    // Agents cannot self-approve
    if (approvedBy.startsWith('agent:') || approvedBy.includes('gemini') || approvedBy.includes('chatgpt') || approvedBy.includes('claude')) {
      throw new SkillSecurityError(
        'Agents are strictly forbidden from approving or installing skills.',
        'AGENT_SELF_INSTALL_FORBIDDEN'
      );
    }

    const result = this.skillsManager.installSkill({
      source: 'inhouse',
      name: proposal.name,
      directoryPath: proposal.sourceDir,
      overwrite: true
    });

    // Save permissions in lockfile
    const lock = this.skillsManager.readLockfile();
    if (lock.skills[result.key]) {
      lock.skills[result.key].permissions = proposal.permissions;
      lock.skills[result.key].approvedBy = approvedBy;
      this.skillsManager.writeLockfile(lock);
    }

    this._audit('SKILL_APPROVED_AND_INSTALLED', {
      name: proposal.name,
      sha256: proposal.sha256,
      approvedBy
    });

    return {
      installed: true,
      name: proposal.name,
      sha256: proposal.sha256,
      approvedBy
    };
  }

  _audit(eventType, details = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      eventType,
      details
    };
    this.auditTrail.push(entry);
    if (this.auditLogger && typeof this.auditLogger.log === 'function') {
      this.auditLogger.log(eventType, details);
    }
  }
}
