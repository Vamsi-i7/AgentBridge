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
import { PermissionGuard } from '../src/permission-guard.js';
import { CONFIG } from '../src/config.js';
import { normalizeAgentId } from '../src/agent-identity.js';
import { CapabilityRegistry, CapabilityDimension, CapabilityState } from '../src/capabilities/capability-registry.js';
import {
  registerAgentManifest,
  unregisterAgentManifest,
  getAgentManifest,
  listAllAgentManifests,
  RouteType,
  RouteEvidence
} from '../src/capabilities/agent-manifest.js';
import { createSessionAdapter } from '../src/session-adapters/index.js';
import { WorkerSupervisor } from '../src/control-plane/worker-supervisor.js';
import { AutonomousCollaborationOrchestrator } from '../src/control-plane/autonomous-collaboration-orchestrator.js';
import { runBridgeDoctor } from '../src/diagnostics/doctor.js';
import { BackupManager } from '../src/storage/backup-restore.js';
import { RetentionPruner } from '../src/storage/retention-pruner.js';

test('Stage 5: Responder Truthfulness, Single Agent Manifest, and Wiring Reachability', async (t) => {
  const tmpDir = path.join(os.tmpdir(), `stage5-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const dbPath = path.join(tmpDir, 'stage5_test.db');
  const logger = new AuditLogger(dbPath);
  const bus = new EventBus(logger);
  const taskMgr = new TaskManager(logger, null, bus);
  const mailbox = new MailboxHub(logger, taskMgr, bus);
  const registry = new ToolRegistry();
  const capRegistry = new CapabilityRegistry(logger);

  t.after(() => {
    mailbox.close();
    logger.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  await t.test('5.1 Responder Truthfulness & Capability Reporting', async () => {
    // 1. Adapter capabilities reporting for antigravity, antigravity-ide, and freebuff
    for (const agentId of ['antigravity', 'antigravity-ide', 'freebuff']) {
      const adapter = createSessionAdapter(agentId, { mailboxHub: mailbox, eventBus: bus });
      const caps = adapter.capabilities();
      assert.strictEqual(
        caps.autonomousModelWake,
        'unsupported; interactive client only',
        `Adapter for ${agentId} must truthfully report autonomousModelWake: unsupported; interactive client only`
      );
    }

    // 2. Tool bridge_get_adapter_capabilities reporting
    const ctx = { mailbox, eventBus: bus, capabilityRegistry: capRegistry, isPrivileged: true };
    for (const agentId of ['antigravity', 'antigravity-ide', 'freebuff']) {
      const toolCaps = await registry.executeTool('bridge_get_adapter_capabilities', { agentId }, ctx);
      assert.strictEqual(
        toolCaps.autonomousModelWake,
        'unsupported; interactive client only',
        `bridge_get_adapter_capabilities for ${agentId} must report autonomousModelWake: unsupported; interactive client only`
      );
    }

    // 3. CapabilityRegistry live probe reporting
    for (const agentId of ['antigravity', 'antigravity-ide', 'freebuff']) {
      await capRegistry.probe(agentId, 'ide-direct');
      const wakeCap = capRegistry.getCapability(agentId, 'ide-direct', CapabilityDimension.AUTONOMOUS_WAKEUP);
      assert.strictEqual(wakeCap.state, CapabilityState.UNSUPPORTED);
      assert.match(wakeCap.evidence, /autonomous model wake: unsupported, interactive client only/);
    }

    // 4. Request to them returns queued-awaiting-pull with status pending, never synthetic or canned
    const req = await mailbox.askAgent({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'antigravity-ide',
      question: 'Run architecture check on bridge',
      asyncMode: true
    });
    assert.strictEqual(req.status, 'pending');
    assert.strictEqual(req.deliveryState, 'queued-awaiting-pull');
    assert.strictEqual(req.mode, 'queued_in_mailbox');
    assert.strictEqual(req.response, undefined, 'Must not return synthetic or canned response');

    // 5. Verify canned "zia" handler cannot answer in default/production path
    assert.strictEqual(mailbox.agentHandlers.has('zia'), false, 'Default/production path must have NO canned zia handler');
    const ziaReq = await mailbox.askAgent({
      fromAgent: 'chatgpt-desktop',
      toAgent: 'zia',
      question: 'Summarize Zia core state',
      asyncMode: true
    });
    assert.strictEqual(ziaReq.status, 'pending');
    assert.strictEqual(ziaReq.deliveryState, 'queued-awaiting-pull');
    assert.strictEqual(ziaReq.response, undefined, 'Zia request must be queued, never answered by canned stub');

    // 6. Deliver pending-work notices by appending compact digest to tool responses
    // When antigravity-ide calls bridge_ask_agent, it receives a pendingWorkNotice for the above queued items
    const askNoticeResult = await registry.executeTool('bridge_ask_agent', {
      fromAgent: 'antigravity-ide',
      toAgent: 'chatgpt-desktop',
      question: 'Ping from antigravity',
      asyncMode: true
    }, ctx);
    assert.ok(askNoticeResult.pendingWorkNotice, 'Must include pendingWorkNotice for recipient with queued work');
    assert.ok(askNoticeResult.pendingWorkNotice.pendingCount >= 1);
    assert.ok(askNoticeResult.pendingWorkNotice.items.some(it => it.requestId === req.requestId));
  });

  await t.test('5.2 Single Agent Manifest feeds permission-guard, config, worker-supervisor, agent-identity, orchestrator', async () => {
    const fakeAgentId = 'synthetic-scout-agent';
    const fakeManifest = {
      agentId: fakeAgentId,
      displayName: 'Synthetic Scout Worker',
      appType: 'custom_daemon',
      routes: [
        {
          id: 'scout-route-mcp',
          priority: 1,
          type: RouteType.MCP,
          capabilities: ['telemetry', 'bidirectional'],
          evidence: RouteEvidence.MOCK_TESTED
        }
      ],
      maxConcurrency: 2,
      headlessCliSupported: true
    };

    // 1. Register manifest dynamically
    const registered = registerAgentManifest(fakeManifest);
    assert.strictEqual(registered.agentId, fakeAgentId);

    // 2. Feeds CONFIG.AGENT_IDENTITIES
    assert.ok(
      CONFIG.AGENT_IDENTITIES.includes(fakeAgentId),
      'CONFIG.AGENT_IDENTITIES must dynamically include newly registered manifest agent'
    );

    // 3. Feeds agent-identity: normalizeAgentId
    assert.strictEqual(normalizeAgentId(fakeAgentId), fakeAgentId);
    assert.strictEqual(normalizeAgentId(`  ${fakeAgentId.toUpperCase()}  `), fakeAgentId);

    // 4. Feeds PermissionGuard: recognized identity but DEFAULT-DENY permissions
    const guard = new PermissionGuard(CONFIG);
    const validCheck = guard.validateAgent(fakeAgentId);
    assert.strictEqual(validCheck.allowed, true, 'Agent identity must be recognized from manifest');

    // Default-deny: no policy exists in agentPolicies, so every permission must be denied
    const writeCheck = guard.checkPermission(fakeAgentId, 'WRITE');
    assert.strictEqual(writeCheck.allowed, false);
    assert.match(writeCheck.reason, /No security policy defined/);

    const execCheck = guard.checkPermission(fakeAgentId, 'EXECUTE');
    assert.strictEqual(execCheck.allowed, false);
    assert.match(execCheck.reason, /No security policy defined/);

    // 5. Feeds WorkerSupervisor: script resolution & registration
    const supervisor = new WorkerSupervisor({ bridgeRoot: tmpDir, dataDir: tmpDir });
    const fakeScript = path.join(tmpDir, 'fake-worker.js');
    fs.writeFileSync(fakeScript, '// fake worker\n');
    supervisor.registerWorkerScript(fakeAgentId, fakeScript);
    assert.strictEqual(supervisor.workerScripts[fakeAgentId], fakeScript);

    // 6. Feeds AutonomousCollaborationOrchestrator: default candidate pool includes manifest agent
    capRegistry.setCapability({
      agentId: fakeAgentId,
      routeId: 'scout-route-mcp',
      dimension: CapabilityDimension.MODEL_EXECUTION,
      state: CapabilityState.VERIFIED
    });
    const orchestrator = new AutonomousCollaborationOrchestrator({
      logger,
      db: logger.db,
      capabilityRegistry: capRegistry
    });
    const candidateResult = orchestrator.selectBestAgent({
      preferredAgent: fakeAgentId,
      verifyLiveness: false
    });
    assert.strictEqual(candidateResult.selectedAgent, fakeAgentId);

    // Clean up dynamic manifest
    unregisterAgentManifest(fakeAgentId);
    assert.strictEqual(getAgentManifest(fakeAgentId), null);
    assert.strictEqual(CONFIG.AGENT_IDENTITIES.includes(fakeAgentId), false);
  });

  await t.test('5.3 Standalone Modules Verification (Doctor, Backup, Retention)', async () => {
    // 1. runBridgeDoctor
    const doctorReport = await runBridgeDoctor({ logger, db: logger.db });
    assert.ok(doctorReport && typeof doctorReport === 'object');
    assert.ok(Array.isArray(doctorReport.checks));
    assert.ok(doctorReport.checks.length >= 3);

    // 2. BackupManager
    const backupDest = path.join(tmpDir, 'backup_verify');
    const backupMgr = new BackupManager({ dbPath });
    const backupRes = await backupMgr.createBackup(backupDest);
    assert.ok(backupRes);
    assert.strictEqual(backupRes.status, 'SUCCESS');
    assert.ok(fs.existsSync(path.join(backupDest, 'agent-bridge.sqlite')));

    // 3. RetentionPruner
    const pruner = new RetentionPruner(logger.db);
    const pruneAudit = pruner.pruneAuditLog(30);
    assert.strictEqual(typeof pruneAudit.pruned, 'number');
    const pruneRequests = pruner.pruneRequestLedger(14);
    assert.strictEqual(typeof pruneRequests.pruned, 'number');
  });
});
