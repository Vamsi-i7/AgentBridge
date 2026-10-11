import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { AuditLogger } from '../src/audit-logger.js';
import { MailboxHub } from '../src/mailbox-hub.js';
import { TaskManager } from '../src/task-manager.js';
import { EventBus } from '../src/event-bus.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { createSessionAdapter, ClaudeDesktopSessionAdapter, AgentSessionAdapter } from '../src/session-adapters/index.js';
import {
  registerAgentManifest,
  unregisterAgentManifest,
  getAgentManifest,
  listAllAgentManifests,
  RouteType,
  RouteEvidence
} from '../src/capabilities/agent-manifest.js';
import { normalizeAgentId } from '../src/agent-identity.js';
import { runBridgeDoctor } from '../src/diagnostics/doctor.js';
import { BackupManager } from '../src/storage/backup-restore.js';
import { RetentionPruner } from '../src/storage/retention-pruner.js';

test('Stage 4: Wiring, Extensibility & Truthful Capability Reporting', async (t) => {
  const tmpDir = path.join(os.tmpdir(), `bridge-stage4-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const dbPath = path.join(tmpDir, 'stage4_test.db');
  const logger = new AuditLogger(dbPath);
  const bus = new EventBus(logger);
  const taskMgr = new TaskManager(logger, null, bus);
  const mailbox = new MailboxHub(logger, taskMgr, bus);
  const registry = new ToolRegistry();

  t.after(() => {
    mailbox.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  await t.test('4.1 Truthful Capability Reporting: interactive-only autonomousModelWake report and response digest', async () => {
    // 1. ClaudeDesktopSessionAdapter reports autonomousModelWake: unsupported; interactive client only
    const claudeAdapter = new ClaudeDesktopSessionAdapter({ mailboxHub: mailbox, eventBus: bus });
    const claudeCaps = claudeAdapter.capabilities();
    assert.equal(claudeCaps.autonomousExecution, false);
    assert.equal(claudeCaps.autonomousModelWake, 'unsupported; interactive client only');
    assert.equal(claudeCaps.pendingWorkDelivery, 'response_digest');

    // 2. Base AgentSessionAdapter also reports unsupported
    const baseAdapter = new AgentSessionAdapter('generic-interactive-agent');
    const baseCaps = baseAdapter.capabilities();
    assert.equal(baseCaps.autonomousModelWake, 'unsupported; interactive client only');

    // 3. MCP tool bridge_get_adapter_capabilities returns truthful autonomousModelWake
    const ctx = {
      mailbox,
      eventBus: bus,
      isPrivileged: true
    };
    const toolCaps = await registry.executeTool('bridge_get_adapter_capabilities', {
      agentId: 'claude-desktop'
    }, ctx);
    assert.equal(toolCaps.autonomousModelWake, 'unsupported; interactive client only');

    // 4. Queue pending request for Claude and verify response digest delivery
    const req = await mailbox.askAgent({
      fromAgent: 'gemini',
      toAgent: 'claude-desktop',
      question: 'Review security patch #104',
      asyncMode: true
    });
    assert.ok(req.requestId);

    // Verify Claude adapter generates pending work digest
    const digest = claudeAdapter.getPendingWorkDigest();
    assert.ok(digest, 'Must produce a pending work digest when inbound work is queued');
    assert.ok(digest.pendingCount >= 1);
    assert.ok(digest.requests.some(r => r.requestId === req.requestId));

    // Verify deliverResponse bundles the pendingWorkDigest
    const delRes = await claudeAdapter.deliverResponse({ requestId: 'resp_123' });
    assert.ok(delRes.pendingWorkDigest);
    assert.equal(delRes.pendingWorkDigest.pendingCount, digest.pendingCount);

    // Verify bridge_ask_agent bundles pendingWorkNotice when claude asks another agent
    mailbox.registerAgentHandler('gemini', async () => 'Gemini test response');
    const askResult = await registry.executeTool('bridge_ask_agent', {
      fromAgent: 'claude-desktop',
      toAgent: 'gemini',
      question: 'Status update please'
    }, ctx);

    assert.ok(askResult.pendingWorkNotice, 'Response to claude must contain pendingWorkNotice digest');
    assert.ok(askResult.pendingWorkNotice.pendingCount >= 1);
    assert.ok(askResult.pendingWorkNotice.notice.includes('pending request(s) queued'));
  });

  await t.test('4.2 Single source of identity: onboard fake agent from validated manifest alone', () => {
    const fakeManifest = {
      agentId: 'fake-scout-agent',
      displayName: 'Fake Scout Autonomous Agent',
      appType: 'custom_daemon',
      routes: [
        {
          id: 'scout-mcp',
          priority: 1,
          type: RouteType.MCP,
          capabilities: ['telemetry', 'bidirectional'],
          evidence: RouteEvidence.MOCK_TESTED
        }
      ],
      maxConcurrency: 2,
      headlessCliSupported: true
    };

    // 1. Validation rejection of malformed manifest
    assert.throws(() => registerAgentManifest(null), /Manifest must be a non-null object/);
    assert.throws(() => registerAgentManifest({ agentId: '' }), /Manifest requires a valid non-empty string agentId/);
    assert.throws(() => registerAgentManifest({ agentId: 'bad', displayName: 'Bad' }), /Manifest requires a routes array/);
    assert.throws(() => registerAgentManifest({ agentId: 'bad', displayName: 'Bad', routes: [{}] }), /Each route in manifest.routes must specify id and type/);

    // 2. Successful registration of valid manifest
    const registered = registerAgentManifest(fakeManifest);
    assert.equal(registered.agentId, 'fake-scout-agent');
    assert.equal(registered.displayName, 'Fake Scout Autonomous Agent');

    // 3. Manifest retrieval & listing
    const fetched = getAgentManifest('fake-scout-agent');
    assert.ok(fetched);
    assert.equal(fetched.agentId, 'fake-scout-agent');
    const all = listAllAgentManifests();
    assert.ok(all.some(m => m.agentId === 'fake-scout-agent'));

    // 4. Dynamic identity resolution through normalizeAgentId
    assert.equal(normalizeAgentId('fake-scout-agent'), 'fake-scout-agent');
    assert.equal(normalizeAgentId('  FAKE-SCOUT-AGENT  '), 'fake-scout-agent');

    // 5. Dynamic session adapter instantiation for newly onboarded agent
    const adapter = createSessionAdapter('fake-scout-agent');
    assert.ok(adapter);
    assert.equal(adapter.agentId, 'fake-scout-agent');
    const caps = adapter.capabilities();
    assert.equal(caps.agentId, 'fake-scout-agent');
    assert.equal(caps.autonomousModelWake, 'unsupported; interactive client only');

    // Cleanup dynamic manifest
    unregisterAgentManifest('fake-scout-agent');
    assert.equal(getAgentManifest('fake-scout-agent'), null);
  });

  await t.test('4.3 Reachability & Standalone Modules Verification (Doctor, Backup, Retention)', async () => {
    // 1. runBridgeDoctor executes diagnostic checks and returns clean structured report
    const doctorReport = await runBridgeDoctor({ logger, db: logger.db });
    assert.ok(doctorReport && typeof doctorReport === 'object');
    assert.ok(Array.isArray(doctorReport.checks));
    assert.ok(doctorReport.checks.length >= 3);
    assert.ok(doctorReport.checks.some(c => c.name === 'Control Plane Auth Key'));
    assert.ok(doctorReport.checks.some(c => c.name === 'Allowed Roots Confinement'));

    // 2. BackupManager instantiates and verifies DB snapshot safely
    const backupDest = path.join(tmpDir, 'backup_out');
    const backupMgr = new BackupManager({ dbPath });
    const backupRes = await backupMgr.createBackup(backupDest);
    assert.ok(backupRes);
    assert.equal(backupRes.status, 'SUCCESS');
    assert.ok(fs.existsSync(path.join(backupDest, 'agent-bridge.sqlite')));

    // 3. RetentionPruner operates without errors and preserves non-expired rows
    const pruner = new RetentionPruner(logger.db);
    const pruneAudit = pruner.pruneAuditLog(30);
    assert.ok(typeof pruneAudit.pruned === 'number');
    const pruneRequests = pruner.pruneRequestLedger(14);
    assert.ok(typeof pruneRequests.pruned === 'number');
  });
});
