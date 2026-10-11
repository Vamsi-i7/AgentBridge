import crypto from 'node:crypto';
import { LifecycleStage } from '../diagnostics/request-tracer.js';

/**
 * Multi-Hop Router & Parallel Fan-Out/Fan-In Coordinator (Mission E)
 *
 * Capabilities:
 * 1. Return-target hop-to-hop forwarding: forwards directly without waking intermediate agents to relay.
 * 2. Fan-out / fan-in: executes N child tasks in parallel and wakes the parent once with all joined results.
 * 3. Cancel propagation: cancelling a parent task propagates cancellation to all active child tasks.
 * 4. Hop/turn limits: strict loop prevention with maxHops ceiling.
 * 5. Correlated tracing: maintains parentRequestId, child attemptIds, and monotonic epochs across hops.
 */
export class MultiHopRouter {
  constructor({ mailboxHub, taskManager, eventBus, tracer = null }) {
    this.mailbox = mailboxHub;
    this.taskManager = taskManager;
    this.eventBus = eventBus;
    this.tracer = tracer || mailboxHub?.tracer || null;
    this.maxHops = 10;
    this.childTasksByParent = new Map(); // parentTaskId -> Set<childTaskId>
  }

  /**
   * Execute an autonomous multi-hop pipeline:
   * Agent A -> Agent B -> Agent C -> ... -> Agent Z
   * Forwards results hop-to-hop without waking intermediate agents merely to relay.
   *
   * @param {object} params
   * @param {Array<string>} params.hops - Array of agent IDs: ['chatgpt-desktop', 'gemini', 'claude-desktop', ...]
   * @param {string} params.initialInput - Initial query or payload
   * @param {string} [params.parentRequestId]
   * @param {number} [params.maxHops=10]
   * @param {number} [params.timeoutPerHopMs=30000]
   * @returns {Promise<object>}
   */
  async executeHopChain({
    hops,
    initialInput,
    parentRequestId = null,
    maxHops = 10,
    timeoutPerHopMs = 30000
  }) {
    if (!Array.isArray(hops) || hops.length === 0) {
      throw new Error('At least one agent hop must be specified.');
    }
    if (hops.length > maxHops) {
      const err = new Error(`HOP_LIMIT_EXCEEDED: Chain length ${hops.length} exceeds max allowed hops ${maxHops}`);
      err.code = 'HOP_LIMIT_EXCEEDED';
      throw err;
    }

    const pReqId = parentRequestId || `req_multihop_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const hopTrace = [];
    let currentPayload = initialInput;

    for (let i = 0; i < hops.length; i++) {
      const currentAgent = hops[i];
      const previousAgent = i === 0 ? 'initiator' : hops[i - 1];
      const hopEpoch = i + 1;
      const hopAttemptId = `att_hop_${i}_${currentAgent}`;
      const hopReqId = `${pReqId}_hop_${i}`;

      this.tracer?.mark?.({
        requestId: pReqId,
        stage: LifecycleStage.ACCEPTED,
        agentId: currentAgent,
        attemptId: hopAttemptId,
        meta: {
          hopIndex: i,
          hopEpoch,
          currentAgent,
          previousAgent,
          isHopForwarding: true
        }
      });

      // Dispatch directly to target agent's mailbox / handler
      const hopResult = await this.mailbox.askAgent({
        fromAgent: previousAgent,
        toAgent: currentAgent,
        question: currentPayload,
        requestId: hopReqId,
        timeoutMs: timeoutPerHopMs
      });

      if (hopResult.status !== 'completed') {
        const failureErr = new Error(`MULTI_HOP_FAILED at hop ${i} (${currentAgent}): ${hopResult.error || hopResult.status}`);
        failureErr.code = 'MULTI_HOP_FAILED';
        failureErr.failedHopIndex = i;
        failureErr.failedAgent = currentAgent;
        failureErr.hopTrace = hopTrace;
        throw failureErr;
      }

      currentPayload = hopResult.response || hopResult.result;
      hopTrace.push({
        hop: i,
        fromAgent: previousAgent,
        toAgent: currentAgent,
        epoch: hopEpoch,
        attemptId: hopAttemptId,
        responseSnippet: typeof currentPayload === 'string' ? currentPayload.slice(0, 100) : null
      });
    }

    return {
      status: 'completed',
      parentRequestId: pReqId,
      totalHops: hops.length,
      finalAgent: hops[hops.length - 1],
      result: currentPayload,
      hopTrace
    };
  }

  /**
   * Fan-Out / Fan-In:
   * Dispatches N child tasks in parallel and joins all results into one payload,
   * waking the parent once when all children finish.
   *
   * @param {object} params
   * @param {string} params.parentTaskId
   * @param {Array<object>} params.childTasks - [{ toAgent, instructions, title }]
   * @param {number} [params.timeoutMs=60000]
   * @returns {Promise<object>}
   */
  async executeFanOutFanIn({
    parentTaskId,
    childTasks,
    timeoutMs = 60000
  }) {
    if (!Array.isArray(childTasks) || childTasks.length === 0) {
      throw new Error('At least one child task must be provided for fan-out.');
    }

    const childrenSet = new Set();
    this.childTasksByParent.set(parentTaskId, childrenSet);

    // 1. Fan-out: create and dispatch all child tasks concurrently
    const childPromises = childTasks.map(async (def, idx) => {
      const task = this.taskManager.createTask({
        title: def.title || `Child Task ${idx + 1} of ${parentTaskId}`,
        instructions: def.instructions,
        fromAgent: def.fromAgent || 'parent_orchestrator',
        toAgent: def.toAgent,
        priority: def.priority || 'normal',
        context: { parentTaskId, childIndex: idx }
      });

      childrenSet.add(task.id);

      const reqId = `req_task_${task.id}`;
      if (this.taskManager?.db) {
        try {
          const now = new Date().toISOString();
          this.taskManager.db.prepare(`
            INSERT INTO bridge_requests (
              request_id, conversation_id, from_agent, to_agent, question,
              task_id, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
          `).run(
            reqId,
            `conv_${parentTaskId}`,
            def.fromAgent || 'parent_orchestrator',
            def.toAgent,
            def.instructions || def.title || `Child Task ${idx + 1}`,
            task.id,
            now,
            now
          );
        } catch {}
      }

      // Wait for child task completion via eventBus
      const outcome = await this.eventBus.waitForResponse({
        requestId: reqId,
        taskId: task.id,
        timeoutMs
      });

      return {
        taskId: task.id,
        toAgent: def.toAgent,
        status: outcome.status,
        result: outcome.response || outcome.result,
        error: outcome.error
      };
    });

    // 2. Fan-in: await all children and join
    const settledChildren = await Promise.all(childPromises);
    this.childTasksByParent.delete(parentTaskId);

    const completed = settledChildren.filter(c => c.status === 'completed');
    const failed = settledChildren.filter(c => c.status !== 'completed');

    return {
      status: failed.length === 0 ? 'completed' : 'partial_failure',
      parentTaskId,
      totalChildren: settledChildren.length,
      completedCount: completed.length,
      failedCount: failed.length,
      results: settledChildren
    };
  }

  /**
   * Cancel Propagation:
   * Cancelling a parent task cascades cancellation to all registered child tasks.
   *
   * @param {string} parentTaskId
   * @param {string} reason
   * @returns {{ cancelledChildrenCount: number }}
   */
  propagateCancel(parentTaskId, reason = 'Parent task was cancelled') {
    const children = this.childTasksByParent.get(parentTaskId);
    let count = 0;
    if (children && children.size > 0) {
      for (const childId of children) {
        try {
          const task = this.taskManager.getTask(childId);
          const callerId = task ? (task.from_agent || task.creator) : 'system';
          this.mailbox.cancelTask({ taskId: childId, agentId: callerId, reason });
          count++;
        } catch {}
      }
      this.childTasksByParent.delete(parentTaskId);
    }
    return { cancelledChildrenCount: count };
  }
}
