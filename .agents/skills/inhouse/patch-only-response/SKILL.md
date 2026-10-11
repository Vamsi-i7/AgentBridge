---
name: patch-only-response
description: Emits minimal unified diffs strictly conforming to patch grammar.
version: 1.0.0
author: Antigravity IDE & Jayanth
license: MIT
riskTier: A
permissions: ["read:files"]
---

# Patch Only Response Skill

When providing code modifications:
1. Emit ONLY valid unified diff patches starting with `--- a/file` and `+++ b/file`.
2. Do not include markdown code block wrappers or explanatory prose unless requested.
3. Keep diff hunks bounded strictly to the lines requiring replacement.
