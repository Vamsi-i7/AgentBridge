/**
 * Collaboration Patterns & Bridge-Side Templates (Mission H.8)
 *
 * Implements standard multi-agent interaction patterns as bridge-orchestrated templates.
 * Invoked explicitly, never by default.
 * Each pattern declares its expected token multiplier upfront before execution.
 *
 * Patterns:
 * 1. Ask-and-Review: Agent A delegates to B, Agent C reviews and validates B's response.
 *    Token multiplier: ~1.8x
 * 2. Parallel-Ask-and-Merge: Concurrently dispatches to N agents and aggregates/synthesizes results.
 *    Token multiplier: ~2.2x
 * 3. Arbitrate: Two distinct agents provide competing solutions; a third judge decides.
 *    Token multiplier: ~2.5x
 * 4. Escalate: Submits first to a fast/cheap agent. If validation or confidence fails, escalates to strong model.
 *    Token multiplier: 1.0x (un-escalated), 2.1x (if escalated).
 */

export const CollaborationPatternType = Object.freeze({
  ASK_AND_REVIEW: 'ask_and_review',
  PARALLEL_ASK_AND_MERGE: 'parallel_ask_and_merge',
  ARBITRATE: 'arbitrate',
  ESCALATE: 'escalate'
});

export const PATTERN_SPECIFICATIONS = Object.freeze({
  [CollaborationPatternType.ASK_AND_REVIEW]: {
    name: 'Ask-and-Review',
    expectedTokenMultiplier: 1.8,
    description: 'Primary agent generates solution; reviewer agent verifies correctness before final return.'
  },
  [CollaborationPatternType.PARALLEL_ASK_AND_MERGE]: {
    name: 'Parallel-Ask-and-Merge',
    expectedTokenMultiplier: 2.2,
    description: 'Fan-out to N specialist agents concurrently, followed by a join/merge synthesis turn.'
  },
  [CollaborationPatternType.ARBITRATE]: {
    name: 'Arbitrate',
    expectedTokenMultiplier: 2.5,
    description: 'Two independent agents produce candidate answers; judge agent selects the superior output.'
  },
  [CollaborationPatternType.ESCALATE]: {
    name: 'Escalate (Cheap-First Tiering)',
    expectedTokenMultiplier: 1.0, // Base multiplier if tier 1 succeeds; ~2.1x if escalated
    description: 'Executes via lightweight/cheap agent first; escalates to frontier model only on validation failure.'
  }
});

export class CollaborationPatternOrchestrator {
  constructor({ mailboxHub, taskManager, eventBus, guard = null }) {
    this.mailbox = mailboxHub;
    this.taskManager = taskManager;
    this.eventBus = eventBus;
    this.guard = guard;
  }

  /**
   * Get pattern specification and expected cost multiplier upfront.
   */
  getPatternSpec(patternType) {
    return PATTERN_SPECIFICATIONS[patternType] || null;
  }

  /**
   * 1. Ask-and-Review Pattern
   */
  async executeAskAndReview({ initiatorAgent, workerAgent, reviewerAgent, prompt, reviewPrompt = null, timeoutMs = 45000 }) {
    // Turn 1: Worker generates response
    const turn1 = await this.mailbox.askAgent({
      fromAgent: initiatorAgent,
      toAgent: workerAgent,
      question: prompt,
      timeoutMs
    });

    if (turn1.status !== 'completed') {
      return { status: 'failed', step: 'worker_turn', error: turn1.error, pattern: CollaborationPatternType.ASK_AND_REVIEW };
    }

    const workerResult = turn1.response || turn1.result;

    // Turn 2: Reviewer critiques
    const reviewQuery = reviewPrompt ||
      `Review the following solution to '${prompt.slice(0, 100)}...':\n${workerResult}\nProvide verdict (APPROVED / CHANGES_NEEDED) and feedback.`;

    const turn2 = await this.mailbox.askAgent({
      fromAgent: initiatorAgent,
      toAgent: reviewerAgent,
      question: reviewQuery,
      timeoutMs
    });

    return {
      status: turn2.status === 'completed' ? 'completed' : 'review_failed',
      pattern: CollaborationPatternType.ASK_AND_REVIEW,
      workerAgent,
      reviewerAgent,
      workerResult,
      reviewResult: turn2.response || turn2.result,
      expectedTokenMultiplier: PATTERN_SPECIFICATIONS[CollaborationPatternType.ASK_AND_REVIEW].expectedTokenMultiplier
    };
  }

  /**
   * 2. Parallel-Ask-and-Merge Pattern
   */
  async executeParallelAskAndMerge({ initiatorAgent, workerAgents = [], mergerAgent, prompt, timeoutMs = 60000 }) {
    if (workerAgents.length === 0) throw new Error('At least one worker agent required for fan-out.');

    // Concurrently dispatch to all workers
    const workerPromises = workerAgents.map(agentId =>
      this.mailbox.askAgent({
        fromAgent: initiatorAgent,
        toAgent: agentId,
        question: prompt,
        timeoutMs
      }).then(res => ({ agentId, status: res.status, result: res.response || res.result }))
    );

    const results = await Promise.all(workerPromises);

    // Merge turn
    const mergeInput = `Synthesize and reconcile the following perspectives for prompt '${prompt}':\n` +
      results.map(r => `[Agent ${r.agentId}]:\n${r.result}`).join('\n\n');

    const mergeTurn = await this.mailbox.askAgent({
      fromAgent: initiatorAgent,
      toAgent: mergerAgent,
      question: mergeInput,
      timeoutMs
    });

    return {
      status: mergeTurn.status === 'completed' ? 'completed' : 'merge_failed',
      pattern: CollaborationPatternType.PARALLEL_ASK_AND_MERGE,
      workerResults: results,
      mergedResult: mergeTurn.response || mergeTurn.result,
      expectedTokenMultiplier: PATTERN_SPECIFICATIONS[CollaborationPatternType.PARALLEL_ASK_AND_MERGE].expectedTokenMultiplier
    };
  }

  /**
   * 3. Arbitrate Pattern
   */
  async executeArbitrate({ initiatorAgent, candidateA, candidateB, arbitratorAgent, prompt, timeoutMs = 45000 }) {
    const [resA, resB] = await Promise.all([
      this.mailbox.askAgent({ fromAgent: initiatorAgent, toAgent: candidateA, question: prompt, timeoutMs }),
      this.mailbox.askAgent({ fromAgent: initiatorAgent, toAgent: candidateB, question: prompt, timeoutMs })
    ]);

    const arbInput = `Evaluate both proposed solutions to: '${prompt}'\n\n` +
      `[Candidate A (${candidateA})]:\n${resA.response || resA.result}\n\n` +
      `[Candidate B (${candidateB})]:\n${resB.response || resB.result}\n\n` +
      `Decide which solution is superior and explain why.`;

    const arbTurn = await this.mailbox.askAgent({
      fromAgent: initiatorAgent,
      toAgent: arbitratorAgent,
      question: arbInput,
      timeoutMs
    });

    return {
      status: arbTurn.status === 'completed' ? 'completed' : 'arbitration_failed',
      pattern: CollaborationPatternType.ARBITRATE,
      candidateAOutput: resA.response || resA.result,
      candidateBOutput: resB.response || resB.result,
      arbitrationDecision: arbTurn.response || arbTurn.result,
      expectedTokenMultiplier: PATTERN_SPECIFICATIONS[CollaborationPatternType.ARBITRATE].expectedTokenMultiplier
    };
  }

  /**
   * 4. Escalate Pattern (Cheap-First Tiering)
   */
  async executeEscalate({
    initiatorAgent,
    tier1Agent, // cheap / fast model
    tier2Agent, // strong / frontier model
    prompt,
    validateFn = null, // (result) => boolean
    timeoutMs = 45000
  }) {
    // Attempt Tier 1
    const t1 = await this.mailbox.askAgent({
      fromAgent: initiatorAgent,
      toAgent: tier1Agent,
      question: prompt,
      timeoutMs
    });

    const t1Result = t1.response || t1.result;
    const isValid = t1.status === 'completed' && (validateFn ? validateFn(t1Result) : Boolean(t1Result));

    if (isValid) {
      return {
        status: 'completed',
        pattern: CollaborationPatternType.ESCALATE,
        escalated: false,
        resolvedByTier: 1,
        agent: tier1Agent,
        result: t1Result,
        actualTokenMultiplier: 1.0
      };
    }

    // Escalate to Tier 2
    const t2 = await this.mailbox.askAgent({
      fromAgent: initiatorAgent,
      toAgent: tier2Agent,
      question: prompt,
      timeoutMs
    });

    return {
      status: t2.status === 'completed' ? 'completed' : 'escalation_failed',
      pattern: CollaborationPatternType.ESCALATE,
      escalated: true,
      resolvedByTier: 2,
      agent: tier2Agent,
      result: t2.response || t2.result,
      actualTokenMultiplier: 2.1
    };
  }
}
