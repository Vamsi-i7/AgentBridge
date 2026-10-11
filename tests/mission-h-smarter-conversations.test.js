import test from 'node:test';
import assert from 'node:assert/strict';
import { StructuredContractValidator, ContractType } from '../src/contracts/structured-contracts.js';
import { RollingSummaryManager } from '../src/collaboration/rolling-summary.js';
import { ContextReferenceManager } from '../src/collaboration/context-reference-manager.js';
import { CollaborationGuard, BudgetStopReason } from '../src/collaboration/collaboration-guard.js';
import { CollaborationPatternOrchestrator, CollaborationPatternType, PATTERN_SPECIFICATIONS } from '../src/collaboration/collaboration-patterns.js';
import { RepoCodeMapGenerator } from '../src/code-intelligence/repo-code-map.js';
import { SemanticCache } from '../src/cache/semantic-cache.js';
import { CheapFirstRouter, TaskComplexity } from '../src/routing/cheap-first-router.js';
import { PromptCompressor } from '../src/compression/prompt-compressor.js';

test('Mission H: Smarter, Cheaper Conversations Suite [TEST-PROVEN]', async (t) => {
  // ---------------------------------------------------------------------------
  // 1. Structured Result Contracts
  // ---------------------------------------------------------------------------
  await t.test('1. Structured contracts enforce schema and format compact results', () => {
    // 1a. Valid Review
    const reviewPayload = {
      verdict: 'APPROVED',
      issues: [{ file: 'server.js', line: 42, severity: 'INFO', message: 'Add comment' }],
      suggestions: ['Refactor helper']
    };
    const vReview = StructuredContractValidator.validate(ContractType.REVIEW, reviewPayload);
    assert.equal(vReview.valid, true);
    assert.match(vReview.compactText, /\[CONTRACT:REVIEW verdict=APPROVED issues=1\]/);

    // 1b. Invalid Review
    const vBadReview = StructuredContractValidator.validate(ContractType.REVIEW, { verdict: 'MAYBE' });
    assert.equal(vBadReview.valid, false);
    assert.ok(vBadReview.errors.length > 0);

    // 1c. Valid Patch
    const patchPayload = {
      patch: '--- a/f.js\n+++ b/f.js\n@@ -1,1 +1,1 @@\n-old\n+new',
      filesChanged: ['f.js'],
      testsNeeded: true
    };
    const vPatch = StructuredContractValidator.validate(ContractType.PATCH, patchPayload);
    assert.equal(vPatch.valid, true);
    assert.match(vPatch.compactText, /\[CONTRACT:PATCH files=f.js/);

    // 1d. Valid Research
    const researchPayload = {
      query: 'What is epoch fencing?',
      answer: 'Epoch fencing invalidates stale attempt leases.',
      keyFindings: ['Monotonic increment', 'Cryptographic nonce'],
      confidence: 0.98
    };
    const vResearch = StructuredContractValidator.validate(ContractType.RESEARCH, researchPayload);
    assert.equal(vResearch.valid, true);
    assert.match(vResearch.compactText, /\[CONTRACT:RESEARCH confidence=0.98\]/);
  });

  // ---------------------------------------------------------------------------
  // 2. Context by Reference & Deltas
  // ---------------------------------------------------------------------------
  await t.test('2. ContextReferenceManager sends base on turn 1 and deltas on subsequent turns', () => {
    const mgr = new ContextReferenceManager();
    const baseLines = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}: Invariant test specification rule ${i + 1}`).join('\n');
    const docV1 = baseLines;
    const docV2 = baseLines.replace('rule 15', 'rule 15 modified');

    // Turn 1
    const p1 = mgr.prepareContextPayload('gemini', 'invariants.txt', docV1);
    assert.equal(p1.isDelta, false);
    assert.match(p1.payload, /\[CONTEXT-BASE key=invariants.txt ref=ref:[a-f0-9]{64}\]/);

    // Turn 2: same content
    const p2Identical = mgr.prepareContextPayload('gemini', 'invariants.txt', docV1);
    assert.equal(p2Identical.isDelta, true);
    assert.match(p2Identical.payload, /\[CONTEXT-UNCHANGED/);
    assert.ok(p2Identical.tokensSavedEstimate > 0);

    // Turn 3: small edit
    const p3Delta = mgr.prepareContextPayload('gemini', 'invariants.txt', docV2);
    assert.equal(p3Delta.isDelta, true);
    assert.match(p3Delta.payload, /\[CONTEXT-DELTA/);
  });

  // ---------------------------------------------------------------------------
  // 3. Rolling Collaboration Summaries
  // ---------------------------------------------------------------------------
  await t.test('3. RollingSummaryManager compresses history while preserving decisions and full log in CAS', () => {
    const summaryMgr = new RollingSummaryManager({ tokenThreshold: 50 });
    const collabId = 'collab_test_1';

    summaryMgr.appendTurn(collabId, {
      hop: 1,
      fromAgent: 'chatgpt-desktop',
      toAgent: 'gemini',
      output: 'Initial architectural survey of database locking.',
      facts: ['SQLite requires WAL mode for concurrent readers']
    });

    summaryMgr.appendTurn(collabId, {
      hop: 2,
      fromAgent: 'gemini',
      toAgent: 'claude-desktop',
      output: 'Detailed evaluation of WAL lock timeouts.',
      decision: 'Adopt 5000ms busy timeout',
      facts: ['Deadlock eliminated with single writer queue']
    });

    const nextPayload = summaryMgr.getNextHopPayload(collabId, 'Review this locking design');
    assert.match(nextPayload, /\[COLLABORATION-CONTEXT id=collab_test_1 hops=2 ref=ref:[a-f0-9]{64}\]/);
    assert.match(nextPayload, /Adopt 5000ms busy timeout/);
    assert.match(nextPayload, /Review this locking design/);

    // Verify full untruncated history is 100% intact by CAS reference
    const fullHistory = summaryMgr.getFullHistory(collabId);
    assert.equal(fullHistory.length, 2);
    assert.equal(fullHistory[0].fromAgent, 'chatgpt-desktop');
    assert.equal(fullHistory[1].decision, 'Adopt 5000ms busy timeout');
  });

  // ---------------------------------------------------------------------------
  // 4. Budgets and Guards
  // ---------------------------------------------------------------------------
  await t.test('4. CollaborationGuard detects ping-pong loops, repeated queries, and hop ceilings', () => {
    const guard = new CollaborationGuard({ maxHops: 3, maxTokens: 1000 });
    const collabId = 'guard_collab_1';

    // Hop 1: A -> B
    const h1 = guard.checkHop(collabId, 'agentA', 'agentB', 'Question 1', 100);
    assert.equal(h1.allowed, true);

    // Hop 2: B -> A
    const h2 = guard.checkHop(collabId, 'agentB', 'agentA', 'Question 2', 100);
    assert.equal(h2.allowed, true);

    // Hop 3: A -> B
    const h3 = guard.checkHop(collabId, 'agentA', 'agentB', 'Question 3', 100);
    assert.equal(h3.allowed, true);

    // Hop 4: B -> A (Exceeds maxHops = 3 AND triggers Ping-Pong)
    const h4 = guard.checkHop(collabId, 'agentB', 'agentA', 'Question 4', 100);
    assert.equal(h4.allowed, false);
    assert.equal(h4.stopReason, BudgetStopReason.BUDGET_EXCEEDED_HOPS);

    // Test Repeated Query Detection
    const guardRepeated = new CollaborationGuard({ maxHops: 10 });
    const c2 = 'guard_collab_2';
    const longQuery = 'Explain in detail the formal proof of Byzantine fault tolerance in decentralized systems.';

    const q1 = guardRepeated.checkHop(c2, 'agentA', 'agentB', longQuery);
    assert.equal(q1.allowed, true);

    const q2 = guardRepeated.checkHop(c2, 'agentB', 'agentC', longQuery);
    assert.equal(q2.allowed, false);
    assert.equal(q2.stopReason, BudgetStopReason.LOOP_DETECTED_REPEATED_QUERY);
  });

  // ---------------------------------------------------------------------------
  // 5. Collaboration Patterns
  // ---------------------------------------------------------------------------
  await t.test('5. CollaborationPatternOrchestrator reports multipliers upfront and executes patterns', async () => {
    const mockMailbox = {
      async askAgent({ toAgent, question }) {
        if (toAgent === 'worker') return { status: 'completed', response: 'Initial draft solution' };
        if (toAgent === 'reviewer') return { status: 'completed', response: 'VERDICT: APPROVED. Looks clean.' };
        if (toAgent === 'cheap') return { status: 'completed', response: 'Fast cheap answer' };
        if (toAgent === 'frontier') return { status: 'completed', response: 'Deep reasoning answer' };
        return { status: 'completed', response: `Response from ${toAgent}` };
      }
    };

    const orchestrator = new CollaborationPatternOrchestrator({ mailboxHub: mockMailbox });

    // Check upfront specification
    const spec = orchestrator.getPatternSpec(CollaborationPatternType.ASK_AND_REVIEW);
    assert.equal(spec.expectedTokenMultiplier, 1.8);

    // Execute Ask-and-Review
    const resReview = await orchestrator.executeAskAndReview({
      initiatorAgent: 'initiator',
      workerAgent: 'worker',
      reviewerAgent: 'reviewer',
      prompt: 'Draft consensus specification'
    });
    assert.equal(resReview.status, 'completed');
    assert.equal(resReview.workerResult, 'Initial draft solution');
    assert.match(resReview.reviewResult, /APPROVED/);

    // Execute Escalate (Tier 1 succeeds)
    const resEscalatePass = await orchestrator.executeEscalate({
      initiatorAgent: 'initiator',
      tier1Agent: 'cheap',
      tier2Agent: 'frontier',
      prompt: 'Simple factual query',
      validateFn: (r) => r.includes('cheap')
    });
    assert.equal(resEscalatePass.escalated, false);
    assert.equal(resEscalatePass.actualTokenMultiplier, 1.0);

    // Execute Escalate (Tier 1 fails, escalates to Tier 2)
    const resEscalateFail = await orchestrator.executeEscalate({
      initiatorAgent: 'initiator',
      tier1Agent: 'cheap',
      tier2Agent: 'frontier',
      prompt: 'Complex proof',
      validateFn: (r) => r.includes('Deep reasoning')
    });
    assert.equal(resEscalateFail.escalated, true);
    assert.equal(resEscalateFail.actualTokenMultiplier, 2.1);
  });

  // ---------------------------------------------------------------------------
  // 6. Repo Code Map
  // ---------------------------------------------------------------------------
  await t.test('6. RepoCodeMapGenerator creates outline and fetches specific symbols on demand', () => {
    const generator = new RepoCodeMapGenerator();
    const sourceCode = `
export class OrderProcessor {
  constructor(db) { this.db = db; }

  processOrder(orderId, amount) {
    if (amount <= 0) throw new Error('Invalid');
    return { orderId, status: 'PROCESSED' };
  }
}

export function calculateTax(subtotal, rate) {
  return subtotal * rate;
}
`;
    const parsed = generator.parseSymbols('order.js', sourceCode);
    assert.equal(parsed.symbols.length, 4); // class, constructor, method, function
    assert.equal(parsed.symbols[0].name, 'OrderProcessor');
    assert.equal(parsed.symbols[1].name, 'constructor');
    assert.equal(parsed.symbols[2].name, 'processOrder');
    assert.equal(parsed.symbols[3].name, 'calculateTax');

    const compactMap = generator.formatCompactMap(parsed);
    assert.match(compactMap, /\[CODE-MAP file=order.js/);
    assert.match(compactMap, /OrderProcessor/);
    assert.match(compactMap, /processOrder\(orderId, amount\)/);

    // On-demand fetch of specific symbol
    const fetched = generator.fetchSymbolContent('order.js', 'processOrder', sourceCode);
    assert.ok(fetched);
    assert.equal(fetched.symbol, 'processOrder');
    assert.match(fetched.code, /status: 'PROCESSED'/);
  });

  // ---------------------------------------------------------------------------
  // 7. Semantic Cache
  // ---------------------------------------------------------------------------
  await t.test('7. SemanticCache caches read-only queries, refuses writes, and invalidates on file change', () => {
    const cache = new SemanticCache();

    // 7a. Rejects mutation queries
    assert.equal(cache.isCacheable('WRITE', 'write to file.txt'), false);
    assert.equal(cache.isCacheable('READ', 'delete old branch'), false);
    assert.equal(cache.isCacheable('READ', 'explain the consensus invariants'), true);

    // 7b. Cache put and hit
    const fileHashes = { 'consensus.md': 'hash_v1' };
    cache.put('explain the consensus invariants', 'Invariants require monotonic epoch', fileHashes);

    const hit = cache.get('explain the consensus invariants', fileHashes);
    assert.ok(hit);
    assert.equal(hit.hit, true);
    assert.equal(hit.response, 'Invariants require monotonic epoch');

    // 7c. Invalidation on file modification
    cache.invalidateFiles(['consensus.md']);
    const missAfterInvalidate = cache.get('explain the consensus invariants', fileHashes);
    assert.equal(missAfterInvalidate, null);
  });

  // ---------------------------------------------------------------------------
  // 8. Cheap-First Router
  // ---------------------------------------------------------------------------
  await t.test('8. CheapFirstRouter routes lightweight tasks to cheap tier and deep reasoning to frontier', () => {
    const router = new CheapFirstRouter({ cheapAgentId: 'gemini', frontierAgentId: 'claude-desktop' });
    const available = ['gemini', 'claude-desktop'];

    const relayTask = { type: 'relay', instructions: 'Pass this message to next agent' };
    const relayRoute = router.selectAgent(relayTask, available);
    assert.equal(relayRoute.tier, 'cheap');
    assert.equal(relayRoute.selectedAgent, 'gemini');
    assert.equal(relayRoute.estimatedSavingsPct, 75);

    const auditTask = { type: 'security_audit', instructions: 'Perform formal verification of attempt fencing' };
    const auditRoute = router.selectAgent(auditTask, available);
    assert.equal(auditRoute.tier, 'frontier');
    assert.equal(auditRoute.selectedAgent, 'claude-desktop');
  });

  // ---------------------------------------------------------------------------
  // 9. Prompt Compressor
  // ---------------------------------------------------------------------------
  await t.test('9. PromptCompressor eliminates boilerplate while strictly preserving code and identifiers', () => {
    const compressor = new PromptCompressor({ enabled: true });
    const prose = 'As mentioned previously, please be advised that it is important to note that the system requires SQLite WAL mode. '.repeat(10);
    const code = '```javascript\nfunction secureEpoch(id, nonce) { return { id, nonce: "ABC_123" }; }\n```';
    const input = `${prose}\n\n${code}\n\n${prose}`;

    const res = compressor.compress(input);
    assert.ok(res.tokensSaved > 0);
    // Code block must remain 100% byte-identical
    assert.ok(res.compressedText.includes(code), 'Code block must be preserved byte-for-byte');
    assert.ok(res.compressedText.includes('"ABC_123"'), 'Identifiers must be preserved byte-for-byte');
  });
});
