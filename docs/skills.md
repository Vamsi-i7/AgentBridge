# Agent Bridge Skills Platform & Security Policy

*Document Version: 1.2.0 (Mission 4 Ship-Ready)*

---

## 1. Single Source of Truth & Lock File

All skills in Agent Bridge are managed by `SignedSkillRegistry` (`src/skills/skill-registry.js`) and locked in `.agents/skills/skills.lock.json`.

Key Guarantees:
1. **Mandatory Human Approval:** All skill additions or activations require explicit operator approval.
2. **Prohibition on Agent Self-Approval:** Any tool call or script executed by an agent that attempts to approve a skill (`isHumanApproved: false`) throws `SkillSecurityError`.
3. **Cryptographic SHA-256 Hashes:** Every file in a skill directory is hashed. Modifying skill contents invalidates the signature and blocks tool execution.

---

## 2. Seed Skills Status

The 4 pre-packaged seed skills in `.agents/skills/` are initialized with `"approvalStatus": "pending-user-approval"`:

1. `diff-review`: Structural diff review and analysis tool.
2. `patch-only-response`: Enforces clean, unpadded unified diff responses.
3. `repo-outline`: Fast symbol outline generation for classes and functions.
4. `task-triage`: Error log parsing and triage categorization.

---

## 3. Human Approval Workflow

To approve a skill for active production use:

```bash
# Inspect and approve an installed skill
node bin/bridge.js skill approve diff-review
node bin/bridge.js skill approve patch-only-response
node bin/bridge.js skill approve repo-outline
node bin/bridge.js skill approve task-triage
```

To install and approve a new skill from a directory:
```bash
node bin/bridge.js skill add /path/to/skill-dir
```
Computes the SHA-256 hash, prompts the operator for approval, and records the signed entry in `skills.lock.json`.
