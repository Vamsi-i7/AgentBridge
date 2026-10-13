# Testing Hermeticity in Agent Bridge v2

## Core Rule
**Tests must NEVER touch real `data/` databases or tracked lockfiles (`.agents/skills/skills.lock.json`).**

All tests executed via `npm test` or `node --test` must be strictly hermetic and isolated from the live runtime environment.

## Architectural Safeguards

1. **`tests/helpers/hermetic.js`**:
   - `createHermeticTestEnv(prefix)`: Generates an isolated per-test temporary directory in `os.tmpdir()` with a dedicated SQLite database (`test_bridge.sqlite`).
   - `createHermeticSkillsEnv(options)`: Generates an isolated skills environment with a separate lockfile, optionally copying existing in-house skills for verification without touching `.agents/skills/skills.lock.json`.

2. **Production-Side Safety Net**:
   - `AuditLogger` constructor inspects the runtime environment (`NODE_TEST_CONTEXT`, `NODE_ENV=test`, or `node --test` runner flags). If executed in a test environment without explicit opt-in (`AGENT_BRIDGE_ALLOW_PROD_DB_IN_TEST=1`), any attempt to resolve the default production database path (`CONFIG.DB_PATH`) throws a `HermeticityViolation` error immediately.
   - `SkillsManager` constructor performs the identical check against the tracked lockfile path (`.agents/skills/skills.lock.json`). If executed in a test environment without explicit opt-in (`AGENT_BRIDGE_ALLOW_PROD_SKILLS_IN_TEST=1`), it throws a `HermeticityViolation` error immediately.

3. **Desktop & Automation Gating**:
   - Real macOS Accessibility calls (`osascript`, JXA, UI automation) are disabled by default in test suites and gated behind explicit environment flags (e.g. `AGENT_BRIDGE_ALLOW_REAL_OSASCRIPT=1`). In standard test execution, automation adapters run in simulated/stubbed mode.

4. **Verification Script**:
   - `scripts/verify-hermetic.js` runs the test suite while snapshotting database state, file hashes, and tracked git status before and after execution to prove zero test side-effects on live state.
