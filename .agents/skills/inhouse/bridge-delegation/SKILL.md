---
name: bridge-delegation
description: Multi-agent task delegation patterns, bounds checking, recursion limits, and lifecycle tracking across Agent Bridge.
version: 1.0.0
author: Antigravity IDE & Jayanth
license: MIT
riskTier: A
---

# Bridge Delegation Skill

## Overview
Agent Bridge enables autonomous agents (Antigravity, Claude Desktop, ChatGPT Desktop, Gemini, Freebuff) to delegate tasks across application and system boundaries. This skill defines the canonical protocol for initiating, tracking, bounding, and claiming delegated tasks.

## Core Rules

1. **Explicit Targeting**: Always address tasks to a specific, registered agent identifier (`chatgpt-desktop`, `claude-desktop`, `antigravity-ide`, `gemini`, `freebuff`). Never delegate to unregistered arbitrary identities.
2. **Authority Fencing**: An agent cannot delegate authority it does not possess. Delegations inherit the security policy, workspace boundaries, and permissions of the originating caller.
3. **Delegation Depth Limits**: Prevent infinite delegation loops. Tasks carry a `delegationDepth` counter. The bridge rejects delegations exceeding depth limit (default: 4 hops).
4. **Idempotency**: All delegations MUST include a deterministic `dedupKey` or `taskId`. Concurrent submissions with identical parameters return the existing task rather than creating duplicate execution records.

## Usage Workflow

### 1. Delegating a Task via MCP
```javascript
// Example tool call payload for bridge_delegate_task
{
  "toAgent": "claude-desktop",
  "title": "Perform static review of response observer",
  "instructions": "Inspect response-observer.js for race conditions between poll intervals and grace timers.",
  "priority": "high",
  "timeoutMs": 60000,
  "context": {
    "targetFiles": ["src/control-plane/response-observer.js"],
    "requiresReview": true,
    "hasSideEffects": false
  }
}
```

### 2. Checking Task Status
Use `bridge_get_task_status` with the returned `taskId` to observe state transitions (`pending` -> `claimed` -> `running` -> `completed` / `failed`).

### 3. Claiming & Submitting
Workers claim via `bridge_claim_task({ taskId, agentId })` and submit via `bridge_submit_task_result({ taskId, result, completionConfidence })`.

## Anti-Patterns to Avoid
- **Synthetic Simulation**: Never pretend another agent replied. If an agent is offline or fails, report truthfully as `OFFLINE` or `FAILED`.
- **Side-Effect Escalation**: Never delegate a mutating task without declaring `hasSideEffects: true` in context.
