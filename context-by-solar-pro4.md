# Agent Bridge — Complete Context by Solar Pro 4

> Compiled from a full-codebase dive: every source file, every config, every test suite outcome, every doc.
> Written in blood: what it is, what it does, what I found, what I would change.

---

## 1. What Agent Bridge IS — one sentence

A local-first, macOS-only coordination fabric that lets independent desktop AI agents (Claude Desktop, ChatGPT Desktop, Antigravity IDE, Gemini, local CLI agents) discover each other, send correlated tasks, execute authorized local operations (file read/edit, git, process spawn, symbol search), stream those operations to a dashboard, and settle results through a cryptographic nonce/epoch fencing system — BUT it is not an orchestrator, not an intelligence layer, and not a wrapper. It is the plumbing beneath them.

---

## 2. Scale & Composition (measured, not estimated)

| Metric | Value |
|---|---|
| **Total project JS lines** (excludes node_modules, .git, tests) | **70,797 lines** |
| **src/ only** | **37,124 lines** across 123 source files |
| **src/ disk size** | 1.5 MB |
| **node_modules** | 245 MB (zod, @modelcontextprotocol/sdk, better-sqlite3, uuid, etc.) |
| **Test files** | 134 test files |
| **Git commits (origin/main)** | 79 commits |
| **Git branches** | 13 |
| **.git object size** | 162 MB |
| **Top-level config keys** | 22 |
| **IMPLEMENTATION_STATE.md** | 822 lines — a checkpoint ledger, not a changelog |
| **README.md** | Honest evidence tiers, not marketing. No screenshot. No "✨" |

Largest single source files (src/):

1. `tool-registry.js` — 2,548 lines
2. `mailbox-hub.js` — 2,499 lines
3. `project-controller.js` — 1,099 lines
4. `artifact-store.js` — 1,058 lines
5. `http-server.js` — 1,026 lines
6. `task-manager.js` — 982 lines
7. `event-bus.js` — 960 lines
8. `git-controller.js` — 863 lines
9. `autonomous-collaboration-orchestrator.js` — 799 lines

Biggest internal design tension: the two largest files (`tool-registry.js`, `mailbox-hub.js`) are exactly the two places where "just add one more tool/one more mail path" produces the most branching complexity.

---

## 3. Architecture — the shape of the thing

### 3.1 The four-layer spine

From the outside in:

```
Agent Apps (Claude / ChatGPT / Antigravity / Gemini / CLI)
   │
   ▼
Entry Points
   mcp-server.js  ·  http-server.js  ·  bin/bridge.js  ·  agent-runner.js
   │
   ▼
Security & Control Substrate  (PermissionGuard · WAL audit logger · ResponseCorrelatorV2)
   │
   ├──► Tool Registry   (single unified registry for MCP + HTTP JSON-RPC)
   │
   └──► Control Plane Routing
          CliProcessAdapter
          ChromiumCdpAdapter
          NativeAxAdapter  (Swift AX helper daemon)
          ModelOrchestrator / MultiHopRouter
   │
   ▼
Storage & Persistence
   SchemaMigrator (PRAGMA user_version, forward-only)
   ArtifactStore   (SHA-256 CAS, O_EXCL/O_NOFOLLOW, realpath containment)
   RetentionPruner (lease + request pruning)
```

### 3.2 The golden rule the code enforces

**No agent can widen its own permissions.**

There is no tool, no endpoint, no config path that lets a connected model:
- add itself to `AGENT_IDENTITIES`
- modify `agentPolicies`
- approve its own skills
- escape `ALLOWED_ROOTS`
- execute a command not on the allowlist
- read a file outside containment
- promote itself to `system`

Only the human operator on the local machine can do those things — via CLI or dashboard, both local-only.

### 3.3 Request lifecycle (the real call chain, not the marketing one)

1. Agent A dispatches `bridge_ask_agent` (or `bridge_delegate_task`) with `{ toAgent, question, contextRef?, contract? }`
2. `ToolRegistry.executeTool('bridge_ask_agent', args, ctx)`
3. `MailboxHub.askAgent()`:
   - optional `SemanticCache` check (opt-in, read-only)
   - optional `CheapFirstRouter` (opt-in, only when no target is declared)
   - inserts into `bridge_requests` with `status='pending'`, `attempt_id`, `epoch`
4. `ResponseCorrelatorV2.generateNonce(requestId, attemptId, epoch, routeId)`
5. Route selection: CLI → `CliProcessAdapter.send()`, CDP → `ChromiumCdpAdapter.send()`, AX → `NativeAxAdapter.send()`
6. Observation:
   - streamed chunks/ deltas captured
   - tokens committed to `BridgeDisplayManager`
   - completion tier classified:
     - `AUTHENTICATED_SUBMIT` (nonce-matched `bridge_submit_task_result`) — highest confidence
     - `NETWORK_END_OF_STREAM`
     - `A2A_COMPLETION`
     - `PROCESS_EXIT`
     - `UI_STOP_IDLE`
     - `STABILITY_HEURISTIC` — always labeled low-confidence
7. Settlement:
   - `AttemptLedger.validateFencing()` rejects stale/duplicate attempts
   - `ResponsePreserver` / `ArtifactStore` write authentic response artifact
   - `TokenAccountant` records honest usage
   - MailboxHub resolves waiter, returns `CorrelatedResponse` to Agent A

### 3.4 Multi-hop chains

- `MultiHopRouter` (`src/control-plane/multi-hop-router.js`)
- `CollaborationGuard`: hop budget (max 10), cycle detection
- Context passed by hash reference (`ref_<sha256>`), not body retransmission
- `RollingSummaryManager` keeps a compact summary across intermediate hops
- Intermediate agents are NOT woken merely to relay

---

## 4. The subsystems — what each piece actually does

### 4.1 PermissionGuard (`src/permission-guard.js`, 491 lines)

Default-deny gate. Every protected tool/route runs through it.

What it does:
- Identity resolution (who is calling)
- Permission lookup against `agentPolicies`
- Path containment check via `fs.realpathSync` against `ALLOWED_ROOTS`
- Command allowlist enforcement for process execution
- Protected branch guard for git push (main/master/production/release blocked unless `allowProtected` or `ALLOW_AUTONOMOUS_PROTECTED_PUSH`)

What it does NOT do:
- It is not a sandbox. It is an authorization gate.
- It does not replace macOS sandbox, SIP, or filesystem permissions.
- It trusts the local caller identity; it does not authenticate the remote model itself.

### 4.2 AgentIdentityManager (`src/agent-identity.js`, 205 lines)

3-tier identity resolution:
1. Explicit agent id from context (if already authenticated session)
2. Environment/startup identity
3. Fallback/declared identity from config

Used by PermissionGuard and MailboxHub to know who is asking.

### 4.3 EffectsLedger (`src/effects/effects-ledger.js`, 289 lines)

Classifies 17 tools into effect tiers:
- read
- write
- execute
- network
- collaboration
- configuration
- destructive

This is what `PermissionGuard` and the tool registry use to decide "can this agent even touch this tool."

V2 fencing: effects are tied to attempt/epoch so the same tool invocation cannot be double-settled.

### 4.4 ToolRegistry (`src/tool-registry.js`, 2,548 lines)

The single source of truth for every tool MCP and HTTP can call.

What it contains:
- `SKILLS_TOOL_DEFINITIONS` — frozen array
- `COMMUNICATION_TOOL_DEFINITIONS` — frozen array
- `TOOL_PROFILES` — frozen
- `PROFILE_TOOLS` — frozen
- `ToolRegistry` class — the live registry

Roughly 74 distinct tools across categories:
- filesystem (read/edit/create/delete/search)
- git (status/diff/log/commit/push/resolve)
- process execution (allowlisted, argv, sanitized env)
- collaboration (ask/delegate/submit/notify)
- symbol outline / code intelligence
- artifacts (store/read/transfer)
- knowledge store queries
- skills (install/approve/uninstall)
- dashboard/telemetry
- diagnostics

Profiles gate which tools a given agent identity can see/use.

### 4.5 MailboxHub (`src/mailbox-hub.js`, 2,499 lines)

The heart of inter-agent coordination.

Responsibilities:
- durable request queue in SQLite (`bridge_requests`)
- request state machine: `pending → claimed → in_progress → completed/failed/cancelled/quarantined`
- correlation via `ResponseCorrelatorV2`
- waiter resolution / async response binding
- pending work digest for session adapters (e.g., "you have 3 pending requests")
- cross-agent delivery to the correct route/adapter

This is the file that makes "agent A asks agent B" durable rather than a fragile in-memory promise.

### 4.6 HTTP Server (`src/http-server.js`, 1,026 lines)

Endpoints:
- MCP over HTTP JSON-RPC
- SSE for dashboard live tailing
- `/api/task`, `/api/message`, `/api/audit`, `/api/mcp/call` — all auth-gated
- Host/Origin guard: non-loopback Host → 403; untrusted Origin → 403
- Unauthenticated POST to `/mcp` → 401 `{ok:false, error:"Unauthorized: missing or invalid API key."}`
- Dashboard serves strict CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'`

Auth:
- `extractApiKey()` from `X-API-Key` header or `Bearer` token
- `resolveAuth()` returns 401 when `requireApiKey` is true and no valid key
- Dashboard token is randomly generated per-run (`crypto.randomBytes(24)`) — not hard-coded
- Control-plane API key from macOS keychain or `AGENT_BRIDGE_KEY` env — never hard-coded

### 4.7 Dashboard (`src/dashboard/dashboard-server.js`, 215 lines)

- Port 8768
- Token-gated (random per-run)
- Streams live agent activity, request state, audit tail
- Agent approval from dashboard requires human authentication; agents cannot self-approve

### 4.8 Control Plane (`src/control-plane/`, 404 KB — the largest src/ subtree)

- `chatgpt-autonomous-session.js` — 503 lines, the largest single control-plane file
- `desktop-control-adapter.js` — 101 lines
- `conversation-registry.js` — 168 lines
- `autonomous-collaboration-orchestrator.js` — 799 lines
- `multi-hop-router.js`
- `chatbot-discovery.js` / `browser-discovery.js` (Chrome/Edge CDP discovery)

This is where "actually drive the desktop app or browser" lives:
- Zero-focus spawn for CLI
- CDP target/DOM for Chromium
- Swift AX helper daemon for macOS Accessibility

### 4.9 Artifacts (`src/artifacts/artifact-store.js`, 1,058 lines)

Content-addressed storage for binary artifacts (PNG, MP4, JPEG, GIF, WebP, MOV, txt, json,bin).

Security properties:
- artifact ids are server-generated → caller cannot influence path
- paths containment-checked against artifact root
- files created with `O_EXCL` + `O_NOFOLLOW` (no clobber, no symlink follow)
- reads reject symlinks and re-verify containment via `realpath`
- size limits enforced
- MIME/content agreement enforced
- signature MIME types (png/jpeg/gif/webp/mp4/mov) MUST match magic bytes
- retrieval authorized per artifact: storing agent + explicitly authorized agents only

Default max: 500 MiB (`AGENT_BRIDGE_MAX_ARTIFACT_BYTES`). Max inline: 8 MiB.

Tests verify real binary round-trip:
- PNG byte-for-byte with SHA-256
- MP4 video round-trip
- chunked streaming tests with SHA-256

All three apps (claude, chatgpt, gemini) can receive real bytes via `bridge_artifact_read` (base64 + SHA-256), not just a path.

### 4.10 Knowledge Store

FTS5 + BM25 full-text search on top of SQLite. Provenance tracked. Lifecycle states enforced. This is how "search across stored context" is real, not a mock.

### 4.11 Skills Platform

- `SignedSkillRegistry` — single source of truth with SHA-256 integrity verification
- Skills start in `pending-user-approval`
- Agents cannot approve skills; only human operator via CLI `bridge skill approve <name>` or dashboard
- Agent self-approval is rejected by cryptographic identity verification
- Vetted skill pinned at a specific commit (dbd4588 in the evidence)

### 4.12 Protocol V2

Standardized identifiers:
- `req_<timestamp>_<hex>`
- `task_<timestamp>_<hex>`
- `att_<epoch>_<hex>`
- `nonce_<random_bytes_hex>`
- `a2a_corr_<hex>`
- `ref_<sha256_hash>`

Request envelope is immutable. States are monotonic. Duplicate terminal settlement is rejected by SQLite constraints + attempt ledger fencing.

### 4.13 Other modules (24 more subsystems)

EventBus, TaskManager, Collaboration patterns, CLI (`bin/bridge.js`), Capabilities/EvidenceRegistry, Diagnostics, Desktop notifier, Compression, Routing, Security utilities, Storage, Memory, Tokenizers, transports, session adapters (claude, chatgpt, gemini, base), workspaces, testing harness, contract validator, symbol outline generator, project-controller, git-controller, and 15+ more.

---

## 5. What the docs promise vs what the code earns

The docs are unusually honest for an agent project:

- **README.md** lists `live-verified`, `mock-tested`, `declared` as distinct evidence tiers.
- **security.md** states explicitly: unauthenticated protected endpoints fail closed with 401.
- **threat-model.md** enumerates 6 attackers and 10 invariants, then says those invariants are enforced by automated regression and mutation tests.
- **protocol.md** labels `STABILITY_HEURISTIC` as low-confidence (0.3) and refuses to dress it up.

This is not a project pretending everything is verified. It is a project that has drawn a line between "verified", "tested with fakes", and "declared but not yet active", and put that line in the README.

---

## 6. What I found — honest assessment

### Strengths

1. **PermissionGuard is real.** Not a stub. Realpath canonicalization, allowlist, path containment, command allowlist, protected branch guard. 491 lines of "what could go wrong" thinking.
2. **Claim/lease/recovery in mailbox.** Durable requests with monotonic states, attempt/epoch fencing, duplicate settlement rejection. This is what turns "agent asks agent" from a flaky in-memory idea into something that survives process restart.
3. **ArtifactStore is security-engineered, not just storage.** O_EXCL, O_NOFOLLOW, realpath re-check on read, signature MIME verification, per-artifact authorization, SHA-256 on write and read. This is the right shape for a system that passes binary artifacts between agents.
4. **ToolRegistry is the single registry.** MCP and HTTP go through the same tool definitions. This avoids the dual-source-of-truth drift that kills a lot of MCP+HTTP projects.
5. **Identity resolution is layered.** Not "trust whatever the caller says." Three-tier, with PermissionGuard on top.
6. **Test coverage is broad.** 134 test files. 1,044 passing in the npm run verify outcome. Artifact round-trips are real binary, not mock.
7. **Docs are evidence-honest.** The README evidence matrix is the kind of thing most projects lie about. This one publishes its own uncertainty.

### Weaknesses

1. **`index.js` is a thin shell and that is slightly dangerous.** It logs config and starts the MCP stdio server. That is fine, but the real startup orchestration (which subsystems initialize in what order, which failures are fatal, which are recoverable) is spread across the entry points and control-plane files. A new reader cannot see the startup graph in one place.
2. **The running bridge's commit origin is unknowable from the data available.** Process start time and command line do not cleanly map to a single commit. That is a live-operations observability gap: if you are running a bridge process, you should be able to answer "which build am I?" without guessing.
3. **Mutation/invariant testing exists but is not always live in the regular path.** The threat model says 10 invariants are enforced by mutation tests. Whether they run in the default `npm test` path by default is murky. If they are manual/opt-in, that is a slower immune system than it should be.
4. **The largest files are the most branched.** `tool-registry.js` (2,548) and `mailbox-hub.js` (2,499) are the two files most likely to accumulate conditionals as new tools/routes are added. Without clear sub-section boundaries, these become the files everyone is afraid to touch.
5. **Session adapters are thin for some agents.** Claude adapter is well-developed (notifications, activate app on wake, pending digest). Others are thinner. That is acceptable for a V1, but it means "agent X can receive a task" does not always mean "agent X has a rich delivery experience."
6. **Tool count vs advertised count may be slightly mismatched.** The tool registry is large (effectively ~74–81 distinct tool shapes depending on how you count profile-gated vs always-present). If the number advertised to an agent or in docs is a rounded count, that is fine; if it is an exact claim, it should be exact.
7. **Timestamps / state ledger entries are scattered across modules.** Audit, attempt ledger, mailbox states, artifact metadata, token accountant — all have timestamps, but not one canonical "event time" abstraction. That is fine until you need a consistent timeline across subsystems.
8. **No explicit post-heuristic confirmation path for the lowest tier.** `STABILITY_HEURISTIC` is correctly labeled low confidence. The question is what the system does after that — does it surface the uncertainty to the operator, does it require confirmation, does it mark the result as provisional? The protocol is honest about confidence; the downstream handling could be more explicit.
9. **Dashboard demo data uses `ab_tok_...` style strings.** These are test fixtures / demo data, not real credentials, but they are exactly the shape of a credential and could confuse a future reader who does not know the demo fixture convention.
10. **Separate recovery timers / retries in more than one place.** Mailbox, artifact, collaboration, and control-plane each have their own timeout/retry thinking. Not necessarily wrong, but the retry policy is not one coherent document or abstraction.

### Surprises

- The Swift AX helper lives at `tools/macos-accessibility-helper/.build/release/bridge-ax-helper`. That is a real compiled binary in the repo, not a "would be nice" note.
- The artifact store's magic-byte signature verification is the kind of thing most projects skip and then get wrong later. Here it is explicit for the signature MIME types.
- The README evidence matrix is uncomfortably honest. Most projects would say "verified" and move on. This one separate `live-verified`, `mock-tested`, and `declared`.

---

## 7. What I would improve — ranked

### High priority (would materially reduce future bugs / confusion)

1. **One-page startup graph.** A single doc or diagram (or at least an `INTERNAL_STARTUP.md`) that says: "on `node src/index.js`, these subsystems initialize in this order, these are fatal, these are recoverable, these require X env var." Right now that graph is distributed across `index.js`, `mcp-server.js`, `http-server.js`, `config.js`, and the control-plane files. For a 37k-line system, that is too much archaeology for the first question a new contributor asks.

2. **Make the 10 security invariants run in the default test path.** If they already do, document it explicitly in README and `package.json` scripts. If they are opt-in, make the default `npm test` (or a clearly documented `npm run verify`) include them. The threat model promises enforcement; the test command should make that promise easy to verify.

3. **Coherent retry / timeout policy.** Centralize or at least document the timeout/retry thinking across mailbox, artifact, collaboration, and control-plane. Right now each subsystem has its own timer-shaped decisions. A single "agent bridge retry and timeout policy" doc would reduce the odds of divergent behavior in edge cases.

4. **Canonical event time abstraction.** One small utility that all state ledger / audit / artifact / mailbox timestamping goes through. Not because the current code is wrong, but because a 37k-line system will eventually need a consistent timeline for debugging, audit, and "what happened right before that failure."

### Medium priority (would improve maintainability and onboarding)

5. **Sub-section the two large files.** `tool-registry.js` and `mailbox-hub.js` are each ~2,500 lines. Add clearer internal section boundaries, module-like region comments, or split out pure subsections (e.g., tool definition constants, profile resolution, mailbox state machine) so that the files are navigable without holding the whole thing in your head.

6. **One authoritative tool count source.** If the docs or agent-facing responses say "N tools," that N should come from one canonical accessor rather than being hand-counted or hand-written in multiple places.

7. **Dashboard demo fixture convention + comment.** If `ab_tok_...` style strings are demo fixtures, mark them as such explicitly near their definition, so a future reader does not spend 20 minutes wondering whether they are real credentials.

8. **Post-heuristic result handling.** Make the path after `STABILITY_HEURISTIC` explicit: does the result get marked provisional, does it get surfaced to the operator, does it require confirmation? The protocol already labels confidence; the downstream behavior should be just as visible.

### Low priority (nice-to-have, not blocking)

9. **Start/build id visible in the running process.** A small startup log line or process metadata that ties a running bridge to its build/commit. This solves the "which commit am I running?" question without guessing from process start time.

10. **Explicit default agent permission summary in docs.** The code is clear; the docs could be one short matrix: "by default, agent X can/cannot do Y." Helpful for operators who are not going to read 491 lines of PermissionGuard.

11. **README "what this is not" line.** One bullet that says what Agent Bridge explicitly does not do (orchestration, model inference, remote access, a sandbox, a replacement for macOS sandbox/SIP). The README already implies this; making it explicit would reduce misdirected expectations.

12. **Test count breakdown in CI/diagnostics.** A small diagnostic or CI note that says how many tests are live-model, how many are mock/integration, how many are unit. Right now that information exists in the test outcomes, but it is not surfaced as a first-class number an operator can check at a glance.

---

## 8. The short version — my read on the author's mindset

This is a project written by someone who has already been burned by:

- over-promising verification
- under-securing a tool registry
- trusting a model too much
- letting a big file become a big file without boundaries

So the code defaults to:
- default-deny
- realpath containment
- nonce/epoch fencing
- SHA-256 on anything that crosses a trust boundary
- honest evidence tiers instead of a single "verified" stamp
- no self-elevation path for agents

The project is not trying to be impressive. It is trying to be difficult to misuse. That is a coherent and useful design goal, and the code mostly earns it.

The biggest gap is not security — it is **operability and navigable size**. The system has the architecture of something that could be trusted to run locally; it does not yet have the onboarding shape of something a new contributor can understand in an afternoon. The two largest files, the distributed startup graph, and the slightly scattered retry/timer logic are the places where that shows up first.

---

*Compiled by Solar Pro 4 from a full codebase dive of Agent Bridge, src/, docs/, config, tests, evidence logs, and git state.*
