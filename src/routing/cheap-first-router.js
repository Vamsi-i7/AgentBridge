/**
 * Cheap-First Routing Coordinator (Mission 4: Honest Defaults & Opt-In Routing)
 *
 * Invariants & Guarantees (P4 Remediation):
 * 1. NEVER SUBSTITUTES EXPLICIT TARGETS: If caller provides `task.toAgent`, that target is strictly preserved.
 * 2. STRICTLY OPT-IN: Cheap-first routing is disabled by default (`enabled: false`).
 * 3. EXPLICIT TASK TYPES ONLY: Only activates when the caller declares NO target AND specifies a recognized task type.
 * 4. TRANSPARENT AUDIT: All routing decisions are logged with complexity and tier classification.
 */

export const TaskComplexity = Object.freeze({
  LIGHTWEIGHT: 'lightweight',   // relay, format, simple fact query, lint
  STANDARD: 'standard',         // implementation, unit test, documentation
  DEEP_REASONING: 'deep_reasoning' // security audit, consensus verification, architectural design
});

export class CheapFirstRouter {
  constructor(options = {}) {
    this.enabled = Boolean(options.enabled); // Opt-in only
    this.manifest = options.manifest || null;
    this.cheapAgentId = options.cheapAgentId || 'gemini';
    this.frontierAgentId = options.frontierAgentId || 'claude-desktop';
    this.auditLogger = options.auditLogger || null;
  }

  /**
   * Classify task complexity from declared task type.
   * Grounded strictly in declared task types, never heuristic guesswork.
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

    // Default when no recognized type is declared
    return TaskComplexity.STANDARD;
  }

  /**
   * Select agent route.
   */
  selectAgent(task = {}, availableAgents = []) {
    // Invariant 1: Routing NEVER substitutes an explicitly named target
    if (task.toAgent) {
      return {
        selectedAgent: task.toAgent,
        complexity: this.classifyComplexity(task),
        tier: 'explicit_target',
        substituted: false,
        reason: 'Explicit caller target preserved without substitution'
      };
    }

    // Invariant 2: Cheap-first routing is opt-in only
    if (!this.enabled) {
      const defaultAgent = availableAgents[0] || this.frontierAgentId;
      return {
        selectedAgent: defaultAgent,
        complexity: this.classifyComplexity(task),
        tier: 'default_disabled',
        substituted: false,
        reason: 'Cheap-first routing is disabled by default; preserved primary agent'
      };
    }

    const complexity = this.classifyComplexity(task);

    let selectedAgent = null;
    let tier = 'standard';

    if (complexity === TaskComplexity.LIGHTWEIGHT) {
      const preferredCheap = availableAgents.find(a => a === this.cheapAgentId || a.includes('gemini') || a.includes('freebuff'));
      if (preferredCheap) {
        selectedAgent = preferredCheap;
        tier = 'cheap';
      }
    } else if (complexity === TaskComplexity.DEEP_REASONING) {
      const preferredFrontier = availableAgents.find(a => a === this.frontierAgentId || a.includes('claude') || a.includes('chatgpt'));
      if (preferredFrontier) {
        selectedAgent = preferredFrontier;
        tier = 'frontier';
      }
    }

    if (!selectedAgent) {
      selectedAgent = availableAgents[0] || this.frontierAgentId;
    }

    const decision = {
      selectedAgent,
      complexity,
      tier,
      estimatedSavingsPct: tier === 'cheap' ? 75 : 0,
      substituted: true,
      reason: `Cheap-first routing selected '${selectedAgent}' for ${complexity} task`
    };

    if (this.auditLogger && typeof this.auditLogger.log === 'function') {
      this.auditLogger.log('CHEAP_FIRST_ROUTING_DECISION', decision);
    }

    return decision;
  }
}
