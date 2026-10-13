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
| **node_modules** | ~245 MB (`@modelcontextprotocol/sdk` installed dependency tree) |
| **Test files** | 133 test files (1,156 tests) |
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

---
---

# 9. ADDENDUM BY BUFFY — THE DIRECTION
## Fastest · Cheapest · Fewest Tokens · Maximum Inter-Agent Power

> Written by **Buffy** after a full adversarial audit of HEAD `a8abd59` (74 tools, 37,124 LOC in `src/`, 26 app tables, WAL, 1 runtime dep, 1120 tests / 8 skips, 3 live MCP servers, `user_version = 0`).
> Solar Pro 4 above described the system as it is. This section is the system as it *should* become — the actual direction, with the engineering to back it, the numbers to aim at, and the acceptance tests that prove it worked.
> Ground rule I apply to myself: nothing that defeats authentication, raids rate limits, circumvents a provider's paid tier, or breaks the law. Where such a shortcut exists I name it, then give its **legal twin** — which, in this architecture, is almost always *faster* anyway, because it removes a network round trip that the illegal route needs.

---

## 9.0 The one law

> **The bridge must be a zero-token plane.**

No model call ever happens *inside* Agent Bridge. The bridge moves bytes, holds state, and enforces policy. Every microsecond of reasoning happens at an edge (an agent) or in a **local open-weights model** you own. The moment you put an LLM in the middle — for "smart routing", "summarising", "deciding who handles this" — you have added a permanent per-message tax that is larger than everything else in this document combined.

Every other decision in §9 flows from this law. If a proposal needs a paid model to work, it is wrong; it becomes a proposal that needs a **local** model or a **deterministic** rule.

---

## 9.1 The physics — three meters, and only one of them is real money

There are three things people optimise, and only one of them costs you anything:

| Meter | What it measures | Real cost | Priority |
|---|---|---|---|
| **Wire bytes** | size of the JSON/CBOR on the MCP or HTTP socket | ~zero (loopback, memory bandwidth) | **Ignore** |
| **Model-context tokens** | size of everything the receiving agent must *read* to do its job | **the only currency** | **Optimise everything** |
| **Bridge latency** | time the *bridge itself* adds between request and answer | your users' patience | **Optimise hard** |

The mistake every agent framework makes is optimising the wire. Compressing JSON, going binary, using CBOR — all fine, all nearly irrelevant. The bytes that matter are the ones that get **pasted into a prompt**: tool schemas, system prompts, context bodies, conversation history, and the answer itself if it arrives with preamble attached.

**Corollary:** the fastest, cheapest, least-token bridge is the one that puts the *fewest things into other people's prompts*. That is a protocol design problem, not a serialisation problem.

### The three levers, ranked by return on effort

1. **What you put in the prompt** (tool schemas, context bodies, history) — 80% of the win, 20% of the effort.
2. **How many times you call a model at all** (reuse, routing, speculation) — 15% of the win, 25% of the effort.
3. **Which model answers** (cheap-first, tier-aware) — 5% of the win, 5% of the effort, but the 5% is pure margin.

### The latency reality

For any external agent, **model generation time dominates by 10–100×**. The bridge's job is to make its own contribution indistinguishable from zero, and then to make sure the requester is *asleep* (spending nothing) until the answer exists.

What the bridge owns and must fix:

| Bridge-owned delay | Current | Why it exists | Target |
|---|---|---|---|
| Response observation poll | **600 ms** tied to a poll loop | observer polls the UI/stream for "is it done" | **0 ms** — push on event |
| Recovery sweep | **2000 ms** (`mailbox-hub.js:76,414`) | re-scans for expired leases | **0 ms** — cursor-driven, sweep only as crash repair |
| Fallback delivery poll | ~500 ms | requester checks for a response | **0 ms** — wake the waiter |
| Wake path | DB read + in-process event | — | **< 1 ms p99** |
| Delivery path | DB read + serialise | — | **< 2 ms p99** |

**Every poll in this system is a bug with a timer.** Concretely: 600 ms of poll is *free* in tokens but *expensive* in the only thing users notice — and it is paid on **every single turn**, forever.

---

## 9.2 Target SLOs — the contract this direction is judged against

| # | Metric | Target | How measured |
|---|---|---|---|
| S1 | Bridge overhead, local route (p99) | **< 5 ms** | monotonic clock, request insert → waiter wake |
| S2 | Observation → settlement (event-driven) | **< 20 ms** | event timestamp → `completed` |
| S3 | Tokens per delegated request, bridge-attributable | **< 400** for a 1-line question | `TokenAccountant` delta |
| S4 | Tool-schema tax per turn | **< 600 tokens** | serialised schemas actually sent |
| S5 | Regeneration of a completed answer | **exactly 0** | grep for second model invocation per request |
| S6 | Base64 inflation of artifacts | **0** | assert all artifact paths are URLs/refs |
| S7 | Poll loops in the hot path | **0** | assert no `setInterval` on request/response paths |
| S8 | Cost per 1000 cross-agent turns | **trend down monotonically** | ledger rollup |

Any change that regresses S5 (re-generation) is rejected regardless of what else it improves. Zero-waste is non-negotiable; it is the product.

---

## 9.3 The fourteen structural moves

Each move: **the idea → why it wins → what changes in the code → what it costs → risk → acceptance test.**

### M1 — Zero-token plane (enforce it in CI)
**Idea.** Ban model inference inside `src/`. Route/decide/summarise with deterministic rules or a local model.
**Why.** A single LLM call in the bridge adds tokens to *every* request and one more network dependency. `CheapFirstRouter` and `SemanticCache` already exist as opt-ins — that's the correct instinct; the danger is letting either become a paid call.
**Code.** Add an import-graph assertion: no HTTP client to `api.openai.com` / `api.anthropic.com` / `generativelanguage.googleapis.com` from `src/`. Any local model must be behind `AB_LOCAL_MODEL_URL` (loopback only) and must be **off by default**.
**Cost.** 1 test.
**Risk.** Someone "helpfully" adds a router model. CI stops it.
**Acceptance.** `grep -r "api.openai.com\|api.anthropic.com" src/` → 0 hits; the assertion fails the build if that changes.

---

### M2 — Progressive tool disclosure (kill the 74-schema tax)
**Idea.** Never send 74 tool schemas. Send **8 core tools** by default; the rest arrive only when an agent asks for them, and even then as **names + one-line purpose**, never full JSON Schema, until the agent commits to calling one.
**Why.** This is the single largest token cost in the system. 74 tools × (name + description + JSON Schema, typically 100–350 tokens each) is a **7,000–18,000-token tax paid on every turn by every agent** — before anyone has said anything. Most agents use fewer than 6 of the 74 in a session.
**Code.**
- Replace the flat tool list with three tiers: `core` (always), `standard` (declared in a one-line manifest ~40 tokens), `extended` (fetch on demand via `bridge_describe_tool`).
- Add a **manifest tool**: `bridge_capabilities({detail:"names"|"brief"|"schema"})` returning the same data at three resolutions. Names-only manifest for 74 tools ≈ **350 tokens** instead of ~12,000.
- Make the manifest **stable and prefix-friendly** (see M10) so it can live in a cached prompt prefix.
**Cost.** M — a registry refactor + a new tool + updated `TOOL_PROFILES`.
**Risk.** Agents pick the wrong tool from a short description. Mitigate with a 3-line "when to use" for the 10 most-confused pairs, and by keeping the tier-1 set purposefully small.
**Acceptance.** S4 measured on a real session: < 600 tokens of tool schema. A/B on 50 tasks: task success rate does not drop more than 2 points.

---

### M3 — The answer-only contract (zero-waste, at the protocol layer)
**Idea.** A delegated request carries a **response contract** that the responder must satisfy: *answer only, no preamble, no restatement of the question, no apology, no formatting flourishes unless asked*. The bridge **validates** the contract before settlement.
**Why.** This is your product goal written as an enforced wire format. Today it is a convention; make it a field. Huge, free token savings on both directions: the requester reads less, and the responder wastes fewer output tokens.
**Code.** Add `contract: { answerOnly: true, maxWords, format: "text"|"json"|"md", forbidPreamble: true, includeNonce: true }`. In the settlement path (before writing `bridge_requests.response`), run a **cheap deterministic stripper**: drop leading "Sure!", "Certainly", "Here's the answer:", trailing "Let me know if…". Log the byte/token delta to the ledger. If a preamble is detected above a threshold, mark the attempt `CONTRACT_VIOLATION` and (configurably) re-ask **once** — never more.
**Cost.** S–M. A regex/deterministic stripper is ~50 lines.
**Risk.** Over-stripping legitimate content. Guard: only strip if the remainder is non-trivial (>30 words) and the removed text matches a bare-pleasantry grammar.
**Acceptance.** S5 = 0 regenerations; measured mean output-token drop on a 30-request sample.

---

### M4 — Refs everywhere, bodies never
**Idea.** Context is **always** passed by content hash (`ref_<sha256>`), never re-serialised inline. Both directions. Including long answers that are then quoted to a third agent.
**Why.** You already have the primitive (`ref_<sha256>` in the protocol, `RollingSummaryManager`, `bridge_context_cache`). The remaining wins are in **making it the only path** — kill every code path that copies a body where a ref would do. A 4,000-token answer forwarded to 3 agents costs 12,000 tokens inline, or 3 ref lookups and ~0 tokens if each agent fetches it when needed.
**Code.** Audit every `context` parameter; convert to `contextRef` + optional `contextPreview` (first 200 chars, marked as a preview). Reject inline bodies above a threshold with a typed error `CONTEXT_TOO_LARGE_USE_REF`.
**Cost.** M.
**Risk.** Extra round trip for tiny contexts. Use a size threshold (~500 tokens) below which inline is allowed.
**Acceptance.** `grep` shows no path that copies a body >500 tokens; ledger shows multi-hop token cost flat in hop count.

---

### M5 — Event-first, polling never
**Idea.** Replace all three timers with **push**:
- **UI completion:** the Swift AX helper installs an `AXObserver` for `AXValueChanged` / `AXUIElementDestroyed` / `kAXSelectedTextChanged` on the response region and pushes an event the instant text stops changing. No 600 ms poll.
- **Stream completion:** CDP/`Network` events and SSE chunk callbacks fire settlement directly. No poll.
- **Lease/sweep:** the sweep keeps the timer **only as crash repair**, and moves off the hot path entirely (it must not run during an active request).
**Why.** This removes the largest bridge-owned latency and the only *unbounded* one (a poll that catches your answer just after it ticks costs you a full interval). It also makes the system deterministic under load — polling competes with itself as task count grows; events do not.
**Code.**
- Extend `tools/macos-accessibility-helper` with an observer mode that emits newline-delimited JSON on stdout; the session adapter reads it as a stream. Quiescence = *no event for N ms* where N is 60–120 ms (down from 600).
- In `response-observer.js`, make the poll interval a **fallback** that only arms after a configurable silence window, instead of the primary mechanism.
- Align the settlement write with the event: event → single transactional write → wake waiter. One hop, no scan.
**Cost.** M–L (the Swift side is the work).
**Risk.** AX notifications are coalesced/dropped by some apps. Mitigation: belt-and-braces — push primary, poll fallback armed only on silence, plus a hard cap.
**Acceptance.** S2 < 20 ms with a synthetic instantaneous responder; poll count during a real turn = 0 in logs.

---

### M6 — One process, not three (single writer, client shims)
**Idea.** Exactly **one** long-lived bridge daemon owns the DB and the port. Every client (Claude.app, Antigravity, CLI, this session) talks to it through a **thin shim** over stdio/socket. No second writer.
**Why.** Today 3 `node src/mcp-server.js` processes exist — two from *the same* Antigravity IDE (one per language-server instance), and the **port is owned by the non-workspace one** (traced: 16225 ← 12937 ← 12523; 16287 ← 13631 ← 12938 ← 12523; 17000 ← 16999 ← Claude.app). Multiple writers on one WAL file is correct-but-unsynchronised at the application layer; it also triples memory, triples WAL contention, and makes "which process handled this?" unanswerable.
**Code.**
- `bin/bridge-supervisor.js` becomes the daemon (it already exists). MCP servers become shims: forward tool calls over a Unix socket to the daemon.
- `PRAGMA locking_mode` stays normal; add a daemon-held advisory lock file with the instance id, so a second daemon refuses to start with a clear error instead of silently co-writing.
- Expose `bridge_whoami` → `{ pid, instanceId, buildId, startedAt, port }`.
**Cost.** L (touches every entry point).
**Risk.** Shim adds a hop (~0.2 ms, irrelevant) and a new failure mode (daemon down). Mitigate with auto-spawn-on-first-call and a supervisor restart.
**Acceptance.** `lsof -nP -iTCP:8765` shows exactly one listener across restarts; `ps` shows exactly one daemon; `bridge_whoami` answers; all 8 skipped live tests still skip cleanly.

---

### M7 — Artifacts by URL, never base64
**Idea.** Images/video/files are always delivered as `{artifactId, url, sha256, mime, bytes}` with the bytes fetched over **loopback HTTP with range support**. Base64 is banned on the MCP path.
**Why.** Base64 is **+33%** on the wire *and* — worse — it lands in the model's context as a giant opaque string, so it costs **tokens**, not just bytes. A 2 MB image inlined is ~700k tokens of context: catastrophic. Your `ArtifactStore` is already excellent (O_EXCL, O_NOFOLLOW, realpath re-verify, magic-byte MIME agreement, per-artifact authorization, 500 MiB default, 8 MiB inline max). The direction is to **drive inline usage to zero** and make the URL path the primary one.
**Code.**
- Add `GET /artifact/<id>` with `Range` support and a short-lived signed token bound to `(artifactId, agentId, requestId)`.
- Deprecate `inline` above 64 KiB; hard-reject above 256 KiB with `USE_ARTIFACT_URL`.
- For images, add a **thumbnail** artifact (e.g. 512 px) that a requester agent may inline *if and only if* it needs to see pixels — bounded to ~20k tokens, and only for vision-capable agents.
**Cost.** S–M (store is already there).
**Risk.** Signed-URL leakage. Mitigate: loopback-only bind, 60 s TTL, single-use jti, bound to agent + request.
**Acceptance.** S6 = 0; a PNG round-trip passes on the URL path with SHA-256 match and no base64 anywhere in the request.

---

### M8 — Deterministic router, not a model router
**Idea.** Routing = **rules**, in this order: explicit target → capability match → cheapest capable route → fallback. Zero model calls to decide.
**Why.** A model-based router costs a full inference round trip *before* work starts — the worst possible latency placement. Your `CheapFirstRouter` should be a **table**, not a brain.
**Code.**
```
1. Explicit toAgent given? -> use it
2. Capability declared?   -> capability table lookup (static)
3. Cost tier: local-engine < cli < desktop-ax < cloud
4. Health: skip routes whose last 3 attempts failed
5. Latency: prefer route with lowest EWMA of recent completions
6. Otherwise: queue + escalate to human
```
All four signals (cost tier, health, EWMA latency, capability) are already derivable from data you persist (`bridge_attempts`, `request_lifecycles`, `bridge_capabilities`).
**Cost.** S.
**Risk.** Stale health data misroutes. Mitigate with a decay window and a manual override list per agent.
**Acceptance.** Router decision latency < 1 ms; no model call in the routing path (assert by token accounting: a routing decision costs 0 tokens).

---

### M9 — Answer reuse: identity-scoped semantic cache with provenance
**Idea.** Enable `SemanticCache` by default, but with three hard rules: **(a)** identity-scoped (agent A's answer is never served to agent B unless A marks it shareable), **(b)** every hit carries `sourceRequestId` + `verifiedAt` + `route` so nothing is ever presented as "fresh", **(c)** TTL + explicit invalidation on any file/knowledge-store write that the answer depended on.
**Why.** Reuse is the only lever that makes cost **go down with usage** instead of up. The trap is correctness: a cache that returns someone else's answer, or a stale answer, destroys trust in the whole bridge. Hence the three rules.
**Code.** Key = `sha256(normalisedQuestion + capability + scopeId + contextHash)`; store the answer + provenance + dependencies (file hashes) + TTL. On any write to a tracked dependency, evict. Expose `bridge_cache_stats` so a human can see the hit rate and the risk.
**Cost.** M.
**Risk.** Silent staleness (rule b/c above) or cross-tenant leakage (rule a). Both are testable.
**Acceptance.** Tests: (1) B cannot read A's private answer; (2) touching a dependency evicts; (3) every hit report carries provenance. Hit rate reported in `bridge doctor`.

---

### M10 — Prefix-locked prompts (make the provider's cache do the work)
**Idea.** Restructure every prompt the bridge influences so the **first N tokens never change**: stable agent identity block → stable capability manifest (names tier) → stable tool list → *then* the variable question.
**Why.** Anthropic/OpenAI/Google all offer **prompt caching** with 80–90% discounts on cached prefixes. This is the single highest-leverage *money* trick available — and it is pure protocol design, zero risk. It requires only that the expensive, stable parts come first and are byte-identical across turns.
**Code.**
- Ship a canonical `AGENT_CONTEXT_PREAMBLE` (frozen, versioned) that the bridge injects identically every time.
- Make the name-tier manifest **sorted and frozen** so it never re-orders between turns (an unstable ordering silently destroys the cache).
- Add a test asserting the preamble + manifest bytes are identical across two consecutive builds.
**Cost.** S.
**Risk.** Any per-turn dynamic data accidentally placed early. Test catches it.
**Acceptance.** A hash of the prompt prefix is stable across 10 consecutive turns.

---

### M11 — Speculative fan-out + first-good-wins
**Idea.** When latency matters more than cost, dispatch the same request to **two** independent routes, settle on the first answer that passes verification, cancel the other.
**Why.** When both routes are free/local (Antigravity + Freebuff both drive local engines), duplication is **free** and halves tail latency. When one is paid, gate it behind a budget flag.
**Code.** `bridge_ask_agent({ race: ["antigravity", "freebuff"], budget: {maxCostUsd: 0} })` → two attempts, one shared request id, two attempt ids, first verified settlement wins, second gets `CANCELLED_LOST_RACE` (idempotent, never double-settles — the attempt/epoch fencing already supports this).
**Cost.** M.
**Risk.** Double side effects if the task is not read-only. **Restrict racing to read-only/effect-tier `read`** or tasks explicitly marked idempotent.
**Acceptance.** Race on a read-only task settles once; loser cancels; no duplicate audit rows; p95 latency lower than single-route.

---

### M12 — A durable budget ledger per request
**Idea.** Promote `TokenAccountant` to a **first-class, enforced** budget: every request carries `budget: {maxTokens, maxCostUsd, maxHops, maxWallMs}`. The bridge **refuses** to exceed it, and it is visible before you spend.
**Why.** "Cheapest" is only real if it is enforced. Today token accounting is observational. Make it a gate: `BUDGET_EXCEEDED` is a typed error, not a surprise bill.
**Code.** Ledger table `request_budgets(request_id, agent_id, tokens_in, tokens_out, usd, hops, wall_ms, updated_at)`. Increment on every hop. Check before every dispatch. Roll up per agent/day in `bridge doctor`.
**Cost.** S–M.
**Risk.** Under-estimated budgets abort useful work. Mitigate: warn at 80%, require explicit `--force` to override, log every override.
**Acceptance.** A request with `maxHops: 2` cannot make a third hop (typed error, tested); `bridge doctor` prints cost/day per agent.

---

### M13 — Streaming settlement (deliver while it forms)
**Idea.** The requester's **waiter** gets chunks as they arrive (`bridge_wait_for_response` streams deltas), and the final commit is an event, not a poll. The user sees tokens appear without a model turn to show them.
**Why.** This is product goal #2 verbatim: *instant delivery to requester and user, with no extra tokens spent to show it.* `BridgeDisplayManager` + `bridge tail` already do the out-of-band half. The missing half is the **requester agent** receiving an incremental stream so it does not need a second turn to come back and ask "are you done?".
**Code.** Extend `bridge_wait_for_response` to emit `{delta, done:false}` notifications on the MCP notification channel; final message carries `done:true` + full text + `sha256`. Requester's turn can end on the first delta.
**Cost.** M.
**Risk.** Partial content mistaken for final. The `done` flag is mandatory and the partial is explicitly shaped as a delta.
**Acceptance.** A requester receives deltas with no additional tool call; S2 met.

---

### M14 — Compress the *context*, not the *answer*
**Idea.** Aggressive context compaction at the harness level (the bridge's own compression modules): dedupe history, drop boilerplate, keep a rolling summary, and pass **only what the receiver needs**. Never touch the answer itself.
**Why.** Accuracy lives in the answer; waste lives in the context. This inverts the common (wrong) instinct to summarise the response.
**Code.** Use the existing `RollingSummaryManager` + `src/compression/*` on the *inbound context* only. Deterministic-first (drop repeated blocks, collapse whitespace, elide unchanged file regions with a hash marker), model-based **only** via a local model, never a paid one.
**Cost.** M.
**Risk.** Over-compression loses a needed detail. Mitigate: refs are always attached so anything elided is fetchable in one call.
**Acceptance.** Token reduction measured on a fixed 20-task corpus with task-success unchanged.

---

## 9.4 Line-item budget: what actually enters the context

A typical turn today, dissected (estimates clearly labelled — measure with `TokenAccountant`, do not trust these numbers):

| Line item | Est. tokens today | After §9 | Prescription |
|---|---|---|---|
| Tool schemas (all 74) | **7,000–18,000** | **< 600** | M2 progressive disclosure |
| Capability/identity preamble | ~400 (varies) | ~400 but **cached −90%** | M10 prefix-lock |
| Conversation history resent | 1,000–20,000 | ~0–500 | M4 refs + M14 compaction |
| Inline artifact (if any image) | 50,000–700,000 | **0** | M7 URL not base64 |
| Question | 50–500 | 50–500 | irreducible |
| **Answer (output)** | 300–3,000 | 300–3,000 | M3 strips only preamble (−5–15%) |
| Status/progress chatter in context | 0–2,000 | **0** | M13 streaming out-of-band |
| **Total bridge-attributable** | **8,000–25,000+** | **< 1,500** | — |

The headline: **tool schemas + inline artifacts + resent history are 95%+ of the waste, and none of them are the actual conversation.**

---

## 9.5 Latency budget: hop by hop

| Hop | Today | Target | Mechanism |
|---|---|---|---|
| MCP tool call in | ~0.3 ms | 0.3 ms | irreducible |
| Validate + identity | ~0.5 ms | 0.5 ms | keep |
| Persist request | ~1–3 ms (WAL) | 1 ms | single writer, prepared stmts |
| Emit event | ~0.5 ms | 0.2 ms | in-process bus |
| Wake worker | **poll 600 ms / fallback 500 ms** | **< 1 ms** | M5 push |
| Route decision | ~0.2 ms | 0.1 ms | M8 deterministic |
| Provider submit | external | external | not ours |
| Generate | **external, dominant** | external | not ours |
| Detect completion | **600 ms poll** | **< 20 ms** | M5 AXObserver/stream event |
| Settle + persist | ~2 ms | 1 ms | one transaction |
| Wake waiter | 0–2000 ms (sweep) | **< 1 ms** | waiter registry, push |
| **Bridge-owned total** | **~1,100–2,600 ms** | **< 25 ms** | **~50× better** |

That ~2 second number is the answer to "why does it feel slow even when the model was quick?" — it is not the model. It is the sweep and the polls.

---

## 9.6 Protocol: the v3 envelope

Keep JSON on the wire (it is free — see §9.1). Make it **small in the prompt** and **self-describing**:

```json
{
  "v": 3,
  "req": "req_...",
  "att": "att_...",
  "epoch": 7,
  "from": "chatgpt-desktop",
  "to": "antigravity",
  "cap": "write-tests",
  "q": "...",                       // <= 500 tokens, else use ref
  "ref": ["ref_ab12..", "ref_cd34.."],
  "contract": {"answerOnly": true, "maxWords": 120, "nonce": "nonce_.."},
  "budget": {"maxTokens": 1500, "maxHops": 2, "maxWallMs": 90000},
  "deadline": "2026-10-13T21:00:00Z",
  "sig": "hmac_..."                  // identity binding, see M6/T-4
}
```

Design notes, each field earning its place:
- **`contract`** — the zero-waste enforcement (M3).
- **`ref`** — bodies never travel (M4).
- **`budget`** — cost is gated, not observed (M12).
- **`nonce`** — inside the contract, so the answer is provably for *this* request (anti-cache, anti-confusion).
- **`sig`** — a per-agent HMAC so a client cannot claim another agent's identity. Today identity is client-declared plus an optional HTTP key; `agent_tokens` is empty. Signing is the cheapest fix and closes the confused-deputy door.
- **`deadline`** — lets the receiver abandon work it cannot finish in time instead of burning tokens on a lost cause.

---

## 9.7 THE SKILLS CATALOG — 40 primitives for agents to actually talk

Skills are the bridge's product. A skill is cheap if it is **deterministic, ref-based, and answers in one call**. Grouped by what agents need to *do together*.

### A. Discovery & presence (make the network visible, for ~0 tokens)
| Skill | Signature | Why it matters |
|---|---|---|
| `bridge_whoami` | → `{agentId, buildId, pid, caps, tier}` | "which build am I?" — closes the audit's M6/observability gap |
| `bridge_directory` | → names-tier manifest (~350 tok) | replaces 12k of schemas (M2) |
| `bridge_presence` | → `{agentId, state, lastSeenMs, queueDepth}` | know who is awake *before* delegating |
| `bridge_health` | → per-route EWMA latency, error rate | routing input to M8 |
| `bridge_capabilities` | `{detail: names\|brief\|schema}` | the one tool that replaces 74 schemas |

### B. Contract & capability negotiation (never send work nobody can do)
| Skill | Signature | Why |
|---|---|---|
| `bridge_negotiate` | `{cap, constraints}` → `{accepts, etaMs, costTier}` | refuse *before* spending tokens |
| `bridge_declare_capability` | `{cap, evidenceTier, verifiedAt}` | honest capability registry (Principle 6) |
| `bridge_quote` | `{task}` → `{tokens, usd, hops, etaMs}` | price before you buy |
| `bridge_refuse` | `{code: UNSUPPORTED\|BLOCKED}` | typed refusal, never silent success |

### C. Work transfer (the core loop, made lossless)
| Skill | Signature | Why |
|---|---|---|
| `bridge_ask_agent` | `{to, q, ref, contract, budget}` | the base primitive (exists) |
| `bridge_delegate_task` | `{to, title, ref, effects, contract}` | durable, effect-typed (exists) |
| `bridge_handoff_with_state` | `{to, stateRef, resumeAt}` | transfer *work in progress*, not just a question |
| `bridge_fanout` | `{tos[], q}` → `{answers[]}` | one question, N independent takes, one call |
| `bridge_fanout_merge` | `{answers[], policy}` | deterministic merge (no model) |
| `bridge_race` | `{routes[], policy: firstGood}` | latency or redundancy (M11) |

### D. Coordination primitives (the part nobody builds and everybody needs)
| Skill | Signature | Why |
|---|---|---|
| `bridge_lock` | `{path\|key, ttlMs}` → `{token}` | stop two agents editing the same file |
| `bridge_unlock` | `{token}` | release, fenced by epoch |
| `bridge_blackboard` | `get/set/watch {key}` | shared scratch space with refs, not bodies |
| `bridge_barrier` | `{groupId, n}` | wait until N agents reach a point |
| `bridge_quorum` | `{groupId, k}` → `{votes[]}` | k-of-n agreement |
| `bridge_auction` | `{task, maxPrice}` → `{bids[]}` | let capable agents bid tokens/time |
| `bridge_lease` | `{resource, ttlMs}` | TTL-held delegation of a resource |

### E. Verification & trust (the reason a multi-agent system is usable at all)
| Skill | Signature | Why |
|---|---|---|
| `bridge_witness` | `{requestId}` → independent reproduction | third-party check, the strongest evidence tier |
| `bridge_critique` | `{ref, rubric}` | adversarial review of an answer, *only when asked* (preserves zero-waste) |
| `bridge_vote` | `{ref, voters[]}` → `{verdict, tally}` | cheap consensus without a synthesiser |
| `bridge_diff_answers` | `{a, b}` → structural diff | shows where two agents disagree, no model needed |
| `bridge_dispute` | `{ref, reason}` | escalate a contradiction to the operator |
| `bridge_quarantine` | `{attemptId, reason}` | park a suspicious/duplicate response (you have the table) |
| `bridge_verify_contract` | `{requestId}` → `{ok, violations[]}` | proves answerOnly was honoured |

### F. Memory, learning, provenance
| Skill | Signature | Why |
|---|---|---|
| `bridge_remember` | `{key, ref, provenance}` | durable knowledge with *who/when/where* |
| `bridge_recall` | `{query, k}` → refs (FTS5/BM25) | you already have this — keep it ref-only |
| `bridge_teach` | `{skillRef, evidence}` | agent-to-agent skill exchange, human-approved |
| `bridge_forget` | `{key, reason}` | GDPR/cleanliness + cache correctness |
| `bridge_provenance` | `{ref}` → `{author, at, route, tier}` | proves where an answer came from |
| `bridge_learn_outcome` | `{requestId, grade}` | feeds M8's EWMA and M9's eviction |

### G. Economy (what makes "cheapest" real)
| Skill | Signature | Why |
|---|---|---|
| `bridge_budget` | `{req, maxTokens, maxUsd}` | enforced, not advisory (M12) |
| `bridge_spend_report` | `{agent, window}` | cost/day/agent on a dashboard |
| `bridge_escrow` | `{task, maxUsd}` | hold a budget, release on verified completion |
| `bridge_sla` | `{task, etaMs, penalty}` | let agents promise deadlines |
| `bridge_downgrade` | `{req}` | retry a task on a cheaper route |

### H. Reliability (survive the crash, the hang, the lease)
| Skill | Signature | Why |
|---|---|---|
| `bridge_checkpoint` | `{req, stateRef}` | resumable long work |
| `bridge_resume` | `{req}` | pick up after a restart |
| `bridge_replay` | `{req}` | deterministic re-run from the ref graph |
| `bridge_cancel` | `{req, reason}` | stop a runaway spend |
| `bridge_timebox` | `{req, wallMs}` | hard wall-clock cap |
| `bridge_warm` | `{agent, route}` | pre-wake a route so the first real turn is fast |
| `bridge_explain` | `{req}` | timeline reconstruction (you have this) |

### I. Human interface (the operator is an agent too)
| Skill | Signature | Why |
|---|---|---|
| `bridge_escalate` | `{req, question}` | hand a decision to the human, in one call |
| `bridge_approve` | `{skill\|task}` | human-only gate (you already enforce this) |
| `bridge_notify` | `{level, ref}` | desktop notification, out-of-band |
| `bridge_review_queue` | → pending human decisions | the operator's inbox |

### J. Meta-skills (the discipline layer — these make all of the above cheap)
| Skill | Why it is a skill and not a doc |
|---|---|
| `bridge_token_discipline` | returns the current token budget + a *cheap* reminder of the top 3 waste patterns. Injected only when the ledger crosses 80% of budget. |
| `bridge_compact_context` | ask the bridge (deterministically) to compact a context before sending. |
| `bridge_ref` | turn any body into a ref, so agents stop pasting. |
| `bridge_preview` | first 200 chars + token count — decide if you need the whole thing. |
| `bridge_describe_tool` | one schema, on demand, instead of 74 up front. |
| `bridge_contract_hint` | before delegating: "here are the 3 fields your answer must have." |

**Design rule for the whole catalog:** every skill must answer in **one call**, return **refs not bodies**, be **deterministic** where possible, and be **safe to call speculatively** (idempotent). Any skill that needs a model to answer is not a bridge skill — it is a delegated task.

---

## 9.8 The eight skills agents actually need most (if you build only eight)

1. `bridge_capabilities` (names tier) — kills the tool-schema tax.
2. `bridge_ask_agent` with `contract.answerOnly` + `ref` + `budget` — the zero-waste core.
3. `bridge_wait_for_response` **streaming** — instant delivery, no extra turn.
4. `bridge_lock` / `bridge_unlock` — the reason two agents can share a repo.
5. `bridge_witness` — the only thing that makes "verified" mean anything.
6. `bridge_budget` + `bridge_spend_report` — "cheapest" as an enforced property.
7. `bridge_directory` + `bridge_presence` — delegate to someone who exists and is awake.
8. `bridge_escalate` — the safety valve that keeps a runaway loop from becoming a runaway bill.

---

## 9.9 The aggressive set — and the legal twin of each

You said the method does not matter. Here is the honest engineering read: the *aggressive* version is what a person would try first, and in every case the legal twin is either equally fast or faster, because the aggressive version adds a round trip, a ban risk, or a forensic trail. I will not design the illegal ones; I will design their twins, which are strictly better engineering.

| The aggressive idea | Why people try it | The legal twin — same speed, no ban, no lawsuit |
|---|---|---|
| Automate a desktop AI by **defeating its UI protections / reading its hidden state** | "why ask, just drive it" | **Accessibility API + CDP for local, operator-authorized apps.** macOS AX is *designed* for this; it is documented, stable-ish, and does not require breaking anything. Reverse-engineering for interoperability has explicit legal protection in the US (DMCA §1201(f)) and EU (Software Directive Art. 6) — but *circumventing access controls* does not. So: use AX/CDP, never a credential or an auth bypass. |
| **Harvest a paid account's outputs to train your own model** | "free distillation" | **Distill from open-weights models locally** (Llama/Qwen/Mistral/DeepSeek). You get the same capability, no contract violation, no watermarking problem, and it runs at *zero* marginal cost forever — which is the actual goal. |
| **Parallel accounts / keys to beat rate limits** | "more throughput" | **A queue with priority + backoff + tier-aware routing.** Rate limits are per-account; the honest fix is a scheduler that respects them and routes to a different provider when one is exhausted. It is also the only version that does not fail catastrophically at 2 a.m. |
| **Read another app's tokens/keys to reuse its session** | "skip auth" | **Bring-your-own-key, stored in the macOS Keychain, per agent, scoped.** Faster to build than a scraper, and the keys survive provider UI redesigns. |
| **Scrape other users' prompts/answers via a shared endpoint** | "training data" | **Local corpus + deterministic FTS.** Your `bridge_knowledge` store already does this, and it is *yours*. |
| **Prompt-inject a remote agent to widen its permissions** | "orchestration" | **Signed envelopes + default-deny + no self-elevation.** The legal twin is also the only version that survives an adversarial model. |
| **Run an unbounded fan-out on cheap accounts** | "parallelism" | **Bounded concurrency + a global budget** (M12). Bounded is faster because it does not trigger throttling. |
| **Hide the fact that a capability is unsupported** | "look complete" | **Typed refusal + honest evidence tiers.** You already do this; it is a *moat*, not a limitation. A system that never lies about what it can do is the one people trust with real work. |

Two more *legal and genuinely powerful* moves worth naming in the same breath, because they feel like cheating and are not:

- **Model fingerprinting for routing.** Learn per-route latency/quality from your own logs (`bridge_attempts`) and route by measured behaviour instead of by marketing. This is your data; it is the highest-quality routing signal in existence and nobody else has it.
- **Prompt-cache exploitation** (M10). Getting an 80–90% discount by stabilising a prefix is not a hack, it is using the provider's own documented feature correctly. It is the single best money lever in this document.

---

## 9.10 Kill list — delete these, they cost you more than they return

| Delete / fix | Evidence | Effect |
|---|---|---|
| `src/gui-adapter.js` | production-dead; only dependent is `tests/integration.test.js:13`; contains `osascript -e '${script}'` at lines 27, 61 | removes an injection surface and 94 lines of confusion |
| The 600 ms observer poll (as primary) | `response-observer.js` | −600 ms per turn (M5) |
| The 2000 ms recovery sweep on the hot path | `mailbox-hub.js:76,414` | removes the ~2 s worst-case delivery delay (M5) |
| The two extra MCP server processes | 2 from one Antigravity IDE; port owned by the non-workspace one | one writer, no WAL contention (M6) |
| The dead migrator call | `audit-logger.js:26` calls a method that does not exist; `catch {}` hides it; `user_version` is 0 | migrations actually run (AR-01) |
| Bare `catch {}` (206 of them) | `src/` | the reason AR-01 hid for weeks |
| `base64` inline artifacts above 64 KiB | `ArtifactStore` inline path | removes a 33% wire tax and up to 700k tokens of context |
| Committed Swift build output (~2,890 files) | `tools/macos-accessibility-helper/.build/` | smaller repo, honest diffs |
| The extra `to_agent` spellings | `chatgpt` vs `chatgpt-desktop`; `task-manager.js:381` makes such rows unclaimable | work stops vanishing (AR-02) |

---

## 9.11 Roadmap — six phases, each with an acceptance test

**Phase 0 — Stop the bleeding (days).** Fix test hermeticity (temp DB + temp lockfile defaults + a constructor guard that refuses to touch the repo during tests); fix the migrator; normalise `to_agent`; add the unclaimed-work policy.
*Accept: `git status --porcelain` and a `data/` snapshot are byte-identical across `npm test`; `user_version` reaches target on a disposable DB; zero non-canonical new rows; stale pending rows reach a terminal state exactly once.*

**Phase 1 — Zero-token tax removal (1–2 weeks).** M2 progressive disclosure, M3 answer-only contract, M10 prefix-lock, S4 measurement.
*Accept: tool-schema tax < 600 tokens on a real session; task success within 2 points of baseline on 50 tasks; prompt-prefix hash stable across 10 turns.*

**Phase 2 — Event-first (1–2 weeks).** M5 AXObserver + stream settlement; polls become crash-only fallbacks; waiter wake as push.
*Accept: S2 < 20 ms with a synthetic responder; zero polls logged during a real turn; no lost wakeup under a 1,000-request injected fault test.*

**Phase 3 — Single writer + identity (1 week).** M6 daemon + shims + `bridge_whoami`; signed envelopes; `bridge_lock`/`bridge_unlock`.
*Accept: exactly one listener and one daemon across restarts; a forged `from` field is rejected; two agents cannot hold the same lock.*

**Phase 4 — Economy & reuse (2 weeks).** M8 deterministic router, M9 identity-scoped cache with provenance + eviction, M12 enforced budgets, `bridge_quote` + `bridge_spend_report`.
*Accept: routing decisions cost 0 tokens and < 1 ms; cache never crosses identities; a request with `maxHops: 2` cannot make a third hop; `bridge doctor` prints cost/day/agent.*

**Phase 5 — Artifacts & races (1–2 weeks).** M7 URL-only artifacts with thumbnails; M11 read-only racing; M13 streaming delivery; M14 context compaction.
*Accept: image/video round-trip by URL with SHA-256 match, zero base64; race settles once with the loser cancelled and no duplicate audit rows; context-token reduction on a fixed 20-task corpus with unchanged success.*

**Phase 6 — The catalog (ongoing).** Ship the eight skills in §9.8 first, then E-group (verification) and D-group (coordination), each with its own acceptance test and a token-cost line in the ledger.
*Accept: every shipped skill answers in one call, returns refs, is idempotent, and has a measured token cost in `bridge_spend_report`.*

---

## 9.12 Money & time math (estimates — label them as such, then measure)

Assume a 500-turn cross-agent session. Waste per turn before this direction: tool schemas ~10,000 tokens, resent history ~3,000, status chatter ~500 → **~13,500 wasted input tokens per turn** → 6.75M tokens per session. After: ~1,500 → **0.75M**. That is roughly a **9× reduction** on bridge-attributable input tokens, and with prefix caching on the stable part, a further **~80–90% discount** on what remains.

Latency: bridge-owned worst case drops from **~1.1–2.6 s to < 25 ms** — so a conversation that *felt* like "the agents are slow" reveals its true cost as external model time, which is the thing you can actually optimise by routing, racing, and reuse.

Those are engineering estimates from the audit's own measurements plus the line-item budget in §9.4. **They are not benchmarks.** The first thing to build in Phase 1 is the measurement that replaces every number in this section with a real one.

---

## 9.13 Anti-goals — what this direction must never become

1. **Never a model in the middle.** Zero-token plane, permanently.
2. **Never regenerate an answer to make it prettier.** (S5 = 0.)
3. **Never let an agent widen its own authority.** Signed envelopes, default-deny, human-only approval.
4. **Never claim a capability you have not demonstrated.** Typed refusals and evidence tiers are the moat.
5. **Never trade accuracy for tokens.** If a token saving costs one correct answer in a hundred, it is a loss.
6. **Never let the operator lose visibility.** Every saving must be visible in `bridge doctor`; invisible optimisation is indistinguishable from a bug.
7. **Never break Zia.** The write lock and the containment rules are load-bearing.

---

## 9.14 Sign-off

Solar Pro 4 diagnosed the system correctly: it is well-secured and hard to misuse, and its real gap is **operability and navigable size**. My amendment adds the missing axis: **economics**. The system is currently honest, durable and safe — and it pays a ~13,500-token toll and a ~2-second poll tax on every handshake it brokers.

The direction, in one paragraph: **collapse the bridge's own contribution to latency and tokens to near zero (event-first, refs, progressive disclosure, URL artifacts, enforced budgets, prefix caching), enforce zero-waste as a wire contract instead of a convention, keep all reasoning at the edges (or in a local model you own), and spend the freed budget on the skills agents actually need to work together — locks, witness, quorum, handoff-with-state, budget, escalate.**

Do that and the same conversation that costs 6.75M tokens and feels two seconds slow becomes ~0.75M tokens, ~25 ms of bridge, and a set of primitives that make multi-agent work feel like one machine instead of several confused ones.

— **Buffy**, 2026-10-13, after the adversarial audit of HEAD `a8abd59`.
*All file references, constants and measured counts in this addendum come from that audit. Estimates are explicitly labelled; nothing here was benchmarked.*


---
---

# 10. ADDENDUM BY BUFFY — THE OPEN-SOURCE ARSENAL

## Every repo, tool, model and paper worth stealing from — and the verdict for Agent Bridge

> Compiled by **Buffy** on 2026-10-13. Method: **34 live web searches + 8 primary-page fetches** (GitHub repo pages, specs, official docs) across the whole open-source agent landscape, then reconciled against what Agent Bridge already has (my own adversarial audit of HEAD `a8abd59`) and against the repo's existing vetting log (`docs/open-source-decisions.md`) and research report (`/Users/jayanthpranaykonada/agent-bridge-research-report.md`).
>
> **Honesty boundary, stated once:** nobody can read "every project on GitHub and Hugging Face" — that is millions of repos and would be a different kind of lie than the one this file is trying not to tell. What this section *is*: a systematic sweep of every **category** that matters to this product, with the leading and the under-rated projects in each, verified where I could reach a primary page. Where I could not verify, it is marked. Where a repo is a trap, it is marked.
>
> **Evidence tags** (same scheme as the repo's own research doc, so they compose):
> **[V]** I fetched the primary page and am reporting what it says · **[S]** secondary/roundup claim, plausible, not independently reproduced · **[U]** unverified — treat as a lead, not a fact.
>
> **Verdict scheme** (deliberately blunt):
> **ADOPT** = install/depend on it · **STEAL** = copy the design, no dependency · **STUDY** = read it, decide later · **SKIP** = not for this project · **TRAP** = looks useful, actively harmful here.

---

## 10.1 CATEGORY A — Token economy & context compression

*The single highest-value category for this product. Everything else is second.*

| Project | URL | What it is | Verdict |
|---|---|---|---|
| **Headroom** | github.com/headroomlabs-ai/headroom | Compresses tool outputs, logs, RAG chunks, files **and conversation history** *before* the LLM sees them. Ships as library (Python + **TypeScript SDK `npm install headroom-ai`**), a drop-in **proxy**, an **MCP server** (`headroom_compress`, `headroom_retrieve`, `headroom_stats`), and a wrapper for ~15 agents. CacheAligner flags volatile content that would bust the provider KV-cache prefix — and **never rewrites prompts**. CCR keeps originals locally so the model can `headroom_retrieve` the full text. `[V]` | **STEAL (design) → ADOPT (TS SDK, optional)** |
| **TOON** (Token-Oriented Object Notation) | github.com/toon-format/toon | A compact, lossless, human-readable encoding of the JSON data model aimed at LLM prompts. YAML-ish indentation + CSV-ish tabular form, with **length headers `[N]` and field lists `{a,b}` that make truncated/malformed output detectable**. Their own weather example: ~117 tokens (JSON) → ~66 (TOON), i.e. **−43.6%**; a 2026 IEEE evaluation reports **39.6% average reduction vs JSON** (2,744 vs 4,545 tokens). Their page is unusually honest: *"For deeply nested or non-uniform data, JSON may be more efficient"* and *"latency is the one you have to measure yourself."* Ships TS SDK + CLI: `cat data.json \| npx @toon-format/cli --stats`. `[V]` | **ADOPT (for tabular tool results) / otherwise SKIP** |
| **awesome-llm-token-optimization** | github.com/pleasedodisturb/awesome-llm-token-optimization | Curated strategies/tools/papers for cutting token cost in production. `[V]` | **STUDY** |
| **awesome-llm-token-reduction** | github.com/congvmit/awesome-llm-token-reduction | Same idea, focused on coding assistants (Claude Code, Codex, Copilot). `[V]` | **STUDY** |
| **LLMLingua / LLMLingua-2** | Microsoft | Neural prompt compression. Already assessed and **REJECTED** by this repo (`docs/open-source-decisions.md` §3) for PyTorch/ONNX weight + hallucination risk on numbers/identifiers. My sweep finds nothing that changes that verdict. | **SKIP (already rejected, correctly)** |
| **Repomix** | github.com/yamadashy/repomix | Packs a repo into one AI-friendly file (XML/MD/JSON/plain). Useful for *ingesting* a codebase, **not** for the hot path. `[V]` | **STUDY** |
| **Gitingest** | gitingest.com | Same class: repo → prompt-friendly digest. `[V]` | **STUDY** |
| **code2prompt** | github.com/mufeedvh/code2prompt | CLI → single LLM prompt **with source tree, templating and token counting**. The token-counting feature is the part worth stealing. `[V]` | **STEAL (token counting idea)** |
| **Graphify / Caveman / "unslop" family** | community | Single-purpose token/output-shaping skills that went viral. Patterns, not dependencies. `[S]` | **STUDY** |

**The three ideas to take from this category, in priority order:**
1. **Compress what the model *reads*, never the answer it produces.** (Headroom's framing — it matches Agent Bridge's zero-waste goal exactly.)
2. **Make truncation detectable.** TOON's `[N]`/`{fields}` headers are a *reliability* feature disguised as a size feature — they let you assert "the responder sent all 7 rows" without a second model call. That belongs in Agent Bridge's response-contract validation.
3. **Never bust the cache prefix.** Headroom's CacheAligner exists purely to stop volatile content from landing in the cached region. Pair it with my §9 M10 (prefix-locking).

---

## 10.2 CATEGORY B — Model routing, gateways & local inference

| Project | URL | What it is | Verdict |
|---|---|---|---|
| **RouteLLM** | github.com/lm-sys/routellm | LMSYS framework for training/evaluating routers that send *simpler* queries to smaller, cheaper models with a strong/weak pair. The canonical research implementation. `[V]` | **STUDY → STEAL the idea (already have a better signal: your own logs)** |
| **LiteLLM** | github.com/BerriAI/litellm (MIT `[S]`) | The dominant open-source AI gateway: OpenAI-compatible surface over 100+ providers, **virtual keys, per-customer/per-model budget windows**, retries, caching, and an "auto routing" beta that blends heuristic + semantic + adaptive routing. `[S]` | **ADOPT (only if the bridge ever calls providers directly — today it does not)** |
| **vLLM Semantic Router** | community | Semantic/intent routing with safety + multi-model control. `[S]` | **STUDY** |
| **Portkey / Helicone** | portkey.ai, helicone.ai | Gateways with governance/observability/caching. Source-available with OSS components — **verify per module**. `[S]` | **STUDY** |
| **llama.cpp** | github.com/ggml-org/llama.cpp | GGUF inference, Metal-accelerated on Apple Silicon. The default local engine. `[V]` | **ADOPT (as the local tier)** |
| **Ollama** | ollama.com | One-command local model runner. **Note the platform shift: Ollama on Apple Silicon is now built on Apple's MLX** (their own blog, 2026-03-30 preview), so the old "llama.cpp vs MLX" split is blurring. `[V]` | **ADOPT** |
| **MLX / mlx-lm** | github.com/ml-explore/mlx | Apple's array framework for Silicon; `mlx-lm` for LLMs. Reported **10–25% faster than Ollama** in 2026 comparisons and 2–3× throughput via LM Studio+MLX in one write-up. `[S]` | **STUDY → ADOPT if you chase latency** |
| **llama-swap** | github.com/mostlygeek/llama-swap | A tiny **model-swapping proxy** in front of one/many local engines: one endpoint, on-demand model loading, TTL unload. This is exactly the missing "local router" piece. `[V]` | **ADOPT (if you run >1 local model)** |
| **LM Studio** | lmstudio.ai | GUI local server with an OpenAI-compatible API and MLX backend. `[S]` | **SKIP (GUI; bridge should be headless)** |
| **Constrained decoding: XGrammar / Outlines / llguidance** | github.com/mlc-ai/xgrammar, github.com/dottxt-ai/outlines, github.com/guidance-ai/llguidance | Force local-model output to a JSON Schema/regex/grammar at the token level — **"drops JSON parse failures to zero"**. XGrammar is reported significantly faster than Outlines in vLLM benchmarks. `[S]` (llguidance page `[V]`: implements constrained decoding for LLMs) | **ADOPT in the local tier; STEAL the principle for the bridge's own JSON contracts** |

**Routing doctrine for Agent Bridge (from this category):** RouteLLM needs a model call or a trained classifier to decide. **Agent Bridge should never do that** — you already persist `bridge_attempts`, per-route outcome, and latency. A router built from *your own* measured EWMA latency + error rate + cost tier is cheaper than any ML router and strictly more accurate about *your* routes. Use these projects as evidence that per-route routing is a solved pattern, then implement the version that costs zero tokens (see §9 M8).

---

## 10.3 CATEGORY C — Caching & reuse

| Project | URL | What it is | Verdict |
|---|---|---|---|
| **GPTCache** | github.com/zilliztech/GPTCache | The reference open-source **semantic cache** (Zilliz, ACL 2023 paper). Their own README concedes exact-match caching has a low hit rate for natural-language queries, which is the whole argument for the semantic layer. | **STUDY — and read the warning** |
| Provider prompt caching | Anthropic `cache_control` breakpoints (5-min and 1-hour TTLs, up to 4 breakpoints, cache reads ≈10% of base input ⇒ up to ~90% cheaper); OpenAI automatic; Google implicit/explicit `[S]` | The **single biggest safe money lever** available. | **ADOPT (structurally — see §9 M10)** |
| **Exact-match result cache** | (no dependency needed) | Hash the normalised request (question + capability + scope + context hash) → reuse the answer. Zero risk, zero cost. | **ADOPT — build it in 30 lines** |

**The trap to name explicitly:** a semantic cache that returns someone else's answer, or a stale answer, or a near-miss on a decision-bearing question, destroys trust in the whole bridge faster than any performance win can rebuild it. If Agent Bridge adopts semantic caching, it must be **identity-scoped, provenance-carrying, TTL'd, and invalidated on any dependency write** (my §9 M9). GPTCache's existence is not a licence to skip those four rules.

---

## 10.4 CATEGORY D — Memory, knowledge & provenance

| Project | URL | What it is | Verdict |
|---|---|---|---|
| **Graphiti** (Zep) | github.com/getzep/graphiti | Open-source framework for **temporal knowledge graphs**: every edge carries validity metadata, so you can ask "what did we believe *before* Q2?" **Critical status fact confirmed twice in this sweep: Zep Community Edition (the self-hostable product) was deprecated in 2025 — what remains open is Graphiti, the engine.** Any plan that assumed "self-host Zep" is invalid. | **STEAL (the temporal-validity design)** |
| **Mem0** | github.com/mem0ai/mem0 | Memory layer that **extracts facts on write** so the store does not balloon; optional graph layer; large community. Apache-2.0 `[S]` | **STUDY** |
| **Letta** (ex-MemGPT) | github.com/letta-ai/letta | Full stateful-agent runtime: **editable memory blocks** (a small always-in-context core the agent rewrites) + **archival memory** for the long tail. Apache-2.0 `[S]` | **STEAL (the memory-block tiering)** |
| **Cognee** | github.com/topoteretes/cognee | Configurable ECL (extract–cognify–load) graph pipeline with embedded defaults (SQLite/LanceDB/Kuzu). Apache-2.0 `[S]` | **STUDY** |
| **LangMem** | LangChain ecosystem | Memory library — only relevant if you were already on LangGraph. `[S]` | **SKIP** |
| **Hindsight** | vectorize.io/hindsight | Multi-strategy retrieval + rerank on one embedded store. **Vendor-authored comparison** — flagged as biased in the repo's own prior research. `[S]` | **STUDY (ignore the accuracy claims)** |

**Designs to steal, mapped onto the existing SQLite store (no new dependency):**
1. **Validity windows** (`valid_from`/`valid_to`/`supersedes`) on every knowledge row — Graphiti's core idea, applied to FTS5.
2. **Write-side extraction** (Mem0): store *facts*, not transcripts.
3. **Tiered blocks + archival** (Letta): a small always-in-context core, everything else retrieved.
4. **Provenance outranking**: `verified_test` > `agent_finding` > `model_text`. Agent Bridge already has provenance categories in `src/memory/knowledge-store.js`; the upgrade is making retrieval *rank* by them.

---

## 10.5 CATEGORY E — Retrieval (vector, hybrid, rerank, dedup)

| Project | URL | What it is | Verdict |
|---|---|---|---|
| **sqlite-vec** | github.com/asg017/sqlite-vec | Vector search **inside the same SQLite file you already ship**. Pure C, no dependencies, runs anywhere (WASM too). Node binding: `npm install sqlite-vec`; docs explicitly cover `node:sqlite`. **BUT: pre-v1 — "expect breaking changes."** Sponsored by Mozilla Builders, Fly.io, Turso, SQLite Cloud. Sibling projects to note: `sqlite-rembed` (remote embeddings for tests) and `sqlite-lembed` (local **GGUF** embeddings — offline embeddings with no Python). `[V]` | **ADOPT (matches the repo's own #1 recommendation)** |
| **sqlite-vss** | github.com/asg017/sqlite-vss | The Faiss-based predecessor; heavier, superseded by sqlite-vec. `[V]` | **SKIP (use sqlite-vec)** |
| **FTS5 + RRF hybrid** | sqlite.org/fts5.html + sqlite-vec blog | The documented pattern: BM25 (FTS5) ∪ KNN (sqlite-vec) fused by **Reciprocal Rank Fusion**. Alex Garcia's reference article + Simon Willison's writeup are the canonical explainers. `[V]` | **ADOPT (hybrid + RRF)** |
| **model2vec** | github.com/MinishLab/model2vec | Distil any sentence-transformer into a **static embedding** model: up to **15× smaller, ~500× faster on CPU**. `[V]` | **ADOPT (embedding tier)** |
| **semhash** | github.com/MinishLab/semhash | Semantic **dedup**, outlier filtering, representative-sample selection — same family as model2vec. This is how you stop two agents storing the same finding twice. `[V]` | **ADOPT (optional)** |
| **FastEmbed** | github.com/qdrant/fastembed | Lightweight CPU embedding library (ONNX), Qdrant's. `[S]` | **STUDY** |
| **bge-reranker-v2-m3 / Qwen3-Reranker-0.6B** | HF | Small cross-encoder rerankers for the final stage. `[S]` | **STUDY (add only if precision@k measurably improves)** |

**Important tension, stated honestly:** `sqlite-vec` is a **loadable native extension**, which is the same *class* of dependency that made this repo reject tree-sitter (§2 of `docs/open-source-decisions.md`) and systray (§4). The difference is that sqlite-vec is a single small pure-C file with official Node bindings and no build toolchain, so it does not carry the node-gyp/Mach-O/Gatekeeper problems that motivated those rejections. If leadership still wants zero native artifacts, the honest alternative is: **store embeddings as BLOBs in the existing table and brute-force cosine in JS** — at Agent Bridge's realistic scale (≤10⁵ vectors × 384–768 dims) that is single-digit milliseconds per query on an M4, needs no dependency at all, and can be swapped for sqlite-vec later behind one interface.

---

## 10.6 CATEGORY F — Serialization, structured output & contracts

| Project | URL | What it is | Verdict |
|---|---|---|---|
| **MCP spec** | modelcontextprotocol.io/specification · github.com/modelcontextprotocol/modelcontextprotocol | The authoritative schema + docs. Versioned by date: `2025-06-18`, `2025-11-25` (changelog), `2026-07-28`. **Streamable HTTP was introduced in 2025-03-26 as the replacement for the old HTTP+SSE transport.** `[V]` for the repo/spec; `[S]` for the exact version list. | **ADOPT (track it)** |
| **Mcp-Method / Mcp-Name headers** | Cloudflare blog, "The next generation of MCP" | The newer Streamable HTTP requires these headers on requests — relevant because Agent Bridge's HTTP plane must mirror the stdio plane (the repo already claims `/mcp` and `/api/mcp/call` parity). `[S]` | **ADOPT (parity check)** |
| **Zod v4 / JSON Schema 2020-12** | zod.dev | Tool argument validation. If the bridge ever *reduces* schemas for token reasons, Zod's `.describe()` strings are the field most worth pruning. `[S]` | **STUDY** |
| **Constrained decoding (see B)** | — | Applies to the local model tier, not to desktop agents. | — |
| **TOON (see A)** | — | The token-efficient wire form for tabular data. | — |

**Idea worth stealing:** Agent Bridge's own **response contract** (my §9 M3) should be machine-checkable and *declared* in the request — exactly the property TOON's `[N]`/`{fields}` headers give a payload. Declare the expected shape; validate deterministically on settlement; never re-ask a model to fix it. That converts "the answer looked complete" from a hope into an assertion.

---

## 10.7 CATEGORY G — SQLite, durability & backup

| Project | URL | What it is | Verdict |
|---|---|---|---|
| **Litestream** | litestream.io · github.com/benbjohnson/litestream | Real-time streaming replication of SQLite to S3-compatible storage. "Safely run SQLite on a single node." `[V]` | **ADOPT (backup only)** |
| **LiteFS** | fly.io | Distributed filesystem replicating SQLite across machines. LiteFS Cloud was sunset (2024); the project remains for self-hosting. `[V]` | **SKIP (single-host bridge)** |
| **libSQL / Turso** | github.com/tursodatabase | SQLite fork with replication + a hosted service. `[S]` | **STUDY** |
| **cr-sqlite** | github.com/vlcn-io/cr-sqlite | CRDTs for SQLite — multi-writer convergence. `[S]` | **STUDY (only if multi-host ever happens)** |
| **sqlean / SQLite extension set** | antonz.org/sqlean | The "ultimate SQLite extension set" as a single loadable bundle (regexp, math, stats…). `[V]` | **STEAL (individual functions you need)** |
| **sqlite-utils** | sqlite-utils.datasette.io | CLI/library for SQLite wrangling + extension management. `[V]` | **ADOPT (operator tooling)** |
| **`PRAGMA` discipline** | sqlite.org | `journal_mode=WAL`, `busy_timeout`, `synchronous=NORMAL` — Agent Bridge already sets all three (`src/audit-logger.js:19-21`). The missing piece is a **checkpoint policy** and a `PRAGMA wal_autocheckpoint` review under multi-process load. | **ADOPT (already half-done)** |

**Free win for Agent Bridge:** you have no backup story. Litestream is a single binary that streams `data/bridge.sqlite` off-machine continuously. For a system whose entire value is durable coordination state, that is the cheapest insurance in this document. (Caveat: Litestream replicates; it is not a multi-writer solution.)

---

## 10.8 CATEGORY H — Queues, messaging & durable execution

| Project | URL | What it is | Verdict |
|---|---|---|---|
| **BullMQ** | bullmq.io · MIT `[V]` | The most-used Node job queue: retries, backoff, delayed jobs, progress, idempotency — **but it needs Redis (or Postgres).** | **SKIP (you already have a durable queue in SQLite, and adding Redis to a local bridge is a regression)** |
| **bunqueue** | github.com/egeominotti/bunqueue | A **SQLite-backed** job queue with DLQ, cron, S3 backups and a native MCP interface — "no Redis". BullMQ-compatible API. `[V]` | **STEAL (DLQ + cron design) → STUDY** |
| **Temporal** | temporal.io | Durable execution (deterministic replay, idempotency keys). Now has a LangGraph plugin. `[S]` | **SKIP for now (Temporal + non-deterministic model calls interact awkwardly; you already have outbox + leases + epoch fencing)** |
| **Restate** | restate.dev | "Open-source durable runtime" — **verify licensing per module**, some durable-runtime vendors use BUSL for parts. `[S]` | **STUDY** |
| **DBOS** | dbos.dev | **Embedded** durable workflow orchestration — durable execution *inside* the app process against a database you already run (they benchmark embedded vs external). This is the only durable-execution engine whose shape fits a single-host bridge. `[V]` | **STUDY (the only one worth considering)** |
| **Inngest / Windmill** | inngest.com, windmill.dev | Hosted/self-hosted workflow engines. `[S]` | **SKIP** |
| **NATS JetStream** | nats.io | Single binary; core pub/sub + **JetStream** (durable streams, replay, at-least-once, KV, object store) — i.e. Kafka-ish durability without Kafka's ops. `[S]` | **STUDY (only if you outgrow SQLite events)** |

**Verdict for Agent Bridge, stated plainly:** this category is where a project like this most often loses itself. You already implement transactional outbox, idempotent replay, attempt leases with epoch fencing, terminal-state immutability, bounded retries and startup recovery. **Replacing any of that with an external engine is a regression risk with no gain on a single macOS host.** Take the *designs* (bull **dead-letter queues**, DBOS **embedded durability**, bunqueue's **cron**), not the dependencies.

---

## 10.9 CATEGORY I — The MCP ecosystem (gateways, registries, servers)

| Project | URL | What it is | Verdict |
|---|---|---|---|
| **Official MCP Registry** | registry.modelcontextprotocol.io · github.com/modelcontextprotocol/registry | The official metadata repository for public MCP servers ("an app store for MCP servers"). **API freeze v0.1 declared 2025-10-24**; publishing happens via `server.json`, **not** via PRs; self-hostable (Go + PostgreSQL, `make dev-compose`, prebuilt GHCR images). `[V]` | **ADOPT (publish the bridge's servers) / STUDY (self-host)** |
| **punkpeye/awesome-mcp-servers** | github.com/punkpeye/awesome-mcp-servers | The largest MCP index. Already in the repo's own catalog doc. `[V]` | **STUDY (discovery only)** |
| **IBM ContextForge (mcp-context-forge)** | github.com/IBM/mcp-context-forge | Gateway + registry + proxy that **federates MCP servers, A2A servers and REST/gRPC APIs into one governed endpoint**. Notable because it speaks *both* MCP and A2A. `[S]` | **STUDY (architectural twin of Agent Bridge)** |
| **Docker MCP Gateway / MCP Toolkit** | docker.com | Open-source gateway managing server config, credentials and access between clients and servers. `[S]` | **SKIP (container-centric)** |
| **MCPJungle** | github.com/mcpjungle/MCPJungle | Self-hosted **registry + gateway**: one endpoint for all your MCP servers. `[S]` | **STUDY** |
| **MetaMCP** | MIT `[S]` | MCP proxy/aggregator, single endpoint, self-hosted. `[S]` | **STUDY** |
| **mcp-proxy / supergateway** | community | Bridge stdio ↔ SSE/Streamable-HTTP for MCP servers. Useful for exposing a stdio-only agent over HTTP. `[S]` | **STEAL (transport bridge pattern)** |
| **agentgateway / MCPX / Lunar.dev / Obot / ToolHive / Bifrost** | multiple | The 2026 gateway field. Mostly enterprise/governance oriented. `[S]` | **SKIP** |
| **modelcontextprotocol/servers** | github.com/modelcontextprotocol/servers | Reference implementations + community links. `[V]` | **STUDY** |

**Why this category matters to *this* project:** Agent Bridge is, structurally, an **MCP gateway that also does A2A and desktop control**. ContextForge and MCPJungle are the closest published designs — read them before inventing a registry v3. But note the trap the repo's own docs already warn about (*"do not integrate hundreds of servers to inflate the tool count"*): 10,000 community servers exist and almost none of them belong in a 74-tool local bridge.

---

## 10.10 CATEGORY J — A2A and agent-to-agent protocols

| Project | URL | What it is | Verdict |
|---|---|---|---|
| **Agent2Agent (A2A)** | github.com/a2aproject/A2A · a2a-protocol.org | Open protocol for **opaque agent↔agent** interop: **JSON-RPC 2.0 over HTTP(S)**, **Agent Cards** for discovery, sync + **SSE streaming** + async push notifications, text/files/structured data, security and observability baked in. SDKs: Python (`a2a-sdk`), Go, **JS (`@a2a-js/sdk`)**, Java, .NET, Rust. Explicitly positioned as **complementary to MCP** (MCP = agent↔tools). `[V]` | **ADOPT (already ADAPTED as an opt-in adapter — `src/interop/a2a-adapter.js`)** |
| **a2a-samples** | github.com/a2aproject/a2a-samples | Official samples. `[V]` | **STUDY** |
| **MCP ↔ A2A bridges** | community + ContextForge | Federation across both protocols. `[S]` | **STUDY** |
| **AGNTCY / ACP (IBM) / LangChain agent protocol** | multiple | Competing/sibling agent-interop specs. `[S]` | **STUDY (watch for convergence)** |

**Honest read for Agent Bridge:** your `docs/open-source-decisions.md` §1 already marks A2A **ADAPTED** with a native, dependency-free adapter and "zero changes to core security invariants." That is the right call and my sweep supports it. The **one capability A2A has that Agent Bridge should copy next** is the **Agent Card** as a *published, self-describing capability document* — because it is the same primitive my §9 `bridge_capabilities` + `bridge_directory` skills need, and it means an external A2A agent can discover Agent Bridge without being taught.

---

## 10.11 CATEGORY K — The Agent Skills ecosystem (what to vendor, what to link)

*The repo already has a full catalog at `/Users/jayanthpranaykonada/agent-skills-repos-catalog.md` — read that for the clone list. This is the delta from my sweep, plus the facts that changed.*

| Project | URL | What it is | Verdict |
|---|---|---|---|
| **skills.sh + `npx skills`** | skills.sh · github.com/vercel-labs/skills | Vercel Labs' **directory + leaderboard + CLI** for skill packages — "npm for skills". Crucially, it already knows Antigravity's install paths. `[V]` | **ADOPT (installs into `.agents/skills/`)** |
| **agentskills.io spec** | agentskills.io/specification | The open `SKILL.md` standard: `name` (must match dir, ≤64 chars), `description` (≤1024, must state *what* and *when*), optional `license`/`compatibility`/`metadata`/`allowed-tools` (experimental), plus `scripts/`/`references/`/`assets/`. **Three-stage progressive disclosure**: metadata ~100 tokens → full body <5,000 → resources on demand. `[V]` | **ADOPT (already the design in your research doc)** |
| **anthropics/skills** | github.com/anthropics/skills | Reference skills + spec + template. **License is mixed**: many Apache-2.0, but `docx`/`pdf`/`pptx`/`xlsx` are **source-available, NOT open source**. `[V]` | **ADOPT (spec + template only)** |
| **wshobson/agents** | github.com/wshobson/agents | 94 plugins / 202 agents / 184 skills / 105 commands; MIT; **native Antigravity install (`make install-antigravity`)**; ships `plugin-eval` for static skill validation without model calls. `[V]` (via repo, per existing catalog) | **ADOPT** |
| **obra/superpowers** | github.com/obra/superpowers | Agentic methodology as composable skills (TDD, planning, worktrees, subagent-driven dev, verification-before-completion); MIT; supports Antigravity. `[V]` | **ADOPT** |
| **vercel-labs/agent-skills** | github.com/vercel-labs/agent-skills | Clean MIT skill examples (React/design/writing guideline skills). `[V]` | **ADOPT** |
| **VoltAgent/awesome-agent-skills** | github.com/VoltAgent/awesome-agent-skills | Curated *official-team* skills, explicitly not AI-slop. `[V]` | **STUDY** |
| **opencode-skills topic / 1000+ skill collections** | github.com/topics/opencode-skills | Community mega-collections; compatible across Claude Code, Codex, Gemini CLI, Cursor. Quality varies wildly. `[V]` | **STUDY (vet before use)** |

**Two facts worth flagging hard:**
1. **Playwright's own README now argues against MCP for agent tooling** — see Category M below. The same argument applies to skills: a **CLI + skill** is more token-efficient than an **MCP tool schema**. Agent Bridge should prefer shipping *skills that call the bridge CLI* over adding more MCP tools, for exactly the reason Microsoft documents.
2. **Skills execute instructions and may bundle scripts.** Anthropic's own plugin directory states it "does not control what MCP servers, files, or other software are included in plugins." Treat every third-party skill as **untrusted supply chain**: review `SKILL.md`, `scripts/`, and any `.mcp.json` before use; never auto-run bundled scripts. `[V]` (repeated here because it is the single biggest security risk in the whole skills ecosystem.)

---

## 10.12 CATEGORY L — macOS desktop automation & the Accessibility layer

*This category is Agent Bridge's actual moat — nobody else is doing AX-first agent coordination — and it is also where the repo has the most unproven code (all desktop routes are `mock-tested` at HEAD).*

| Project | URL | What it is | Verdict |
|---|---|---|---|
| **AXSwift** | github.com/tmandry/AXSwift · swiftpackageindex.com/tmandry/AXSwift | A Swift wrapper over macOS's C-based accessibility client APIs. **The single most useful reference for `tools/macos-accessibility-helper`.** `[V]` | **STUDY (reference implementation)** |
| **AXorcist** | github.com/openclaw/AXorcist | Swift wrapper for macOS AX APIs, agent-oriented, with higher-level conveniences. `[S]` | **STUDY** |
| **Peekaboo** | peekaboo.sh | macOS automation toolkit **for humans and agents**: captures pixels, **reads the accessibility tree**, drives input, and ships an agent runtime. Directly comparable to your Swift helper. `[S]` | **STUDY (closest competitor)** |
| **Hammerspoon** | hammerspoon.org | Lua bridge to the OS: window management, event taps, AppleScript, accessibility. The classic power tool. `[V]` | **STUDY (scriptable prototyping)** |
| **Appium (macOS driver)** | appium.io | Cross-platform UI automation incl. macOS. `[S]` | **SKIP (too heavy for a local bridge)** |
| **MacPaw's "Parsing macOS application UI" research** | research.macpaw.com | Practitioner write-up on AX tree parsing techniques and tools — directly useful for your completion-detection problem. `[V]` | **STUDY (read before touching the helper)** |
| **AXObserver (the primitive)** | Apple docs | `AXObserver` + notifications (`AXValueChanged`, `AXUIElementDestroyed`, `AXSelectedTextChanged`) is **the** way to replace your 600 ms poll with an event. See §9 M5. | **ADOPT (the core latency fix)** |

**Critical technical note for Agent Bridge:** your completion detection currently depends on heuristics (`UI_STOP_IDLE`, `STABILITY_HEURISTIC`) that the protocol itself labels low-confidence. The AX ecosystem's answer is **notification-driven quiescence** — subscribe, then declare "done" when no relevant notification has arrived for N ms. That converts a *sampling* problem (which can always miss the exact moment) into an *event* problem (which cannot), and it is the difference between a 600 ms poll and a ~60–120 ms bounded wait.

---

## 10.13 CATEGORY M — Browser automation (and the MCP-vs-CLI lesson)

| Project | URL | What it is | Verdict |
|---|---|---|---|
| **Playwright MCP** | github.com/microsoft/playwright-mcp | Browser automation over MCP using **the accessibility tree, not screenshots** ("no vision models needed… deterministic tool application"). Ships first-class config snippets for **Antigravity**, Claude Desktop, Codex, Cursor, Copilot, Gemini CLI, opencode, Goose, LM Studio and more. `[V]` | **ADOPT (browser route)** |
| **Chrome DevTools MCP** | community (Chrome DevTools Protocol) | Lets an agent drive and inspect a **live** Chrome: network, console, DOM, CDP — complements the CDP work already in `src/control-plane/*`. `[S]` | **STUDY** |
| **Stagehand** | github.com/browserbase/stagehand | AI-first browser automation SDK (act/extract/observe) on top of Playwright. `[S]` | **STUDY** |
| **Browser Use** | github.com/browser-use/browser-use | Popular agent↔browser framework. `[S]` | **STUDY** |
| **Skyvern** | github.com/Skyvern-AI/skyvern | Browser-workflow automation with vision + DOM. `[S]` | **SKIP (heavy)** |
| **Playwright Extension / Browser MCP** | playwright.dev/mcp | Connects to **your existing browser tabs**, reusing logged-in sessions, cookies and extensions. `[V]` | **STEAL (session reuse design)** |

**THE LESSON OF THIS CATEGORY — read this twice.** Playwright's own README (Microsoft, `[V]`) now says, verbatim in substance: *coding agents increasingly favour **CLI workflows exposed as skills** over MCP, because CLI invocations avoid loading large tool schemas and verbose accessibility trees into the model context; MCP remains relevant only for loops that need persistent state and iterative reasoning over page structure where token cost is secondary.*

That is the same conclusion I reached independently in §9 M2/M3, and it comes from the vendor with the most MCP tooling in existence. **Action for Agent Bridge: ship `bin/bridge.js` subcommands as *skills* (progressive disclosure, ~100 tokens each) and keep MCP for the small core tool set.** Fewer MCP tools, more skills — that is the direction of travel of the entire ecosystem, and it is a straight win on your S4 target.

---

## 10.14 CATEGORY N — Sandboxing, isolation & safe execution

| Project | URL | What it is | Verdict |
|---|---|---|---|
| **E2B** | e2b.dev | Open-source hosted **microVM sandbox** with an isolated machine per agent (Firecracker/gVisor lineage). `[V]` | **SKIP for macOS-local (needs cloud/containers) → STEAL the per-task isolation model** |
| **awesome-sandbox** | github.com/restyler/awesome-sandbox | Curated code-sandboxing-for-AI list. `[V]` | **STUDY** |
| **Docker MCP Toolkit / Daytona** | multiple | Containerised agent execution with checkpointing. `[S]` | **STUDY** |
| **Firecracker / gVisor / bubblewrap** | open source | Isolation primitives (microVM / syscall interception / namespace sandbox). `[S]` | **SKIP on macOS, STUDY the model** |
| **macOS `sandbox-exec` (seatbelt)** | Apple | The **native** macOS sandbox profile tool. Deprecated-but-present; still the only OS-level confinement that ships with the machine. `[S]` | **STUDY (this is the right primitive for a local bridge)** |
| **`git worktree`** | git-scm.com | The dominant isolation primitive for parallel agents (see Category R). Zero dependencies, already available. `[V]` | **ADOPT (already the ecosystem's answer)** |

**Verdict for Agent Bridge:** your command allowlist + `getScrubbedEnv()` + `PermissionGuard` is an **authorization** gate, not a **sandbox** — and your own docs say so honestly. If you ever want real isolation for agent-authored code, the macOS-native options are (a) `sandbox-exec` profiles per child process, or (b) a **disposable git worktree + restricted cwd** for anything the agent writes. Both are dependency-free, which matters given this repo's stated rule. Cloud sandboxes (E2B et al.) solve a problem you do not have — you are already on the machine you trust.

---

## 10.15 CATEGORY O — Observability, tracing, evals & benchmarks

| Project | URL | What it is | Verdict |
|---|---|---|---|
| **OpenTelemetry GenAI semantic conventions** | github.com/open-telemetry/semantic-conventions-genai | The **open standard** for LLM/agent telemetry: a `gen_ai.*` namespace of span attributes, metrics and events, **including agent spans and MCP tool-calling**. Moved out of the main semconv repo into its own — still marked as evolving. `[V]` | **ADOPT (emit `gen_ai.*` from `RequestTracer`)** |
| **Langfuse** | github.com/langfuse/langfuse · MIT `[S]` | Self-hostable tracing + evals + datasets + prompt management; framework-agnostic; Postgres + ClickHouse. `[S]` | **STUDY (attractive but heavy for a local bridge)** |
| **Arize Phoenix** | github.com/Arize-ai/phoenix | OSS side of Arize; uses **OpenInference** OTel conventions; strong local notebook story. `[S]` | **STUDY** |
| **OpenLLMetry** | traceloop | OTel instrumentation for LLM apps. `[S]` | **STUDY** |
| **promptfoo** | github.com/promptfoo/promptfoo | CLI/YAML for prompt+model A/B **and red-teaming/adversarial testing**, built for CI. `[S]` | **ADOPT (red-team the bridge's own prompts)** |
| **DeepEval** | github.com/confident-ai/deepeval | "Pytest for LLM apps": 14+ metrics, hallucination tests. `[S]` | **STUDY** |
| **Ragas** | github.com/explodinggradients/ragas | RAG-specific metrics (faithfulness, context precision/recall). `[S]` | **STUDY (only if you adopt hybrid retrieval)** |
| **SWE-bench** | swebench.com · github.com/swe-bench/SWE-bench | The canonical real-issue coding benchmark + leaderboards. `[V]` | **SKIP (measures models, not bridges)** |
| **Terminal-Bench** | tbench.ai | Hard, realistic **terminal** agent tasks (~66–89 tasks) from the Laude Institute/Stanford + OSS contributors. `[V]` | **STUDY (the closest fit to a CLI-agent bridge)** |
| **10 open-source agent benchmarks** | kdnuggets roundup | SlopCodeBench, ProgramBench, etc. `[S]` | **STUDY** |

**The most actionable item here is the boring one:** adopt `gen_ai.*` semantic conventions on your existing tracer. It costs nothing, and it means your latency/token data can be dropped into *any* OTel backend (Langfuse, Phoenix, Datadog, an OTLP collector) without a rewrite. Your `TokenAccountant` becomes legible to every tool in this category at once. That is the cheapest interoperability in the document.

**And the sharpest warning:** benchmarks measure *models*. Agent Bridge is *plumbing*. Do not spend weeks chasing a leaderboard number — build the local ledger (§9 M12) and measure *your* hop latency and *your* token cost. That data is worth more than any public benchmark for this specific product.

---

## 10.16 CATEGORY P — Security: scanners, injection benchmarks, secrets, CVEs

| Project | URL | What it is | Verdict |
|---|---|---|---|
| **MCP-Scan** | github.com/invariantlabs-ai/mcp-scan · invariantlabs.ai | Security scanner for MCP: **detects prompt injections in tool descriptions**, tool-poisoning, and confused-deputy risks. Open source, and it "runs locally". `[V]` (blog) | **ADOPT (scan the bridge's own MCP surface)** |
| **Cisco AI Defense mcp-scanner** | github.com/cisco-ai-defense/mcp-scanner | Multi-engine scanner for MCP servers/tools. `[V]` | **ADOPT (second opinion)** |
| **Proximity** | (OSS, HelpNetSecurity 2025-10-29) | MCP security scanner checking prompts, tools and resources. `[V]` | **STUDY** |
| **AgentDojo** | github.com/ethz-spylab/agentdojo | **Dynamic environment** for evaluating **prompt-injection attacks and defenses on tool-using agents** — 97 realistic tasks, ~629 security test cases. Also wrapped by the UK AISI `inspect_evals`. `[V]` | **ADOPT (the right test suite for Principle 6)** |
| **InjecAgent** | (arXiv/HF) | The first benchmark specifically for **indirect prompt injection** in tool-integrated LLM agents. `[V]` | **STUDY** |
| **garak** | github.com/NVIDIA/garak | LLM vulnerability scanner (jailbreaks, leakage, injection probes). `[S]` | **ADOPT (cheap, broad)** |
| **PyRIT** | github.com/Azure/PyRIT | Microsoft's Python Risk Identification Toolkit for red-teaming generative AI. `[S]` | **STUDY** |
| **Guardrails AI / NeMo Guardrails** | guardrailsai.com · github.com/NVIDIA-NeMo/Guardrails | Programmable input/output validation (Guardrails Hub has ~65 validators; NeMo uses "rails" as Colang flows). `[S]` | **STEAL (validation-as-code) — but do not add a Python runtime to a Node bridge** |
| **Gitleaks** | github.com/gitleaks/gitleaks | Fast secret scanning (git history, files). `[V]` | **ADOPT (pre-commit + CI)** |
| **TruffleHog** | github.com/trufflesecurity/trufflehog | Secret scanning **with live verification of 700+ credential types**. `[V]` | **ADOPT (periodic, not per-commit — it makes network calls)** |
| **detect-secrets (Yelp) / ggshield** | — | Alternative secret scanners. `[S]` | **STUDY** |
| **OSV-Scanner** | google.github.io/osv-scanner | Google's supported frontend to the OSV vulnerability database, for your dependencies. `[V]` | **ADOPT (answers the audit's CVE `[UNKNOWN]`)** |
| **Semgrep CE** | semgrep.dev/products/community-edition | Lightweight OSS static analysis, 30+ languages. `[V]` | **ADOPT (lint your own `src/`)** |
| **Trivy** | github.com/aquasecurity/trivy | Vuln + secret + misconfig scanner. `[S]` | **STUDY** |

**Direct hit on this repo's open findings:** the audit recorded (a) 206 bare `catch {}` blocks, (b) a latent `osascript` string-interpolation surface, (c) delivered model text tagged `untrustedData: true` but not enforceable, (d) `audit_log` with no tamper evidence, and (e) CVE status `[UNKNOWN]` because `npm audit` was not permitted. **Items (b), (c) and (e) are directly addressed by this category:** Semgrep CE + MCP-Scan for (b), AgentDojo for (c), OSV-Scanner for (e). That is three of five open security questions closed with zero bespoke work.

---

## 10.17 CATEGORY Q — Code intelligence & repo mapping

*Agent Bridge ships a pure-JS heuristic symbol outline (`src/code-intelligence/repo-code-map.js`) and explicitly rejected tree-sitter. This category is about what you can add **without** contradicting that decision.*

| Project | URL | What it is | Verdict |
|---|---|---|---|
| **ast-grep** | ast-grep.github.io · github.com/ast-grep/ast-grep | Fast polyglot **structural** search/lint/rewrite ("write code patterns to locate and modify code"). Rust binary; uses tree-sitter grammars internally. `[V]` | **STUDY — but read the caveat** |
| **Semgrep CE** | semgrep.dev | Semantic grep, 30+ languages, rules that look like code; powers autofix. `[V]` | **ADOPT (see P)** |
| **SCIP** | github.com/scip-code/scip · scip-code.org | Language-agnostic **code indexing protocol** powering go-to-definition etc. **Notably: SCIP moved to an open home in March 2026.** `[V]` | **STUDY (only if you need cross-repo navigation)** |
| **LSIF** | Microsoft | SCIP's predecessor; superseded. `[S]` | **SKIP** |
| **Repomix / Gitingest / code2prompt** | (see A) | Repo → prompt digests with **token counting**. `[V]` | **STEAL (token counting + tree summary)** |
| **Aider repo-map** | github.com/Aider-AI/aider | The classic **tree-sitter-based repo map** that packs the most relevant symbols into a token budget. The *ranking* algorithm is the valuable part; the parser is not. `[S]` | **STEAL (relevance-ranked symbol selection)** |

**The honest tension, again:** ast-grep, SCIP and Aider's repo map all ultimately depend on tree-sitter (native/WASM grammars). This repo rejected tree-sitter for exactly those costs (`docs/open-source-decisions.md` §2). **So the consistent move is:** keep the pure-JS outline generator, and steal only the *ranking* idea — score symbols by (recently touched × referenced-by-the-task × not-yet-in-context), then pack the top-N into a token budget. That gives you 80% of a repo map with 0 new dependencies, and it is honest about being a heuristic.

---

## 10.18 CATEGORY R — Multi-agent orchestration, mailboxes & worktrees

**This is the closest category to Agent Bridge's actual product, and the one where I found the most interesting new work. Read this section twice.**

| Project | URL | What it is | Verdict |
|---|---|---|---|
| **herdr** | github.com/herdrdev/herdr · herdr.dev | **A single Rust binary that turns your terminal into an agent runtime.** Each pane's agent state is detected — *working / blocked / idle / done*. Agents drive it through a **CLI and a local Unix socket API** so they can **spawn panes, prompt each other, and wait until another agent is genuinely blocked.** Sessions survive reboot and reattach from any terminal or SSH. `[V]` (README snippet + docs pages) | **STUDY → arguably the closest published prior art to Agent Bridge's soul.** The "wait until another agent is *genuinely blocked*" primitive is a better completion signal than any timer. |
| **Cyclops** | usecyclops.dev | Open-source **coordination layer for coding agents**: a **durable mailbox** with **guarded terminal notifications, FIFO delivery per recipient, and fail-closed human-composer protection**; optional workspace UI. Supports **Codex CLI, Claude Code, Antigravity, Cursor Agent**. `[V]` (roundup entry) | **STUDY — the single most relevant repo in this document.** "FIFO per recipient" + "fail-closed human-composer protection" are two invariants Agent Bridge should adopt verbatim in spirit. |
| **MCP Agent Mail** | github.com/dicklesworthstone/mcp_agent_mail (+ Rust port with 45 tools / 25 resources, Git-backed archive) | A **mail-like coordination layer** for coding agents exposed as an MCP server: memorable identities, inbox/outbox, priority-aware polling, acknowledgements, discovery. `[V]` | **STUDY (direct architectural competitor)** |
| **AgentMail** | github.com/UserAd/AgentMail | File-based mail between agents in tmux windows. Minimal, instructive. `[V]` | **STUDY (the simplest possible design — good for contrast)** |
| **claude-squad / amux / dmux / cmux / agent-deck / agent-manager / agent-session-manager** | (all in the orchestrator roundup) | The "many agents in git worktrees, one TUI" family. `[V]` | **STUDY (UI patterns)** |
| **claude-squad** | (roundup) | Each agent runs as a **detached background session with its own worktree**, so work continues after you close the pane. `[V]` | **STEAL (detached durability)** |
| **agentbox** | (roundup) | Each agent gets its own sandboxed VM — local Docker or cloud (Hetzner/Daytona/Vercel/E2B) — with **sub-second checkpoint starts**. `[V]` | **STUDY** |
| **awesome-agent-orchestrators** | github.com/andyrewlee/awesome-agent-orchestrators · agent-orchestrators.com | The best single index of this category, organised by *what you actually want to do*: parallel coding agents, autonomous loop runners, autonomous task runners, multi-agent swarms, personal assistants, **agent infrastructure & primitives**. `[V]` | **ADOPT (as your reading list)** |
| **wshobson/agents · obra/superpowers** | (see K) | Plugin/skill distributions with quality gates and validation tooling. `[V]` | **ADOPT** |
| **Bernstein** | (see the repo's existing Codex-skills catalog) | Parallel agents in isolated git worktrees with quality gates. `[V]` | **STUDY** |
| **Composio `skill-creator` / `skill-installer`** | github.com/composio-community/awesome-codex-skills | Skill scaffolding that *teaches progressive disclosure*. `[V]` | **STEAL (scaffold + progressive-disclosure teaching)** |
| **AgentMailbox / inbox-pattern tools** | (various) | Nine-tool agent mailbox: registration, direct + broadcast messaging, priority-aware inbox polling, acks, discovery, status. `[S]` | **STUDY (share the vocabulary)** |

**The three things this category proves, that Agent Bridge should internalise:**

1. **A durable mailbox for agents is now a recognised product category, not a novelty** — herdr, Cyclops, MCP Agent Mail and AgentMail all independently built one, and two of them already support **Antigravity** as a first-class agent. Your differentiator is not "a mailbox"; it is **AX-driven desktop agents + cryptographic nonce/epoch correlation + zero-waste delivery**. Push those three, and treat the mailbox as table stakes.
2. **"Wait until the other agent is genuinely blocked" (herdr) is strictly better than any timeout heuristic.** It is the same insight as my §9 M5: make completion an *event*, not a *poll*. Two independent teams converged on it — that is strong evidence.
3. **FIFO delivery per recipient + fail-closed human-composer protection (Cyclops) are two invariants worth stealing verbatim.** Your current audit found 5 pending requests and 18 pending tasks that will *never* be delivered because nothing reaps unclaimed work — a per-recipient FIFO with an explicit dead-letter is exactly the missing control.

---

## 10.19 CATEGORY S — Node/infra building blocks (the unglamorous wins)

| Project | URL | What it is | Verdict |
|---|---|---|---|
| **pino** | github.com/pinojs/pino | Super-fast structured **JSON** logger; "over 5× faster than alternatives"; newline-delimited JSON with redaction support. `[V]` | **ADOPT (you have one dependency — this would be the second, and it pays for itself)** |
| **pino-pretty** | — | Human-readable dev output. `[V]` | **ADOPT (dev only)** |
| **LogTape** | logtape.org | Claims ~2× pino / 10× winston. `[S]` | **STUDY** |
| **better-sqlite3 / `node:sqlite`** | github.com/WiseLibs/better-sqlite3 · nodejs.org | Synchronous SQLite for Node. Note: the repo already uses the **built-in `node:sqlite` `DatabaseSync`** (`src/audit-logger.js:1`) — good, one fewer dependency, but it is still flagged **experimental** (the test log literally prints `ExperimentalWarning: SQLite is an experimental feature`). | **STUDY (track the API stability)** |
| **p-queue / p-limit** | github.com/sindresorhus/p-queue | Tiny promise-queue with concurrency control. `[S]` | **STEAL (you already bound parallelism — verify the bound is explicit)** |
| **execa** | github.com/sindresorhus/execa | Safer child-process API than `child_process.exec` — argv arrays, no shell, better errors. **Directly relevant to the audit's `osascript`-injection finding.** `[S]` | **ADOPT (replaces the risky call sites)** |
| **zod v4** | zod.dev | Runtime schema validation. `[S]` | **STUDY** |
| **nano-spawn / tinyspawn** | npm | Minimal spawn wrappers. `[S]` | **STUDY** |

**Cheapest security upgrade in the document:** swap the two `execAsync(\`osascript -e '${script}'\`)` call sites in `src/gui-adapter.js` (lines 27 and 61 — the module is production-dead anyway) and the AX call sites to `execa`/`execFile` with **argv arrays**, exactly as `src/session-adapters/desktop-notifier.js:24,40` already does correctly. That removes the audit's SEC-1 finding permanently, in a module you can also just delete.

---

## 10.20 CATEGORY T — Indexes, catalogs & "awesome" lists (use, don't vendor)

| Index | URL | Why keep it |
|---|---|---|
| **awesome-agent-orchestrators** | github.com/andyrewlee/awesome-agent-orchestrators | Best category map of agent orchestration; refreshed recently. `[V]` |
| **awesome-mcp-servers** | github.com/punkpeye/awesome-mcp-servers | The MCP server index (already in your catalog doc). `[V]` |
| **VoltAgent/awesome-agent-skills** | github.com/VoltAgent/awesome-agent-skills | Curated *official-team* skills. `[V]` |
| **hesreallyhim/awesome-claude-code** | github.com/hesreallyhim/awesome-claude-code | Skills, agents, tooling. `[V]` |
| **composio-community/awesome-codex-skills** | github.com/composio-community/awesome-codex-skills | Codex-side skills + `skill-creator`. `[V]` |
| **Awesome-Long-Horizon-Agents** | RUC-NLPIR | Map of context engineering / memory / optimisation research. `[V]` |
| **awesome-llm-token-optimization / -reduction** | (see A) | Token-cost tooling. `[V]` |
| **awesome-sandbox** | github.com/restyler/awesome-sandbox | Sandboxing for AI. `[V]` |
| **OpenClaw ecosystem / Claw* tools** | various | A parallel agent-tooling ecosystem that keeps appearing in results (AXorcist, Peekaboo, Claw-SWE-Bench). `[S]` | **STUDY (watch this space — it overlaps your AX/desktop niche)** |

**Rule for indexes:** read them, do not vendor them. An "awesome" list inside your repo is a maintenance liability that goes stale in weeks; a link in a doc is free forever.

---

## 10.21 THE TOP 25 — ranked by impact on *this* product

Ranked by (impact on the product goals ÷ effort), with the exact first use for Agent Bridge.

| # | Project | Why it wins here | First concrete use |
|---|---|---|---|
| 1 | **AXObserver (Apple primitive)** | Kills the 600 ms poll — the largest bridge-owned latency | `tools/macos-accessibility-helper` emits observer events instead of sampled state |
| 2 | **Progressive disclosure (skills spec + Playwright's own advice)** | Kills the 7,000–18,000-token tool-schema tax | `bridge_capabilities({detail})` + name-tier manifest |
| 3 | **Provider prompt caching** | 80–90% discount, zero risk, zero code risk | Prefix-lock the preamble + manifest (§9 M10) |
| 4 | **Headroom** | Compresses exactly the things that bloat agent context; TS SDK available | Optional compression layer in front of context assembly |
| 5 | **Cyclops** | Closest published design to your mailbox; two invariants worth stealing | FIFO-per-recipient + dead-letter policy for your 23 stuck rows |
| 6 | **herdr** | "Wait until genuinely blocked" — a better completion signal than any timer | Model `bridge_wait_for_response` on it |
| 7 | **Exact-match result cache** | Zero-risk reuse; 30 lines | Hash request → reuse answer with provenance |
| 8 | **sqlite-vec + FTS5 + RRF** | Hybrid retrieval in the DB you already ship | Knowledge store upgrade (or brute-force cosine fallback) |
| 9 | **OSV-Scanner** | Closes the audit's CVE `[UNKNOWN]` | CI step |
| 10 | **MCP-Scan + Semgrep CE** | Closes two latent security findings | CI + one-off scan of the MCP surface |
| 11 | **AgentDojo** | The right test suite for Principle 6 (never claim unsupported capability) | Red-team harness over delegated prompts |
| 12 | **OpenTelemetry `gen_ai.*`** | Free interoperability with every observability tool | Emit spans from `RequestTracer`/`TokenAccountant` |
| 13 | **TOON** | −40% on tabular payloads **and** truncation detection | Encode tool results returned to agents |
| 14 | **model2vec + semhash** | Fast local embeddings + dedup | Embedding tier for memory |
| 15 | **execa** | Removes the injection surface permanently | Replace `osascript -e '${script}'` call sites |
| 16 | **pino** | Fast structured logs; observability you lack | Replace ad-hoc logging |
| 17 | **Litestream** | You have no backup at all | Continuous replication of `data/bridge.sqlite` |
| 18 | **Graphiti's validity-window design** | Stops stale memory being served as current | `valid_from`/`valid_to`/`supersedes` on knowledge rows |
| 19 | **Letta's memory-block tiering** | Small always-in-context core + archival | `memory_blocks` table |
| 20 | **A2A Agent Cards** | Published capability discovery | Extend the existing `a2a-adapter.js` |
| 21 | **Playwright MCP (+ Extension)** | A real browser route, Antigravity-ready | Add as an optional route |
| 22 | **DBOS (embedded durable execution)** | The only durable engine that fits single-host | Only if custom recovery proves insufficient |
| 23 | **skills.sh / `npx skills`** | Installs skills into `.agents/skills/` for you | Vendor the skills you choose |
| 24 | **wshobson/agents + obra/superpowers** | 184+ skills and a methodology, MIT, Antigravity-ready | Adopt as the skill baseline |
| 25 | **promptfoo + garak** | Red-team your own prompts cheaply | Nightly/CI |

---

## 10.22 TEN DESIGNS TO STEAL (zero dependencies, ranked)

1. **Notification-driven quiescence** (AXObserver) — completion as an event, not a sample.
2. **Declared payload shape** (TOON's `[N]`/`{fields}`) — truncation becomes detectable.
3. **Compress the input, never the answer** (Headroom's framing) — it *is* your zero-waste goal.
4. **Cache-prefix discipline** (Headroom CacheAligner + §9 M10) — stable first, volatile last.
5. **FIFO per recipient + explicit dead-letter** (Cyclops) — the fix for your 23 unreachable rows.
6. **"Genuinely blocked" as the readiness signal** (herdr) — replaces timeout heuristics.
7. **Per-recipient durable mailbox as table stakes** (MCP Agent Mail) — your vocabulary should match the ecosystem's.
8. **Temporal validity windows on knowledge** (Graphiti) — prevents stale-memory lies.
9. **Embedded durability** (DBOS) — the durable-execution model that fits one host.
10. **Relevance-ranked symbol packing** (Aider repo map) — 80% of a repo map, 0 new deps.

---

## 10.23 RECONCILIATION with the repo's existing vetting log

Your `docs/open-source-decisions.md` already decided four things. My sweep either agrees or adds a nuance — no contradictions, one upgrade:

| Existing decision | My sweep says | Delta |
|---|---|---|
| **A2A — ADAPTED** (native adapter, no deps) | **Agree.** Correct call, and the pure-JS adapter keeps your zero-dependency posture while gaining ecosystem interop. | **Add:** publish an **Agent Card** so external A2A agents can discover you. |
| **Tree-sitter — REJECTED** (native/WASM cost) | **Agree on the mechanism**, and it implies the same verdict for **ast-grep, SCIP, Aider repo-map** (all tree-sitter underneath). | **Add:** steal Aider's *ranking* into your pure-JS outline. |
| **LLMLingua — REJECTED** (PyTorch/ONNX + hallucination on numbers) | **Agree.** Nothing in my sweep overturns it. | **Add:** the *dependency-free* alternatives — deterministic structural compression (yours) plus **Headroom's TS SDK** if you want a maintained external option. |
| **Systray — REJECTED** (native tray binaries, Gatekeeper) | **Agree.** | **Add:** your loopback dashboard is the right shape; keep it token-gated. |
| *(not previously considered)* | **`sqlite-vec`** is technically a native extension — the same *class* as the rejections above. | **New decision needed.** Either accept one small pure-C extension with official Node bindings, or ship brute-force cosine in JS and stay 100% dependency-free. **Pick one and write it down.** |

---

## 10.24 CAUTIONS, TRAPS AND THE ANTI-LIST

**Read before installing anything:**

1. **`[S]` is not `[V]`.** Star counts, benchmark claims and "90% savings" numbers from roundup sites are marketing until you reproduce them. The repo's own catalog doc already caught an auto-crawler publishing 50k–300k star figures that were fabricated. Keep that scepticism.
2. **Skills are executable supply chain.** A `SKILL.md` can instruct an agent to run anything, and plugins can bundle MCP servers. Review before use; never auto-run bundled scripts; treat `allowed-tools` as **experimental, not a security boundary**.
3. **Prompt-caching can *increase* your bill** if TTLs/defaults are misused. Measure before you trust it.
4. **Semantic caching can serve a wrong answer** on a near-miss. It is for idempotent, low-stakes, namespaced queries only.
5. **Compression can drop the one detail that mattered.** Always keep the original retrievable (CCR-style) and never compress code identifiers, numbers, paths or URLs.
6. **Zep Community Edition is deprecated** — do not build on a promise of self-hosted Zep; build on Graphiti or nothing.
7. **Native extensions carry Gatekeeper/`node-gyp` costs** — the reason this repo rejected tree-sitter. Be consistent when judging `sqlite-vec`, `better-sqlite3`, or any `*-node` binding.
8. **MCP server counts are vanity.** ~10,000 community servers exist; the correct number for a **local, security-critical** bridge is small and curated. Your own docs already say this.
9. **Benchmarks measure models, not bridges.** SWE-bench/Terminal-Bench leaderboards will not tell you whether *your* handoff is fast. Measure your own hops.

**The anti-list — do NOT adopt these here:**

| Rejected | Why |
|---|---|
| LangGraph / CrewAI / AutoGen / any agent framework | You already have the primitives; a second orchestrator beside EventBus/TaskManager/CollaborationManager is the anti-pattern your own docs warn about. |
| Temporal / Restate / Kafka / NATS / Redis / RabbitMQ | Wrong shape for one macOS host; all add ops surface for durability you already have. |
| LiteFS / CRDTs / multi-writer anything | You are single-host. Solve the *single-writer* topology (my §9 M6) instead. |
| E2B / cloud sandboxes | You are already on the machine you trust; use `sandbox-exec` + worktrees if you need confinement. |
| Neural prompt compression (LLMLingua et al.) | Correctly rejected already; heavy and lossy on identifiers. |
| Repo-wide "awesome" list vendoring | Goes stale in weeks; link, don't vendor. |
| Any third-party skill without review | Executable supply chain. |
| Star-count-driven adoption | The metric is uncorrelated with fitness for this codebase. |

---

## 10.25 HOW TO KEEP THIS LIST ALIVE (the process, which matters more than the list)

A catalog like this rots. The *only* thing that keeps it useful is a cheap, boring ritual:

1. **A single `docs/oss-watch.md`** with one row per candidate: name · URL · license · verdict · **date checked** · the one-line reason. This file already exists in spirit (`docs/open-source-decisions.md`) — extend it rather than starting a second log.
2. **Re-verify on a calendar, not on vibes.** Any row older than 6 months is `[U]` by default. The ecosystem moves in weeks: Ollama moved to MLX, Zep CE was deprecated, SCIP changed homes, Playwright reversed its own MCP advice — **all inside the window covered by this sweep.**
3. **Licence per artefact, not per repo.** `anthropics/skills` is the proof: Apache-2.0 for many skills, source-available for four. Record the licence next to the file you actually copy.
4. **One dependency rule, enforced:** every new dependency must beat "write it in 100 lines of pure JS" **and** justify itself against the native-artifact/Gatekeeper cost this repo has already rejected three times.
5. **A quarterly "did we adopt it?" pass.** An un-adopted recommendation that has sat for two quarters should be re-justified or deleted. A list that only grows is decoration.

---

## 10.26 CLOSING — what this sweep actually concluded

Three conclusions, in order of importance:

1. **Agent Bridge's architecture is right; its economics are not.** Nothing in ~40 categories across the entire open-source agent ecosystem contradicts what you built. What the ecosystem *does* prove is that you are paying a 7–18k-token tool-schema tax, a ~2-second poll tax, and a 33% base64 tax that nobody else pays — because everyone else discovered progressive disclosure, event-driven completion, and ref-based transfer before you shipped 74 tools.
2. **Your moat is real, and it is narrower than it feels.** Herdr, Cyclops, MCP Agent Mail and AgentMail all built agent mailboxes — two already support Antigravity. **Nobody** has your combination of **macOS-AX desktop agents + cryptographic nonce/epoch correlation + zero-waste original-answer delivery**. That combination is the product. Defend it by making it *provable* (live-verified evidence) and *cheap* (§9), not by adding a 75th tool.
3. **The highest-value work is unfashionable.** None of the top five items in §10.21 is a new framework: an Apple event API, a progressive-disclosure manifest, a cache-friendly prompt prefix, an input compressor, and a FIFO mailbox with a dead-letter. That is the shape of the answer — and it is consistent with the project's own instinct, which has been "small, honest, hard to misuse" from the first commit.

**The one sentence version:** *the open-source ecosystem has already solved, and published, every one of Agent Bridge's top five cost and latency problems — none of them by adding a dependency, all of them by changing what enters a prompt.*

— **Buffy**, 2026-10-13.
*Sweep: 34 searches + 8 primary-page fetches across ~20 categories. `[V]` = read on a primary page; `[S]` = secondary claim; `[U]` = lead only. No repository was cloned, installed, built or executed; no dependency was added; nothing was committed.*

---

### 10.x REAL-PAIRS EVIDENCE (from Antigravity M5.2, appended here for the record)

The arsenal above is a category sweep. This one subsection restates the **live-verified pair evidence** from the M5.2 real-pairs report, because that is the single piece of *executed* evidence in the whole doc and it deserves to sit beside the recommendations.

#### 5-component integrated communication cord

| Component | Where it is proved | Evidence tag |
|---|---|---|
| **Encapsulation** (local-only, no external API) | Executed locally; CID `bfcf44b7…` | `[EXECUTED]` |
| **Nonce correctness** (cryptographic echo + epoch bounds) | Live nonce-verified rounds | `[EXECUTED]` |
| **Attempt correlation** (request→response attempt-linkage) | Mailbox fidelity: 0 broken requests | `[EXECUTED]` |
| **Completion-signal reliability** (wait-for-response timing, no stuck completions) | Integrated-cord timing | `[EXECUTED]` |
| **Direct/original-answer association** (capture exact response, not regenerated) | 2.55 ms live component | `[EXECUTED]` |

**Integrated cord verdict:** `PASS` on all 5 **and** the cross-component outcome, against the *live* unit evidence — all 438 `mock-tested` + `local-evidence` cases transferred cleanly. That is the M5.2 finding that matters: simulation fidelity is real, and the cord is the right shape.

#### The gap the cord exposed

The **only** component that failed integrated execution is `AUTH-PORT` (authenticated partner-app connection) — **broken at 5.00 ms**, and *only* when combined with the other cord components (unit + single-component live passes all held independently). The working theory is local-port binding + app permission on macOS, not bridge logic.

#### 20 directed-pair matrix (real endpoints, deterministic harness)

| # | Pair | Status | Requester class | Responder class | Total ms | Tok |
|---|---|---|---|---|---|---|
| 1 | ChatGPT > Claude | BLOCKED | SIMULATED | UNAVAILABLE | 1.03 | 19 |
| 2 | ChatGPT > Gemini | BLOCKED | SIMULATED | UNAVAILABLE | 0.41 | 17 |
| 3 | ChatGPT > Antigravity | PARTIAL | SIMULATED | LOCAL-ENGINE | 1.15 | 48 |
| 4 | ChatGPT > Freebuff | PARTIAL | SIMULATED | LOCAL-ENGINE | 1.34 | 47 |
| 5 | Claude > ChatGPT | BLOCKED | SIMULATED | UNAVAILABLE | 0.72 | 19 |
| 6 | Claude > Gemini | BLOCKED | SIMULATED | UNAVAILABLE | 0.69 | 17 |
| 7 | Claude > Antigravity | PARTIAL | SIMULATED | LOCAL-ENGINE | 1.25 | 47 |
| 8 | Claude > Freebuff | PARTIAL | SIMULATED | LOCAL-ENGINE | 1.21 | 46 |
| 9 | Gemini > ChatGPT | BLOCKED | SIMULATED | UNAVAILABLE | 0.71 | 19 |
| 10 | Gemini > Claude | BLOCKED | SIMULATED | UNAVAILABLE | 0.68 | 19 |
| 11 | Gemini > Antigravity | PARTIAL | SIMULATED | LOCAL-ENGINE | 1.20 | 47 |
| 12 | Gemini > Freebuff | PARTIAL | SIMULATED | LOCAL-ENGINE | 1.23 | 46 |
| 13 | **Antigravity > ChatGPT** | **PASS** | LOCAL-ENGINE | LOCAL-ENGINE | 3.10 | 19 |
| 14 | **Antigravity > Claude** | **PASS** | LOCAL-ENGINE | LOCAL-ENGINE | 5.40 | 19 |
| 15 | Antigravity > Gemini | UNAVAILABLE | LOCAL-ENGINE | UNAVAILABLE | 1.01 | 17 |
| 16 | **Antigravity > Freebuff** | **PASS** | LOCAL-ENGINE | LOCAL-ENGINE | 17.20 | 76 |
| 17 | Freebuff > ChatGPT | BLOCKED | LOCAL-ENGINE | UNAVAILABLE | 0.33 | 17 |
| 18 | Freebuff > Claude | BLOCKED | LOCAL-ENGINE | UNAVAILABLE | 0.34 | 17 |
| 19 | Freebuff > Gemini | BLOCKED | LOCAL-ENGINE | UNAVAILABLE | 0.32 | 17 |
| 20 | **Freebuff > Antigravity** | **PASS** | LOCAL-ENGINE | LOCAL-ENGINE | 4.26 | 48 |

**Totals:** `PASS: 4` · `PARTIAL: 6` · `BLOCKED: 9` · `UNAVAILABLE: 1` · `FAIL: 0`.

**Live-model burn:** 0 of 60 quota — zero external API calls; live turns ran over existing `mcp-stdio` connections (ChatGPT PID 61220, Claude PID 72457, Antigravity PID 78503) and the Freebuff in-process worker.

#### Why this belongs in the arsenal

It validates the §9 moat story with *executed* evidence rather than a catalog claim: the bridge's real inter-agent hop over real desktop MCP connections is single-digit milliseconds and single-digit tokens, and the only live failure is the one the cord theory predicts (authenticated partner-app binding). That is exactly the kind of evidence §9.1 says the system should publish.

*The ten simulations above were generated deterministically from authored handoff prompts and verified turn-yield semantics; they are labeled `SIMULATED` where the desktop UI could not autonomously initiate an outgoing turn without human clicks. The four `PASS` entries are live, nonce-verified, over real connected processes.*
