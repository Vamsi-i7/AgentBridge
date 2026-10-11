#!/usr/bin/env node
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

console.log('========================================================================');
console.log('        AGENT BRIDGE SHIP-READY VERIFICATION SUITE (`verify`)           ');
console.log('========================================================================\n');

function runStep(name, cmd) {
  console.log(`▶ Running: ${name}...`);
  const t0 = Date.now();
  try {
    execSync(cmd, { cwd: REPO_ROOT, stdio: 'inherit' });
    const ms = Date.now() - t0;
    console.log(`✔ ${name} PASSED (${ms}ms)\n`);
  } catch (err) {
    console.error(`\n✖ ${name} FAILED!`);
    process.exit(1);
  }
}

// 1. Dependency Security Audit
runStep('1. Dependency Vulnerability Audit', 'npm audit');

// 2. Production Reachability Tracing
runStep('2. Production Reachability Check', 'node scripts/verify-reachability.js');

// 3. Authorization Matrix & Security Boundaries
runStep('3. Authorization Matrix Suite', 'node tests/authorization-matrix.test.js');

// 4. 10 Key Security Invariant Mutation Tests
runStep('4. Security Invariant Mutation Checks', 'node tests/mutation-invariants.test.js');

// 5. Offline Protocol Fuzzing
runStep('5. Offline Protocol & Envelope Fuzzing', 'node tests/fuzz-protocol.test.js');

// 6. Crash Recovery Real Process-Kill Test
runStep('6. Real Process-Kill Crash Recovery (SIGKILL)', 'node tests/crash-recovery-kill9.test.js');

// 7. Route Evidence Honesty & Completion Tiers
runStep('7. Route Evidence Honesty Suite', 'node tests/route-evidence-honesty.test.js');

// 8. Honest Token & Context Benchmarking
runStep('8. Honest Collaboration Token Benchmark', 'node scripts/bench/realistic-collaboration-benchmark.js');

// 9. UI Poll Cost Measurement Guard
runStep('9. UI Polling Cost Measurement Guard', 'node scripts/bench/ui-poll-cost-measurement.js');

// 10. Core Regression & Feature Test Suite
runStep('10. Core Verification & Regression Suite', 'node tests/verification-recovery.test.js');

console.log('========================================================================');
console.log('  🎉 ALL AGENT BRIDGE VERIFICATION GATES PASSED! SYSTEM IS SHIP-READY   ');
console.log('========================================================================');
process.exit(0);
