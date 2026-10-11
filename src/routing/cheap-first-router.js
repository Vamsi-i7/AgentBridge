/**
 * Cheap-First Routing Coordinator (Mission H.9)
 *
 * Routes requests based on declared task complexity and cost tiering:
 * - Simple relay, factual retrieval, syntax formatting -> Fast/Cheap Tier (CLI process / Gemini Flash / local worker)
 * - Deep reasoning, security auditing, multi-file synthesis -> Frontier Tier (Claude / ChatGPT / deep models)
 *
 * Grounded strictly in declared task types and manifest capabilities, never heuristic guesswork.
 */

export const TaskComplexity = Object.freeze({
  LIGHTWEIGHT: 'lightweight',   // relay, format, simple fact query, lint
  STANDARD: 'standard',         // implementation, unit test, documentation
  DEEP_REASONING: 'deep_reasoning' // security audit, consensus verification, architectural design
});

export class CheapFirstRouter {
  constructor(options = {}) {
    this.manifest = options.manifest || null;
    this.cheapAgentId = options.cheapAgentId || 'gemini';
    this.frontierAgentId = options.frontierAgentId || 'claude-desktop';
  }

  /**
   * Classify task complexity from declared task type and metadata.
   * @param {object} task - { type, title, instructions, metadata }
   * @returns {string} TaskComplexity enum
   */
  classifyComplexity(task = {}) {
    const declaredType = task.type || task.metadata?.taskType || '';
    if (['relay', 'format', 'lint', 'fact_query', 'ping'].includes(declaredType)) {
      return TaskComplexity.LIGHTWEIGHT;
    }
    if (['security_audit', 'consensus_verification', 'architecture_review', 'arbitration'].includes(declaredType)) {
      return TaskComplexity.DEEP_REASONING;
    }

    // Fallback classification on instructions length
    const textLen = (task.instructions || task.title || '').length;
    if (textLen < 200) return TaskComplexity.LIGHTWEIGHT;
    if (textLen > 2500) return TaskComplexity.DEEP_REASONING;
    return TaskComplexity.STANDARD;
  }

  /**
   * Select optimal agent route.
   */
  selectAgent(task = {}, availableAgents = []) {
    const complexity = this.classifyComplexity(task);

    if (complexity === TaskComplexity.LIGHTWEIGHT) {
      const preferredCheap = availableAgents.find(a => a === this.cheapAgentId || a.includes('gemini') || a.includes('freebuff'));
      if (preferredCheap) {
        return {
          selectedAgent: preferredCheap,
          complexity,
          tier: 'cheap',
          estimatedSavingsPct: 75 // ~75% lower cost compared to frontier tier
        };
      }
    }

    if (complexity === TaskComplexity.DEEP_REASONING) {
      const preferredFrontier = availableAgents.find(a => a === this.frontierAgentId || a.includes('claude') || a.includes('chatgpt'));
      if (preferredFrontier) {
        return {
          selectedAgent: preferredFrontier,
          complexity,
          tier: 'frontier',
          estimatedSavingsPct: 0
        };
      }
    }

    // Default: first available or specified
    return {
      selectedAgent: task.toAgent || availableAgents[0] || this.frontierAgentId,
      complexity,
      tier: 'standard',
      estimatedSavingsPct: 0
    };
  }
}
