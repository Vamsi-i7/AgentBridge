import { EventEmitter } from 'node:events';
import { sendDesktopNotification } from '../session-adapters/desktop-notifier.js';
import { formatCompactResultEnvelope } from '../protocol/compact-envelope.js';

/**
 * BridgeDisplayManager:
 * Bridge-owned user display and live streaming manager.
 * 
 * Invariants & Guarantees:
 * 1. Immediate Display: Full result reaches the panel buffer and notification the moment it commits.
 * 2. Live Partial Streaming: Partial text streams to user-facing panel as it is generated.
 * 3. Token Discipline: Initiator tool result declares `alreadyDisplayed: true`, instructing the model
 *    not to duplicate or retype the response in its chat turn.
 * 4. Model Context Isolation: Internal bridge progress/heartbeat events NEVER enter the model context.
 */
export class BridgeDisplayManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.activeStreams = new Map();   // requestId -> { buffer, startedAt, updatedAt, meta }
    this.committedPanels = new Map(); // requestId -> { displayed: true, content, committedAt, meta }
    this.notifyOnCommit = options.notifyOnCommit !== false;
  }

  /**
   * Start a new streaming display session for a request.
   */
  startStream(requestId, meta = {}) {
    const stream = {
      requestId,
      buffer: '',
      startedAt: Date.now(),
      updatedAt: Date.now(),
      meta,
      isStreaming: true
    };
    this.activeStreams.set(requestId, stream);
    this.emit('stream_started', { requestId, meta });
    return stream;
  }

  /**
   * Append a live partial chunk to the user display buffer.
   */
  appendChunk(requestId, delta) {
    if (!delta) return;
    let stream = this.activeStreams.get(requestId);
    if (!stream) {
      stream = this.startStream(requestId);
    }
    stream.buffer += delta;
    stream.updatedAt = Date.now();
    this.emit('chunk', { requestId, delta, currentBuffer: stream.buffer });
  }

  /**
   * Commit full result the instant durable settlement occurs.
   * Result is visible in the panel immediately before the initiator model's next turn.
   */
  async commitResult(requestId, fullResult, meta = {}) {
    const rawContent = typeof fullResult === 'string'
      ? fullResult
      : (fullResult?.response || fullResult?.result || JSON.stringify(fullResult));

    const panelEntry = {
      requestId,
      displayed: true,
      content: rawContent,
      committedAt: Date.now(),
      meta,
      isStreaming: false
    };

    this.committedPanels.set(requestId, panelEntry);
    this.activeStreams.delete(requestId);

    this.emit('committed', panelEntry);

    // Trigger desktop notification if configured
    if (this.notifyOnCommit && process.platform === 'darwin') {
      try {
        await sendDesktopNotification({
          title: 'Agent Bridge — Response Ready',
          subtitle: meta.fromAgent ? `From ${meta.fromAgent}` : 'Task Completed',
          message: rawContent.slice(0, 150),
          sound: false
        });
      } catch  {
      // swallow-ok: intentional non-fatal error suppression
    }
    }

    return panelEntry;
  }

  /**
   * Get the current panel display state for a request.
   */
  getDisplay(requestId) {
    if (this.committedPanels.has(requestId)) {
      return this.committedPanels.get(requestId);
    }
    if (this.activeStreams.has(requestId)) {
      const s = this.activeStreams.get(requestId);
      return {
        requestId,
        displayed: false,
        content: s.buffer,
        isStreaming: true,
        meta: s.meta
      };
    }
    return null;
  }

  /**
   * Format tool result envelope for the initiator agent.
   * Instructs the model that the full response is already displayed to the user,
   * preventing wasteful token echo in the initiator's subsequent reply.
   */
  formatToolResult(outcome, options = {}) {
    const requestId = outcome?.requestId || 'unknown';
    const rawBody = outcome?.response || outcome?.result || outcome?.error || '';
    const fromAgent = outcome?.fromAgent || outcome?.agentId || 'peer-agent';
    const status = outcome?.status || 'completed';

    const compactEnvelope = formatCompactResultEnvelope({
      status,
      requestId,
      fromAgent,
      body: rawBody,
      casStore: options.casStore || null
    });

    return {
      requestId,
      status,
      alreadyDisplayed: true,
      displayNote: 'The response is already displayed in the Bridge panel. Do NOT duplicate or echo this text in your response.',
      envelope: compactEnvelope,
      content: compactEnvelope
    };
  }

  /**
   * Filter events so that internal bridge heartbeats/status transitions never enter model context.
   * @param {Array<object>} events
   * @returns {Array<object>} User/Model context-safe events only
   */
  filterContextSafeEvents(events) {
    if (!Array.isArray(events)) return [];
    const BLOCKED_TYPES = new Set([
      'heartbeat',
      'cursor_tick',
      'status_transition',
      'canary_probe',
      'lock_acquired',
      'route_health',
      'internal_watcher_poll'
    ]);
    return events.filter(e => !BLOCKED_TYPES.has(e.type || e.action));
  }
}

export const defaultDisplayManager = new BridgeDisplayManager();
