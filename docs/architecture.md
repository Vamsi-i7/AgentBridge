# Agent Bridge System Architecture

*Document Version: 1.2.0 (Mission 4 Ship-Ready)*

---

## 1. Overview & Core Philosophy

Agent Bridge provides a unified, local-first inter-agent communication, file execution, and task coordination fabric for independent AI agents on macOS Darwin.

Instead of disparate wrappers or fragile web scraping, Agent Bridge enforces:
1. **Single Tool & Execution Registry:** Both MCP (Model Context Protocol stdio/SSE) and local HTTP JSON-RPC execute through the exact same `ToolRegistry`.
2. **Deterministic Control Plane Routes:** Dedicated adapters for CLI headless processes (`CliProcessAdapter`), Chrome DevTools Protocol sessions (`ChromiumCdpAdapter`), and native macOS Accessibility (`NativeAxAdapter` / `SwiftAXBridge`).
3. **Cryptographic V2 Correlation:** Nonce replay guards, epoch/attempt fencing, and structured error propagation ensure no out-of-order execution or duplicate settlement.
4. **Token-Neutral Architecture:** Zero extra model tokens injected by default. Complex operations (structured contracts, context references, rolling summaries, compression) execute bridge-side or behind explicit opt-in flags.

---

## 2. Component Diagram

```
+-----------------------------------------------------------------------------------+
|                              CONNECTED AI AGENTS                                  |
|   Claude Desktop      ChatGPT Desktop       Antigravity IDE       Google Gemini   |
+-----------------------------------------------------------------------------------+
           |                        |                       |               |
           | MCP Stdio              | macOS AX UI           | MCP / HTTP    | CLI Subproc
           v                        v                       v               v
+-----------------------------------------------------------------------------------+
|                               ENTRY POINTS                                        |
|   mcp-server.js        http-server.js        bin/bridge.js       agent-runner.js  |
+-----------------------------------------------------------------------------------+
                                   |
                                   v
+-----------------------------------------------------------------------------------+
|                        SECURITY & CONTROL SUBSTRATE                               |
|   PermissionGuard         AuditLogger (WAL)        ResponseCorrelatorV2           |
|   (Default-Deny)          (SQLite bridge.db)       (Attempt / Epoch Fencing)      |
+-----------------------------------------------------------------------------------+
                                   |
         +-------------------------+-------------------------+
         |                                                   |
         v                                                   v
+-----------------------------------+   +-------------------------------------------+
|          TOOL REGISTRY            |   |           CONTROL PLANE ROUTING           |
|  - Filesystem (Read/Edit/Search)  |   |  BaseRouteAdapter (route-interface.js)    |
|  - Git Controller (Branch/Diff)   |   |  - CliProcessAdapter (Zero-focus spawn)   |
|  - Process Exec (Allowlist/Argv)  |   |  - ChromiumCdpAdapter (CDP Target/DOM)    |
|  - Collaboration Patterns         |   |  - NativeAxAdapter (Swift daemon helper)  |
|  - Symbol Outline Generator       |   |  - ModelOrchestrator & MultiHopRouter     |
|  - Structured Contract Validator  |   +-------------------------------------------+
+-----------------------------------+                        |
         |                                                   |
         v                                                   v
+-----------------------------------------------------------------------------------+
|                            STORAGE & PERSISTENCE                                  |
|   SchemaMigrator         ArtifactStore (CAS)        RetentionPruner               |
|   (PRAGMA user_version)  (SHA-256 CAS Blob Store)   (Lease & Request Pruning)     |
+-----------------------------------------------------------------------------------+
```

---

## 3. Request Execution Call Chain

When an agent invokes `bridge_ask_agent` or `bridge_delegate_task`:

```
1. Caller (Agent A) dispatches `bridge_ask_agent` { toAgent: 'claude-desktop', question: '...' }
   │
2. ToolRegistry.executeTool('bridge_ask_agent', args, ctx)
   │
3. MailboxHub.askAgent()
   ├─ Check SemanticCache (if opt-in enabled and read-only) -> Cache Hit returns immediately
   ├─ Check CheapFirstRouter (if opt-in enabled and no target declared)
   └─ Insert bridge_requests (status = 'pending', attempt_id = 'att_1', epoch = 1)
   │
4. ResponseCorrelatorV2.generateNonce(requestId, attemptId, epoch, routeId)
   │
5. Target Route Selection (from Manifest & Evidence Registry):
   ├─ CLI Route -> CliProcessAdapter.send() -> Spawns isolated child process
   ├─ CDP Route -> ChromiumCdpAdapter.send() -> Dispatches input via CDP
   └─ AX Route  -> NativeAxAdapter.send() -> Dispatches via Swift AX Bridge
   │
6. Observation & Completion Evidence:
   ├─ Captures streamed chunks / deltas
   ├─ Commits streamed tokens to BridgeDisplayManager
   └─ Detects Completion Evidence Tier:
        - AUTHENTICATED_SUBMIT (bridge_submit_task_result with matching nonce)
        - NETWORK_END_OF_STREAM (CDP stream closed)
        - PROCESS_EXIT (exit code 0)
        - UI_STOP_IDLE (stop generation button disappeared)
   │
7. Settlement & Durable Finalization:
   ├─ AttemptLedger.validateFencing() verifies active attempt and epoch
   ├─ ResponsePreserver / ArtifactStore writes authentic response artifact
   ├─ TokenAccountant records honest usage metrics
   └─ MailboxHub resolves waiter and returns CorrelatedResponse to Agent A
```

---

## 4. Multi-Hop Autonomous Pipeline

When executing chains ($A \rightarrow B \rightarrow C \rightarrow A$):
- Handled by `MultiHopRouter` (`src/control-plane/multi-hop-router.js`).
- `CollaborationGuard` enforces hop budgets (maximum 10 hops) and cycle detection.
- `ContextReferenceManager` passes context by hash reference (`ref_<sha256>`) rather than re-transmitting bodies.
- `RollingSummaryManager` maintains a compact summary across intermediate hops.
- Results flow directly without waking intermediate agents merely to relay.
