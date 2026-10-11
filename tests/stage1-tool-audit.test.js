import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../src/tool-registry.js';
import { generateAuditTable } from '../scripts/audit-tools.js';
import {
  TOOL_SECURITY_CLASSIFICATIONS,
  ToolSecurityCategory,
  getToolSecurityCategory
} from '../src/effects/effects-ledger.js';

test('Stage 1.2: Programmatic tool audit table assertions', async (t) => {
  const reg = new ToolRegistry();
  const regToolNames = Array.from(reg.tools.keys()).sort();
  const table = generateAuditTable();
  const tableToolNames = table.map(r => r.name).sort();

  await t.test('1. Table tool names equal registry names exactly (74 tools)', () => {
    assert.strictEqual(regToolNames.length, 74, 'Registry must have exactly 74 tools');
    assert.strictEqual(tableToolNames.length, 74, 'Audit table must have exactly 74 tools');
    assert.deepStrictEqual(tableToolNames, regToolNames, 'Audit table names must match registry names exactly');
  });

  await t.test('2. All state-mutating and cross-agent tools require authentication', () => {
    for (const row of table) {
      if (
        row.securityCategory === ToolSecurityCategory.STATEFUL_MESSAGING ||
        row.securityCategory === ToolSecurityCategory.CROSS_AGENT_DATA ||
        row.securityCategory === ToolSecurityCategory.WORKSPACE_MUTATING ||
        row.securityCategory === ToolSecurityCategory.SYSTEM_EXECUTING
      ) {
        assert.strictEqual(
          row.authRequired,
          'YES',
          `Tool '${row.name}' categorized as ${row.securityCategory} must require authentication`
        );
        assert.strictEqual(
          row.identitySource,
          'trusted transport / context',
          `Tool '${row.name}' must require trusted transport identity`
        );
      }
    }
  });

  await t.test('3. CI Guard: Every registered tool is mapped in TOOL_SECURITY_CLASSIFICATIONS', () => {
    for (const name of regToolNames) {
      assert.ok(
        TOOL_SECURITY_CLASSIFICATIONS[name],
        `SECURITY VIOLATION: Registered tool '${name}' lacks explicit security classification in TOOL_SECURITY_CLASSIFICATIONS`
      );
    }
  });

  await t.test('4. Cross-agent tools guard check', () => {
    const crossAgentTools = [
      'bridge_ask_agent', 'bridge_send_message', 'bridge_broadcast_message',
      'bridge_delegate_task', 'bridge_claim_task', 'bridge_submit_task_result',
      'bridge_answer_request', 'bridge_get_audit_log', 'bridge_get_events',
      'bridge_request_review', 'bridge_read_file', 'bridge_check_inbox',
      'bridge_get_response', 'bridge_get_request_status', 'bridge_get_pending_requests'
    ];

    for (const catName of crossAgentTools) {
      const category = getToolSecurityCategory(catName);
      assert.ok(
        category === ToolSecurityCategory.STATEFUL_MESSAGING ||
        category === ToolSecurityCategory.CROSS_AGENT_DATA ||
        category === ToolSecurityCategory.WORKSPACE_READ,
        `Tool '${catName}' must be explicitly categorized as stateful, cross-agent, or workspace-read`
      );
    }
  });
});
