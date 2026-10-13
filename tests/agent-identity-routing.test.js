import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

import { AuditLogger } from '../src/audit-logger.js';
import { AgentIdentityManager, normalizeAgentId, canonicalizeTargetAgent, isKnownAgentId, getAliasesFor, AGENT_ALIASES } from '../src/agent-identity.js';
import { registerAgentManifest } from '../src/capabilities/agent-manifest.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { TaskManager } from '../src/task-manager.js';
import { EventBus } from '../src/event-bus.js';
import { PresenceManager } from '../src/presence-manager.js';
import { CONFIG } from '../src/config.js';

test('Stage 1 — Agent Identity, Alias Normalization & Non-Substitution Suite', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-test-'));
  const dbPath = path.join(tmpDir, 'identity.sqlite');
  const logger = new AuditLogger(dbPath);
  const eventBus = new EventBus(logger);
  const taskManager = new TaskManager(logger);
  const presence = new PresenceManager(logger);
  const mailbox = new MailboxHub(logger, taskManager, eventBus);

  t.after(() => {
    eventBus.close();
    logger.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  await t.test('1. Alias normalization maps all supported logical aliases', () => {
    assert.strictEqual(normalizeAgentId('claude'), 'claude-desktop');
    assert.strictEqual(normalizeAgentId('claude-desktop'), 'claude-desktop');
    assert.strictEqual(normalizeAgentId('chatgpt'), 'chatgpt-desktop');
    assert.strictEqual(normalizeAgentId('chatgpt-desktop'), 'chatgpt-desktop');
    assert.strictEqual(normalizeAgentId('antigravity'), 'antigravity-ide');
    assert.strictEqual(normalizeAgentId('antigravity-ide'), 'antigravity-ide');
    assert.strictEqual(normalizeAgentId('gemini'), 'gemini');
    assert.strictEqual(normalizeAgentId('gemini-desktop'), 'gemini');
    assert.strictEqual(normalizeAgentId('google-gemini'), 'gemini');
    assert.strictEqual(normalizeAgentId('freebuff'), 'freebuff');
    assert.strictEqual(normalizeAgentId('zia'), 'zia');
    assert.strictEqual(normalizeAgentId('system'), 'system');
    assert.strictEqual(normalizeAgentId('unknown-bot'), 'unknown-bot');
  });

  await t.test('2. Unbound caller supplying Gemini NEVER falls back to Freebuff', () => {
    const identity = new AgentIdentityManager(logger, null);

    const directGemini = identity.resolveIdentity('gemini');
    assert.strictEqual(directGemini.agentId, 'gemini', 'Direct gemini identity must resolve to gemini');
    assert.notStrictEqual(directGemini.agentId, 'freebuff', 'Gemini must NEVER fall back to freebuff');

    const desktopGemini = identity.resolveIdentity('gemini-desktop');
    assert.strictEqual(desktopGemini.agentId, 'gemini', 'gemini-desktop must normalize and resolve to gemini');
    assert.notStrictEqual(desktopGemini.agentId, 'freebuff');

    const googleGemini = identity.resolveIdentity('google-gemini');
    assert.strictEqual(googleGemini.agentId, 'gemini', 'google-gemini must normalize and resolve to gemini');
    assert.notStrictEqual(googleGemini.agentId, 'freebuff');
  });

  await t.test('3. Unbound caller supplying unknown identity is marked isUnknown and never coerced to Freebuff', () => {
    const identity = new AgentIdentityManager(logger, null);
    const res = identity.resolveIdentity('nonexistent-third-party-agent');
    assert.strictEqual(res.agentId, 'nonexistent-third-party-agent');
    assert.strictEqual(res.isUnknown, true);
    assert.strictEqual(res.method, 'unbound_unknown_identity');
    assert.notStrictEqual(res.agentId, 'freebuff', 'Unknown identities must NOT be coerced to freebuff');
  });

  await t.test('4. Alias normalization emits auditable log entry', () => {
    const identity = new AgentIdentityManager(logger, null);
    identity.resolveIdentity('claude');

    const logRow = logger.db.prepare(`
      SELECT * FROM audit_log WHERE action = 'agent_alias_normalized' AND agent_id = 'claude-desktop' ORDER BY timestamp DESC LIMIT 1
    `).get();

    assert.ok(logRow, 'Audit log must record agent_alias_normalized');
    const details = JSON.parse(logRow.details);
    assert.strictEqual(details.raw, 'claude');
    assert.strictEqual(details.normalized, 'claude-desktop');
  });

  await t.test('5. askAgent with alias routes to canonical worker or handler', async () => {
    mailbox.registerAgentHandler('claude-desktop', async (q) => `Canonical Claude: ${q}`);

    // Call using alias 'claude'
    const res = await mailbox.askAgent({
      fromAgent: 'chatgpt',
      toAgent: 'claude',
      question: 'Hello via alias',
      timeoutMs: 1000
    });

    assert.strictEqual(res.status, 'completed');
    assert.strictEqual(res.response, 'Canonical Claude: Hello via alias');
    assert.strictEqual(res.toAgent, 'claude-desktop');
    assert.strictEqual(res.fromAgent, 'chatgpt-desktop');
  });

  await t.test('6. askAgent with missing target agent fails with EXECUTION_UNSUPPORTED', async () => {
    const res = await mailbox.askAgent({
      fromAgent: 'chatgpt-desktop',
      toAgent: null,
      question: 'Ping',
      timeoutMs: 500
    });

    assert.strictEqual(res.status, 'failed');
    assert.strictEqual(res.mode, 'request_failed');
    assert.ok(res.error.includes('EXECUTION_UNSUPPORTED'), 'Error must explicitly state EXECUTION_UNSUPPORTED');
  });

  await t.test('7. askAgent to agent without active worker stays durably pending and times out truthfully', async () => {
    const res = await mailbox.askAgent({
      fromAgent: 'claude-desktop',
      toAgent: 'chatgpt-desktop',
      question: 'Reply if active worker running',
      timeoutMs: 100
    });

    assert.strictEqual(res.status, 'timeout');
    assert.strictEqual(res.mode, 'request_timeout');
    assert.strictEqual(res.recoverable, true);

    // Verify request stays pending in database
    const req = mailbox.getRequest(res.requestId);
    assert.ok(req);
    assert.strictEqual(req.status, 'pending', 'Timed-out request must stay pending for late recovery');
  });

  await t.test('8. createTask with alias normalizes to_agent on write', () => {
    const task = taskManager.createTask({
      fromAgent: 'chatgpt',
      toAgent: 'claude',
      title: 'Alias write normalization test',
      instructions: 'Verify canonical to_agent'
    });

    assert.strictEqual(task.toAgent, 'claude-desktop');
    assert.strictEqual(task.fromAgent, 'chatgpt-desktop');

    const dbRow = logger.db.prepare('SELECT to_agent, from_agent FROM tasks WHERE id = ?').get(task.id);
    assert.strictEqual(dbRow.to_agent, 'claude-desktop', 'Database row must store canonicalized to_agent');
    assert.strictEqual(dbRow.from_agent, 'chatgpt-desktop', 'Database row must store canonicalized from_agent');
  });

  await t.test('9. canonicalizeTargetAgent enforces required target agent', () => {
    assert.throws(
      () => canonicalizeTargetAgent('', { required: true }),
      (err) => err.code === 'TARGET_AGENT_REQUIRED'
    );
  });

  await t.test('10. Legacy task stored with alias (to_agent=chatgpt) is claimable by canonical worker (chatgpt-desktop)', () => {
    const legacyTaskId = `task_legacy_${Date.now()}`;
    const now = new Date().toISOString();
    logger.db.prepare(`
      INSERT INTO tasks (
        id, created_at, updated_at, from_agent, to_agent, title, instructions,
        status, priority, timeout_ms, max_retries
      ) VALUES (?, ?, ?, 'system', 'chatgpt', 'Legacy Alias Task', 'Claim me', 'pending', 'normal', 60000, 3)
    `).run(legacyTaskId, now, now);

    // Canonical worker claims work
    const claimed = taskManager.claimTask(legacyTaskId, 'chatgpt-desktop');
    assert.ok(claimed, 'Canonical worker must be able to claim task stored with alias');
    assert.strictEqual(claimed.id, legacyTaskId);
    assert.strictEqual(claimed.toAgent, 'chatgpt-desktop', 'Claiming must normalize to_agent to canonical worker identity');

    // Confirm DB row is normalized
    const updatedRow = logger.db.prepare('SELECT to_agent, status FROM tasks WHERE id = ?').get(legacyTaskId);
    assert.strictEqual(updatedRow.to_agent, 'chatgpt-desktop');
    assert.strictEqual(updatedRow.status, 'claimed');
  });

  await t.test('11. Legacy task stored with alias is claimable when worker uses alias on claim', () => {
    const legacyTaskId = `task_legacy_alias_${Date.now()}`;
    const now = new Date().toISOString();
    logger.db.prepare(`
      INSERT INTO tasks (
        id, created_at, updated_at, from_agent, to_agent, title, instructions,
        status, priority, timeout_ms, max_retries
      ) VALUES (?, ?, ?, 'system', 'chatgpt', 'Legacy Alias Claim', 'Claim me via alias', 'pending', 'normal', 60000, 3)
    `).run(legacyTaskId, now, now);

    // Worker claims using alias 'chatgpt'
    const claimed = taskManager.claimTask(legacyTaskId, 'chatgpt');
    assert.ok(claimed, 'Worker claiming via alias must succeed');
    assert.strictEqual(claimed.id, legacyTaskId);
    assert.strictEqual(claimed.toAgent, 'chatgpt-desktop', 'Claiming must normalize to canonical identity');
  });

  await t.test('12. askAgent with alias stores canonicalized request in database', async () => {
    const res = await mailbox.askAgent({
      fromAgent: 'chatgpt',
      toAgent: 'claude',
      question: 'Will this normalize to_agent?',
      asyncMode: true
    });

    assert.ok(res.requestId);
    const row = logger.db.prepare('SELECT to_agent, from_agent FROM bridge_requests WHERE request_id = ?').get(res.requestId);
    assert.strictEqual(row.to_agent, 'claude-desktop', 'Stored to_agent must be canonical');
    assert.strictEqual(row.from_agent, 'chatgpt-desktop', 'Stored from_agent must be canonical');
  });

  await t.test('13. sendMessage with alias normalizes recipient on write', () => {
    const msg = mailbox.sendMessage({
      fromAgent: 'claude',
      toAgent: 'chatgpt',
      subject: 'Alias message',
      content: 'Hello via alias'
    });
    assert.strictEqual(msg.toAgent, 'chatgpt-desktop');
    assert.strictEqual(msg.fromAgent, 'claude-desktop');

    const row = logger.db.prepare('SELECT to_agent, from_agent FROM messages WHERE id = ?').get(msg.id);
    assert.strictEqual(row.to_agent, 'chatgpt-desktop');
    assert.strictEqual(row.from_agent, 'claude-desktop');
  });

  await t.test('14. Dynamic agent registered via registerAgentManifest is recognized and claimable', () => {
    const dynamicAgentId = 'dynamic-custom-agent';
    registerAgentManifest({
      agentId: dynamicAgentId,
      displayName: 'Custom Dynamic Worker',
      appType: 'service',
      bundleId: null,
      appName: null,
      routes: [
        { id: 'mcp-stdio', priority: 1, type: 'mcp', capabilities: ['bidirectional'] }
      ],
      fallbackChain: ['mcp-stdio'],
      maxConcurrency: 2
    });

    assert.strictEqual(isKnownAgentId(dynamicAgentId), true);
    assert.strictEqual(canonicalizeTargetAgent(dynamicAgentId), dynamicAgentId);

    const task = taskManager.createTask({
      fromAgent: 'system',
      toAgent: dynamicAgentId,
      title: 'Dynamic Agent Task',
      instructions: 'Run dynamic work'
    });

    assert.strictEqual(task.toAgent, dynamicAgentId);

    const claimed = taskManager.claimNextTask(dynamicAgentId);
    assert.ok(claimed);
    assert.strictEqual(claimed.id, task.id);
  });

  await t.test('15. scripts/normalize-agent-ids.js dry-run and apply on temporary database', () => {
    const scriptPath = path.join(CONFIG.BRIDGE_ROOT, 'scripts', 'normalize-agent-ids.js');
    const normTestDbPath = path.join(tmpDir, 'norm-test.sqlite');

    // Create fresh test database with legacy rows
    const normLogger = new AuditLogger(normTestDbPath);
    const now = new Date().toISOString();
    normLogger.db.prepare(`
      INSERT INTO tasks (id, created_at, updated_at, from_agent, to_agent, title, instructions, status)
      VALUES ('task_alias_1', ?, ?, 'chatgpt', 'claude', 'Task 1', 'Do work', 'pending')
    `).run(now, now);
    normLogger.db.prepare(`
      INSERT INTO bridge_requests (request_id, conversation_id, from_agent, to_agent, question, status, timeout_ms, created_at, updated_at)
      VALUES ('req_alias_1', 'conv_1', 'chatgpt', 'claude', 'Q1', 'pending', 60000, ?, ?)
    `).run(now, now);
    normLogger.close();

    // 1. Dry run
    const dryRun = spawnSync('node', [scriptPath, normTestDbPath], { encoding: 'utf8' });
    assert.strictEqual(dryRun.status, 0);
    assert.ok(dryRun.stdout.includes('DRY RUN complete'));
    assert.ok(dryRun.stdout.includes('chatgpt-desktop'));
    assert.ok(dryRun.stdout.includes('claude-desktop'));

    // Check DB was NOT modified in dry run
    const checkDb = new AuditLogger(normTestDbPath);
    const preTask = checkDb.db.prepare("SELECT to_agent, from_agent FROM tasks WHERE id = 'task_alias_1'").get();
    assert.strictEqual(preTask.to_agent, 'claude');
    assert.strictEqual(preTask.from_agent, 'chatgpt');
    checkDb.close();

    // 2. Apply
    const applyRun = spawnSync('node', [scriptPath, normTestDbPath, '--apply'], { encoding: 'utf8' });
    assert.strictEqual(applyRun.status, 0);
    assert.ok(applyRun.stdout.includes('Successfully normalized'));

    // Check DB WAS modified
    const postDb = new AuditLogger(normTestDbPath);
    const postTask = postDb.db.prepare("SELECT to_agent, from_agent FROM tasks WHERE id = 'task_alias_1'").get();
    assert.strictEqual(postTask.to_agent, 'claude-desktop');
    assert.strictEqual(postTask.from_agent, 'chatgpt-desktop');

    const postReq = postDb.db.prepare("SELECT to_agent, from_agent FROM bridge_requests WHERE request_id = 'req_alias_1'").get();
    assert.strictEqual(postReq.to_agent, 'claude-desktop');
    assert.strictEqual(postReq.from_agent, 'chatgpt-desktop');
    postDb.close();
  });
});
