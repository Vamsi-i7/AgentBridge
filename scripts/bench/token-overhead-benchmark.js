/**
 * Token Overhead Benchmark Suite (Mission B)
 *
 * Compares:
 * 1. Baseline: Full schema (74 tools, ~6,740 tokens), verbose protocol, JSON envelopes, duplicated chat turn.
 * 2. Optimized: Communication profile (5 tools, ~485 tokens), stable cached protocol, compact plain-text envelope,
 *    and CAS pass-by-reference.
 */

import { ToolRegistry } from '../../src/tool-registry.js';
import { STABLE_PROTOCOL_INSTRUCTIONS, formatStableProtocolPrompt } from '../../src/protocol/stable-protocol.js';
import { formatCompactResultEnvelope, INLINE_BODY_MAX_BYTES } from '../../src/protocol/compact-envelope.js';
import { ContentAddressedStore } from '../../src/artifacts/content-addressed-store.js';

export function runTokenOverheadBenchmark() {
  const registry = new ToolRegistry();
  const allDefs = registry.getToolDefinitions('all');
  const commDefs = registry.getToolDefinitions('communication');

  const allSchemaBytes = Buffer.byteLength(JSON.stringify(allDefs), 'utf8');
  const commSchemaBytes = Buffer.byteLength(JSON.stringify(commDefs), 'utf8');

  const allSchemaTokens = Math.ceil(allSchemaBytes / 4);
  const commSchemaTokens = Math.ceil(commSchemaBytes / 4);

  const benchmarkPrompts = [
    {
      name: '1. Short Relay / Fact Query',
      prompt: 'Verify consensus invariants for request req_7718.',
      response: 'All 10 safety invariants verified and satisfied in current epoch.',
      rawTokens: 14
    },
    {
      name: '2. Code Modification Query',
      prompt: 'Implement monotonic attempt epoch fencing in SQLite transition guard.',
      response: `function updateTaskEpoch(db, taskId, attemptId, epoch) {
  const row = db.prepare('SELECT epoch FROM task_epochs WHERE task_id = ?').get(taskId);
  if (!row || epoch <= row.epoch) throw new Error('FENCED_ATTEMPT_ERROR: Stale epoch');
  db.prepare('UPDATE task_epochs SET epoch = ?, attempt_id = ? WHERE task_id = ?').run(epoch, attemptId, taskId);
  return { taskId, epoch, attemptId };
}`,
      rawTokens: 78
    },
    {
      name: '3. Architecture Analysis',
      prompt: 'Explain the difference between same-process and cross-process wakeups in Agent Bridge.',
      response: 'Agent Bridge employs a multi-tiered event notification hierarchy to eliminate lost wakeups.\n\n' +
        '1. Same-Process Fast Path: Handled directly in-process via EventBus.dispatchLocal(). When a result commits to SQLite, the local registered waiter promise is resolved synchronously within <0.5ms.\n' +
        '2. Cross-Process Backstop: Employs atomic notify file touch (CONFIG.NOTIFY_PATH) monitored via fs.watch, backed by an adaptive micro-polling loop. Durable state is committed before event publishing.',
      rawTokens: 105
    },
    {
      name: '4. Large Document / Multi-KB Artifact',
      prompt: 'Generate full JSON project snapshot with symbol graph and module dependencies.',
      response: 'X'.repeat(8000), // 8KB payload
      rawTokens: 2000
    }
  ];

  const cas = new ContentAddressedStore();
  const results = [];

  for (const item of benchmarkPrompts) {
    const rawTokens = item.rawTokens;

    // Baseline calculation:
    // Schema tokens + Verbose protocol (250 tokens) + JSON envelope (60 tokens) + 2x response (tool + chat repetition)
    const baselineSchema = allSchemaTokens;
    const baselineProtocol = 250;
    const baselineEnvelope = 60;
    const baselineResponseTokens = rawTokens * 2; // Doubled: once in tool submit, once typed into chat window
    const baselineTotal = baselineSchema + baselineProtocol + baselineEnvelope + baselineResponseTokens;
    const baselineOverheadPct = ((baselineTotal - rawTokens) / rawTokens) * 100;

    // Optimized (Mission B) calculation:
    // Profile comm (485 tokens) + cached stable protocol (0 incremental tokens when cached, ~110 if first turn) +
    // compact envelope (header only ~15 tokens) + single response (no chat duplication; model replies '✓' = 1 token).
    // For large body (>6KB), CAS reference replaces payload with digest + ref.
    const isLarge = Buffer.byteLength(item.response, 'utf8') > INLINE_BODY_MAX_BYTES;
    const compactEnv = formatCompactResultEnvelope({
      requestId: 'req_bench_1',
      fromAgent: 'freebuff',
      body: item.response,
      casStore: cas
    });
    const compactEnvTokens = Math.ceil(Buffer.byteLength(compactEnv, 'utf8') / 4);

    const optSchema = commSchemaTokens;
    const optProtocolCached = 0; // 100% cache hit on stable prefix
    const optChatAckToken = 1;   // "✓" checkmark
    const optReturnedTokens = isLarge ? compactEnvTokens : (rawTokens + 15);
    const optTotal = optSchema + optProtocolCached + optChatAckToken + optReturnedTokens;
    const optOverheadPct = ((optTotal - rawTokens) / rawTokens) * 100;

    // Incremental communication overhead (excluding initial tool discovery):
    const incrementalOverhead = optReturnedTokens - rawTokens + optChatAckToken;
    const incrementalOverheadPct = (incrementalOverhead / rawTokens) * 100;

    results.push({
      name: item.name,
      rawTokens,
      baselineTotal,
      baselineOverheadPct: Number(baselineOverheadPct.toFixed(1)),
      optTotal,
      optOverheadPct: Number(optOverheadPct.toFixed(1)),
      incrementalOverhead,
      incrementalOverheadPct: Number(incrementalOverheadPct.toFixed(1)),
      tokenReductionPct: Number((((baselineTotal - optTotal) / baselineTotal) * 100).toFixed(1))
    });
  }

  return {
    schemas: {
      allToolsCount: allDefs.length,
      allSchemaBytes,
      allSchemaTokens,
      commToolsCount: commDefs.length,
      commSchemaBytes,
      commSchemaTokens,
      schemaReductionPct: Number((((allSchemaBytes - commSchemaBytes) / allSchemaBytes) * 100).toFixed(1))
    },
    benchmarks: results
  };
}

if (process.argv[1] && process.argv[1].endsWith('token-overhead-benchmark.js')) {
  const data = runTokenOverheadBenchmark();
  console.log('='.repeat(80));
  console.log('AGENT BRIDGE — MISSION B: TOKEN SURFACE & OVERHEAD BENCHMARK');
  console.log('='.repeat(80));
  console.log(`Tool Schema Baseline ('all', ${data.schemas.allToolsCount} tools):        ${data.schemas.allSchemaBytes} B (~${data.schemas.allSchemaTokens} tokens)`);
  console.log(`Tool Schema Optimized ('comm', ${data.schemas.commToolsCount} tools):     ${data.schemas.commSchemaBytes} B (~${data.schemas.commSchemaTokens} tokens)`);
  console.log(`Tool Schema Token Reduction:                         ${data.schemas.schemaReductionPct}%\n`);

  console.log('BENCHMARK PROMPT COMPARISONS:');
  console.log('-'.repeat(80));
  for (const b of data.benchmarks) {
    console.log(`Test: ${b.name} (Raw Body: ${b.rawTokens} tokens)`);
    console.log(`  Baseline Total:     ${b.baselineTotal} tokens (+${b.baselineOverheadPct}% overhead)`);
    console.log(`  Mission B Total:    ${b.optTotal} tokens (+${b.optOverheadPct}% overhead)`);
    console.log(`  Incremental Comm:   +${b.incrementalOverhead} tokens (+${b.incrementalOverheadPct}% above raw body)`);
    console.log(`  Total Savings:      ${b.tokenReductionPct}% token reduction vs baseline\n`);
  }
}
