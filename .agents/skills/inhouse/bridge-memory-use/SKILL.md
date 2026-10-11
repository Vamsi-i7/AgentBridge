---
name: bridge-memory-use
description: Local FTS5 knowledge store interaction, BM25 query formulation, content provenance, and lifecycle status tracking.
version: 1.0.0
author: Antigravity IDE & Jayanth
license: MIT
riskTier: A
---

# Bridge Memory & Knowledge Use Skill

## Overview
Agent Bridge includes a local-first, durable knowledge store (`KnowledgeStore`) backed by SQLite FTS5 with BM25 ranking. It allows agents to store architectural findings, environment invariants, test outcomes, and project guidelines without consuming external embeddings quota or bloating system prompts.

## Key Principles

1. **Local-First & Zero Quota**: All indexing and searching runs locally in SQLite (`data/bridge.sqlite`). No external LLM calls or vector API embeddings are required.
2. **Compact Ranked Snippets**: `bridge_search_knowledge` returns short, ranked snippets. Full content is fetched on-demand using `bridge_get_knowledge`.
3. **Lifecycle States**:
   - `verified`: Ground truth verified by reproducible commands or test runs.
   - `hypothesis`: Pending empirical confirmation.
   - `obsolete`: Outdated or superseded by new implementation.
   - `failed-experiment`: Documented failure to prevent repeat regressions.
   - `agent-claimed`: Asserted by an agent without external verification.

## Formulating Queries
- Use precise keyword queries rather than conversational sentences for FTS5 BM25 search.
  - Good: `"completion confidence grace recheck"`
  - Poor: `"can you tell me how the observer checks if the response is done"`
- Filter by category (`architecture`, `invariant`, `test_result`, `convention`) to narrow results.

## Storing Verified Findings
When a complex invariant is proved or discovered:
```javascript
// Storing knowledge via MCP tool
{
  "key": "completion-confidence-grace-check-interval",
  "category": "architecture",
  "title": "Response Observer Grace Re-check Interval Scaling",
  "content": "In ResponseObserver, graceRecheckIntervalMs must scale with pollIntervalMs (Math.min(500, pollIntervalMs * 2)) to avoid starving fast unit tests while ensuring production 600ms polling retains full 500ms grace window.",
  "status": "verified",
  "tags": ["control-plane", "response-observer", "grace-check", "timing"]
}
```
