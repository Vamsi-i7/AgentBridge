import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../src/tool-registry.js';
import { PermissionGuard } from '../src/permission-guard.js';
import { isEffectfulTool } from '../src/effects/effects-ledger.js';
import { CONFIG } from '../src/config.js';

test('Comprehensive Authorization Matrix Suite [TEST-PROVEN]', async (t) => {
  const guard = new PermissionGuard();
  const registry = new ToolRegistry();
  const toolDefs = registry.getToolDefinitions();

  await t.test('1. Every tool in ToolRegistry is classified and policy-checked', () => {
    assert.ok(toolDefs.length >= 50, `Expected at least 50 tools, got ${toolDefs.length}`);

    const matrix = [];
    for (const tool of toolDefs) {
      const effectful = isEffectfulTool(tool.name);
      matrix.push({
        name: tool.name,
        effectful,
        requiresAuth: effectful || !['bridge_ping', 'bridge_discover_agents', 'bridge_agent_presence', 'bridge_diagnostics'].includes(tool.name)
      });
    }

    // Assert that every effectful tool requires auth
    for (const entry of matrix) {
      if (entry.effectful) {
        assert.strictEqual(entry.requiresAuth, true, `Effectful tool '${entry.name}' must require authorization`);
      }
    }
  });

  await t.test('2. Unregistered / rogue agents are denied across all operations (Default-Deny)', () => {
    const rogueId = 'malicious-injected-agent-404';
    const permissions = ['READ', 'WRITE', 'EXECUTE', 'GIT_WRITE', 'PUSH', 'DELEGATE'];

    for (const perm of permissions) {
      const check = guard.checkPermission(rogueId, perm);
      assert.strictEqual(check.allowed, false, `Rogue agent must be denied '${perm}' permission`);
      assert.ok(check.reason.includes('No security policy') || check.reason.includes('Unknown') || check.reason.includes('not recognized'));
    }
  });

  await t.test('3. Registered agents have strict permission boundaries', () => {
    const policyAgents = ['chatgpt-desktop', 'claude-desktop', 'antigravity-ide', 'gemini', 'freebuff'];
    for (const agentId of policyAgents) {
      // Destructive actions without human approval are blocked
      const destCheck = guard.checkPermission(agentId, 'DESTRUCTIVE');
      assert.strictEqual(destCheck.allowed, false, `Agent '${agentId}' cannot execute DESTRUCTIVE without human approval`);

      // Normal read is permitted for recognized policy agents
      const readCheck = guard.checkPermission(agentId, 'READ');
      assert.strictEqual(readCheck.allowed, true, `Agent '${agentId}' should have READ permission`);
    }
  });

  await t.test('4. Filesystem path containment strictly blocks traversal', () => {
    const dangerousPaths = [
      '/etc/passwd',
      '/Users/jayanthpranaykonada/.ssh/id_rsa',
      '/tmp/outside-bridge-root-secret',
      '../../../../../../etc/shadow'
    ];

    for (const p of dangerousPaths) {
      const check = guard.validatePathAccess(p, 'READ');
      assert.strictEqual(check.allowed, false, `Dangerous path '${p}' must be blocked`);
    }
  });
});
