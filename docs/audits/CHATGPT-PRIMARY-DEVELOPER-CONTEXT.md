# Agent Bridge — Primary Developer Context (Hardened Post-Mission)

**Audience:** ChatGPT (Primary Developer) & Future Engineering Agents  
**Updated:** 2026-10-14 (Post-Hardening Mission AR-01 through AR-14)  
**Repository:** `/Users/jayanthpranaykonada/agent-bridge` (HEAD `1fd5e97feecc89c3f3f9a86bef755d6e0226d1d4`, branch `main`)  
**Protected Project:** `/Users/jayanthpranaykonada/Zia` (**100% UNTOUCHED**)  

---

## 1. Core Principles & Architectural Invariants

As the primary developer on Agent Bridge v2, every pull request, fix, and feature you design must adhere to these non-negotiable invariants:

1. **Zero-Waste Verbatim Delivery:**
   - Responders generate output once. The requester receives the **exact original bytes** (code, markdown, whitespace intact).
   - Never inject an intermediate model call to summarize or rephrase delegated results unless assist/synthesis mode is explicitly requested.
2. **Strict Capability Truthfulness:**
   - MCP tool connectivity ≠ Live model execution capability.
   - If an external application is closed, lack accessibility permissions, or has no debug port bound, the adapter MUST fail with a typed error (`EXECUTION_UNSUPPORTED`, `UNSUPPORTED`, `CODEX_CLI_NOT_FOUND`) and park work as `queued-awaiting-pull`.
   - Never generate synthetic simulated responses to mimic a live model.
3. **Zia Invariant Protection:**
   - The `/Users/jayanthpranaykonada/Zia` codebase is strictly write-locked (`ZIA_WRITE_LOCKED=true`).
   - No agent (including system) may mutate Zia files directly. Any proposed changes must be quarantined in isolated attempt worktrees.
4. **Hermetic Test Enforcement:**
   - Never allow test runs to mutate the live production database (`data/bridge.sqlite`) or tracked files (`.agents/skills/skills.lock.json`).
   - Always execute tests via `npm run test:hermetic`. All test databases must use `createHermeticTestEnv` from `tests/helpers/hermetic.js`.
5. **No Undocumented Silent Catches:**
   - Never introduce bare empty `catch {}` or `catch (e) {}` blocks.
   - Any intentional swallowed exception must carry a descriptive `// swallow-ok: <specific reason>` annotation and be recorded in `docs/silent-catch-inventory.md`. This is strictly enforced by `tests/silent-catch-lint.test.js`.
6. **Command Injection Prevention:**
   - Never construct shell command strings or AppleScript/JXA payloads using unsanitized template interpolation.
   - Always use `execFile` with array arguments (`gui-adapter.js`) and pass application identifiers through `validateTargetApp` and `escapeJxaString` from `src/utils/jxa-sanitizer.js`.

---

## 2. Key Architecture & File Map

```
MCP Clients (IDE / Apps)
       │
       ▼
src/mcp-server.js ──────► src/http-server.js (127.0.0.1:8765, loopback auth guarded)
       │
       ▼
src/tool-registry.js (74 core registered tools + 5 skills tools + 2 comms tools)
       │
       ▼
src/mailbox-hub.js ◄────► src/task-manager.js (Write normalization, alias matching)
       │                           │
       ▼                           ▼
src/event-bus.js            src/attempts/attempt-ledger.js (Monotonic epoch fencing)
       │
       ▼
src/storage/schema-migrator.js (Atomic migrations: user_version 3)
       │
       ▼
data/bridge.sqlite (WAL mode, SQLite store)
```

### Critical File Reference:
| Responsibility | Primary File | Key Interfaces / Invariants |
|---|---|---|
| **Schema Migration** | `src/storage/schema-migrator.js` | `migrateToLatest()`, `migrate(v)`, `validateRuntimeSchema()` |
| **Identity & Aliasing** | `src/agent-identity.js` | `normalizeAgentId(id)`, `getAliasesFor(id)`, `canonicalizeTargetAgent(id)` |
| **Mailbox & Recovery** | `src/mailbox-hub.js` | `askAgent()`, `getPendingRequests()`, `recoverExpiredRequests()` |
| **Task Lifecycle** | `src/task-manager.js` | `createTask()`, `claimNextTask()`, `recoverExpiredTasks()` |
| **JXA Security** | `src/utils/jxa-sanitizer.js` | `validateTargetApp(app)`, `escapeJxaString(str)` |
| **Build Info** | `src/utils/build-info.js` | `getBuildInfo()` (`buildId`, `gitShort`, `version`) |
| **Hermetic Testing** | `tests/helpers/hermetic.js` | `createHermeticTestEnv()`, `createHermeticSkillsEnv()` |
| **System Diagnostics** | `src/diagnostics/doctor.js` | `runBridgeDoctor()` (Wired to `node bin/bridge.js doctor`) |

---

## 3. Developer Runbook & Essential Commands

### 1. Running the Hermetic Test Suite
```bash
# Run full suite (1164 tests, ~37s, zero prod DB mutations)
npm run test:hermetic

# Run a single test file hermetically
NODE_ENV=test node --test tests/schema-migrator.test.js
```

### 2. Checking System Health & Presence
```bash
# Run system doctor diagnostic
node bin/bridge.js doctor

# Check live agent connectivity
node bin/bridge.js presence

# View bridge status and allowed roots
node bin/bridge.js status
```

### 3. Expiry and Maintenance Utilities
```bash
# Dry-run inspection of stale pending rows
node scripts/expire-stale-pending.js

# Apply expiry with safety confirmation
node scripts/expire-stale-pending.js --apply --i-understand-live

# Normalize legacy agent alias rows
node scripts/normalize-agent-ids.js --dry-run
```

### 4. Running Provider Probes
```bash
# Safe offline dry-runs (never touches live desktop apps)
node bin/bridge.js live-verify gemini cli-process --dry-run
node bin/bridge.js live-verify chatgpt-desktop macos-ax --dry-run
node bin/bridge.js live-verify claude-desktop chromium-cdp --dry-run

# Live interactive run (requires operator presence)
node bin/bridge.js live-verify chatgpt-desktop macos-ax --confirm-live-run
```

---

## 4. Staged Repo Hygiene Note

The Swift build artifacts in `tools/macos-accessibility-helper/.build/` (2,890 tracked files) have been added to `.gitignore`. To complete untracking without mutating Git history during automated missions, execute:
```bash
git rm -r --cached tools/macos-accessibility-helper/.build/
```
The standalone binary `tools/macos-accessibility-helper/bridge-ax-helper` (334 KB) is checked in and executes with zero build dependencies.
