#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SkillsManager } from '../../src/skills/skills-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bridgeRoot = path.resolve(__dirname, '../..');

function parseArgs(args) {
  const parsed = { positional: [], flags: {} };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        parsed.flags[key] = next;
        i++;
      } else {
        parsed.flags[key] = true;
      }
    } else {
      parsed.positional.push(a);
    }
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const targetPath = args.positional[0];

if (!targetPath) {
  console.error('Usage: node scripts/skills/install.js <path-to-skill-directory> [--source inhouse] [--name custom-name] [--overwrite]');
  process.exit(1);
}

const source = args.flags.source || 'inhouse';
const resolvedPath = path.resolve(process.cwd(), targetPath);
const skillName = args.flags.name || path.basename(resolvedPath);
const overwrite = Boolean(args.flags.overwrite);

const manager = new SkillsManager({ bridgeRoot });

try {
  console.log(`Scanning and installing skill '${skillName}' from ${resolvedPath} into source '${source}'...`);
  const result = manager.installSkill({
    source,
    name: skillName,
    directoryPath: resolvedPath,
    overwrite
  });
  console.log('Successfully installed and pinned skill:');
  console.log(`  Key:        ${result.key}`);
  console.log(`  Version:    ${result.version}`);
  console.log(`  Risk Tier:  Tier ${result.riskTier}`);
  console.log(`  SHA-256:    ${result.sha256}`);
  console.log(`  Files:      ${result.fileCount}`);
  console.log(`  Path:       ${result.installedPath}`);
  process.exit(0);
} catch (err) {
  console.error(`Installation failed: ${err.message}`);
  process.exit(1);
}
