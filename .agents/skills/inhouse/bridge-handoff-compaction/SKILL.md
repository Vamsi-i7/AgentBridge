---
name: bridge-handoff-compaction
description: Session compaction survival, persistent handoff artifact conventions, and ground truth re-anchoring across agent turns.
version: 1.0.0
author: Antigravity IDE & Jayanth
license: MIT
riskTier: A
---

# Bridge Handoff Compaction Skill

## Overview
Long-running multi-agent tasks inevitably encounter context compaction or session boundaries. This skill defines the mandatory protocol for ensuring operational state survives context truncation without loss of progress or regression.

## Core Rules

1. **Persistent Handoff Root**: All handoff documents, ground truth states, and stage logs must be written to disk under `/Users/jayanthpranaykonada/agent-bridge-handoff/`.
2. **Deterministic File Naming**:
   - `antigravity-m<mission>-<stage>-<topic>.md` (e.g. `antigravity-m5-0-groundtruth.md`, `antigravity-m5-1-completion-confidence.md`)
   - `pre-restart-snapshot.json` / `post-restart-snapshot.json`
3. **Ground Truth Anchoring**:
   - Every handoff document must record:
     - Exact Git HEAD commit SHA (from `git rev-parse HEAD`)
     - Working tree status (`git status --porcelain` and SHA-256)
     - Test suite results with exact counts (pass / fail / skip)
     - Running bridge PID and startup stamp
4. **Resumption Checklist**:
   - When resuming from a compaction message, immediately inspect:
     - `git status --short`
     - Status of running background daemons (`manage_task list`)
     - Recent handoff documents in `/Users/jayanthpranaykonada/agent-bridge-handoff/`
   - Re-verify critical invariants (e.g., protected projects like `Zia` must remain untouched).

## Evidence Discipline
Never declare a task "complete" or "verified" without citing:
- Exact test command run
- Exit code and pass/fail counts
- Log location
- Truthful evidence tags (`[EXECUTED]`, `[OBSERVED-LIVE]`, `[INFERRED]`)
