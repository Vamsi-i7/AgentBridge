#!/usr/bin/env node
import { STABLE_PROTOCOL_INSTRUCTIONS } from '../../src/protocol/stable-protocol.js';

const agent = process.argv[2] || 'all';

console.log('='.repeat(80));
console.log('AGENT BRIDGE — BYTE-STABLE AGENT CUSTOM INSTRUCTIONS');
console.log('='.repeat(80));
console.log('\nCopy and paste the exact text below into your agent custom instructions / system prompt:');
console.log('(Do not add pleasantries, greetings, or whitespace modifications)\n');
console.log('--- BEGIN SNIPPET ---');
console.log(STABLE_PROTOCOL_INSTRUCTIONS);
console.log('--- END SNIPPET ---\n');
console.log('Why this is byte-stable:');
console.log('- Fixed prefix ensures maximum prompt-caching hit rates on providers supporting prefix caching.');
console.log('- Two-phase return delivers full result via authenticated bridge_submit_task_result tool.');
console.log('- Single checkmark (✓) in chat ensures zero token waste and zero duplicate answers in UI.');
console.log('='.repeat(80));
