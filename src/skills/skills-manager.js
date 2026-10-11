import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { scanSkillDirectory, parseFrontmatter, RiskTier } from './scanner.js';

export class SkillsManager {
  constructor(options = {}) {
    const bridgeRoot = options.bridgeRoot || path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
    this.skillsRoot = options.skillsRoot || path.join(bridgeRoot, '.agents', 'skills');
    this.lockfilePath = options.lockfilePath || path.join(this.skillsRoot, 'skills.lock.json');
    this.ensureLayout();
  }

  ensureLayout() {
    if (!fs.existsSync(this.skillsRoot)) {
      fs.mkdirSync(this.skillsRoot, { recursive: true });
    }
    if (!fs.existsSync(this.lockfilePath)) {
      const initialLock = {
        version: '1.0.0',
        updatedAt: new Date().toISOString(),
        skills: {}
      };
      fs.writeFileSync(this.lockfilePath, JSON.stringify(initialLock, null, 2), 'utf8');
    }
  }

  readLockfile() {
    try {
      if (fs.existsSync(this.lockfilePath)) {
        return JSON.parse(fs.readFileSync(this.lockfilePath, 'utf8'));
      }
    } catch {}
    return { version: '1.0.0', updatedAt: new Date().toISOString(), skills: {} };
  }

  writeLockfile(lock) {
    lock.updatedAt = new Date().toISOString();
    fs.writeFileSync(this.lockfilePath, JSON.stringify(lock, null, 2), 'utf8');
  }

  /**
   * Deterministically compute composite SHA-256 hash for a skill directory.
   */
  computeSkillDigest(skillDirPath) {
    const resolvedDir = path.resolve(skillDirPath);
    if (!fs.existsSync(resolvedDir)) {
      throw new Error(`Directory does not exist: ${resolvedDir}`);
    }

    const relFiles = [];
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.name.startsWith('.') && ent.name !== '.agents') continue;
        if (ent.isDirectory()) {
          walk(full);
        } else if (ent.isFile()) {
          relFiles.push(path.relative(resolvedDir, full));
        }
      }
    };
    walk(resolvedDir);
    relFiles.sort();

    const composite = crypto.createHash('sha256');
    for (const rel of relFiles) {
      const content = fs.readFileSync(path.join(resolvedDir, rel));
      composite.update(`${rel}\0${content.length}\0`);
      composite.update(content);
    }

    return {
      sha256: composite.digest('hex'),
      files: relFiles
    };
  }

  /**
   * Discover all skill directories across standard and legacy hierarchies.
   * Returns Map: `key` -> `{ key, source, name, dirPath }`.
   */
  discoverSkillDirs() {
    const discovered = new Map();
    if (!fs.existsSync(this.skillsRoot)) return discovered;

    const entries = fs.readdirSync(this.skillsRoot, { withFileTypes: true });

    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;

      const entPath = path.join(this.skillsRoot, ent.name);
      const isSkillDirect = fs.existsSync(path.join(entPath, 'SKILL.md'));

      if (isSkillDirect) {
        // Direct root placement (e.g. .agents/skills/mcp-builder) -> alias as local/<name>
        const key = `inhouse/${ent.name}`;
        discovered.set(key, { key, source: 'inhouse', name: ent.name, dirPath: entPath });
        discovered.set(`local/${ent.name}`, { key: `local/${ent.name}`, source: 'local', name: ent.name, dirPath: entPath });
      } else {
        // Subdirectory source hierarchy (e.g. .agents/skills/inhouse/bridge-delegation)
        const source = ent.name;
        try {
          const subEntries = fs.readdirSync(entPath, { withFileTypes: true });
          for (const sub of subEntries) {
            if (!sub.isDirectory() || sub.name.startsWith('.')) continue;
            const subPath = path.join(entPath, sub.name);
            if (fs.existsSync(path.join(subPath, 'SKILL.md'))) {
              const key = `${source}/${sub.name}`;
              discovered.set(key, { key, source, name: sub.name, dirPath: subPath });
            }
          }
        } catch {}
      }
    }

    return discovered;
  }

  /**
   * List installed skills with filtering and pagination.
   */
  listSkills(options = {}) {
    const { source = null, riskTier = null, limit = 50 } = options;
    const lock = this.readLockfile();
    const discovered = this.discoverSkillDirs();
    const results = [];
    const seen = new Set();

    // Prioritize lockfile entries
    for (const [key, entry] of Object.entries(lock.skills || {})) {
      if (seen.has(entry.name)) continue;
      if (source && entry.source !== source) continue;
      if (riskTier && entry.riskTier !== riskTier) continue;

      seen.add(entry.name);
      results.push({
        key,
        name: entry.name,
        source: entry.source,
        version: entry.version || '1.0.0',
        author: entry.author || 'Unknown',
        license: entry.license || 'MIT',
        riskTier: entry.riskTier || RiskTier.TIER_A,
        description: entry.description || '',
        sha256: entry.sha256,
        installedAt: entry.installedAt
      });
    }

    // Discover any unpinned on-disk skills
    for (const [key, disc] of discovered.entries()) {
      if (seen.has(disc.name)) continue;
      if (source && disc.source !== source) continue;

      try {
        const skillMd = fs.readFileSync(path.join(disc.dirPath, 'SKILL.md'), 'utf8');
        const { frontmatter } = parseFrontmatter(skillMd);
        const itemTier = frontmatter.riskTier || RiskTier.TIER_A;
        if (riskTier && itemTier !== riskTier) continue;

        seen.add(disc.name);
        results.push({
          key: `${disc.source}/${disc.name}`,
          name: disc.name,
          source: disc.source,
          version: frontmatter.version || '1.0.0',
          author: frontmatter.author || 'Unknown',
          license: frontmatter.license || 'MIT',
          riskTier: itemTier,
          description: frontmatter.description || '',
          sha256: null,
          installedAt: null
        });
      } catch {}
    }

    return results.slice(0, limit);
  }

  /**
   * Retrieve a specific skill's full metadata, SKILL.md body, and file manifest.
   */
  getSkill(options = {}) {
    const { name, source = null } = options;
    if (!name) throw new Error('Skill name is required');

    const discovered = this.discoverSkillDirs();
    let match = null;

    if (source) {
      match = discovered.get(`${source}/${name}`);
    } else {
      for (const disc of discovered.values()) {
        if (disc.name === name) {
          match = disc;
          break;
        }
      }
    }

    if (!match) {
      throw new Error(`Skill not found: '${name}'${source ? ` (source: ${source})` : ''}`);
    }

    const skillMdPath = path.join(match.dirPath, 'SKILL.md');
    const rawMd = fs.readFileSync(skillMdPath, 'utf8');
    const { frontmatter, body } = parseFrontmatter(rawMd);

    const digest = this.computeSkillDigest(match.dirPath);
    const lock = this.readLockfile();
    const lockEntry = lock.skills?.[`${match.source}/${match.name}`] || null;

    return {
      key: `${match.source}/${match.name}`,
      name: match.name,
      source: match.source,
      version: frontmatter.version || lockEntry?.version || '1.0.0',
      author: frontmatter.author || lockEntry?.author || 'Unknown',
      license: frontmatter.license || lockEntry?.license || 'MIT',
      riskTier: frontmatter.riskTier || lockEntry?.riskTier || RiskTier.TIER_A,
      description: frontmatter.description || lockEntry?.description || '',
      content: body,
      rawSkillMd: rawMd,
      sha256: digest.sha256,
      pinnedSha256: lockEntry?.sha256 || null,
      isVerified: Boolean(lockEntry && lockEntry.sha256 === digest.sha256),
      files: digest.files,
      directory: match.dirPath
    };
  }

  /**
   * Safely read a resource file from within a skill directory.
   */
  getSkillResource(options = {}) {
    const { name, source = null, path: relPath } = options;
    if (!name || !relPath) throw new Error('Skill name and resource path are required');

    const skill = this.getSkill({ name, source });
    const fullPath = path.resolve(skill.directory, relPath);

    // Path traversal containment check
    if (!fullPath.startsWith(path.resolve(skill.directory))) {
      throw new Error(`Access denied: path '${relPath}' escapes skill root directory.`);
    }

    if (!fs.existsSync(fullPath)) {
      throw new Error(`Resource '${relPath}' not found in skill '${name}'.`);
    }

    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) {
      throw new Error(`Resource '${relPath}' is not a regular file.`);
    }

    const content = fs.readFileSync(fullPath, 'utf8');
    return {
      skillName: name,
      path: relPath,
      sizeBytes: stat.size,
      content
    };
  }

  /**
   * Search installed skills using multi-field token & BM25-style keyword relevance.
   */
  searchSkills(options = {}) {
    const { query = '', limit = 10, source = null, riskTier = null } = options;
    const clean = (query || '').trim().toLowerCase();
    if (!clean) {
      return this.listSkills({ source, riskTier, limit });
    }

    const tokens = clean.split(/\s+/).filter(Boolean);
    const STOP_WORDS = new Set(['what', 'to', 'do', 'when', 'is', 'a', 'an', 'the', 'in', 'on', 'of', 'for', 'with', 'how', 'and', 'or', 'can', 'i', 'from']);
    const meaningful = tokens.filter(t => !STOP_WORDS.has(t) && t.length > 2);
    const searchTokens = meaningful.length > 0 ? meaningful : tokens;

    const all = this.listSkills({ source, riskTier, limit: 200 });
    const scored = [];

    for (const item of all) {
      let score = 0;
      const nameNorm = item.name.toLowerCase();
      const descNorm = (item.description || '').toLowerCase();

      // Exact match bonus
      if (nameNorm === clean) score += 120;
      if (nameNorm.includes(clean)) score += 60;
      if (descNorm.includes(clean)) score += 30;

      // Token matches
      for (const t of searchTokens) {
        if (nameNorm.includes(t)) score += 25;
        if (descNorm.includes(t)) score += 14;
      }

      // Check skill content for additional context
      try {
        const full = this.getSkill({ name: item.name, source: item.source });
        const contentNorm = (full.content || '').toLowerCase();
        for (const t of searchTokens) {
          if (contentNorm.includes(t)) {
            // Count frequency up to 5
            const regex = new RegExp(`\\b${t.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'g');
            const matches = contentNorm.match(regex);
            const count = matches ? Math.min(matches.length, 5) : 1;
            score += count * 4;
          }
        }
      } catch {}

      if (score > 0) {
        scored.push({ ...item, searchScore: score });
      }
    }

    scored.sort((a, b) => b.searchScore - a.searchScore);
    return scored.slice(0, limit);
  }

  /**
   * Install or pin a skill directory into the platform and update skills.lock.json.
   */
  installSkill(options = {}) {
    const { source = 'inhouse', name, directoryPath, overwrite = false } = options;
    if (!name || !directoryPath) {
      throw new Error('Skill name and directoryPath are required');
    }

    const scanResult = scanSkillDirectory(directoryPath);
    if (!scanResult.valid) {
      throw new Error(`Skill validation failed for '${name}': ${scanResult.violations.join('; ')}`);
    }

    const targetDir = path.join(this.skillsRoot, source, name);
    if (fs.existsSync(targetDir) && !overwrite) {
      throw new Error(`Target directory already exists: ${targetDir}. Pass overwrite=true to replace.`);
    }

    if (path.resolve(directoryPath) !== path.resolve(targetDir)) {
      fs.mkdirSync(path.dirname(targetDir), { recursive: true });
      fs.cpSync(directoryPath, targetDir, { recursive: true });
    }

    const digest = this.computeSkillDigest(targetDir);
    const lock = this.readLockfile();
    const key = `${source}/${name}`;

    lock.skills[key] = {
      name,
      source,
      version: scanResult.metadata.version || '1.0.0',
      author: scanResult.metadata.author || 'Unknown',
      license: scanResult.metadata.license || 'MIT',
      riskTier: scanResult.computedTier,
      description: scanResult.metadata.description || '',
      sha256: digest.sha256,
      installedAt: new Date().toISOString(),
      files: digest.files
    };

    this.writeLockfile(lock);

    return {
      key,
      name,
      source,
      version: scanResult.metadata.version,
      riskTier: scanResult.computedTier,
      sha256: digest.sha256,
      fileCount: digest.files.length,
      installedPath: targetDir
    };
  }

  /**
   * Verify an installed skill's disk contents against skills.lock.json.
   */
  verifySkill(options = {}) {
    const { source = 'inhouse', name } = options;
    const key = `${source}/${name}`;
    const lock = this.readLockfile();
    const entry = lock.skills?.[key];

    if (!entry) {
      return {
        key,
        name,
        source,
        verified: false,
        error: `Skill '${key}' is not pinned in skills.lock.json`
      };
    }

    const skillDir = path.join(this.skillsRoot, source, name);
    if (!fs.existsSync(skillDir)) {
      return {
        key,
        name,
        source,
        verified: false,
        error: `Skill directory missing: ${skillDir}`
      };
    }

    const currentDigest = this.computeSkillDigest(skillDir);
    const matches = currentDigest.sha256 === entry.sha256;

    return {
      key,
      name,
      source,
      verified: matches,
      expectedSha256: entry.sha256,
      currentSha256: currentDigest.sha256,
      fileCount: currentDigest.files.length
    };
  }

  /**
   * Verify all pinned skills in the lockfile.
   */
  verifyAll() {
    const lock = this.readLockfile();
    const results = [];
    let allValid = true;

    for (const [key, entry] of Object.entries(lock.skills || {})) {
      const res = this.verifySkill({ source: entry.source, name: entry.name });
      if (!res.verified) allValid = false;
      results.push(res);
    }

    return {
      allValid,
      totalChecked: results.length,
      skills: results
    };
  }
}
