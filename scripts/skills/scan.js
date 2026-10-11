#!/usr/bin/env node
import path from 'node:path';
import { scanSkillDirectory } from '../../src/skills/scanner.js';
import { SkillsManager } from '../../src/skills/skills-manager.js';

const target = process.argv[2];

if (!target) {
  console.log('Scanning all installed skills across .agents/skills...');
  const manager = new SkillsManager();
  const discovered = manager.discoverSkillDirs();
  let failCount = 0;

  for (const [key, item] of discovered.entries()) {
    if (key.startsWith('local/')) continue;
    const res = scanSkillDirectory(item.dirPath);
    const status = res.valid ? '[PASS]' : '[FAIL]';
    console.log(`${status} ${key.padEnd(35)} Tier: ${res.computedTier} License: ${res.metadata.license}`);
    if (!res.valid) {
      failCount++;
      for (const v of res.violations) {
        console.error(`      -> VIOLATION: ${v}`);
      }
    }
  }

  if (failCount > 0) {
    console.error(`\nScan finished with ${failCount} failing skill(s).`);
    process.exit(1);
  } else {
    console.log('\nAll scanned skills passed security and license checks.');
    process.exit(0);
  }
} else {
  const resolved = path.resolve(process.cwd(), target);
  console.log(`Scanning target skill directory: ${resolved}`);
  const res = scanSkillDirectory(resolved);

  console.log('Scan Results:');
  console.log(`  Name:           ${res.skillName}`);
  console.log(`  Valid:          ${res.valid}`);
  console.log(`  Computed Tier:  Tier ${res.computedTier}`);
  console.log(`  License:        ${res.metadata?.license} (${res.licenseAllowed ? 'Approved SPDX' : 'DISALLOWED'})`);
  console.log(`  Files Scanned:  ${res.files.length}`);

  if (res.warnings.length > 0) {
    console.log('\nWarnings:');
    for (const w of res.warnings) console.log(`  - ${w}`);
  }

  if (res.violations.length > 0) {
    console.error('\nViolations:');
    for (const v of res.violations) console.error(`  - ${v}`);
    process.exit(1);
  }

  console.log('\nNo security violations detected. Skill is safe for platform execution.');
  process.exit(0);
}
