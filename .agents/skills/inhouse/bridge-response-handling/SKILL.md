---
name: bridge-response-handling
description: Three-tier confidence interpretation, verbatim fidelity delivery, and handling unconfirmed transport routes.
version: 1.0.0
author: Antigravity IDE & Jayanth
license: MIT
riskTier: A
---

# Bridge Response Handling Skill

## Overview
When an agent completes a task or responds to an inquiry through Agent Bridge, downstream agents depend on the structural integrity, veracity, and confidence tier of the response. This skill governs how responses are processed, preserved, and delivered.

## Three-Tier Confidence Interpretation

Downstream consumers must inspect the `completionConfidence` field on all returned envelopes:

1. **`EXPLICIT_END_OF_TURN`**:
   - High confidence. The target application UI or engine emitted a definitive end-of-turn signal.
   - Safe for immediate acceptance and downstream mutation.
2. **`INDICATOR_BASED`**:
   - Medium confidence. The target application displayed an active generation/thinking indicator and then cleanly removed it while text stabilized.
   - Safe for task completion and side-effecting operations.
3. **`STABILITY_HEURISTIC`**:
   - Heuristic stillness. Neither explicit turn indicators nor stop buttons were observed; response settled via tick stability.
   - **MUST NOT** be used to trigger irreversible mutations or execute destructive side effects.
   - If the task required side effects, the bridge automatically rejects heuristic completions with `INSUFFICIENT_COMPLETION_CONFIDENCE`.

## Verbatim Delivery Principle

- **Zero Synthesis Inflation**: When a tool result or inter-agent answer is received, return the response verbatim to the caller. Do not re-prompt an LLM to "summarize" or "paraphrase" the answer unless explicitly requested via `assist` mode.
- **Envelope Metadata**: Check `_envelope` or `executionMetadata` for:
  - `responseId`
  - `completionConfidence`
  - `isHeuristic`
  - `observedSignals`
  - `graceRecheck`

## Handling Unconfirmed Routes

- If route delivery status is `SENT_UNCONFIRMED`, never perform a blind fallback to another agent or transport. A message in `SENT_UNCONFIRMED` state may already be executing in the target process. Blind fallback causes duplicate side effects.
- Instead, query `bridge_get_request_status` or wait for the correlation waiter to resolve.
