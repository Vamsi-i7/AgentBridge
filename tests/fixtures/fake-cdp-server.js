import http from 'node:http';
import crypto from 'node:crypto';
import EventEmitter from 'node:events';

/**
 * Fake Chromium CDP Test Server (Test Harness / MOCK-ONLY)
 * Serves /json/list HTTP endpoint and CDP WebSocket debugging protocol
 * for local adapter testing without touching real desktop applications.
 */
export class FakeCdpServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.port = options.port || 0;
    this.server = null;
    this.clients = new Set();
    this.pageState = {
      inputValue: '',
      responseText: '',
      isGenerating: false,
      stopped: false
    };
  }

  async start() {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        if (req.url === '/json/list' || req.url === '/json') {
          const addr = this.server.address();
          const target = [{
            id: 'fake_page_target_1',
            type: 'page',
            title: 'Mock Chat Harness',
            url: `http://127.0.0.1:${addr.port}/chat`,
            webSocketDebuggerUrl: `ws://127.0.0.1:${addr.port}/devtools/page/fake_page_target_1`
          }];
          res.writeHead(200, { 'Content-Type': 'application/json', 'Connection': 'close' });
          res.end(JSON.stringify(target));
          return;
        }

        if (req.url === '/chat') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <!DOCTYPE html>
            <html>
            <body>
              <textarea class="chat-input"></textarea>
              <button class="send-button">Send</button>
              <button class="stop-button">Stop</button>
              <div class="response-content"></div>
            </body>
            </html>
          `);
          return;
        }

        res.writeHead(404);
        res.end();
      });

      // WebSocket Upgrade Handler (RFC 6455)
      this.server.on('upgrade', (req, socket, head) => {
        const key = req.headers['sec-websocket-key'];
        if (!key) {
          socket.destroy();
          return;
        }

        const digest = crypto
          .createHash('sha1')
          .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
          .digest('base64');

        const headers = [
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${digest}`
        ];

        socket.write(headers.join('\r\n') + '\r\n\r\n');

        const client = {
          socket,
          sendEvent: (method, params = {}) => {
            this.sendWsFrame(socket, JSON.stringify({ method, params }));
          },
          sendResult: (id, result = {}) => {
            this.sendWsFrame(socket, JSON.stringify({ id, result }));
          },
          sendError: (id, message) => {
            this.sendWsFrame(socket, JSON.stringify({ id, error: { message } }));
          }
        };

        this.clients.add(client);

        socket.on('data', (buffer) => {
          this.handleWsData(client, buffer);
        });

        socket.on('close', () => {
          this.clients.delete(client);
        });

        socket.on('error', () => {
          this.clients.delete(client);
        });
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve({ port: this.port });
      });
    });
  }

  sendWsFrame(socket, text) {
    if (socket.destroyed) return;
    const payload = Buffer.from(text, 'utf8');
    const length = payload.length;

    let header;
    if (length < 126) {
      header = Buffer.from([0x81, length]);
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }

    try {
      socket.write(Buffer.concat([header, payload]));
    } catch {}
  }

  handleWsData(client, buffer) {
    if (buffer.length < 2) return;
    const opcode = buffer[0] & 0x0F;
    if (opcode === 0x08) {
      try {
        client.socket.write(Buffer.from([0x88, 0x00]));
        client.socket.destroy();
      } catch {}
      this.clients.delete(client);
      return;
    }
    const masked = (buffer[1] & 0x80) !== 0;
    let length = buffer[1] & 0x7F;
    let offset = 2;

    if (length === 126) {
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      length = Number(buffer.readBigUInt64BE(2));
      offset = 10;
    }

    let mask = null;
    if (masked) {
      mask = buffer.slice(offset, offset + 4);
      offset += 4;
    }

    const payload = buffer.slice(offset, offset + length);
    if (masked && mask) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= mask[i % 4];
      }
    }

    const text = payload.toString('utf8');
    try {
      const msg = JSON.parse(text);
      this.handleCdpMessage(client, msg);
    } catch {}
  }

  handleCdpMessage(client, msg) {
    const { id, method, params } = msg;

    if (method === 'Runtime.enable' || method === 'Page.enable' || method === 'Network.enable') {
      client.sendResult(id, {});
      return;
    }

    if (method === 'Runtime.evaluate') {
      const expr = params?.expression || '';

      if (expr.includes('document.querySelector')) {
        if (expr.includes('.stop-button')) {
          this.pageState.stopped = true;
          this.pageState.isGenerating = false;
          client.sendResult(id, { result: { value: { stopped: true } } });
          return;
        }

        if (expr.includes('input.value =') || expr.includes('sendBtn.click()')) {
          this.pageState.isGenerating = true;
          this.pageState.stopped = false;
          this.emit('prompt_sent', params);
          client.sendResult(id, { result: { value: { ok: true, sent: true } } });
          return;
        }

        if (expr.includes('response-content')) {
          client.sendResult(id, { result: { value: this.pageState.responseText } });
          return;
        }
      }

      client.sendResult(id, { result: { value: true } });
      return;
    }

    client.sendResult(id, {});
  }

  // Simulation helpers for tests
  simulateNetworkChunk(text) {
    this.pageState.responseText += text;
    const len = Buffer.byteLength(text, 'utf8');
    for (const client of this.clients) {
      client.sendEvent('Network.dataReceived', { requestId: 'net_1', dataLength: len });
    }
  }

  simulateLoadingFinished() {
    this.pageState.isGenerating = false;
    for (const client of this.clients) {
      client.sendEvent('Network.loadingFinished', { requestId: 'net_1', timestamp: Date.now() });
    }
  }

  simulatePageNavigation() {
    for (const client of this.clients) {
      client.sendEvent('Page.frameNavigated', { frame: { id: 'frame_1', url: 'http://127.0.0.1/chat?reload=1' } });
    }
  }

  simulateConnectionLoss() {
    for (const client of this.clients) {
      try { client.socket.destroy(); } catch {}
    }
    this.clients.clear();
  }

  async close() {
    for (const client of this.clients) {
      try { client.socket.destroy(); } catch {}
    }
    this.clients.clear();
    return new Promise((resolve) => {
      if (this.server) {
        if (typeof this.server.closeAllConnections === 'function') {
          this.server.closeAllConnections();
        }
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}
