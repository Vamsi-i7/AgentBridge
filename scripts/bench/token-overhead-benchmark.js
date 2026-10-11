/**
 * Honest Token Overhead Benchmark (Step 8)
 *
 * Measures bridge overhead versus a manual copy-paste of raw body:
 * Cases:
 * 1. 200-token answer
 * 2. 2,000-token answer
 * 3. 20,000-token answer
 *
 * Tokenizer: HonestTokenizer (cl100k_base regex BPE segmenter modeling GPT-4 / Claude).
 * 
 * Reports:
 * - Tool schema tokens (communication profile vs full profile)
 * - Protocol prefix tokens (byte-stable prefix)
 * - Envelope tokens (header / digest + ref)
 * - Extra chat reply tokens (1 token ack with alreadyDisplayed: true vs full retype)
 * - Overhead percentage vs 5% target
 */

import { ToolRegistry } from '../../src/tool-registry.js';
import { STABLE_PROTOCOL_INSTRUCTIONS } from '../../src/protocol/stable-protocol.js';
import { formatCompactResultEnvelope, INLINE_BODY_MAX_BYTES } from '../../src/protocol/compact-envelope.js';
import { ContentAddressedStore } from '../../src/artifacts/content-addressed-store.js';
import { HonestTokenizer } from '../../src/tokenizer/honest-tokenizer.js';

export function runTokenOverheadBenchmark() {
  const registry = new ToolRegistry();
  const allDefs = registry.getToolDefinitions('all');
  const commDefs = registry.getToolDefinitions('communication');

  const allSchemaJson = JSON.stringify(allDefs);
  const commSchemaJson = JSON.stringify(commDefs);

  const allSchemaTokens = HonestTokenizer.countTokens(allSchemaJson);
  const commSchemaTokens = HonestTokenizer.countTokens(commSchemaJson);
  const protocolPrefixTokens = HonestTokenizer.countTokens(STABLE_PROTOCOL_INSTRUCTIONS);

  const testCases = [
    { name: '200-Token Answer', targetTokens: 200 },
    { name: '2,000-Token Answer', targetTokens: 2000 },
    { name: '20,000-Token Answer', targetTokens: 20000 }
  ];

  const cas = new ContentAddressedStore();
  const results = [];

  for (const tc of testCases) {
    const rawBody = HonestTokenizer.generateTextOfTokenLength(tc.targetTokens);
    const rawTokens = HonestTokenizer.countTokens(rawBody);

    const isLarge = Buffer.byteLength(rawBody, 'utf8') > INLINE_BODY_MAX_BYTES;
    const compactEnv = formatCompactResultEnvelope({
      requestId: 'req_bench_test',
      fromAgent: 'chatgpt-desktop',
      body: rawBody,
      casStore: cas
    });

    const envTokens = HonestTokenizer.countTokens(compactEnv);
    const envelopeOverheadTokens = isLarge ? envTokens : (envTokens - rawTokens);
    const chatAckTokens = 1; // "✓" because alreadyDisplayed: true prevents echo

    // Incremental turn overhead (Envelope + Ack):
    // This is the additional cost per request when tool schema & system prompt are cached.
    const incrementalTurnOverheadTokens = envelopeOverheadTokens + chatAckTokens;
    const incrementalOverheadPct = (incrementalTurnOverheadTokens / rawTokens) * 100;

    // Full first-turn overhead (Uncached Schema + Protocol + Envelope + Ack):
    const fullTurnOverheadTokens = commSchemaTokens + protocolPrefixTokens + envelopeOverheadTokens + chatAckTokens;
    const fullTurnOverheadPct = (fullTurnOverheadTokens / rawTokens) * 100;

    // Evaluated against target of <= 5%:
    const meetsTargetIncremental = incrementalOverheadPct <= 5.0;

    results.push({
      name: tc.name,
      rawTokens,
      breakdown: {
        rawManualPasteTokens: rawTokens,
        toolSchemaTokensComm: commSchemaTokens,
        toolSchemaTokensFull: allSchemaTokens,
        protocolPrefixTokens,
        envelopeTokens: envTokens,
        envelopeOverheadTokens,
        chatAckTokens,
        isCasReference: isLarge
      },
      incrementalTurnOverheadTokens,
      incrementalOverheadPct: Number(incrementalOverheadPct.toFixed(2)),
      fullTurnOverheadTokens,
      fullTurnOverheadPct: Number(fullTurnOverheadPct.toFixed(2)),
      meetsTargetIncremental,
      assessment: meetsTargetIncremental
        ? `PASSED (<= 5.0%): ${incrementalOverheadPct.toFixed(2)}% overhead`
        : `MISSED (> 5.0%): ${incrementalOverheadPct.toFixed(2)}% overhead (fixed 18-token envelope exceeds 5% threshold on short 200-token payload)`
    });
  }

  return {
    tokenizer: HonestTokenizer.name,
    schemas: {
      allToolsCount: allDefs.length,
      allSchemaTokens,
      commToolsCount: commDefs.length,
      commSchemaTokens,
      protocolPrefixTokens,
      schemaReductionPct: Number((((allSchemaTokens - commSchemaTokens) / allSchemaTokens) * 100).toFixed(1))
    },
    benchmarks: results
  };
}

if (process.argv[1] && process.argv[1].endsWith('token-overhead-benchmark.js')) {
  const data = runTokenOverheadBenchmark();
  console.log('='.repeat(80));
  console.log(`AGENT BRIDGE — HONEST TOKEN OVERHEAD BENCHMARK`);
  console.log(`Tokenizer: ${data.tokenizer}`);
  console.log('='.repeat(80));
  console.log(`Tool Schema Baseline ('all', ${data.schemas.allToolsCount} tools):    ${data.schemas.allSchemaTokens} tokens`);
  console.log(`Tool Schema Profile ('comm', ${data.schemas.commToolsCount} tools):     ${data.schemas.commSchemaTokens} tokens`);
  console.log(`Byte-Stable Protocol Prefix:                         ${data.schemas.protocolPrefixTokens} tokens`);
  console.log(`Schema Token Reduction:                              ${data.schemas.schemaReductionPct}%\n`);

  console.log('BENCHMARK CASES (vs Manual Copy-Paste Baseline):');
  console.log('-'.repeat(80));
  for (const b of data.benchmarks) {
    console.log(`Case: ${b.name}`);
    console.log(`  Manual Paste Baseline:         ${b.rawTokens} tokens`);
    console.log(`  Envelope Overhead:             ${b.breakdown.envelopeOverheadTokens} tokens (${b.breakdown.isCasReference ? 'CAS digest+ref' : 'inline header'})`);
    console.log(`  Chat Ack Reply (alreadyDisp):  ${b.breakdown.chatAckTokens} token`);
    console.log(`  Incremental Overhead:          +${b.incrementalTurnOverheadTokens} tokens (${b.incrementalOverheadPct}%)`);
    console.log(`  Full 1st-Turn Overhead:        +${b.fullTurnOverheadTokens} tokens (${b.fullTurnOverheadPct}%)`);
    console.log(`  Status vs <= 5% Target:        ${b.assessment}\n`);
  }
}
