#!/usr/bin/env node
import { SkillsManager } from '../../src/skills/skills-manager.js';

const EVAL_BENCHMARK = [
  // 1-5: Delegation
  { id: 1, prompt: 'How do I delegate a task from Claude to ChatGPT with depth limits?', target: 'bridge-delegation' },
  { id: 2, prompt: 'Prevent infinite recursion in multi-hop agent tasks', target: 'bridge-delegation' },
  { id: 3, prompt: 'Claim pending task and ensure idempotency with dedupKey', target: 'bridge-delegation' },
  { id: 4, prompt: 'Authority fencing: ensure delegated task cannot escalate permissions', target: 'bridge-delegation' },
  { id: 5, prompt: 'Task dispatching to registered agent identities', target: 'bridge-delegation' },

  // 6-10: Response Handling & Confidence
  { id: 6, prompt: 'How to interpret EXPLICIT_END_OF_TURN versus STABILITY_HEURISTIC?', target: 'bridge-response-handling' },
  { id: 7, prompt: 'Side-effect gating: rejecting heuristic completion for mutating tasks', target: 'bridge-response-handling' },
  { id: 8, prompt: 'Verbatim delivery without LLM re-synthesis inflation', target: 'bridge-response-handling' },
  { id: 9, prompt: 'What to do when message route status is SENT_UNCONFIRMED?', target: 'bridge-response-handling' },
  { id: 10, prompt: 'Inspect executionMetadata and completionConfidence on envelopes', target: 'bridge-response-handling' },

  // 11-15: Handoff & Compaction
  { id: 11, prompt: 'How do I survive context compaction across agent sessions?', target: 'bridge-handoff-compaction' },
  { id: 12, prompt: 'Persistent handoff artifacts directory conventions', target: 'bridge-handoff-compaction' },
  { id: 13, prompt: 'Anchoring ground truth to git HEAD SHA and test counts', target: 'bridge-handoff-compaction' },
  { id: 14, prompt: 'Resumption protocol after conversation truncation', target: 'bridge-handoff-compaction' },
  { id: 15, prompt: 'Capturing pre-restart and post-restart process snapshots', target: 'bridge-handoff-compaction' },

  // 16-20: Completion Verification
  { id: 16, prompt: 'How does cryptographic nonce correlation prevent replay attacks?', target: 'bridge-completion-verification' },
  { id: 17, prompt: 'Detecting model thinking pauses with grace re-check probes', target: 'bridge-completion-verification' },
  { id: 18, prompt: 'Observing hasStopButton and isGenerating accessibility indicators', target: 'bridge-completion-verification' },
  { id: 19, prompt: 'Distinguishing genuine completion from UI stillness', target: 'bridge-completion-verification' },
  { id: 20, prompt: 'Tagging prompts with AgentBridge Correlation nonce markers', target: 'bridge-completion-verification' },

  // 21-25: Memory & Knowledge
  { id: 21, prompt: 'Search local knowledge store using SQLite FTS5 and BM25', target: 'bridge-memory-use' },
  { id: 22, prompt: 'Storing verified findings and architectural invariants without cloud embeddings', target: 'bridge-memory-use' },
  { id: 23, prompt: 'Knowledge lifecycle states: verified, hypothesis, obsolete', target: 'bridge-memory-use' },
  { id: 24, prompt: 'Fast local memory search using keyword query terms', target: 'bridge-memory-use' },
  { id: 25, prompt: 'Retrieve compact ranked snippets from knowledge store', target: 'bridge-memory-use' },

  // 26-30: Multi-Agent Testing & Token Discipline
  { id: 26, prompt: 'Testing multi-agent communication across separate OS processes', target: 'bridge-multi-agent-testing' },
  { id: 27, prompt: 'Avoiding synthetic simulation traps in peer agent tests', target: 'bridge-multi-agent-testing' },
  { id: 28, prompt: 'Testing hierarchy from L0 mock to L4 live model', target: 'bridge-multi-agent-testing' },
  { id: 29, prompt: 'Cap tool advertisement using minimal or collaborator profiles to save tokens', target: 'bridge-token-discipline' },
  { id: 30, prompt: 'Reduce context bloat with compact artifact envelopes', target: 'bridge-token-discipline' },

  // 31-35: MCP Server & SDK
  { id: 31, prompt: 'Build a high-quality MCP Model Context Protocol server in Python or TypeScript', target: 'mcp-builder' },
  { id: 32, prompt: 'MCP tool design: schema validation and workflow tools', target: 'mcp-builder' },
  { id: 33, prompt: 'Orchestrating agents using Google Antigravity SDK', target: 'google-antigravity-sdk' },
  { id: 34, prompt: 'Build a Chrome browser extension with Manifest V3', target: 'chrome-extensions' },
  { id: 35, prompt: 'Chrome extension service worker and content script communication', target: 'chrome-extensions' },

  // 36-40: Web Guidance, DevTools & Cloud
  { id: 36, prompt: 'Modern web development CSS popovers anchor positioning and container queries', target: 'modern-web-guidance' },
  { id: 37, prompt: 'Debug and optimize Largest Contentful Paint LCP performance Core Web Vitals', target: 'debug-optimize-lcp' },
  { id: 38, prompt: 'Identify memory leaks in JavaScript Node.js heap snapshot', target: 'memory-leak-debugging' },
  { id: 39, prompt: 'Detect memory leaks and detached DOM nodes in web applications', target: 'memory-leak-debugging' },
  { id: 40, prompt: 'Designing Cloud Firestore data models security rules and indexes', target: 'firebase-firestore' }
];

async function runEvaluation() {
  const manager = new SkillsManager();
  console.log(`Starting Retrieval Benchmark across ${EVAL_BENCHMARK.length} test queries...\n`);

  let top1Hits = 0;
  let top3Hits = 0;
  let top5Hits = 0;

  const results = [];

  for (const item of EVAL_BENCHMARK) {
    const hits = manager.searchSkills({ query: item.prompt, limit: 5 });
    const hitNames = hits.map(h => h.name);

    const hitAt1 = hitNames[0] === item.target;
    const hitAt3 = hitNames.slice(0, 3).includes(item.target);
    const hitAt5 = hitNames.slice(0, 5).includes(item.target);

    if (hitAt1) top1Hits++;
    if (hitAt3) top3Hits++;
    if (hitAt5) top5Hits++;

    results.push({
      id: item.id,
      prompt: item.prompt,
      target: item.target,
      rank: hitNames.indexOf(item.target) >= 0 ? hitNames.indexOf(item.target) + 1 : 'Not in top 5',
      topHit: hitNames[0] || 'None',
      hitAt1,
      hitAt3,
      hitAt5
    });
  }

  const n = EVAL_BENCHMARK.length;
  const p1 = (top1Hits / n) * 100;
  const p3 = (top3Hits / n) * 100;
  const r5 = (top5Hits / n) * 100;

  console.log('='.repeat(80));
  console.log('RETRIEVAL BENCHMARK RESULTS');
  console.log('='.repeat(80));
  console.log(`Total Queries:   ${n}`);
  console.log(`Top-1 Accuracy:  ${top1Hits}/${n} (${p1.toFixed(1)}%)`);
  console.log(`Precision@3:     ${top3Hits}/${n} (${p3.toFixed(1)}%)`);
  console.log(`Recall@5:        ${top5Hits}/${n} (${r5.toFixed(1)}%)\n`);

  console.log('Sample Query Evaluations:');
  for (const r of results.slice(0, 10)) {
    const status = r.hitAt1 ? '✓ TOP-1' : (r.hitAt3 ? '✓ TOP-3' : (r.hitAt5 ? '✓ TOP-5' : '✗ MISS'));
    console.log(`  [${status}] #${r.id} -> Target: ${r.target.padEnd(28)} Top: ${r.topHit}`);
  }

  return { total: n, top1Hits, top3Hits, top5Hits, p1, p3, r5, results };
}

runEvaluation();
