import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../src/tool-registry.js';
import { getToolClassification, EffectClassification } from '../src/effects/effects-ledger.js';

/**
 * CI Guard: Enforces that NO tool classified PURE can return or touch cross-agent
 * sensitive data without an explicit, reviewed security exemption and trusted identity binding.
 */

// Explicit, reviewed exemptions list for PURE tools returning/accessing cross-agent data
export const REVIEWED_CROSS_AGENT_EXEMPTIONS = Object.freeze({
  bridge_request_ledger: {
    reason: 'Read-only ledger inspector; strictly requires trustedCallerAgentId or isPrivileged in handler',
    reviewedDate: '2026-10-11'
  },
  bridge_explain_request: {
    reason: 'Read-only execution explainer; strictly requires trustedCallerAgentId participant match',
    reviewedDate: '2026-10-11'
  },
  bridge_diagnostics: {
    reason: 'Diagnostics and tracing; strictly requires trusted context for requestId or agentId queries',
    reviewedDate: '2026-10-11'
  },
  bridge_wait_for_response: {
    reason: 'Correlated response waiter; strictly verifies trusted context and settlement participant identity',
    reviewedDate: '2026-10-11'
  },
  bridge_get_response: {
    reason: 'Response artifact reader; strictly requires trusted caller participant check',
    reviewedDate: '2026-10-11'
  },
  bridge_get_request_status: {
    reason: 'Request status reader; strictly requires trusted context and participant match',
    reviewedDate: '2026-10-11'
  },
  bridge_get_task_status: {
    reason: 'Task status reader; strictly requires trusted context',
    reviewedDate: '2026-10-11'
  },
  bridge_get_pending_requests: {
    reason: 'Pending work reader; strictly requires trusted context for target agentId',
    reviewedDate: '2026-10-11'
  },
  bridge_check_inbox: {
    reason: 'Agent inbox reader; strictly requires trusted context matching recipient agentId',
    reviewedDate: '2026-10-11'
  },
  bridge_get_events: {
    reason: 'Event bus query; non-privileged callers restricted strictly to their own events',
    reviewedDate: '2026-10-11'
  },
  bridge_claim_task: {
    reason: 'Pending task claim; strictly requires trusted context matching claimant agentId',
    reviewedDate: '2026-10-11'
  },
  bridge_artifact_get: {
    reason: 'Artifact metadata reader; strictly requires trusted caller or privileged in ArtifactStore',
    reviewedDate: '2026-10-11'
  },
  bridge_artifact_read: {
    reason: 'Artifact payload reader; strictly requires trusted caller or privileged in ArtifactStore',
    reviewedDate: '2026-10-11'
  },
  bridge_slice_fetch: {
    reason: 'CAS store content-addressed chunk reader or artifact readChunk with trusted context',
    reviewedDate: '2026-10-11'
  },
  bridge_acknowledge_delivery: {
    reason: 'Delivery acknowledgement; strictly requires trusted context matching recipient',
    reviewedDate: '2026-10-11'
  },
  bridge_answer_request: {
    reason: 'Response delivery tool; caller passes answer payload for its own assigned request',
    reviewedDate: '2026-10-11'
  },
  bridge_submit_task_result: {
    reason: 'Task outcome delivery tool; verified against attempt fencing and assignment',
    reviewedDate: '2026-10-11'
  },
  bridge_get_audit_log: {
    reason: 'Security audit log; strictly requires isPrivileged or allowAuditRead',
    reviewedDate: '2026-10-11'
  },
  bridge_delegate_task: {
    reason: 'Task delegation tool; passes parentTaskId to create task hierarchy',
    reviewedDate: '2026-10-11'
  },
  bridge_ask_agent: {
    reason: 'Inter-agent request dispatcher; creates new request to recipient',
    reviewedDate: '2026-10-11'
  },
  bridge_file_activity_start: {
    reason: 'File activity concurrency marker; attaches taskId to active file access',
    reviewedDate: '2026-10-11'
  }
});

test('CI GUARD: All PURE tools returning cross-agent data must have an explicit reviewed exemption', () => {
  const registry = new ToolRegistry();
  const allToolNames = Array.from(registry.tools.keys());

  // Also include dynamic tools
  const dynamicTools = [
    'bridge_tool_info', 'bridge_request_ledger', 'bridge_explain_request',
    'bridge_wait_for_response', 'bridge_slice_fetch', 'bridge_get_protocol_snippet',
    'bridge_list_skills', 'bridge_skill_load', 'bridge_discover_tools', 'bridge_get_response',
    'bridge_acknowledge_delivery'
  ];
  for (const dt of dynamicTools) {
    if (!allToolNames.includes(dt)) allToolNames.push(dt);
  }

  // Cross-agent private data accessors: tools that expose requests, responses, tasks, artifacts, inbox, ledgers, or audit logs
  const crossAgentEntityRegex = /requestId|taskId|responseId|artifactId/i;

  for (const name of allToolNames) {
    const classification = getToolClassification(name);
    if (classification === EffectClassification.PURE) {
      const toolDef = registry.tools.get(name) || { name };
      const props = toolDef.inputSchema?.properties || {};
      const propNames = Object.keys(props);
      const isCrossAgentAccessor = propNames.some(p => crossAgentEntityRegex.test(p)) ||
        ['bridge_request_ledger', 'bridge_slice_fetch', 'bridge_get_events', 'bridge_get_audit_log', 'bridge_check_inbox', 'bridge_get_pending_requests'].includes(name);

      if (isCrossAgentAccessor) {
        assert.ok(
          REVIEWED_CROSS_AGENT_EXEMPTIONS[name],
          `SECURITY VIOLATION: Tool '${name}' handles cross-agent entity data while classified PURE without an explicit, reviewed exemption in REVIEWED_CROSS_AGENT_EXEMPTIONS.`
        );
      }
    }
  }
});
