/**
 * StageActionError produces structured, actionable error messages naming the exact
 * failure stage and the prescriptive next action for agents and human operators.
 *
 * Format: [STAGE: <stage>] <cause>. NEXT ACTION: <action>
 */
export class StageActionError extends Error {
  constructor(stage, cause, nextAction, code = 'STAGE_FAILURE') {
    const formatted = `[STAGE: ${stage}] ${cause}. NEXT ACTION: ${nextAction}`;
    super(formatted);
    this.name = 'StageActionError';
    this.stage = stage;
    this.causeMessage = cause;
    this.nextAction = nextAction;
    this.code = code;
  }

  static timeout(stage = 'execution', timeoutMs = 30000) {
    return new StageActionError(
      stage,
      `Request timed out after ${timeoutMs}ms without receiving completion evidence`,
      'Increase timeoutMs in delegation parameters or verify target agent is not blocked by a modal dialog',
      'ERR_STAGE_TIMEOUT'
    );
  }

  static unreachable(agentId, route = 'mcp') {
    return new StageActionError(
      'delivery',
      `Target agent '${agentId}' is unreachable via ${route} route`,
      `Invoke bridge_agent_presence to inspect route health, or restart the ${agentId} process`,
      'ERR_STAGE_UNREACHABLE'
    );
  }

  static nonceMismatch(expected, received) {
    return new StageActionError(
      'correlation',
      `Cryptographic nonce mismatch: expected '${expected}', received '${received}'`,
      'Reject untrusted completion and re-issue the request with a fresh V2 nonce',
      'ERR_STAGE_NONCE_MISMATCH'
    );
  }

  static duplicateSettlement(attemptToken) {
    return new StageActionError(
      'fencing',
      `Duplicate completion rejected by attempt/epoch fencing for token '${attemptToken}'`,
      'No action required: the first verified completion has already settled and cannot be overwritten',
      'ERR_STAGE_FENCING_REJECTED'
    );
  }

  static cancelled(reason = 'Operator cancelled') {
    return new StageActionError(
      'execution',
      `Task execution halted due to cancellation: ${reason}`,
      'Check cancellation reason in audit log and re-issue with a new correlationId if desired',
      'ERR_STAGE_CANCELLED'
    );
  }

  static budgetExceeded(budgetType, ceiling) {
    return new StageActionError(
      'budget',
      `Collaboration halted: ${budgetType} exceeded ceiling (${ceiling})`,
      'Inspect collaboration graph for ping-pong loops or raise per-collaboration budget in configuration',
      'ERR_STAGE_BUDGET_EXCEEDED'
    );
  }
}
