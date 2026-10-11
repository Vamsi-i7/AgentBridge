import EventEmitter from 'node:events';
import { probeApplicationUI } from '../../tools/mac-ui-probe/probe.js';

export const ObserverState = Object.freeze({
  IDLE: 'IDLE',
  REQUEST_SENT: 'REQUEST_SENT',
  ASSISTANT_STARTED: 'ASSISTANT_STARTED',
  ASSISTANT_STREAMING: 'ASSISTANT_STREAMING',
  ASSISTANT_COMPLETED: 'ASSISTANT_COMPLETED',
  ASSISTANT_FAILED: 'ASSISTANT_FAILED',
  TIMEOUT: 'TIMEOUT'
});

export const CompletionConfidence = Object.freeze({
  UNKNOWN: 'UNKNOWN',
  EXPLICIT_END_OF_TURN: 'EXPLICIT_END_OF_TURN',
  INDICATOR_BASED: 'INDICATOR_BASED',
  STABILITY_HEURISTIC: 'STABILITY_HEURISTIC',
  AUTHENTICATED_SUBMIT: 'AUTHENTICATED_SUBMIT'
});

/**
 * ResponseObserver:
 * Event-driven response detection and streaming aggregator for macOS AI clients.
 * Emits response_started, response_delta, and response_completed events.
 * Intelligently chunks/aggregates text deltas to prevent flooding model context.
 * Implements rigorous completion confidence classification and post-settle grace re-checks.
 */
export class ResponseObserver extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.pollIntervalMs = options.pollIntervalMs || 600;
    this.deltaAggregationThreshold = options.deltaAggregationThreshold || 40; // min characters for delta
    this.graceRecheckIntervalMs = options.graceRecheckIntervalMs !== undefined
      ? options.graceRecheckIntervalMs
      : Math.min(500, (options.pollIntervalMs || 600) * 2);
    this.alwaysGraceCheck = Boolean(options.alwaysGraceCheck);
    this.activeObservations = new Map(); // requestId -> observationState
    // Injectable UI probe. Defaults to the real accessibility probe; tests and
    // embedding hosts may supply a deterministic probe so completion detection
    // and delivery can be verified without the live desktop applications.
    this.probe = options.probe || probeApplicationUI;
  }

  /**
   * Begin observing target application for a response to requestId.
   */
  startObservation({ targetApp, requestId, timeoutMs = undefined, minStableTicks = undefined, graceRecheckIntervalMs = null, requiredConfidence = null }) {
    if (this.activeObservations.has(requestId)) {
      return this.activeObservations.get(requestId);
    }

    const obs = {
      requestId,
      targetApp,
      state: ObserverState.REQUEST_SENT,
      startTime: Date.now(),
      timeoutMs: timeoutMs !== undefined ? timeoutMs : (this.options.timeoutMs || 90000),
      lastText: '',
      stableTicks: 0,
      minStableTicks: minStableTicks !== undefined ? minStableTicks : (this.options.minStableTicks !== undefined ? this.options.minStableTicks : 3),
      graceRecheckIntervalMs: graceRecheckIntervalMs !== null ? graceRecheckIntervalMs : this.graceRecheckIntervalMs,
      requiredConfidence: requiredConfidence || null,
      observedSignals: new Set(),
      sawGenerating: false,
      inGraceRecheck: false,
      graceTimer: null,
      timer: null,
      completed: false
    };

    this.activeObservations.set(requestId, obs);
    this.emit('response_state', { requestId, state: ObserverState.REQUEST_SENT });

    obs.timer = setInterval(async () => {
      await this._pollTick(obs);
    }, this.pollIntervalMs);

    return obs;
  }

  async _pollTick(obs) {
    if (obs.completed || obs.inGraceRecheck) return;

    if (Date.now() - obs.startTime > obs.timeoutMs) {
      this._finish(obs, ObserverState.TIMEOUT, { error: 'RESPONSE_TIMEOUT' });
      return;
    }

    try {
      const probe = await this.probe(obs.targetApp);
      if (!probe.running || !probe.textRegions || probe.textRegions.length === 0) {
        return;
      }

      // Locate marker snippet [Agent Bridge <requestId>]
      const markerIdx = probe.textRegions.findIndex(r => r.snippet && r.snippet.includes(obs.requestId));
      if (markerIdx < 0) {
        return; // Marker not yet visible in UI text tree
      }

      // Any text regions appearing after marker belong to assistant response
      const followingRegions = probe.textRegions.slice(markerIdx + 1);
      const currentFullText = followingRegions.map(r => r.snippet).join('\n').trim();
      const isGenerating = Boolean(probe.isGenerating || probe.hasStopButton || probe.streaming || probe.isThinking);
      const explicitFinished = Boolean(probe.turnFinished || probe.endOfTurn || probe.isComplete);

      if (isGenerating) {
        obs.sawGenerating = true;
        obs.observedSignals.add('INDICATOR_ACTIVE');
      }
      if (explicitFinished) {
        obs.observedSignals.add('EXPLICIT_END_SIGNAL');
      }

      if (currentFullText.length > 0 && obs.state === ObserverState.REQUEST_SENT) {
        obs.state = ObserverState.ASSISTANT_STARTED;
        this.emit('response_started', { requestId: obs.requestId, targetApp: obs.targetApp });
        this.emit('response_state', { requestId: obs.requestId, state: ObserverState.ASSISTANT_STARTED });
      }

      if (currentFullText.length > obs.lastText.length) {
        const delta = currentFullText.slice(obs.lastText.length);
        obs.state = ObserverState.ASSISTANT_STREAMING;
        obs.lastText = currentFullText;
        obs.stableTicks = 0;

        // Emit aggregated delta
        if (delta.length >= this.deltaAggregationThreshold || followingRegions.length > 1) {
          this.emit('response_delta', {
            requestId: obs.requestId,
            delta,
            accumulatedLength: currentFullText.length
          });
        }
      } else if (currentFullText.length > 0 && currentFullText === obs.lastText && obs.state === ObserverState.ASSISTANT_STREAMING) {
        if (isGenerating && !explicitFinished) {
          obs.stableTicks = 0;
        } else {
          obs.stableTicks = (obs.stableTicks || 0) + 1;
          obs.observedSignals.add(`STABLE_TICKS_${obs.stableTicks}`);
          if (explicitFinished || obs.stableTicks >= obs.minStableTicks) {
            let confidence;
            if (explicitFinished) {
              confidence = CompletionConfidence.EXPLICIT_END_OF_TURN;
            } else if (obs.sawGenerating && !isGenerating) {
              confidence = CompletionConfidence.INDICATOR_BASED;
              obs.observedSignals.add('INDICATOR_CLEARED');
            } else {
              confidence = CompletionConfidence.STABILITY_HEURISTIC;
            }

            const shouldGraceCheck = (confidence === CompletionConfidence.STABILITY_HEURISTIC || this.alwaysGraceCheck) && obs.graceRecheckIntervalMs > 0;

            if (shouldGraceCheck) {
              obs.inGraceRecheck = true;
              const candidateText = currentFullText;
              obs.graceTimer = setTimeout(async () => {
                obs.graceTimer = null;
                if (obs.completed) return;
                try {
                  const graceProbe = await this.probe(obs.targetApp);
                  const markerIdxGrace = graceProbe?.textRegions?.findIndex(r => r.snippet && r.snippet.includes(obs.requestId)) ?? -1;
                  let graceText = candidateText;
                  if (markerIdxGrace >= 0) {
                    const followingGrace = graceProbe.textRegions.slice(markerIdxGrace + 1);
                    graceText = followingGrace.map(r => r.snippet).join('\n').trim();
                  }
                  const graceGenerating = Boolean(graceProbe?.isGenerating || graceProbe?.hasStopButton || graceProbe?.streaming || graceProbe?.isThinking);

                  if (graceText.length > candidateText.length || graceGenerating) {
                    // Growth after settle or generation resumed! Do not settle.
                    obs.inGraceRecheck = false;
                    obs.lastText = graceText;
                    obs.stableTicks = 0;
                    if (graceGenerating) {
                      obs.sawGenerating = true;
                      obs.observedSignals.add('INDICATOR_ACTIVE_RESUMED');
                    }
                    obs.observedSignals.add('GRACE_CHECK_TEXT_GREW');
                    this.emit('grace_check_resumed', {
                      requestId: obs.requestId,
                      previousLength: candidateText.length,
                      newLength: graceText.length,
                      isGenerating: graceGenerating
                    });
                    return;
                  }

                  // Grace re-check confirmed stability
                  obs.inGraceRecheck = false;
                  this._finish(obs, ObserverState.ASSISTANT_COMPLETED, {
                    response: candidateText,
                    durationMs: Date.now() - obs.startTime,
                    completionConfidence: confidence,
                    observedSignals: Array.from(obs.observedSignals),
                    stableTicks: obs.stableTicks,
                    endOfTurnSignal: explicitFinished ? 'EXPLICIT_PROBE' : 'CONSERVATIVE_FALLBACK_STABILITY',
                    graceRecheck: {
                      performed: true,
                      textGrew: false,
                      intervalMs: obs.graceRecheckIntervalMs
                    }
                  });
                } catch (err) {
                  obs.inGraceRecheck = false;
                  this._finish(obs, ObserverState.ASSISTANT_COMPLETED, {
                    response: candidateText,
                    durationMs: Date.now() - obs.startTime,
                    completionConfidence: confidence,
                    observedSignals: Array.from(obs.observedSignals),
                    stableTicks: obs.stableTicks,
                    endOfTurnSignal: explicitFinished ? 'EXPLICIT_PROBE' : 'CONSERVATIVE_FALLBACK_STABILITY',
                    graceRecheck: {
                      performed: true,
                      error: err.message
                    }
                  });
                }
              }, obs.graceRecheckIntervalMs);
              return;
            }

            // Direct completion
            this._finish(obs, ObserverState.ASSISTANT_COMPLETED, {
              response: currentFullText,
              durationMs: Date.now() - obs.startTime,
              completionConfidence: confidence,
              observedSignals: Array.from(obs.observedSignals),
              stableTicks: obs.stableTicks,
              endOfTurnSignal: explicitFinished ? 'EXPLICIT_PROBE' : 'CONSERVATIVE_FALLBACK_STABILITY',
              graceRecheck: {
                performed: false,
                reason: confidence === CompletionConfidence.STABILITY_HEURISTIC ? 'grace_interval_zero' : 'high_confidence_direct'
              }
            });
          }
        }
      }
    } catch (err) {
      // Non-fatal error during tick, continue polling until timeout
    }
  }

  _finish(obs, finalState, details = {}) {
    if (obs.completed) return;
    obs.completed = true;
    obs.state = finalState;
    if (obs.timer) clearInterval(obs.timer);
    if (obs.graceTimer) clearTimeout(obs.graceTimer);
    this.activeObservations.delete(obs.requestId);

    this.emit('response_state', { requestId: obs.requestId, state: finalState, ...details });
    if (finalState === ObserverState.ASSISTANT_COMPLETED) {
      this.emit('response_completed', {
        requestId: obs.requestId,
        targetApp: obs.targetApp,
        response: details.response || obs.lastText,
        durationMs: details.durationMs,
        endOfTurnSignal: details.endOfTurnSignal || (details.completionConfidence === CompletionConfidence.EXPLICIT_END_OF_TURN ? 'EXPLICIT_PROBE' : 'CONSERVATIVE_FALLBACK_STABILITY'),
        completionConfidence: details.completionConfidence || CompletionConfidence.STABILITY_HEURISTIC,
        observedSignals: details.observedSignals || Array.from(obs.observedSignals || []),
        stableTicks: details.stableTicks !== undefined ? details.stableTicks : obs.stableTicks,
        graceRecheck: details.graceRecheck || null
      });
    } else if (finalState === ObserverState.TIMEOUT || finalState === ObserverState.ASSISTANT_FAILED) {
      this.emit('response_failed', {
        requestId: obs.requestId,
        error: details.error || 'OBSERVATION_FAILED'
      });
    }
  }

  cancel(requestId) {
    if (this.activeObservations.has(requestId)) {
      const obs = this.activeObservations.get(requestId);
      if (obs.graceTimer) clearTimeout(obs.graceTimer);
      this._finish(obs, ObserverState.ASSISTANT_FAILED, { error: 'CANCELLED_BY_CALLER' });
      return true;
    }
    return false;
  }
}
