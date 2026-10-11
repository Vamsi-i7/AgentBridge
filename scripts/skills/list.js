#!/usr/bin/env node
import { SkillsManager } from '../../src/skills/skills-manager.js';

function parseArgs(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    }
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));
const manager = new SkillsManager();

const skills = manager.listSkills({
  source: flags.source || null,
  riskTier: flags.tier || null,
  limit: Number(flags.limit) || 100
});

console.log(`Found ${skills.length} skills:\n`);
console.log(
  'NAME'.padEnd(30) +
  'SOURCE'.padEnd(12) +
  'TIER'.padEnd(8) +
  'LICENSE'.padEnd(14) +
  'VERSION'.padEnd(10) +
  'DESCRIPTION'
);
console.log('-'.repeat(100));

for (const s of skills) {
  const desc = s.description.length > 35 ? s.description.slice(0, 32) + '...' : s.description;
  console.log(
    s.name.padEnd(30) +
    s.source.padEnd(12) +
    (`Tier ${s.riskTier}`).padEnd(8) +
    s.license.padEnd(14) +
    s.version.padEnd(10) +
    desc
  );
}
