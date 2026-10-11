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
const manager = new SkillsManager({ bridgeRoot });

const targetName = args.flags.name || args.positional[0];
const targetSource = args.flags.source || null;

if (targetName) {
  const res = manager.verifySkill({ name: targetName, source: targetSource || 'inhouse' });
  if (res.verified) {
    console.log(`[PASS] Skill '${res.key}' matches pinned checksum.`);
    console.log(`  SHA-256: ${res.currentSha256}`);
    console.log(`  Files:   ${res.fileCount}`);
    process.exit(0);
  } else {
    console.error(`[FAIL] Verification failed for '${res.key}': ${res.error || 'Checksum mismatch'}`);
    if (res.expectedSha256) console.error(`  Expected: ${res.expectedSha256}`);
    if (res.currentSha256) console.error(`  Observed: ${res.currentSha256}`);
    process.exit(1);
  }
} else {
  console.log('Verifying all pinned skills against skills.lock.json...');
  const res = manager.verifyAll();
  console.log(`Checked ${res.totalChecked} skills:`);
  for (const s of res.skills) {
    const status = s.verified ? '[PASS]' : '[FAIL]';
    console.log(`  ${status} ${s.key.padEnd(35)} ${s.verified ? s.currentSha256.slice(0, 16) + '...' : s.error}`);
  }
  if (res.allValid) {
    console.log('\nAll skills verified successfully. Integrity intact.');
    process.exit(0);
  } else {
    console.error('\nVerification failed for one or more skills.');
    process.exit(1);
  }
}
