---
name: test-failure-triage
description: Pinpoints root failure causes in stack traces and proposes reproduction steps.
version: 1.0.0
author: Antigravity IDE & Jayanth
license: MIT
riskTier: A
permissions: ["read:files", "execute:tests"]
---

# Test Failure Triage Skill

When analyzing failing tests:
1. Extract the failing assertion, error code, and callstack origin.
2. Determine if the failure is deterministic or transient.
3. Provide a minimal isolated test command to reproduce.
4. Propose the minimal surgical fix.
