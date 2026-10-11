# Agent Bridge

*Connected AI Development Environment Bridge for Claude Desktop, ChatGPT Desktop, Antigravity IDE, and Local CLI Agents.*

---

## 1. What is Agent Bridge?

Agent Bridge is a local-first coordination and execution fabric running on macOS Darwin. It enables independent desktop AI agents to:
- Discover one another via authoritative manifests.
- Exchange correlated tasks and responses with cryptographic nonces (`[NONCE:nonce_*]`) and attempt/epoch fencing.
- Access authorized local project repositories (`bridge_read_file`, `bridge_edit_file`, `bridge_get_symbol_outline`, `bridge_git_*`).
- Stream tokens to an operator Command Center dashboard (`bridge dashboard` on `127.0.0.1:8768`).
- Execute multi-hop autonomous pipelines without waking intermediate agents merely to relay.

---

## 2. Verified Capabilities & Honest Evidence Status

Every route in Agent Bridge is tracked by `RouteEvidenceRegistry` (`src/capabilities/evidence-registry.js`).
In accordance with Mission 4 Evidence Honesty Rules:
- **`live-verified`**: Reserved exclusively for routes with a cryptographic HMAC-signed evidence record written by the live verification harness with the operator present.
- **`mock-tested`**: Verified by automated test suites using deterministic fakes, hermetic child processes, and isolated SQLite instances.
- **`declared`**: Declared in manifests or configurations but not yet active or verified.

### Route Evidence & Completion Matrix

| Agent ID | Route ID | Route Type | Evidence Status | Completion Evidence Tier | Verified Invariants |
|---|---|---|---|---|---|
| `chatgpt-desktop` | `macos-ax` | UI Automation | **mock-tested** | `UI_STOP_IDLE` | Background execution without focus stealing; Swift AX helper daemon. |
| `chatgpt-desktop` | `chromium-cdp` | CDP Browser | **declared** | `NETWORK_END_OF_STREAM` | Declared fallback only (ChatGPT macOS is native AppKit, not Electron). |
| `claude-desktop` | `chromium-cdp` | CDP Browser | **mock-tested** | `NETWORK_END_OF_STREAM` | Loopback CDP port 9222 attached session; DOM discovery. |
| `claude-desktop` | `macos-ax` | UI Automation | **mock-tested** | `UI_STOP_IDLE` | macOS Accessibility alternative route. |
| `antigravity-ide` | `mcp-stdio` | Active MCP | **mock-tested** | `AUTHENTICATED_SUBMIT` | Stdio / JSON-RPC bidirectional tool protocol. |
| `gemini` | `cli-process` | Headless CLI | **mock-tested** | `PROCESS_EXIT` | Isolated child process with argument arrays and clean environment. |
| `freebuff` | `cli-process` | Headless CLI | **mock-tested** | `PROCESS_EXIT` | Headless CLI worker with synchronous spawn registration. |

---

## 3. Quickstart & Operator CLI

```bash
# 1. Check system readiness & configuration
node bin/bridge.js doctor

# 2. Run full ship-ready verification suite (10 verification gates)
npm run verify

# 3. Start operator command center dashboard
node bin/bridge.js dashboard --port 8768

# 4. Dry-run live verification harness against fakes
node bin/bridge.js live-verify gemini cli-process --dry-run
node bin/bridge.js live-verify claude-desktop chromium-cdp --dry-run

# 5. Backup SQLite state and artifacts
node bin/bridge.js backup ./backups/initial-backup
```

---

## 4. Key Security Invariants

Agent Bridge is built on a **strict default-deny security architecture**:
1. **Path Containment:** Realpath canonicalization (`fs.realpathSync`) prevents symlink escapes and directory traversal outside `ALLOWED_ROOTS`.
2. **Replay & Fencing Guards:** Cryptographic turn nonces (`ResponseCorrelatorV2`) and `AttemptLedger` prevent duplicate settlement or out-of-order execution.
3. **No Agent Self-Elevation:** Connected models have zero endpoints or tools capable of widening permissions, modifying `agentPolicies`, or adding identities.
4. **Human Approval for Skills:** Skills start in `pending-user-approval`. Agents cannot self-approve skills; approval requires explicit operator commands (`bridge skill approve <name>`).
5. **Host & Origin Protection:** Browser DNS rebinding and cross-origin requests are rejected (`403 Forbidden`).

---

## 5. Documentation Directory

- [Architecture & Call Chains](file:///Users/jayanthpranaykonada/agent-bridge/docs/architecture.md)
- [Protocol Specification V2](file:///Users/jayanthpranaykonada/agent-bridge/docs/protocol.md)
- [Security Architecture](file:///Users/jayanthpranaykonada/agent-bridge/docs/security.md)
- [Threat Model & Attackers](file:///Users/jayanthpranaykonada/agent-bridge/docs/threat-model.md)
- [Operations & Runbook](file:///Users/jayanthpranaykonada/agent-bridge/docs/operations.md)
- [Agent Routes & Conformance](file:///Users/jayanthpranaykonada/agent-bridge/docs/agents.md)
- [Skills Platform](file:///Users/jayanthpranaykonada/agent-bridge/docs/skills.md)
- [Dashboard & Live Tailing](file:///Users/jayanthpranaykonada/agent-bridge/docs/dashboard.md)
- [Live Verification Runbook](file:///Users/jayanthpranaykonada/agent-bridge/docs/live-verification-runbook.md)
- [Production Reachability Matrix](file:///Users/jayanthpranaykonada/agent-bridge/docs/reachability.md)
- [Open Source Decisions & Licenses](file:///Users/jayanthpranaykonada/agent-bridge/docs/open-source-decisions.md)
