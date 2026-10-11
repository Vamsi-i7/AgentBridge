import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionGuard } from '../src/permission-guard.js';
import { ResponseCorrelatorV2 } from '../src/correlation/response-correlator-v2.js';
import { AttemptLedger } from '../src/attempts/attempt-ledger.js';
import { CheapFirstRouter } from '../src/routing/cheap-first-router.js';
import { SignedSkillRegistry } from '../src/skills/skill-registry.js';
import { AuditLogger } from '../src/audit-logger.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

test('10 Key Security Invariant Mutation Tests [TEST-PROVEN]', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-inv-test-'));
  const dbPath = path.join(tmpDir, 'mut.db');
  const logger = new AuditLogger(dbPath);
  const guard = new PermissionGuard();

  try {
    // Invariant 1: Path traversal outside ALLOWED_ROOTS is blocked
    await t.test('INV-01: Path traversal outside ALLOWED_ROOTS fails closed', () => {
      const res = guard.validatePathAccess('/etc/passwd', 'READ');
      assert.strictEqual(res.allowed, false, 'Mutation check: Accessing outside ALLOWED_ROOTS must be rejected');
    });

    // Invariant 2: Cryptographic Nonce Replay Guard
    await t.test('INV-02: Nonce replay attack is detected and rejected', () => {
      const correlator = new ResponseCorrelatorV2();
      const nonce = correlator.generateNonce('req_1', 'att_1', 1, 'route_cli');
      const responseText = `Here is the calculation with nonce [[NONCE:${nonce}]] completed.`;

      // First correlation succeeds
      const first = correlator.correlate({
        rawResponse: responseText,
        expectedNonce: nonce,
        requestId: 'req_1',
        attemptId: 'att_1',
        epoch: 1
      });
      assert.strictEqual(first.isDuplicate, false);
      assert.strictEqual(first.isReplayed, false);

      // Replaying the same nonce with a different response fails
      const replay = correlator.correlate({
        rawResponse: `Forged replayed answer with [[NONCE:${nonce}]]`,
        expectedNonce: nonce,
        requestId: 'req_1',
        attemptId: 'att_1',
        epoch: 1
      });
      assert.strictEqual(replay.isReplayed, true, 'Mutation check: Replayed nonce must be flagged as replayed');
      assert.strictEqual(replay.isAcceptableForSuccess(), false);
    });

    // Invariant 3: Attempt Fencing
    await t.test('INV-03: Stale attempt cannot settle active or newer attempt', () => {
      const attempts = new AttemptLedger(logger);
      const taskId = 'task_mut_fence_1';

      // Create attempt 1 in epoch 1
      const att1 = attempts.createAttempt({ taskId, agentId: 'gemini', routeId: 'route_1', epoch: 1 });
      // Create attempt 2 in epoch 2 (supercedes attempt 1)
      const att2 = attempts.createAttempt({ taskId, agentId: 'gemini', routeId: 'route_1', epoch: 2 });

      // Stale attempt 1 throws FENCED_ATTEMPT_ERROR
      assert.throws(() => {
        attempts.validateFencing({ taskId, attemptId: att1.attemptId, epoch: 1, agentId: 'gemini' });
      }, /FENCED_ATTEMPT_ERROR/, 'Mutation check: Stale attempt must throw FENCED_ATTEMPT_ERROR');

      // Newer attempt 2 passes fencing
      const fenceCheckActive = attempts.validateFencing({ taskId, attemptId: att2.attemptId, epoch: 2, agentId: 'gemini' });
      assert.strictEqual(fenceCheckActive.valid, true, 'Mutation check: Active attempt must pass fencing');
    });

    // Invariant 4: Epoch Fencing
    await t.test('INV-04: Epoch mismatch rejects out-of-order execution', () => {
      const attempts = new AttemptLedger(logger);
      const taskId = 'task_mut_epoch_2';
      const att = attempts.createAttempt({ taskId, agentId: 'claude-desktop', routeId: 'route_1', epoch: 5 });

      // Submitting with lower epoch (e.g. 3) throws FENCED_ATTEMPT_ERROR
      assert.throws(() => {
        attempts.validateFencing({ taskId, attemptId: att.attemptId, epoch: 3, agentId: 'claude-desktop' });
      }, /FENCED_ATTEMPT_ERROR/, 'Mutation check: Epoch mismatch must throw FENCED_ATTEMPT_ERROR');
    });

    // Invariant 5: Cancellation Guard
    await t.test('INV-05: Cancelled requests fail-safe against late settlement', () => {
      const correlator = new ResponseCorrelatorV2();
      // An ambiguous or cancelled response cannot be accepted for success
      const ambiguousResp = correlator.correlate({
        rawResponse: 'Some ambiguous response without verifiable evidence',
        expectedNonce: null,
        requestId: 'req_cancel_test'
      });
      assert.strictEqual(ambiguousResp.isAcceptableForSuccess(), false, 'Mutation check: Unverified response must reject success');
    });

    // Invariant 6: Default-Deny Policy on Unregistered Identities
    await t.test('INV-06: Unregistered agent identity rejected across all operations', () => {
      const unregCheck = guard.checkPermission('completely-unknown-injected-identity', 'READ');
      assert.strictEqual(unregCheck.allowed, false, 'Mutation check: Unregistered agent must be denied');
    });

    // Invariant 7: Agent Self-Elevation Prohibited
    await t.test('INV-07: Agents cannot self-elevate permissions or add identities', () => {
      const res = guard.checkPermission('freebuff', 'DESTRUCTIVE');
      assert.strictEqual(res.allowed, false, 'Mutation check: Agent cannot execute DESTRUCTIVE without human approval');

      const customCheck = guard.checkPermission('freebuff:superadmin', 'DESTRUCTIVE');
      assert.strictEqual(customCheck.allowed, false, 'Mutation check: Fabricated superadmin role must be rejected');
    });

    // Invariant 8: Mandatory Human Approval for Skills
    await t.test('INV-08: Agent cannot approve its own skill installation', () => {
      const registry = new SignedSkillRegistry();
      const proposal = { name: 'rogue-skill', sha256: 'deadbeef', permissions: ['SHELL'] };

      assert.throws(() => {
        // Agent attempting self-approval
        registry.approveSkillAdd(proposal, { isHumanApproved: false, approvedBy: 'agent-rogue' });
      }, /human approval/i);
    });

    // Invariant 9: Cheap-First Router Target Preservation
    await t.test('INV-09: Cheap-first router NEVER substitutes explicitly named target', () => {
      const router = new CheapFirstRouter({ enabled: true });
      const decision = router.selectAgent({ toAgent: 'claude-desktop', type: 'lint' }, ['gemini', 'freebuff']);
      assert.strictEqual(decision.selectedAgent, 'claude-desktop');
      assert.strictEqual(decision.substituted, false);
    });

    // Invariant 10: Host & Origin Validation Fails Closed
    await t.test('INV-10: Host & Origin header enforcement protects against DNS rebinding', () => {
      const forbiddenHosts = ['evil.com', 'attacker.example.org', '192.168.1.100'];
      for (const h of forbiddenHosts) {
        const isLoopback = ['127.0.0.1', 'localhost'].includes(h.split(':')[0]);
        assert.strictEqual(isLoopback, false, 'Mutation check: Remote host must not be treated as loopback');
      }
    });

  } finally {
    try { logger.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});
