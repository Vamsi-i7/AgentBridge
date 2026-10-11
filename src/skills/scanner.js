import fs from 'node:fs';
import path from 'node:path';

export const ALLOWED_SPDX_LICENSES = new Set([
  'MIT',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'CC0-1.0',
  'Unlicense'
]);

export const RiskTier = Object.freeze({
  TIER_A: 'A', // Pure documentation & instruction (markdown, templates)
  TIER_B: 'B', // Deterministic scripts (no external network/daemons)
  TIER_C: 'C'  // Network/external scripts or elevated execution
});

const DENY_PATTERNS = [
  {
    category: 'PROMPT_INJECTION',
    pattern: /ignore\s+(?:all\s+)?(?:previous|prior)\s+instructions/i,
    description: 'Attempt to override or disregard prior instructions'
  },
  {
    category: 'SAFETY_BYPASS',
    pattern: /bypass\s+(?:all\s+)?safety\s+(?:rules|guardrails|filters)/i,
    description: 'Attempt to bypass safety rules or guardrails'
  },
  {
    category: 'JAILBREAK',
    pattern: /(?:you\s+are\s+now\s+in\s+DAN\s+mode|jailbreak\s+prompt)/i,
    description: 'Known adversarial jailbreak signature'
  },
  {
    category: 'REMOTE_CODE_EXECUTION',
    pattern: /(?:curl|wget)\s+[^\n|&;]+\|\s*(?:ba|z)?sh/i,
    description: 'Unverified remote script piped directly into shell'
  },
  {
    category: 'DANGEROUS_DESTRUCTION',
    pattern: /rm\s+-(?:rf|fr)\s+\/(?:\s|$)/i,
    description: 'Destructive root-level file removal command'
  },
  {
    category: 'PERMISSIVE_CHMOD',
    pattern: /chmod\s+(?:-R\s+)?777/i,
    description: 'Overly permissive file permissions assignment'
  },
  {
    category: 'FORK_BOMB',
    pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    description: 'Denial of service fork bomb'
  },
  {
    category: 'OBFUSCATED_EVAL',
    pattern: /\beval\s*\(\s*(?:atob|Buffer\.from)\b/i,
    description: 'Obfuscated base64 payload evaluation'
  },
  {
    category: 'OBFUSCATED_EXEC_PYTHON',
    pattern: /\bexec\s*\(\s*base64\.b64decode\b/i,
    description: 'Obfuscated Python base64 exec evaluation'
  },
  {
    category: 'CREDENTIAL_LEAK_SSH',
    pattern: /(?:~|\/root|\/home\/[^\s\/'"]+|\/Users\/[^\s\/'"]+)\/\.ssh(?:\/|$)/,
    description: 'Reference or access to protected SSH directory'
  },
  {
    category: 'CREDENTIAL_LEAK_ENV',
    pattern: /(?:~|\/root|\/home\/[^\s\/'"]+|\/Users\/[^\s\/'"]+)\/\.env(?:\.(?:local|production|development))?(?:\s|$)/,
    description: 'Reference or access to root environment secret files'
  },
  {
    category: 'CREDENTIAL_LEAK_KEYCHAIN',
    pattern: /\/Library\/Keychains(?:\/|$)/,
    description: 'Reference or access to macOS Keychain store'
  },
  {
    category: 'CREDENTIAL_LEAK_AWS',
    pattern: /(?:~|\/root|\/home\/[^\s\/'"]+|\/Users\/[^\s\/'"]+)\/\.aws(?:\/|$)/,
    description: 'Reference or access to AWS credentials'
  }
];

const NETWORK_PATTERNS = [
  /\b(?:fetch|axios|superagent|urllib|requests\.(?:get|post|put|delete))\b/i,
  /\bhttp(?:s)?:\/\/[^\s'")]+/i,
  /\bsocket\.connect\b/i
];

/**
 * Parse YAML frontmatter from markdown content.
 */
export function parseFrontmatter(content) {
  if (!content || typeof content !== 'string') {
    return { frontmatter: {}, body: '' };
  }

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const rawYaml = match[1];
  const body = match[2];
  const frontmatter = {};

  for (const line of rawYaml.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      const key = trimmed.slice(0, colonIdx).trim();
      let val = trimmed.slice(colonIdx + 1).trim();
      // Strip outer quotes if any
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      frontmatter[key] = val;
    }
  }

  return { frontmatter, body };
}

/**
 * Static security and license scanner for an agent skill directory.
 */
export function scanSkillDirectory(skillDirPath) {
  const violations = [];
  const warnings = [];
  const filesScanned = [];

  const resolvedDir = path.resolve(skillDirPath);
  if (!fs.existsSync(resolvedDir)) {
    return {
      valid: false,
      skillName: path.basename(resolvedDir),
      metadata: null,
      files: [],
      riskTier: RiskTier.TIER_A,
      licenseAllowed: false,
      violations: [`Skill directory does not exist: ${resolvedDir}`],
      warnings: []
    };
  }

  const skillMdPath = path.join(resolvedDir, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) {
    violations.push('Missing mandatory SKILL.md file in skill root');
  }

  let metadata = {
    name: path.basename(resolvedDir),
    description: '',
    version: '1.0.0',
    author: 'Unknown',
    license: 'MIT',
    riskTier: RiskTier.TIER_A
  };

  if (fs.existsSync(skillMdPath)) {
    try {
      const rawMd = fs.readFileSync(skillMdPath, 'utf8');
      const { frontmatter } = parseFrontmatter(rawMd);
      metadata = {
        name: frontmatter.name || path.basename(resolvedDir),
        description: frontmatter.description || '',
        version: frontmatter.version || '1.0.0',
        author: frontmatter.author || 'Unknown',
        license: frontmatter.license || 'MIT',
        riskTier: frontmatter.riskTier || RiskTier.TIER_A,
        ...frontmatter
      };
      if (!frontmatter.name) {
        warnings.push('SKILL.md frontmatter missing explicit "name" field; defaulted to directory name');
      }
      if (!frontmatter.description) {
        violations.push('SKILL.md frontmatter missing mandatory "description" field');
      }
    } catch (err) {
      violations.push(`Failed to read SKILL.md: ${err.message}`);
    }
  }

  // License verification
  const normalizedLicense = (metadata.license || '').trim();
  const licenseAllowed = ALLOWED_SPDX_LICENSES.has(normalizedLicense);
  if (!licenseAllowed) {
    violations.push(`License '${normalizedLicense}' is not in the approved SPDX allowlist (${Array.from(ALLOWED_SPDX_LICENSES).join(', ')})`);
  }

  // Recursively collect all files within skill directory
  const realDir = fs.realpathSync(resolvedDir);
  const collectFiles = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      const fullPath = path.join(dir, ent.name);
      // Symlink containment check
      const realPath = fs.realpathSync(fullPath);
      if (!realPath.startsWith(realDir)) {
        violations.push(`Symlink path traversal outside skill directory: ${ent.name}`);
        continue;
      }
      if (ent.name.startsWith('.') && ent.name !== '.agents') {
        violations.push(`Disallowed hidden/dotfile within skill: ${ent.name}`);
        continue;
      }
      if (ent.isDirectory()) {
        collectFiles(fullPath);
      } else if (ent.isFile()) {
        filesScanned.push(path.relative(resolvedDir, fullPath));
      }
    }
  };

  try {
    collectFiles(resolvedDir);
  } catch (err) {
    violations.push(`Failed reading skill directory structure: ${err.message}`);
  }

  let hasExecutableScripts = false;
  let hasNetworkScripts = false;

  const scriptExtensions = new Set(['.py', '.js', '.mjs', '.cjs', '.ts', '.sh', '.bash', '.rb']);

  for (const relFile of filesScanned) {
    const ext = path.extname(relFile).toLowerCase();
    const fullPath = path.join(resolvedDir, relFile);

    if (scriptExtensions.has(ext)) {
      hasExecutableScripts = true;
    }

    try {
      const content = fs.readFileSync(fullPath, 'utf8');

      // Check deny patterns
      for (const rule of DENY_PATTERNS) {
        if (rule.pattern.test(content)) {
          violations.push(`[${rule.category}] File '${relFile}' violates security rule: ${rule.description}`);
        }
      }

      // Check network patterns for Tier determination
      if (scriptExtensions.has(ext)) {
        for (const netPattern of NETWORK_PATTERNS) {
          if (netPattern.test(content)) {
            hasNetworkScripts = true;
            break;
          }
        }
      }
    } catch (err) {
      warnings.push(`Could not read file '${relFile}' as text: ${err.message}`);
    }
  }

  // Compute actual risk tier
  let computedTier = RiskTier.TIER_A;
  if (hasNetworkScripts) {
    computedTier = RiskTier.TIER_C;
  } else if (hasExecutableScripts) {
    computedTier = RiskTier.TIER_B;
  }

  // Ensure declared tier matches or exceeds computed tier
  if (metadata.riskTier === RiskTier.TIER_A && computedTier !== RiskTier.TIER_A) {
    violations.push(`Skill declared as Risk Tier A but contains executable scripts (computed: Tier ${computedTier})`);
  }

  return {
    valid: violations.length === 0,
    skillName: metadata.name,
    metadata,
    files: filesScanned,
    computedTier,
    licenseAllowed,
    violations,
    warnings
  };
}
