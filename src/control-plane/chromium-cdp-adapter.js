import http from 'node:http';
import { BaseRouteAdapter, CompletionEvidenceTier, DeliveryStage } from './route-interface.js';

/**
 * ChromiumCdpAdapter:
 * Full Chromium DevTools Protocol (CDP) route for Electron applications
 * (Claude Desktop, Antigravity IDE, etc.).
 *
 * Connects over WebSocket debugger, injects prompts without stealing focus,
 * streams tokens via network & DOM mutation observation, and terminates on exact
 * NETWORK_END_OF_STREAM evidence.
 */
export class ChromiumCdpAdapter extends BaseRouteAdapter {
  constructor(routeId = 'cdp-chromium', options = {}) {
    super(routeId, options);
    this.port = options.port || 9222;
    this.host = options.host || '127.0.0.1';
    this.targetApp = options.targetApp || 'Chromium';
    this.wsUrl = options.wsUrl || null;
    this.inputSelector = options.inputSelector || 'textarea, div[contenteditable="true"]';
    this.sendButtonSelector = options.sendButtonSelector || 'button[aria-label="Send"], button.send-button, [data-testid="send-button"]';
    this.stopButtonSelector = options.stopButtonSelector || 'button[aria-label="Stop"], button.stop-button';
    this.responseSelector = options.responseSelector || '.response-content, [data-testid="assistant-turn"]';

    this.ws = null;
    this.messageId = 0;
    this.pendingRpc = new Map(); // id -> { resolve, reject }
    this.activeStreams = new Map(); // requestId -> streamState
    this.connected = false;
  }

  /**
   * Launch and attach flags recommended to prevent background throttling in Electron:
   */
  static getBackgroundThrottlingFlags() {
    return [
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding'
    ];
  }

  /**
   * Probe CDP debug port and discover active page targets without stealing focus.
   */
  async probe() {
    return new Promise((resolve) => {
      const req = http.get(`http://${this.host}:${this.port}/json/list`, { timeout: 1000, agent: false, headers: { connection: 'close' } }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            const targets = JSON.parse(data);
            if (!Array.isArray(targets) || targets.length === 0) {
              return resolve({
                ready: false,
                stage: DeliveryStage.CONNECTED,
                reason: 'NO_PAGE_TARGETS_FOUND',
                port: this.port
              });
            }
            const page = targets.find(t => t.type === 'page') || targets[0];
            return resolve({
              ready: true,
              stage: DeliveryStage.READY,
              targetId: page.id,
              webSocketDebuggerUrl: page.webSocketDebuggerUrl,
              title: page.title,
              port: this.port
            });
          } catch (err) {
            return resolve({
              ready: false,
              stage: DeliveryStage.CONNECTED,
              reason: 'INVALID_CDP_RESPONSE',
              error: err.message
            });
          }
        });
      });

      req.on('error', (err) => {
        return resolve({
          ready: false,
          stage: DeliveryStage.DISCONNECTED,
          reason: 'PORT_UNREACHABLE',
          port: this.port,
          error: err.message
        });
      });

      req.on('timeout', () => {
        req.destroy();
        return resolve({
          ready: false,
          stage: DeliveryStage.DISCONNECTED,
          reason: 'PORT_TIMEOUT',
          port: this.port
        });
      });
    });
  }

  /**
   * Establish WebSocket connection to CDP target.
   */
  async connect() {
    if (this.ws && this.connected) return true;

    const probeRes = await this.probe();
    if (!probeRes.ready || !probeRes.webSocketDebuggerUrl) {
      throw new Error(`CDP connection failed: ${probeRes.reason}`);
    }

    const wsUrl = this.wsUrl || probeRes.webSocketDebuggerUrl;

    return new Promise((resolve, reject) => {
      try {
        const WebSocketClass = globalThis.WebSocket;
        if (!WebSocketClass) {
          return reject(new Error('globalThis.WebSocket is not available in Node runtime'));
        }

        this.ws = new WebSocketClass(wsUrl);

        this.ws.onopen = async () => {
          this.connected = true;
          // Enable domains
          try {
            await this.callRpc('Runtime.enable');
            await this.callRpc('Page.enable');
            await this.callRpc('Network.enable');

            // Configure background unthrottling
            await this.callRpc('Runtime.evaluate', {
              expression: `
                try {
                  Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
                  Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
                } catch(e) {}
              `
            });
            resolve(true);
          } catch (initErr) {
            reject(initErr);
          }
        };

        this.ws.onmessage = (event) => {
          this._handleMessage(event.data);
        };

        this.ws.onerror = (err) => {
          this.connected = false;
          if (this.listenerCount('error') > 0) {
            this.emit('error', err);
          }
        };

        this.ws.onclose = () => {
          this.connected = false;
          this.emit('disconnected');
          // Reject any in-flight RPCs
          for (const [id, rpc] of this.pendingRpc.entries()) {
            rpc.reject(new Error('CDP_CONNECTION_LOST'));
          }
          this.pendingRpc.clear();
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Call a CDP method over JSON-RPC.
   */
  async callRpc(method, params = {}) {
    if (!this.ws || !this.connected) {
      await this.connect();
    }

    const id = ++this.messageId;
    return new Promise((resolve, reject) => {
      this.pendingRpc.set(id, { resolve, reject });
      const payload = JSON.stringify({ id, method, params });
      this.ws.send(payload);
    });
  }

  _handleMessage(raw) {
    let msg;
    try {
      msg = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }

    // Response to pending RPC
    if (msg.id && this.pendingRpc.has(msg.id)) {
      const { resolve, reject } = this.pendingRpc.get(msg.id);
      this.pendingRpc.delete(msg.id);
      if (msg.error) {
        reject(new Error(`CDP RPC Error: ${msg.error.message || JSON.stringify(msg.error)}`));
      } else {
        resolve(msg.result);
      }
      return;
    }

    // CDP Events
    if (msg.method) {
      this._handleEvent(msg.method, msg.params);
    }
  }

  _handleEvent(method, params) {
    if (method === 'Network.dataReceived') {
      const { requestId, dataLength } = params;
      for (const [reqId, state] of this.activeStreams.entries()) {
        if (!state.completed) {
          state.bytesReceived += dataLength || 0;
          state.chunksCount++;
          // Trigger observation delta
          state.emitter?.emit('network_chunk', { dataLength });
        }
      }
    } else if (method === 'Network.loadingFinished') {
      const { requestId } = params;
      for (const [reqId, state] of this.activeStreams.entries()) {
        if (!state.completed) {
          state.networkFinished = true;
          this._tryCompleteStream(reqId, CompletionEvidenceTier.NETWORK_END_OF_STREAM);
        }
      }
    } else if (method === 'Page.frameNavigated') {
      // Navigation occurred
      for (const [reqId, state] of this.activeStreams.entries()) {
        if (!state.completed) {
          state.navigated = true;
        }
      }
    }
  }

  _tryCompleteStream(reqId, evidence) {
    const state = this.activeStreams.get(reqId);
    if (!state || state.completed) return;

    state.completed = true;
    if (state.timer) clearTimeout(state.timer);
    if (state.pollInterval) clearInterval(state.pollInterval);

    state.onComplete({
      status: 'completed',
      requestId: reqId,
      response: state.accumulatedText,
      completionConfidence: 'INDICATOR_BASED',
      completionEvidence: evidence,
      durationMs: Date.now() - state.startTime,
      bytesReceived: state.bytesReceived
    });

    this.activeStreams.delete(reqId);
  }

  /**
   * Send prompt into the page input element and click send button without raising window.
   */
  async send(request) {
    if (!this.connected) {
      await this.connect();
    }

    const { requestId, message = '' } = request;
    if (!requestId) throw new Error('requestId is required');

    // Inject prompt without stealing focus or raising window
    const script = `
      (function() {
        const input = document.querySelector(${JSON.stringify(this.inputSelector)});
        if (!input) return { ok: false, error: 'INPUT_NOT_FOUND' };
        if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
          input.value = ${JSON.stringify(message)};
        } else {
          input.innerText = ${JSON.stringify(message)};
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));

        const sendBtn = document.querySelector(${JSON.stringify(this.sendButtonSelector)});
        if (sendBtn && !sendBtn.disabled) {
          sendBtn.click();
          return { ok: true, sent: true };
        }
        return { ok: true, sent: false, note: 'BUTTON_CLICK_WAIT' };
      })()
    `;

    const evalResult = await this.callRpc('Runtime.evaluate', {
      expression: script,
      returnByValue: true
    });

    return {
      accepted: Boolean(evalResult?.result?.value?.ok),
      routeId: this.routeId,
      requestId,
      details: evalResult?.result?.value
    };
  }

  /**
   * Observe response stream over network events and DOM text mutations.
   */
  observe(request, { onChunk = () => {}, onComplete = () => {}, onError = () => {} } = {}) {
    const { requestId, timeoutMs = 60000 } = request;
    const startTime = Date.now();

    const streamState = {
      requestId,
      startTime,
      bytesReceived: 0,
      chunksCount: 0,
      accumulatedText: '',
      networkFinished: false,
      completed: false,
      onChunk,
      onComplete,
      onError,
      timer: null
    };

    if (timeoutMs > 0) {
      streamState.timer = setTimeout(() => {
        if (!streamState.completed) {
          streamState.completed = true;
          this.activeStreams.delete(requestId);
          onError(new Error(`CDP observation timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
    }

    this.activeStreams.set(requestId, streamState);

    // Periodic lightweight DOM pull for partial text rendering without focus
    const pollInterval = setInterval(async () => {
      if (streamState.completed || !this.connected) {
        clearInterval(pollInterval);
        return;
      }

      try {
        const domResult = await this.callRpc('Runtime.evaluate', {
          expression: `
            (function() {
              const nodes = document.querySelectorAll(${JSON.stringify(this.responseSelector)});
              if (!nodes || nodes.length === 0) return '';
              return nodes[nodes.length - 1].innerText || nodes[nodes.length - 1].textContent || '';
            })()
          `,
          returnByValue: true
        });

        const currentText = (domResult?.result?.value || '').trim();
        if (currentText.length > streamState.accumulatedText.length) {
          const delta = currentText.slice(streamState.accumulatedText.length);
          streamState.accumulatedText = currentText;
          onChunk(delta);
        }
      } catch {}
    }, 150);

    streamState.pollInterval = pollInterval;

    return {
      cancel: async () => {
        clearInterval(pollInterval);
        await this.cancel(requestId);
      }
    };
  }

  /**
   * Cancel generation by clicking stop button or terminating stream.
   */
  async cancel(requestId) {
    const state = this.activeStreams.get(requestId);
    if (state) {
      if (state.timer) clearTimeout(state.timer);
      state.completed = true;
      this.activeStreams.delete(requestId);
    }

    try {
      if (this.connected) {
        await this.callRpc('Runtime.evaluate', {
          expression: `
            (function() {
              const stopBtn = document.querySelector(${JSON.stringify(this.stopButtonSelector)});
              if (stopBtn) stopBtn.click();
            })()
          `
        });
      }
    } catch {}

    return true;
  }

  async disconnect() {
    this.connected = false;
    for (const state of this.activeStreams.values()) {
      if (state.timer) clearTimeout(state.timer);
      if (state.pollInterval) clearInterval(state.pollInterval);
    }
    this.activeStreams.clear();
    this.pendingRpc.clear();
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }
}
