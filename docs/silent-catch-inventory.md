# Agent Bridge — Silent Catch Inventory & Audit (AR-08 / AR-14)

**Date:** 2026-10-13T18:11:18.050Z · **Scope:** `src/` (483 total catch blocks analyzed)

## Summary Classification

| Class | Description | Count |
|---|---|---|
| **Class A** | Acceptable cleanup, safe fallback, or documented with `swallow-ok` | 367 |
| **Class B** | Silent catch requiring logging / observability remediation | 89 |
| **Class C** | Critical path rethrowing or propagating | 27 |

## Remediation Policy

1. **Class B Remediation**: In core runtime engines (`schema-migrator`, `mailbox-hub`, `task-manager`, `audit-logger`), bare catches must either:
   - Log at `debug` or `warn` level with structured context via `this.logger?.debug?.(...)` or `this.logger?.log?.(...)`.
   - Include an explicit `// swallow-ok: <specific reason>` comment explaining why ignoring the error is strictly required and safe.
2. **Lint Enforcement**: `tests/silent-catch-lint.test.js` enforces that no unreviewed bare `catch {}` exists in `src/`.

## Inventory

| File | Line | Class | Snippet | Rationale |
|---|---|---|---|---|
| `src/agent-identity.js` | 29 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/agent-identity.js` | 97 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/agent-runner.js` | 94 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/agent-runner.js` | 126 | **A** | `// swallow-ok: best-effort disposal cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/agent-runner.js` | 182 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/agent-runner.js` | 191 | **A** | `this.emit('error', err);` | Logged to logger, console, or emitted as error |
| `src/agent-runner.js` | 217 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/agent-runner.js` | 232 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/agent-runner.js` | 269 | **B** | `this.state = 'FAILED'; if (this.presence) { this.presence.se` | Silent failure without logging or propagation |
| `src/agent-runner.js` | 321 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/agent-runner.js` | 340 | **A** | `// swallow-ok: secondary notification or event dispatch fail` | Explicitly reviewed with swallow-ok justification |
| `src/agent-runner.js` | 357 | **A** | `// swallow-ok: safe fallback for plaintext or non-JSON input` | Explicitly reviewed with swallow-ok justification |
| `src/artifacts/artifact-store.js` | 184 | **B** | `this._realRootCache = path.resolve(this.root);` | Silent failure without logging or propagation |
| `src/artifacts/artifact-store.js` | 301 | **A** | `// swallow-ok: optional record lookup fallback` | Explicitly reviewed with swallow-ok justification |
| `src/artifacts/artifact-store.js` | 310 | **A** | `// swallow-ok: optional record lookup fallback` | Explicitly reviewed with swallow-ok justification |
| `src/artifacts/artifact-store.js` | 370 | **B** | `authorized = [];` | Silent failure without logging or propagation |
| `src/artifacts/artifact-store.js` | 384 | **A** | `// swallow-ok: optional record lookup fallback` | Explicitly reviewed with swallow-ok justification |
| `src/artifacts/artifact-store.js` | 397 | **A** | `// swallow-ok: optional record lookup fallback` | Explicitly reviewed with swallow-ok justification |
| `src/artifacts/artifact-store.js` | 501 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/artifacts/artifact-store.js` | 574 | **C** | `if (err.code === 'ELOOP' || (err.message && err.message.incl` | Rethrows or rejects with error |
| `src/artifacts/artifact-store.js` | 581 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/artifacts/artifact-store.js` | 875 | **A** | `// swallow-ok: process or file cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/artifacts/artifact-store.js` | 888 | **A** | `// swallow-ok: process or file cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/artifacts/artifact-store.js` | 898 | **A** | `// swallow-ok: process or file cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/artifacts/artifact-store.js` | 924 | **A** | `// swallow-ok: optional record lookup fallback` | Explicitly reviewed with swallow-ok justification |
| `src/artifacts/artifact-store.js` | 981 | **C** | `readableStream.destroy(); reject(err);` | Rethrows or rejects with error |
| `src/artifacts/artifact-store.js` | 989 | **A** | `// swallow-ok: process or file cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/artifacts/artifact-store.js` | 1000 | **C** | `reject(err);` | Rethrows or rejects with error |
| `src/artifacts/artifact-store.js` | 1042 | **A** | `this.logger?.debug?.('Failed to query expired artifacts', er` | Logged to logger, console, or emitted as error |
| `src/artifacts/artifact-store.js` | 1054 | **A** | `this.logger?.debug?.(`Failed to clean expired artifact ${row` | Logged to logger, console, or emitted as error |
| `src/artifacts/artifact-store.js` | 1072 | **A** | `// swallow-ok: process or file cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/artifacts/content-addressed-store.js` | 25 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/artifacts/content-addressed-store.js` | 57 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/artifacts/content-addressed-store.js` | 111 | **A** | `return null;` | Handled via safe default/fallback return |
| `src/artifacts/context-cache.js` | 89 | **A** | `// swallow-ok: safe fallback for non-serializable object` | Explicitly reviewed with swallow-ok justification |
| `src/artifacts/context-cache.js` | 125 | **A** | `// swallow-ok: safe fallback for plaintext or non-JSON input` | Explicitly reviewed with swallow-ok justification |
| `src/artifacts/response-preserver.js` | 155 | **A** | `this._logDebug('schema migration skipped', err);` | Logged to logger, console, or emitted as error |
| `src/artifacts/response-preserver.js` | 157 | **A** | `// Non-fatal for in-memory/mock databases, but never silent.` | Logged to logger, console, or emitted as error |
| `src/artifacts/response-preserver.js` | 196 | **A** | `// Expected for JSON-looking text that is not strictly valid` | Logged to logger, console, or emitted as error |
| `src/artifacts/response-preserver.js` | 318 | **A** | `// Non-fatal for in-memory/mock databases, but never silent.` | Logged to logger, console, or emitted as error |
| `src/artifacts/response-preserver.js` | 380 | **A** | `this._logDebug('canonical payload reuse lookup skipped', err` | Logged to logger, console, or emitted as error |
| `src/artifacts/response-preserver.js` | 397 | **A** | `// Keep inline text as a safe fallback; never lose the respo` | Logged to logger, console, or emitted as error |
| `src/artifacts/response-preserver.js` | 424 | **A** | `this._logDebug('canonical payload read failed; falling back ` | Logged to logger, console, or emitted as error |
| `src/artifacts/response-preserver.js` | 438 | **A** | `this._logDebug('getByResponseId failed', err); return null;` | Logged to logger, console, or emitted as error |
| `src/artifacts/response-preserver.js` | 452 | **A** | `this._logDebug('getByRequestId failed', err); return null;` | Logged to logger, console, or emitted as error |
| `src/attempts/attempt-ledger.js` | 8 | **A** | `if (err.message && err.message.includes('cannot start a tran` | Handled via safe default/fallback return |
| `src/attempts/attempt-ledger.js` | 18 | **B** | `if (started) { try { db.exec('ROLLBACK;');` | Silent failure without logging or propagation |
| `src/attempts/attempt-ledger.js` | 20 | **A** | `// swallow-ok: transaction may already be resolved or closed` | Explicitly reviewed with swallow-ok justification |
| `src/attempts/attempt-ledger.js` | 350 | **B** | `this.quarantineLateResponse({ attemptId, requestId: attempt.` | Silent failure without logging or propagation |
| `src/attempts/attempt-ledger.js` | 419 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/attempts/attempt-ledger.js` | 513 | **A** | `return row.grant;` | Handled via safe default/fallback return |
| `src/audit-logger.js` | 46 | **B** | `if (err.message?.includes('readonly') || err.message?.includ` | Silent failure without logging or propagation |
| `src/audit-logger.js` | 138 | **A** | `// swallow-ok: DDL schema idempotency check` | Explicitly reviewed with swallow-ok justification |
| `src/capabilities/capability-registry.js` | 119 | **B** | `// Fall back gracefully to memory` | Completely silent bare catch |
| `src/capabilities/capability-registry.js` | 151 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/capabilities/capability-registry.js` | 199 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/capabilities/evidence-registry.js` | 39 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/capabilities/evidence-registry.js` | 110 | **A** | `// swallow-ok: safe fallback for plaintext or non-JSON input` | Explicitly reviewed with swallow-ok justification |
| `src/client/bridge-client.js` | 37 | **B** | `if (attempt <= maxRetries) { const delay = Math.min(250 * Ma` | Silent failure without logging or propagation |
| `src/collaboration/rolling-summary.js` | 101 | **A** | `return collab.turns;` | Handled via safe default/fallback return |
| `src/config-resolver.js` | 35 | **A** | `return null;` | Handled via safe default/fallback return |
| `src/config.js` | 140 | **A** | `return base;` | Handled via safe default/fallback return |
| `src/contracts/structured-contracts.js` | 37 | **B** | `// Attempt to extract JSON from markdown code block if prese` | Silent failure without logging or propagation |
| `src/contracts/structured-contracts.js` | 43 | **A** | `// swallow-ok: safe fallback for plaintext or non-JSON input` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/autonomous-collaboration-orchestrator.js` | 122 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/autonomous-collaboration-orchestrator.js` | 137 | **A** | `// swallow-ok: secondary notification or event dispatch fail` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/autonomous-collaboration-orchestrator.js` | 293 | **B** | `session.status = CollaborationStatus.FAILED; session.updated` | Silent failure without logging or propagation |
| `src/control-plane/autonomous-collaboration-orchestrator.js` | 329 | **A** | `// swallow-ok: safe fallback for plaintext or non-JSON input` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/autonomous-collaboration-orchestrator.js` | 393 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/autonomous-collaboration-orchestrator.js` | 406 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/ax-engine.js` | 31 | **A** | `return null;` | Handled via safe default/fallback return |
| `src/control-plane/ax-engine.js` | 49 | **A** | `// swallow-ok: safe fallback for non-serializable object` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/ax-engine.js` | 65 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/ax-engine.js` | 69 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/ax-engine.js` | 73 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/ax-engine.js` | 77 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/ax-engine.js` | 84 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/ax-engine.js` | 88 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/ax-engine.js` | 92 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/ax-engine.js` | 136 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/ax-engine.js` | 150 | **A** | `// swallow-ok: safe fallback for non-serializable object` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/ax-engine.js` | 165 | **A** | `return { running: false, error: err.message` | Handled via safe default/fallback return |
| `src/control-plane/ax-engine.js` | 187 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/ax-engine.js` | 344 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/ax-engine.js` | 348 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/ax-engine.js` | 366 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/ax-engine.js` | 377 | **A** | `// swallow-ok: safe fallback for non-serializable object` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/ax-engine.js` | 390 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/ax-engine.js` | 408 | **A** | `return { ok: false, error: err.message` | Handled via safe default/fallback return |
| `src/control-plane/cdp-adapter.js` | 41 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/cdp-adapter.js` | 58 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/cdp-adapter.js` | 83 | **A** | `return { verified: false, reason: 'LSOF_CHECK_FAILED'` | Handled via safe default/fallback return |
| `src/control-plane/cdp-adapter.js` | 109 | **B** | `resolve({ available: false, error: 'INVALID_JSON_RESPONSE'` | Silent failure without logging or propagation |
| `src/control-plane/cdp-adapter.js` | 129 | **A** | `return false;` | Handled via safe default/fallback return |
| `src/control-plane/chatgpt-autonomous-session.js` | 315 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/chatgpt-autonomous-session.js` | 377 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/chatgpt-local-engine.js` | 57 | **A** | `return false;` | Handled via safe default/fallback return |
| `src/control-plane/chatgpt-local-engine.js` | 162 | **A** | `// swallow-ok: process or file cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/chatgpt-local-engine.js` | 166 | **A** | `return { cancelled: false, error: err.message, requestId` | Handled via safe default/fallback return |
| `src/control-plane/chatgpt-local-engine.js` | 235 | **A** | `// swallow-ok: process or file cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/chatgpt-local-engine.js` | 288 | **B** | `workDir = null;` | Silent failure without logging or propagation |
| `src/control-plane/chatgpt-local-engine.js` | 294 | **A** | `// swallow-ok: process or file cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/chatgpt-local-engine.js` | 326 | **B** | `cleanupTemp(); resolve({ ok: false, success: false, transpor` | Silent failure without logging or propagation |
| `src/control-plane/chatgpt-local-engine.js` | 351 | **B** | `try { child.kill(signal);` | Silent failure without logging or propagation |
| `src/control-plane/chatgpt-local-engine.js` | 352 | **A** | `// swallow-ok: process or file cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/chatgpt-local-engine.js` | 392 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/chatgpt-local-engine.js` | 400 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/chatgpt-local-engine.js` | 439 | **B** | `continue; // tolerate malformed / non-JSON diagnostic lines` | Silent failure without logging or propagation |
| `src/control-plane/chatgpt-local-engine.js` | 497 | **B** | `/* tolerate */` | Silent failure without logging or propagation |
| `src/control-plane/chromium-cdp-adapter.js` | 71 | **A** | `return resolve({ ready: false, stage: DeliveryStage.CONNECTE` | Handled via safe default/fallback return |
| `src/control-plane/chromium-cdp-adapter.js` | 140 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/chromium-cdp-adapter.js` | 146 | **C** | `reject(initErr);` | Rethrows or rejects with error |
| `src/control-plane/chromium-cdp-adapter.js` | 171 | **C** | `reject(err);` | Rethrows or rejects with error |
| `src/control-plane/chromium-cdp-adapter.js` | 197 | **A** | `return;` | Handled via safe default/fallback return |
| `src/control-plane/chromium-cdp-adapter.js` | 377 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/chromium-cdp-adapter.js` | 417 | **A** | `// swallow-ok: safe fallback for non-serializable object` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/chromium-cdp-adapter.js` | 433 | **A** | `// swallow-ok: best-effort disposal cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/claude-autonomous-session.js` | 165 | **A** | `return { success: false, transport, requestId: resolvedReqId` | Handled via safe default/fallback return |
| `src/control-plane/claude-desktop-session.js` | 87 | **B** | `inner = { success: false, error: err.message, response: null` | Silent failure without logging or propagation |
| `src/control-plane/cli-process-adapter.js` | 65 | **B** | `version = `${this.command` | Silent failure without logging or propagation |
| `src/control-plane/cli-process-adapter.js` | 78 | **A** | `return { ready: false, stage: DeliveryStage.DISCONNECTED, ev` | Handled via safe default/fallback return |
| `src/control-plane/cli-process-adapter.js` | 176 | **A** | `this.activeProcesses.delete(requestId); return resolve({ out` | Handled via safe default/fallback return |
| `src/control-plane/cli-process-adapter.js` | 244 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/cli-process-adapter.js` | 311 | **B** | `try { if (record.child && !record.child.killed) record.child` | Silent failure without logging or propagation |
| `src/control-plane/cli-process-adapter.js` | 314 | **A** | `// swallow-ok: process or file cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/cli-process-adapter.js` | 325 | **A** | `// swallow-ok: process or file cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/conversation-locator.js` | 38 | **A** | `// swallow-ok: safe fallback for non-serializable object` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/conversation-locator.js` | 52 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/conversation-locator.js` | 56 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/conversation-locator.js` | 60 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/conversation-locator.js` | 78 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/conversation-locator.js` | 87 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/conversation-locator.js` | 129 | **A** | `return { unambiguous: false, conversation: null, status: 'ER` | Handled via safe default/fallback return |
| `src/control-plane/conversation-registry.js` | 34 | **B** | `// Ignore initial load error` | Completely silent bare catch |
| `src/control-plane/conversation-registry.js` | 46 | **B** | `// Ignore background persist error` | Completely silent bare catch |
| `src/control-plane/desktop-agent-worker.js` | 124 | **A** | `// swallow-ok: best-effort disposal cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/desktop-agent-worker.js` | 147 | **A** | `// swallow-ok: secondary notification or event dispatch fail` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/desktop-agent-worker.js` | 254 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/desktop-agent-worker.js` | 292 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/desktop-agent-worker.js` | 321 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/desktop-agent-worker.js` | 372 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/desktop-agent-worker.js` | 390 | **A** | `// swallow-ok: best-effort disposal cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/desktop-agent-worker.js` | 393 | **A** | `// swallow-ok: best-effort disposal cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/desktop-agent-worker.js` | 396 | **A** | `// swallow-ok: best-effort disposal cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/desktop-agent-worker.js` | 407 | **A** | `// swallow-ok: best-effort disposal cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/desktop-agent-worker.js` | 451 | **B** | `this.stats.failed++; try { this._settle(request, { status: '` | Silent failure without logging or propagation |
| `src/control-plane/desktop-agent-worker.js` | 453 | **A** | `// swallow-ok: secondary notification or event dispatch fail` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/desktop-control-plane.js` | 125 | **A** | `return { handled: false, reason: 'REQUEST_LOOKUP_FAILED'` | Handled via safe default/fallback return |
| `src/control-plane/desktop-control-plane.js` | 177 | **B** | `this.emit('completion_settle_failed', { requestId, error: er` | Silent failure without logging or propagation |
| `src/control-plane/desktop-control-plane.js` | 544 | **B** | `envelope.transition(RequestState.UNKNOWN, { error: err.messa` | Silent failure without logging or propagation |
| `src/control-plane/desktop-control-plane.js` | 547 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/desktop-invisibility-monitor.js` | 97 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/gemini-autonomous-session.js` | 144 | **B** | `if (previousFocus) { await this.sessionManager.restoreUserFo` | Silent failure without logging or propagation |
| `src/control-plane/gemini-desktop-session.js` | 115 | **B** | `inner = { success: false, error: err.message, response: null` | Silent failure without logging or propagation |
| `src/control-plane/model-execution-adapter.js` | 93 | **A** | `return false;` | Handled via safe default/fallback return |
| `src/control-plane/model-execution-adapter.js` | 154 | **A** | `// swallow-ok: safe fallback for plaintext or non-JSON input` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/model-execution-adapter.js` | 162 | **A** | `// swallow-ok: process or file cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/model-execution-adapter.js` | 201 | **A** | `// swallow-ok: process or file cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/model-execution-adapter.js` | 210 | **A** | `// swallow-ok: process or file cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/model-execution-adapter.js` | 259 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/model-execution-adapter.js` | 298 | **A** | `const isTimeout = /timed?\s*out/i.test(err.message); return ` | Handled via safe default/fallback return |
| `src/control-plane/model-orchestrator.js` | 89 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/model-orchestrator.js` | 101 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/model-orchestrator.js` | 497 | **B** | `envelope.transition(RequestState.UNKNOWN, { error: err.messa` | Silent failure without logging or propagation |
| `src/control-plane/multi-hop-router.js` | 211 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/multi-hop-router.js` | 267 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/native-ax-adapter.js` | 49 | **A** | `return { ready: false, stage: DeliveryStage.FAILED, reason: ` | Handled via safe default/fallback return |
| `src/control-plane/native-ax-adapter.js` | 154 | **A** | `this.activeRequests.delete(requestId); return { accepted: fa` | Handled via safe default/fallback return |
| `src/control-plane/native-ax-adapter.js` | 211 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/native-ax-adapter.js` | 253 | **A** | `if (record.cancelled) return; completed = true; cleanup(); i` | Handled via safe default/fallback return |
| `src/control-plane/native-ax-adapter.js` | 364 | **B** | `// Continue until deadline unless cancelled` | Completely silent bare catch |
| `src/control-plane/native-ax-adapter.js` | 388 | **A** | `// swallow-ok: optional record lookup fallback` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/persistent-desktop-launcher.js` | 41 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/persistent-session-manager.js` | 84 | **A** | `return { ok: false, running: false, error: err.message` | Handled via safe default/fallback return |
| `src/control-plane/persistent-session-manager.js` | 105 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/persistent-session-manager.js` | 178 | **A** | `return { restored: false` | Handled via safe default/fallback return |
| `src/control-plane/persistent-swift-ax-bridge.js` | 27 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/persistent-swift-ax-bridge.js` | 43 | **A** | `// swallow-ok: best-effort disposal cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/persistent-swift-ax-bridge.js` | 80 | **B** | `finish(resolve, { ok: false, error: 'INVALID_HELPER_RESPONSE` | Silent failure without logging or propagation |
| `src/control-plane/persistent-swift-ax-bridge.js` | 87 | **A** | `// swallow-ok: safe fallback for plaintext or non-JSON input` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/response-observer.js` | 206 | **B** | `obs.inGraceRecheck = false; this._finish(obs, ObserverState.` | Silent failure without logging or propagation |
| `src/control-plane/response-observer.js` | 241 | **B** | `// Non-fatal error during tick, continue polling until timeo` | Completely silent bare catch |
| `src/control-plane/swift-ax-bridge.js` | 31 | **A** | `return false;` | Handled via safe default/fallback return |
| `src/control-plane/swift-ax-bridge.js` | 45 | **A** | `return { ok: false, error: err.message` | Handled via safe default/fallback return |
| `src/control-plane/swift-ax-bridge.js` | 64 | **B** | `// Plain string JavaScript results remain valid.` | Completely silent bare catch |
| `src/control-plane/worker-supervisor.js` | 55 | **A** | `return false;` | Handled via safe default/fallback return |
| `src/control-plane/worker-supervisor.js` | 77 | **A** | `// swallow-ok: process or file cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/worker-supervisor.js` | 81 | **A** | `// swallow-ok: process or file cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/worker-supervisor.js` | 158 | **A** | `// swallow-ok: optional record lookup fallback` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/worker-supervisor.js` | 184 | **A** | `// swallow-ok: process or file cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/worker-supervisor.js` | 243 | **A** | `// swallow-ok: process or file cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/worker-supervisor.js` | 256 | **A** | `// swallow-ok: process or file cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/worker-supervisor.js` | 266 | **A** | `// swallow-ok: process or file cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/control-plane/zia-background-gpt-target.js` | 32 | **A** | `return null;` | Handled via safe default/fallback return |
| `src/dashboard/dashboard-server.js` | 43 | **B** | `this.sseClients.delete(res);` | Silent failure without logging or propagation |
| `src/dashboard/dashboard-server.js` | 52 | **B** | `res.writeHead(500, { 'Content-Type': 'application/json'` | Silent failure without logging or propagation |
| `src/dashboard/dashboard-server.js` | 68 | **A** | `// swallow-ok: best-effort disposal cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/dashboard/dashboard-server.js` | 108 | **B** | `res.writeHead(403, { 'Content-Type': 'application/json'` | Silent failure without logging or propagation |
| `src/dashboard/dashboard-server.js` | 185 | **B** | `res.writeHead(400, { 'Content-Type': 'application/json'` | Silent failure without logging or propagation |
| `src/dashboard/dashboard-server.js` | 223 | **B** | `res.writeHead(400, { 'Content-Type': 'application/json'` | Silent failure without logging or propagation |
| `src/diagnostics/doctor.js` | 90 | **A** | `// swallow-ok: optional record lookup fallback` | Explicitly reviewed with swallow-ok justification |
| `src/diagnostics/doctor.js` | 121 | **B** | `checks.push({ name: 'Disk Space Headroom', status: 'PASS', d` | Silent failure without logging or propagation |
| `src/diagnostics/request-explainer.js` | 93 | **A** | `// swallow-ok: optional record lookup fallback` | Explicitly reviewed with swallow-ok justification |
| `src/diagnostics/request-explainer.js` | 105 | **A** | `// swallow-ok: optional record lookup fallback` | Explicitly reviewed with swallow-ok justification |
| `src/diagnostics/request-explainer.js` | 117 | **A** | `// swallow-ok: optional record lookup fallback` | Explicitly reviewed with swallow-ok justification |
| `src/diagnostics/request-tracer.js` | 60 | **B** | `this.enabled = false;` | Silent failure without logging or propagation |
| `src/diagnostics/request-tracer.js` | 143 | **A** | `// Observability must never break delivery. return null;` | Handled via safe default/fallback return |
| `src/diagnostics/request-tracer.js` | 156 | **A** | `return {` | Handled via safe default/fallback return |
| `src/diagnostics/request-tracer.js` | 287 | **B** | `// Best-effort non-throwing` | Completely silent bare catch |
| `src/diagnostics/request-tracer.js` | 356 | **A** | `return null;` | Handled via safe default/fallback return |
| `src/diagnostics/request-tracer.js` | 426 | **A** | `return r.meta;` | Handled via safe default/fallback return |
| `src/diagnostics/request-tracer.js` | 428 | **A** | `return [];` | Handled via safe default/fallback return |
| `src/diagnostics/request-tracer.js` | 524 | **A** | `return { pruned: 0, hasMore: false, cutoff: cutoffIso` | Handled via safe default/fallback return |
| `src/diagnostics/request-tracer.js` | 547 | **A** | `return { totalRecords: 0, oldest: null, newest: null` | Handled via safe default/fallback return |
| `src/diagnostics-manager.js` | 162 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/display/bridge-display-manager.js` | 88 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/effects/effects-ledger.js` | 8 | **A** | `if (err.message && err.message.includes('cannot start a tran` | Handled via safe default/fallback return |
| `src/effects/effects-ledger.js` | 18 | **B** | `if (started) { try { db.exec('ROLLBACK;');` | Silent failure without logging or propagation |
| `src/effects/effects-ledger.js` | 20 | **A** | `// swallow-ok: transaction may already be resolved or closed` | Explicitly reviewed with swallow-ok justification |
| `src/effects/effects-ledger.js` | 270 | **A** | `return existing.result;` | Handled via safe default/fallback return |
| `src/event-bus.js` | 46 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/event-bus.js` | 61 | **B** | `// Ignore directory/file race conditions` | Completely silent bare catch |
| `src/event-bus.js` | 125 | **A** | `// swallow-ok: DDL schema idempotency check` | Explicitly reviewed with swallow-ok justification |
| `src/event-bus.js` | 131 | **A** | `// swallow-ok: DDL schema idempotency check` | Explicitly reviewed with swallow-ok justification |
| `src/event-bus.js` | 137 | **A** | `// swallow-ok: DDL schema idempotency check` | Explicitly reviewed with swallow-ok justification |
| `src/event-bus.js` | 180 | **A** | `return existing.payload;` | Handled via safe default/fallback return |
| `src/event-bus.js` | 186 | **A** | `// swallow-ok: safe fallback for plaintext or non-JSON input` | Explicitly reviewed with swallow-ok justification |
| `src/event-bus.js` | 224 | **A** | `if (dedupKey && (err.message?.includes('UNIQUE constraint fa` | Handled via safe default/fallback return |
| `src/event-bus.js` | 237 | **A** | `return existing.payload;` | Handled via safe default/fallback return |
| `src/event-bus.js` | 261 | **A** | `return payloadStr;` | Handled via safe default/fallback return |
| `src/event-bus.js` | 269 | **A** | `// swallow-ok: safe fallback for plaintext or non-JSON input` | Explicitly reviewed with swallow-ok justification |
| `src/event-bus.js` | 294 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/event-bus.js` | 318 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/event-bus.js` | 344 | **A** | `this.emit('error', err);` | Logged to logger, console, or emitted as error |
| `src/event-bus.js` | 358 | **A** | `this.emit('error', err);` | Logged to logger, console, or emitted as error |
| `src/event-bus.js` | 369 | **A** | `this.emit('error', err);` | Logged to logger, console, or emitted as error |
| `src/event-bus.js` | 439 | **B** | `// Fallback timer will handle waking up if fs.watch fails` | Completely silent bare catch |
| `src/event-bus.js` | 456 | **A** | `// swallow-ok: best-effort disposal cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/event-bus.js` | 506 | **A** | `return;` | Handled via safe default/fallback return |
| `src/event-bus.js` | 523 | **A** | `return r.payload;` | Handled via safe default/fallback return |
| `src/event-bus.js` | 540 | **A** | `this.emit('error', err);` | Logged to logger, console, or emitted as error |
| `src/event-bus.js` | 584 | **A** | `return null;` | Handled via safe default/fallback return |
| `src/event-bus.js` | 764 | **A** | `return 0;` | Handled via safe default/fallback return |
| `src/event-bus.js` | 780 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/event-bus.js` | 789 | **A** | `return 0;` | Handled via safe default/fallback return |
| `src/event-bus.js` | 832 | **A** | `return r.payload;` | Handled via safe default/fallback return |
| `src/event-bus.js` | 852 | **A** | `// swallow-ok: optional record lookup fallback` | Explicitly reviewed with swallow-ok justification |
| `src/event-bus.js` | 878 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/event-bus.js` | 898 | **A** | `return false;` | Handled via safe default/fallback return |
| `src/event-bus.js` | 929 | **A** | `return r.payload;` | Handled via safe default/fallback return |
| `src/event-bus.js` | 931 | **A** | `return [];` | Handled via safe default/fallback return |
| `src/event-bus.js` | 950 | **A** | `this.emit('error', err);` | Logged to logger, console, or emitted as error |
| `src/event-bus.js` | 978 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/events/transactional-outbox.js` | 48 | **A** | `// swallow-ok: DDL schema idempotency check` | Explicitly reviewed with swallow-ok justification |
| `src/events/transactional-outbox.js` | 67 | **A** | `if (err.message && err.message.includes('cannot start a tran` | Handled via safe default/fallback return |
| `src/events/transactional-outbox.js` | 115 | **B** | `if (started && !committed) { try { this.db.exec('ROLLBACK;')` | Silent failure without logging or propagation |
| `src/events/transactional-outbox.js` | 119 | **A** | `// swallow-ok: transaction may already be resolved or closed` | Explicitly reviewed with swallow-ok justification |
| `src/events/transactional-outbox.js` | 216 | **A** | `return payloadStr;` | Handled via safe default/fallback return |
| `src/events/transactional-outbox.js` | 232 | **A** | `// swallow-ok: optional record lookup fallback` | Explicitly reviewed with swallow-ok justification |
| `src/events/transactional-outbox.js` | 240 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/events/transactional-outbox.js` | 249 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/events/transactional-outbox.js` | 279 | **A** | `return r.payload;` | Handled via safe default/fallback return |
| `src/events/transactional-outbox.js` | 291 | **A** | `// swallow-ok: optional record lookup fallback` | Explicitly reviewed with swallow-ok justification |
| `src/events/transactional-outbox.js` | 299 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/git-controller.js` | 69 | **B** | `// Check if bare repo try { const { stdout: isBare` | Silent failure without logging or propagation |
| `src/git-controller.js` | 76 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/git-controller.js` | 164 | **C** | `throw new Error(`Git status failed in '${repoPath` | Rethrows or rejects with error |
| `src/git-controller.js` | 225 | **C** | `throw new Error(`Git list branches failed in '${repoPath` | Rethrows or rejects with error |
| `src/git-controller.js` | 265 | **C** | `throw new Error(`Failed to create branch '${sanitized` | Rethrows or rejects with error |
| `src/git-controller.js` | 306 | **C** | `throw new Error(`Failed to switch to branch '${sanitized` | Rethrows or rejects with error |
| `src/git-controller.js` | 342 | **C** | `throw new Error(`Failed to delete branch '${sanitized` | Rethrows or rejects with error |
| `src/git-controller.js` | 380 | **C** | `throw new Error(`Git stage failed: ${err.message` | Rethrows or rejects with error |
| `src/git-controller.js` | 440 | **C** | `throw new Error(`Git commit failed: ${err.message` | Rethrows or rejects with error |
| `src/git-controller.js` | 480 | **C** | `throw new Error(`Git log failed in '${repoPath` | Rethrows or rejects with error |
| `src/git-controller.js` | 516 | **C** | `throw new Error(`Git diff failed in '${repoPath` | Rethrows or rejects with error |
| `src/git-controller.js` | 555 | **C** | `throw new Error(`Git pull failed: ${err.message` | Rethrows or rejects with error |
| `src/git-controller.js` | 586 | **C** | `throw new Error(`Git fetch failed: ${err.message` | Rethrows or rejects with error |
| `src/git-controller.js` | 625 | **B** | `const errReason = `InvalidGitBranch: Branch '${targetBranch` | Silent failure without logging or propagation |
| `src/git-controller.js` | 657 | **C** | `throw new Error(`NoCommitsToPush: Branch '${targetBranch` | Rethrows or rejects with error |
| `src/git-controller.js` | 717 | **A** | `this.logger.log({ agentId, action: 'git_push', targetPath: p` | Logged to logger, console, or emitted as error |
| `src/git-controller.js` | 789 | **C** | `throw new Error(`GitSummaryFailed: ${err.message` | Rethrows or rejects with error |
| `src/git-controller.js` | 861 | **C** | `throw new Error(`GitBlameFailed: ${err.message` | Rethrows or rejects with error |
| `src/gui-adapter.js` | 33 | **A** | `const isNotAllowed = err.message.includes('-1728') || err.me` | Handled via safe default/fallback return |
| `src/gui-adapter.js` | 66 | **A** | `return { status: 'error', error: err.message` | Handled via safe default/fallback return |
| `src/gui-adapter.js` | 78 | **A** | `return { success: false, error: err.message` | Handled via safe default/fallback return |
| `src/gui-adapter.js` | 89 | **A** | `return { success: false, error: err.message` | Handled via safe default/fallback return |
| `src/http-server.js` | 53 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/http-server.js` | 369 | **B** | `const err = new Error('Malformed JSON request body.'); err.s` | Silent failure without logging or propagation |
| `src/http-server.js` | 396 | **B** | `res.writeHead(503, { 'Content-Type': 'application/json'` | Silent failure without logging or propagation |
| `src/http-server.js` | 505 | **B** | `if (err.message && err.message.includes('Unauthorized')) { r` | Silent failure without logging or propagation |
| `src/http-server.js` | 605 | **A** | `// swallow-ok: best-effort disposal cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/http-server.js` | 654 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/http-server.js` | 698 | **B** | `res.write(`data: ${JSON.stringify({ done: true, ok: false, p` | Silent failure without logging or propagation |
| `src/http-server.js` | 727 | **B** | `res.writeHead(502, { 'Content-Type': 'application/json'` | Silent failure without logging or propagation |
| `src/http-server.js` | 754 | **A** | `clearInterval(keepAliveTimer);` | Cleanup or safe parser fallback |
| `src/http-server.js` | 776 | **A** | `// swallow-ok: best-effort disposal cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/http-server.js` | 816 | **A** | `// swallow-ok: safe fallback for non-serializable object` | Explicitly reviewed with swallow-ok justification |
| `src/http-server.js` | 920 | **A** | `return sendJsonRpc({ jsonrpc: '2.0', id, result: { isError: ` | Handled via safe default/fallback return |
| `src/http-server.js` | 969 | **B** | `const status = err && err.statusCode ? err.statusCode : 500;` | Silent failure without logging or propagation |
| `src/http-server.js` | 999 | **A** | `// swallow-ok: safe fallback for non-serializable object` | Explicitly reviewed with swallow-ok justification |
| `src/http-server.js` | 1009 | **A** | `// swallow-ok: safe fallback for non-serializable object` | Explicitly reviewed with swallow-ok justification |
| `src/http-server.js` | 1015 | **A** | `// swallow-ok: best-effort disposal cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/http-server.js` | 1021 | **A** | `// swallow-ok: best-effort disposal cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/http-server.js` | 1031 | **A** | `// swallow-ok: best-effort disposal cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/interop/a2a-adapter.js` | 118 | **A** | `return { jsonrpc: '2.0', id: request.id, error: { code: -320` | Handled via safe default/fallback return |
| `src/interop/hot-manifest-reloader.js` | 66 | **B** | `// Rollback on any failure if (previous) { this.manifestRegi` | Silent failure without logging or propagation |
| `src/mailbox-hub.js` | 114 | **A** | `// swallow-ok: DDL schema idempotency check` | Explicitly reviewed with swallow-ok justification |
| `src/mailbox-hub.js` | 133 | **A** | `// swallow-ok: optional record lookup fallback` | Explicitly reviewed with swallow-ok justification |
| `src/mailbox-hub.js` | 160 | **A** | `return { claimed: false, error: tClaimErr.message` | Handled via safe default/fallback return |
| `src/mailbox-hub.js` | 215 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/mailbox-hub.js` | 251 | **A** | `return { claimed: false, error: err.message` | Handled via safe default/fallback return |
| `src/mailbox-hub.js` | 285 | **A** | `return false;` | Handled via safe default/fallback return |
| `src/mailbox-hub.js` | 303 | **A** | `return false;` | Handled via safe default/fallback return |
| `src/mailbox-hub.js` | 321 | **A** | `return false;` | Handled via safe default/fallback return |
| `src/mailbox-hub.js` | 371 | **A** | `// swallow-ok: safe fallback for plaintext or non-JSON input` | Explicitly reviewed with swallow-ok justification |
| `src/mailbox-hub.js` | 486 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/mailbox-hub.js` | 494 | **C** | `this.logger?.debug?.('Error in recoverExpiredRequests', err)` | Rethrows or rejects with error |
| `src/mailbox-hub.js` | 507 | **B** | `// already recorded in runRecoverySweep` | Completely silent bare catch |
| `src/mailbox-hub.js` | 514 | **B** | `// already recorded in runRecoverySweep` | Completely silent bare catch |
| `src/mailbox-hub.js` | 540 | **A** | `this._recoverySweepErrors++; this.logger?.log?.({ agentId: '` | Logged to logger, console, or emitted as error |
| `src/mailbox-hub.js` | 555 | **A** | `// swallow-ok: best-effort disposal cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/mailbox-hub.js` | 774 | **A** | `// swallow-ok: optional record lookup fallback` | Explicitly reviewed with swallow-ok justification |
| `src/mailbox-hub.js` | 793 | **A** | `this.logger?.debug?.('Failed to create matching bridge_reque` | Logged to logger, console, or emitted as error |
| `src/mailbox-hub.js` | 875 | **A** | `return { mode: 'request_failed', fromAgent: normFrom, toAgen` | Handled via safe default/fallback return |
| `src/mailbox-hub.js` | 1018 | **A** | `this.logger?.debug?.('Failed to insert bridge_request in ask` | Logged to logger, console, or emitted as error |
| `src/mailbox-hub.js` | 1048 | **A** | `this.logger?.debug?.('Failed to preserve synchronous peer re` | Logged to logger, console, or emitted as error |
| `src/mailbox-hub.js` | 1088 | **A** | `// swallow-ok: optional record lookup fallback` | Explicitly reviewed with swallow-ok justification |
| `src/mailbox-hub.js` | 1330 | **A** | `// swallow-ok: optional record lookup fallback` | Explicitly reviewed with swallow-ok justification |
| `src/mailbox-hub.js` | 1585 | **A** | `// swallow-ok: safe fallback for plaintext or non-JSON input` | Explicitly reviewed with swallow-ok justification |
| `src/mailbox-hub.js` | 1644 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/mailbox-hub.js` | 1674 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/mailbox-hub.js` | 1700 | **A** | `// swallow-ok: optional record lookup fallback` | Explicitly reviewed with swallow-ok justification |
| `src/mailbox-hub.js` | 1712 | **A** | `// swallow-ok: safe fallback for plaintext or non-JSON input` | Explicitly reviewed with swallow-ok justification |
| `src/mailbox-hub.js` | 1735 | **A** | `this.logger?.debug?.('Failed to quarantine late response in ` | Logged to logger, console, or emitted as error |
| `src/mailbox-hub.js` | 1755 | **A** | `this.logger?.debug?.('Failed to update bridge_requests in su` | Logged to logger, console, or emitted as error |
| `src/mailbox-hub.js` | 1768 | **A** | `return 'direct';` | Handled via safe default/fallback return |
| `src/mailbox-hub.js` | 1799 | **A** | `this.logger?.debug?.('Failed to preserve response artifact i` | Logged to logger, console, or emitted as error |
| `src/mailbox-hub.js` | 1953 | **A** | `// swallow-ok: safe fallback for plaintext or non-JSON input` | Explicitly reviewed with swallow-ok justification |
| `src/mailbox-hub.js` | 2033 | **A** | `// swallow-ok: optional record lookup fallback` | Explicitly reviewed with swallow-ok justification |
| `src/mailbox-hub.js` | 2095 | **A** | `return row.context;` | Handled via safe default/fallback return |
| `src/mailbox-hub.js` | 2173 | **A** | `return r.context;` | Handled via safe default/fallback return |
| `src/mailbox-hub.js` | 2178 | **A** | `return [];` | Handled via safe default/fallback return |
| `src/mailbox-hub.js` | 2203 | **A** | `// swallow-ok: optional record lookup fallback` | Explicitly reviewed with swallow-ok justification |
| `src/mailbox-hub.js` | 2223 | **A** | `this.logger?.debug?.('Failed to quarantine unauth response i` | Logged to logger, console, or emitted as error |
| `src/mailbox-hub.js` | 2257 | **A** | `this.logger?.debug?.('Failed to quarantine late response on ` | Logged to logger, console, or emitted as error |
| `src/mailbox-hub.js` | 2283 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/mailbox-hub.js` | 2305 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/mailbox-hub.js` | 2345 | **A** | `// swallow-ok: safe fallback for plaintext or non-JSON input` | Explicitly reviewed with swallow-ok justification |
| `src/mailbox-hub.js` | 2410 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/mailbox-hub.js` | 2437 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/mailbox-hub.js` | 2459 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/mailbox-hub.js` | 2480 | **B** | `try { this.tasks.attempts.quarantineLateResponse({ attemptId` | Silent failure without logging or propagation |
| `src/mailbox-hub.js` | 2489 | **A** | `this.logger?.debug?.('Failed to quarantine fenced late respo` | Logged to logger, console, or emitted as error |
| `src/mailbox-hub.js` | 2526 | **A** | `this.logger?.debug?.('Failed to quarantine concurrent losing` | Logged to logger, console, or emitted as error |
| `src/mailbox-hub.js` | 2539 | **A** | `return 'direct';` | Handled via safe default/fallback return |
| `src/mailbox-hub.js` | 2570 | **A** | `this.logger?.debug?.('Failed to preserve response artifact i` | Logged to logger, console, or emitted as error |
| `src/mcp-server.js` | 89 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/mcp-server.js` | 191 | **A** | `return { isError: true, content: [ { type: 'text', text: `Er` | Handled via safe default/fallback return |
| `src/mcp-server.js` | 209 | **A** | `this.logger?.warn?.('Startup recovery failed on MCP server s` | Logged to logger, console, or emitted as error |
| `src/mcp-server.js` | 216 | **A** | `if (err.code !== 'EADDRINUSE') { // If port is in use, anoth` | Logged to logger, console, or emitted as error |
| `src/mcp-server.js` | 247 | **A** | `// swallow-ok: best-effort disposal cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/mcp-server.js` | 253 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/mcp-server.js` | 261 | **A** | `// swallow-ok: best-effort disposal cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/mcp-server.js` | 266 | **A** | `// swallow-ok: best-effort disposal cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/mcp-server.js` | 271 | **A** | `// swallow-ok: best-effort disposal cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/mcp-server.js` | 276 | **A** | `// swallow-ok: best-effort disposal cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/memory/knowledge-store.js` | 109 | **A** | `// swallow-ok: DDL schema idempotency check` | Explicitly reviewed with swallow-ok justification |
| `src/memory/knowledge-store.js` | 116 | **A** | `// swallow-ok: DDL schema idempotency check` | Explicitly reviewed with swallow-ok justification |
| `src/memory/knowledge-store.js` | 132 | **B** | `// If FTS5 is already created or slightly different schema e` | Completely silent bare catch |
| `src/memory/knowledge-store.js` | 255 | **A** | `this.logger?.log?.({ agentId: authorAgent, action: 'knowledg` | Logged to logger, console, or emitted as error |
| `src/memory/knowledge-store.js` | 294 | **A** | `this.ftsFailures++; this.logger?.log?.({ agentId: authorAgen` | Logged to logger, console, or emitted as error |
| `src/memory/knowledge-store.js` | 396 | **B** | `// Fallback to LIKE if FTS query syntax error let fallbackSq` | Silent failure without logging or propagation |
| `src/memory/knowledge-store.js` | 426 | **A** | `return [];` | Handled via safe default/fallback return |
| `src/memory/knowledge-store.js` | 434 | **B** | `prov = r.provenance;` | Silent failure without logging or propagation |
| `src/memory/knowledge-store.js` | 479 | **B** | `prov = row.provenance;` | Silent failure without logging or propagation |
| `src/memory/knowledge-store.js` | 525 | **A** | `// swallow-ok: optional record lookup fallback` | Explicitly reviewed with swallow-ok justification |
| `src/memory/knowledge-store.js` | 542 | **A** | `// swallow-ok: optional record lookup fallback` | Explicitly reviewed with swallow-ok justification |
| `src/memory/knowledge-store.js` | 578 | **A** | `// swallow-ok: optional record lookup fallback` | Explicitly reviewed with swallow-ok justification |
| `src/memory/knowledge-store.js` | 645 | **A** | `// swallow-ok: best-effort disposal cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/permission-guard.js` | 22 | **A** | `return path.resolve(root);` | Handled via safe default/fallback return |
| `src/permission-guard.js` | 155 | **C** | `if (err.code === 'ELOOP') { throw new Error('Symlink loop de` | Rethrows or rejects with error |
| `src/permission-guard.js` | 172 | **C** | `if (err.code === 'ELOOP') { throw new Error('Symlink loop de` | Rethrows or rejects with error |
| `src/permission-guard.js` | 192 | **B** | `continue;` | Silent failure without logging or propagation |
| `src/permission-guard.js` | 213 | **A** | `return { allowed: false, reason: `Path '${resolved` | Handled via safe default/fallback return |
| `src/permission-guard.js` | 276 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/permission-guard.js` | 284 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/presence-manager.js` | 60 | **B** | `// Fallback table creation this.db.exec(` CREATE TABLE IF NO` | Silent failure without logging or propagation |
| `src/presence-manager.js` | 183 | **A** | `return false;` | Handled via safe default/fallback return |
| `src/presence-manager.js` | 384 | **A** | `// swallow-ok: safe fallback for plaintext or non-JSON input` | Explicitly reviewed with swallow-ok justification |
| `src/presence-manager.js` | 434 | **B** | `// Suppress heartbeat errors on DB contention` | Completely silent bare catch |
| `src/presence-manager.js` | 445 | **A** | `// swallow-ok: best-effort disposal cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/presence-manager.js` | 540 | **A** | `return { ready: false, stage: 'FAILED', reason: 'PROBE_ERROR` | Handled via safe default/fallback return |
| `src/project-controller.js` | 24 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/project-controller.js` | 283 | **B** | `if (rgErr.code === 1) { // ripgrep exit code 1 means 0 match` | Silent failure without logging or propagation |
| `src/project-controller.js` | 303 | **A** | `return;` | Handled via safe default/fallback return |
| `src/project-controller.js` | 344 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/project-controller.js` | 400 | **B** | `valid = false; syntaxError = (err.stderr || err.message || '` | Silent failure without logging or propagation |
| `src/project-controller.js` | 408 | **B** | `valid = false; syntaxError = err.message;` | Silent failure without logging or propagation |
| `src/project-controller.js` | 415 | **B** | `valid = false; syntaxError = (err.stderr || err.message || '` | Silent failure without logging or propagation |
| `src/project-controller.js` | 481 | **C** | `throw new Error(`JSON parse error: ${err.message` | Rethrows or rejects with error |
| `src/project-controller.js` | 828 | **A** | `return { filePath, success: false, error: err.message` | Handled via safe default/fallback return |
| `src/project-controller.js` | 850 | **B** | `results.push({ filePath, status: 'error', error: err.message` | Silent failure without logging or propagation |
| `src/project-controller.js` | 884 | **B** | `results.push({ path: p, exists: false, error: err.message` | Silent failure without logging or propagation |
| `src/project-controller.js` | 935 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/project-controller.js` | 969 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/project-controller.js` | 1077 | **A** | `// A timeout or non-zero exit is a real failure. Surface it ` | Logged to logger, console, or emitted as error |
| `src/protocol/compact-envelope.js` | 51 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/readonly-mcp-server.js` | 196 | **B** | `// Ignore inaccessible files` | Completely silent bare catch |
| `src/readonly-mcp-server.js` | 262 | **A** | `return;` | Handled via safe default/fallback return |
| `src/readonly-mcp-server.js` | 299 | **B** | `// Skip unreadable files` | Completely silent bare catch |
| `src/readonly-mcp-server.js` | 370 | **A** | `return { content: [ { type: 'text', text: JSON.stringify({ e` | Handled via safe default/fallback return |
| `src/readonly-mcp-server.js` | 480 | **B** | `res.writeHead(200, { 'Content-Type': 'application/json'` | Silent failure without logging or propagation |
| `src/readonly-mcp-server.js` | 505 | **B** | `res.writeHead(400, { 'Content-Type': 'application/json'` | Silent failure without logging or propagation |
| `src/session-adapters/desktop-notifier.js` | 27 | **B** | `resolve(false);` | Silent failure without logging or propagation |
| `src/session-adapters/desktop-notifier.js` | 43 | **B** | `resolve(false);` | Silent failure without logging or propagation |
| `src/session-adapters/desktop-ui-adapter.js` | 64 | **A** | `return false;` | Handled via safe default/fallback return |
| `src/session-adapters/desktop-ui-adapter.js` | 255 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/session-adapters/desktop-ui-adapter.js` | 265 | **B** | `JSON.stringify({ ok: false, error: e.message` | Silent failure without logging or propagation |
| `src/session-adapters/desktop-ui-adapter.js` | 279 | **A** | `return { submitted: false, error: err.message` | Handled via safe default/fallback return |
| `src/skills/scanner.js` | 184 | **B** | `violations.push(`Failed to read SKILL.md: ${err.message` | Silent failure without logging or propagation |
| `src/skills/scanner.js` | 222 | **B** | `violations.push(`Failed reading skill directory structure: $` | Silent failure without logging or propagation |
| `src/skills/scanner.js` | 258 | **B** | `warnings.push(`Could not read file '${relFile` | Silent failure without logging or propagation |
| `src/skills/skills-manager.js` | 51 | **A** | `// swallow-ok: safe fallback for plaintext or non-JSON input` | Explicitly reviewed with swallow-ok justification |
| `src/skills/skills-manager.js` | 133 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/skills/skills-manager.js` | 197 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/skills/skills-manager.js` | 337 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/storage/backup-restore.js` | 47 | **B** | `// Fallback to safe read-copy if VACUUM INTO is unsupported ` | Silent failure without logging or propagation |
| `src/storage/backup-restore.js` | 51 | **A** | `// swallow-ok: best-effort disposal cleanup` | Explicitly reviewed with swallow-ok justification |
| `src/storage/backup-restore.js` | 127 | **A** | `return { valid: false, error: `Failed to open backup databas` | Handled via safe default/fallback return |
| `src/storage/retention-pruner.js` | 30 | **A** | `return { pruned: 0, cutoff` | Handled via safe default/fallback return |
| `src/storage/retention-pruner.js` | 49 | **A** | `// swallow-ok: optional record lookup fallback` | Explicitly reviewed with swallow-ok justification |
| `src/storage/retention-pruner.js` | 58 | **A** | `return { pruned: 0, cutoff` | Handled via safe default/fallback return |
| `src/storage/retention-pruner.js` | 72 | **A** | `return { pruned: 0` | Handled via safe default/fallback return |
| `src/storage/retention-pruner.js` | 86 | **A** | `return { pruned: 0` | Handled via safe default/fallback return |
| `src/storage/schema-migrator.js` | 25 | **A** | `return new Set();` | Handled via safe default/fallback return |
| `src/storage/schema-migrator.js` | 37 | **A** | `return false;` | Handled via safe default/fallback return |
| `src/storage/schema-migrator.js` | 425 | **B** | `try { this.db.exec('ROLLBACK;');` | Silent failure without logging or propagation |
| `src/storage/schema-migrator.js` | 426 | **A** | `// swallow-ok: transaction may already be resolved or closed` | Explicitly reviewed with swallow-ok justification |
| `src/task-manager.js` | 13 | **A** | `if (err.message && err.message.includes('cannot start a tran` | Handled via safe default/fallback return |
| `src/task-manager.js` | 23 | **B** | `if (started) { try { db.exec('ROLLBACK;');` | Silent failure without logging or propagation |
| `src/task-manager.js` | 25 | **A** | `// swallow-ok: transaction may already be resolved or closed` | Explicitly reviewed with swallow-ok justification |
| `src/task-manager.js` | 60 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/task-manager.js` | 102 | **A** | `// swallow-ok: DDL schema idempotency check` | Explicitly reviewed with swallow-ok justification |
| `src/task-manager.js` | 115 | **A** | `// swallow-ok: DDL schema idempotency check` | Explicitly reviewed with swallow-ok justification |
| `src/task-manager.js` | 135 | **B** | `break;` | Silent failure without logging or propagation |
| `src/task-manager.js` | 190 | **A** | `// swallow-ok: optional record lookup fallback` | Explicitly reviewed with swallow-ok justification |
| `src/task-manager.js` | 228 | **A** | `// swallow-ok: optional record lookup fallback` | Explicitly reviewed with swallow-ok justification |
| `src/task-manager.js` | 259 | **A** | `if (effectiveDedupKey && insertErr.message && insertErr.mess` | Handled via safe default/fallback return |
| `src/task-manager.js` | 379 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/task-manager.js` | 440 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/task-manager.js` | 595 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/task-manager.js` | 616 | **A** | `this.logger?.log({ agentId: 'system', action: 'startup_recov` | Logged to logger, console, or emitted as error |
| `src/task-manager.js` | 627 | **A** | `this.logger?.log({ agentId: 'system', action: 'startup_recov` | Logged to logger, console, or emitted as error |
| `src/task-manager.js` | 639 | **A** | `this.logger?.log({ agentId: 'system', action: 'startup_recov` | Logged to logger, console, or emitted as error |
| `src/task-manager.js` | 700 | **A** | `// swallow-ok: secondary notification or event dispatch fail` | Explicitly reviewed with swallow-ok justification |
| `src/task-manager.js` | 743 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/task-manager.js` | 808 | **B** | `quarantinePayload = { attemptId: effectiveAttemptId, request` | Silent failure without logging or propagation |
| `src/task-manager.js` | 878 | **B** | `if (quarantinePayload && this.attempts) { try { this.attempt` | Silent failure without logging or propagation |
| `src/task-manager.js` | 882 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/task-manager.js` | 915 | **A** | `return this.getTask(taskId, false);` | Handled via safe default/fallback return |
| `src/task-manager.js` | 928 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/task-manager.js` | 1021 | **A** | `return row.context;` | Handled via safe default/fallback return |
| `src/task-manager.js` | 1031 | **A** | `return [];` | Handled via safe default/fallback return |
| `src/telemetry/live-quota-gate.js` | 31 | **A** | `return 0;` | Handled via safe default/fallback return |
| `src/telemetry/live-quota-gate.js` | 97 | **B** | `process.stderr.write(`[LiveQuotaGate] Failed to write log: $` | Silent failure without logging or propagation |
| `src/testing/conformance-suite.js` | 67 | **B** | `healthDetails = { error: err.message` | Silent failure without logging or propagation |
| `src/tool-registry.js` | 476 | **C** | `if (artErr?.code === 'ARTIFACT_UNAUTHORIZED') { throw artErr` | Rethrows or rejects with error |
| `src/tool-registry.js` | 655 | **C** | `const durationMs = Date.now() - t0; context.diagnostics?.rec` | Rethrows or rejects with error |
| `src/tool-registry.js` | 702 | **C** | `const durationMs = Date.now() - t0; context.diagnostics?.rec` | Rethrows or rejects with error |
| `src/tool-registry.js` | 744 | **A** | `// swallow-ok: safe fallback for plaintext or non-JSON input` | Explicitly reviewed with swallow-ok justification |
| `src/tool-registry.js` | 856 | **C** | `effectsLedger.failEffect(intent.effectId, err); const durati` | Rethrows or rejects with error |
| `src/tool-registry.js` | 1682 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/tool-registry.js` | 1735 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/transports/transport-contract.js` | 115 | **B** | `result = new TransportResult({ outcome: TransportOutcome.FAI` | Silent failure without logging or propagation |
| `src/workspaces/workspace-manager.js` | 41 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/workspaces/workspace-manager.js` | 97 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/workspaces/workspace-manager.js` | 139 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/workspaces/workspace-manager.js` | 146 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/workspaces/workspace-manager.js` | 153 | **A** | `// swallow-ok: intentional non-fatal error suppression` | Explicitly reviewed with swallow-ok justification |
| `src/workspaces/workspace-manager.js` | 240 | **A** | `return { ok: false, error: err.message, worktreePath: resolv` | Handled via safe default/fallback return |
| `src/workspaces/workspace-manager.js` | 330 | **A** | `this.db.prepare(` UPDATE integration_queue SET status = 'REJ` | Handled via safe default/fallback return |
| `src/workspaces/workspace-manager.js` | 347 | **B** | `hasConflict = true; this.db.prepare(` UPDATE integration_que` | Silent failure without logging or propagation |
| `src/workspaces/workspace-manager.js` | 384 | **A** | `this.db.prepare(` UPDATE integration_queue SET status = 'NEE` | Handled via safe default/fallback return |
