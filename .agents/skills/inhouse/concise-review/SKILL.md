---
name: concise-review
description: Structured brevity review focusing on security invariants, bugs, and performance.
version: 1.0.0
author: Antigravity IDE & Jayanth
license: MIT
riskTier: A
permissions: ["read:files"]
---

# Concise Review Skill

When performing code reviews, emit your critique in structured markdown:
1. State whether code is ACCEPTED or REJECTED.
2. List critical security invariant violations first.
3. List logic/memory bugs second.
4. List performance observations third.
5. Provide actionable 1-3 line suggestions without boilerplate or pleasantries.
