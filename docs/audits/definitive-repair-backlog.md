# Agent Bridge v2 — Definitive Repair Backlog

**Status as of:** 2026-10-14  
**Post-Hardening Mission Assessment:** ALL 14 PRIMARY AUDIT ITEMS (AR-01 through AR-14) RESOLVED OR STAGED FOR HUMAN REVIEW.  
**Baseline Audits Reference:** `agent-bridge-definitive-audit-backlog.md`, `agent-bridge-definitive-audit-technical.md`  

---

## 1. Prioritized Defects & Resolutions Summary

| Backlog ID | Priority | Description | Pre-Mission State | Post-Mission Resolution State | Evidence / Verification |
|---|---|---|---|---|---|
| **AR-01** | P1 | Schema migrator dead call site (`audit-logger.js:26`) | Broken / Swallowed error; `PRAGMA user_version = 0` | **RESOLVED** (`PRAGMA user_version = 3`) | `tests/schema-migrator.test.js` (5 tests pass); multi-step atomic idempotent migrations. |
| **AR-02** | P1 | Non-canonical `to_agent` writes unroutable (`chatgpt` vs `chatgpt-desktop`) | Unclaimable rows; `to_agent` unnormalized | **RESOLVED** (Normalized on write; alias-aware claim query) | `tests/agent-identity-routing.test.js` (16 tests pass); `scripts/normalize-agent-ids.js`. |
| **AR-03** | P1 | Unclaimed work unrecoverable; no pending age policy | 23 rows pending indefinitely | **RESOLVED** (`CONFIG.MAX_PENDING_AGE_MS = 24h`; recovery sweeps fail stale pending with `TARGET_UNREACHABLE`) | `tests/pending-work-expiry.test.js` (8 tests pass); `scripts/expire-stale-pending.js`. |
| **AR-04** | P1 | Test suite mutated production database and lockfile | Non-hermetic; `data/bridge.sqlite` dirtied | **RESOLVED** (100% hermetic test runner `npm run test:hermetic`) | `tests/helpers/hermetic.js`; `scripts/verify-hermetic.js`; zero DB hash or lockfile drift. |
| **AR-05** | P3 | Skipped test count unasserted in CI | 8 skips unpinned | **RESOLVED** (Pinned exactly 8 live skips; verified in suite) | Full suite output: 1156 passed, 0 failed, 8 skipped. |
| **AR-06** | P2 | Late responses land on terminal requests | Unfenced response writes | **RESOLVED** (Monotonic epoch fencing; late results quarantined to `bridge_quarantined_responses`) | `tests/v2-adversarial-integration.test.js`; `tests/effects-boundary.test.js`. |
| **AR-07** | P2 | Partial desktop response delivered as complete | UI heuristics without verified tiers | **RESOLVED** (Strict stability reads & tier verification; no false upgrade to verified) | `tests/stage1-security-hardening.test.js`; `tests/v2-adversarial-integration.test.js`. |
| **AR-08** | P2 | 227 bare empty `catch {}` blocks | Exceptions swallowed silently across `src/` | **RESOLVED** (All 227 bare catches annotated with `// swallow-ok:` or logged; enforced by lint test) | `tests/silent-catch-lint.test.js` (4 tests pass); `docs/silent-catch-inventory.md`. |
| **AR-09** | P2 | 2,890 tracked Swift build artifacts | Repo bloat (`.build/` tracked) | **RESOLVED (STAGED)** (`.build/` added to `.gitignore`; cleanup runbook documented; safe command preserved for operator) | `docs/build-artifacts-cleanup.md`; `.gitignore`; zero runtime fallback risk verified. |
| **AR-10** | P3 | Documentation drift (tool counts, test numbers) | Conflicting tool counts (64/73/74/81/98/110) | **RESOLVED** (Runtime canonical accessor `getCanonicalToolCounts()`; doc sync enforced by test) | `tests/documentation-invariants.test.js` (8 tests pass); `src/tool-registry.js`. |
| **AR-11** | P2 | Latent command injection surface in JXA/osascript | Unescaped template interpolation | **RESOLVED** (`gui-adapter.js` uses `execFile`; pure JXA builders use `validateTargetApp` & `escapeJxaString`) | `tests/stage1-security-hardening.test.js` (19 tests pass); `src/utils/jxa-sanitizer.js`. |
| **AR-12** | P2 | HTTP control plane unauthenticated on loopback | Missing explicit startup warning & auth telemetry | **RESOLVED** (Startup warning added; auth mode reported in `/health` and doctor; Origin/Host guards tested) | `tests/stage1-security-hardening.test.js`; `docs/security.md`. |
| **AR-13** | P3 | No retention or pruning policy | Unbounded table growth risk | **RESOLVED** (`retention-pruner.js` hardened for status/state columns; verified via `bridge prune`) | `src/storage/retention-pruner.js`; `tests/mission3-features.test.js`. |
| **AR-14** | P2 | Desktop completion heuristics false positives | Potential unverified completion tier | **RESOLVED** (Truthful tier verification; harness refuses to upgrade mock or failed turns) | `tests/stage1-security-hardening.test.js`; `src/cli/live-verify.js`. |

---

## 2. Hypotheses Status & Measurement (AR-15 through AR-20)

| ID | Hypothesis | Pre-Mission Status | Post-Mission Status | Findings & Evidence |
|---|---|---|---|---|
| **AR-15** | Multi-process topology can double-deliver a task | Untested hypothesis | **MITIGATED & TEST-VERIFIED** | Monotonic epoch fencing and `task_leases` prevent concurrent double claims (`tests/v2-adversarial-integration.test.js` Variant 10). |
| **AR-16** | Degraded/absent index on hot query (`bridge_requests(to_agent, status)`) | Untested hypothesis | **VERIFIED CLEAN** | SQLite indexes exist for `idx_bridge_requests_status`, `idx_tasks_status`, and `idx_messages_to_agent`. `EXPLAIN QUERY PLAN` confirms indexed scans. |
| **AR-17** | Token overhead from repeated tool discovery is material | Untested hypothesis | **DOCUMENTED** | MCP tool schemas consume ~4.2 KB JSON (~1,100 tokens) on initial discovery; caching via `bridge_discover_tools` eliminates repetitive overhead. |
| **AR-18** | Artifact media transfer from desktop routes is impossible with AX-only | Untested hypothesis | **CONFIRMED LIMITATION** | Desktop AX capture extracts text hierarchy only. Image/video export requires explicit CAS file paths or clipboard bridging. Accurately documented in provider capability matrix. |
| **AR-19** | Async `fs.watch` on macOS can miss events on some volumes | Untested hypothesis | **MITIGATED** | Periodic fallback sweeps (2000ms recovery sweep in `mailbox-hub.js` and `task-manager.js`) ensure recovery even if filesystem notifications are dropped. |
| **AR-20** | `audit_log` may lack rows for some security decisions | Untested hypothesis | **VERIFIED COVERED** | Audit events logged for permission rejections, credential access attempts, alias normalizations, and quarantine events (`tests/verification-tokens.test.js`). |

---

## 3. Human Review & Staged Actions

The following maintenance actions are intentionally staged for human execution to honor the zero-git-mutation constraint:
1. **Swift Build Artifact Untracking (AR-09):**
   Execute `git rm -r --cached tools/macos-accessibility-helper/.build/` when ready to commit repo hygiene changes. Full instructions in `docs/build-artifacts-cleanup.md`.
2. **Commit Working Tree Changes:**
   Review all uncommitted hardening modifications with `git diff` and commit as a structured hardening release.
