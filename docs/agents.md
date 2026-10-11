# Agent Routes & Evidence Matrix

*Generated from `src/capabilities/agent-manifest.js` & `src/capabilities/evidence-registry.js`*
*Document Version: 1.2.0 (Mission 4 Ship-Ready)*

---

## 1. Truthful Route Evidence Table

In accordance with Mission 4 Evidence Honesty Rules:
- `live-verified` exists ONLY when a signed live evidence record has been produced by the live verification harness with the operator present.
- Routes without signed live records top out at `mock-tested`.
- Native applications without supported remote debugging ports remain strictly `declared`.

| Agent ID | Display Name | Route ID | Route Type | Evidence Level | Primary Completion Tier | Invariants & Notes |
|---|---|---|---|---|---|---|
| `chatgpt-desktop` | ChatGPT Desktop | `macos-ax` | UI Automation | `mock-tested` | `UI_STOP_IDLE` | Native macOS AppKit window; Accessibility (AX) primary. Background execution verified. |
| `chatgpt-desktop` | ChatGPT Desktop | `chromium-cdp` | CDP Browser | `declared` | `NETWORK_END_OF_STREAM` | Declared fallback only; ChatGPT macOS is native AppKit, not Electron. |
| `claude-desktop` | Claude Desktop | `chromium-cdp` | CDP Browser | `mock-tested` | `NETWORK_END_OF_STREAM` | Attached loopback CDP session on port 9222. |
| `claude-desktop` | Claude Desktop | `macos-ax` | UI Automation | `mock-tested` | `UI_STOP_IDLE` | macOS Accessibility alternative route. |
| `antigravity-ide` | Antigravity IDE | `mcp-stdio` | Active MCP | `mock-tested` | `AUTHENTICATED_SUBMIT` | Stdio / JSON-RPC bidirectional tool protocol. |
| `gemini` | Google Gemini | `cli-process` | Headless CLI | `mock-tested` | `PROCESS_EXIT` | Isolated child process with argument arrays and clean environment. |
| `freebuff` | Freebuff Worker | `cli-process` | Headless CLI | `mock-tested` | `PROCESS_EXIT` | Headless CLI execution worker. |

---

## 2. Onboarding a New Agent

To onboard a new agent safely into Agent Bridge:

### Step 1: Add Allowed Identity (Human Operator Command)
```bash
node bin/bridge.js agent add <agentId>
```
*Note: Agents cannot self-register or elevate identities. Only local CLI invocation works.*

### Step 2: Verify Conformance Matrix
```bash
node bin/bridge.js agent verify <agentId>
```
Runs the 4-point Route Conformance Suite:
1. Identity registration in `CONFIG.AGENT_IDENTITIES`.
2. Adapter binding.
3. ModelExecutionAdapter interface conformance (`health()`, `send()`, `cancel()`).
4. Health check probe.

### Step 3: Hot-Reload Manifest
```bash
node bin/bridge.js agent reload
```
Atomically updates the manifest across running bridge servers without downtime.
