import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeDisplayManager } from '../src/display/bridge-display-manager.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { EventBus } from '../src/event-bus.js';
import { DatabaseSync } from 'node:sqlite';

test('Step 6: Bridge-Owned Display & Live Streaming Suite [TEST-PROVEN]', async (t) => {
  await t.test('1. Partial streaming deltas reach user panel in real time', async () => {
    const display = new BridgeDisplayManager({ notifyOnCommit: false });
    const reqId = 'req_stream_display_1';

    display.startStream(reqId, { fromAgent: 'gemini' });
    display.appendChunk(reqId, 'Hello');
    display.appendChunk(reqId, ' world');

    const state = display.getDisplay(reqId);
    assert.equal(state.displayed, false);
    assert.equal(state.isStreaming, true);
    assert.equal(state.content, 'Hello world');
  });

  await t.test('2. Committed result is visible in the panel the moment it commits', async () => {
    const display = new BridgeDisplayManager({ notifyOnCommit: false });
    const reqId = 'req_stream_display_2';

    display.startStream(reqId);
    display.appendChunk(reqId, 'Calculating 2 + 2...');

    const commitResult = await display.commitResult(reqId, 'The answer is 4.', { fromAgent: 'claude-desktop' });

    assert.equal(commitResult.displayed, true);
    assert.equal(commitResult.content, 'The answer is 4.');

    const panel = display.getDisplay(reqId);
    assert.equal(panel.displayed, true);
    assert.equal(panel.isStreaming, false);
    assert.equal(panel.content, 'The answer is 4.');
  });

  await t.test('3. Initiator tool result sets alreadyDisplayed: true so model does not retype output', async () => {
    const display = new BridgeDisplayManager({ notifyOnCommit: false });
    const outcome = {
      requestId: 'req_tool_disp_3',
      status: 'completed',
      fromAgent: 'chatgpt-desktop',
      response: 'Deterministic computation output: 42'
    };

    const formatted = display.formatToolResult(outcome);
    assert.equal(formatted.alreadyDisplayed, true);
    assert.match(formatted.displayNote, /already displayed in the Bridge panel/);
    assert.match(formatted.envelope, /Deterministic computation output: 42/);
  });

  await t.test('4. Internal progress/heartbeat events are blocked from model context', async () => {
    const display = new BridgeDisplayManager();
    const rawEvents = [
      { id: 1, type: 'heartbeat', agentId: 'gemini' },
      { id: 2, type: 'cursor_tick', cursor: 120 },
      { id: 3, type: 'task_completed', result: 'Success' },
      { id: 4, type: 'internal_watcher_poll', count: 5 },
      { id: 5, type: 'message_received', text: 'Important note' }
    ];

    const safeEvents = display.filterContextSafeEvents(rawEvents);
    assert.equal(safeEvents.length, 2);
    assert.deepEqual(safeEvents.map(e => e.type), ['task_completed', 'message_received']);
  });

  await t.test('5. bridge_wait_for_response commits to panel and returns alreadyDisplayed tool result', async () => {
    const memDb = new DatabaseSync(':memory:');
    const mockLogger = { db: memDb, log: () => {} };
    const eventBus = new EventBus(mockLogger);
    const display = new BridgeDisplayManager({ notifyOnCommit: false });
    const registry = new ToolRegistry();

    const reqId = 'req_wait_panel_5';

    // Arm waiter via tool execution
    const waitPromise = registry.executeTool('bridge_wait_for_response', {
      requestId: reqId,
      timeoutMs: 5000,
      compact: true
    }, {
      eventBus,
      displayManager: display,
      agentId: 'initiator_agent'
    });

    // Durable commit in bridge_requests followed by local dispatch
    memDb.prepare(`
      INSERT INTO bridge_requests (request_id, conversation_id, from_agent, to_agent, question, status, response, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'completed', 'Answer from peer agent', datetime('now'), datetime('now'))
    `).run(reqId, 'conv_1', 'peer_worker', 'initiator_agent', 'test question');

    eventBus.dispatchLocal({
      request_id: reqId,
      status: 'completed',
      response: 'Answer from peer agent',
      from_agent: 'peer_worker'
    });

    const result = await waitPromise;

    // Verify result is committed to user panel
    const panel = display.getDisplay(reqId);
    assert.ok(panel, 'Panel entry must exist');
    assert.equal(panel.displayed, true);
    assert.equal(panel.content, 'Answer from peer agent');

    // Verify tool outcome returned to model has alreadyDisplayed: true
    assert.equal(result.alreadyDisplayed, true);
    assert.match(result.displayNote, /already displayed/);
    assert.match(result.envelope, /Answer from peer agent/);

    memDb.close();
  });
});
