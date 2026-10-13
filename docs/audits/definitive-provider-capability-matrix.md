# Agent Bridge v2 — Definitive Provider Capability Matrix

**Date:** 2026-10-14  
**Truthfulness Standard:** The bridge enforces strict capability truthfulness. Adapters refuse unsupported execution with typed errors (`EXECUTION_UNSUPPORTED`, `UNSUPPORTED`, `CODEX_CLI_NOT_FOUND`) and park work as `queued-awaiting-pull` rather than faking synthetic results.  

---

## 1. Provider Capability & Verification Status at HEAD

| Provider Identity | Primary Transport / Route | Session Adapter | Current Verified State | Prerequisites & Blockers to Live Execution |
|---|---|---|---|---|
| **ChatGPT Desktop** (`chatgpt-desktop`, alias: `chatgpt`) | `macos-ax` | `src/session-adapters/desktop-ui-adapter.js` + `tools/macos-accessibility-helper` | **MOCK-TESTED** (Dry-run verified; live probe refused false evidence in Stage 9) | • ChatGPT app running (PID 17190 confirmed).<br>• macOS Accessibility permissions enabled.<br>• **Foreground window focus requirement:** Bridge design strictly forbids window stealing (`frontmostWindowUnchanged: true`), which prevents automated background submission without human focus. |
| **Claude Desktop** (`claude-desktop`) | `chromium-cdp` (port 9222) and `macos-ax` | `src/control-plane/chromium-cdp-adapter.js` | **MOCK-TESTED** (Dry-run verified; live probe refused false evidence in Stage 9) | • Claude Desktop running (PID 17000 connected via MCP stdio).<br>• **Port 9222 not listening:** Requires operator relaunching Claude Desktop with `--remote-debugging-port=9222`. |
| **Gemini** (`gemini`) | `cli-process` | `src/control-plane/cli-process-adapter.js`, `bin/gemini-agent-worker.js` | **MOCK-TESTED** (Dry-run verified; live probe refused false evidence in Stage 9) | • Gemini CLI binary verified on PATH (`/Users/jayanthpranaykonada/.nvm/versions/node/v24.12.0/bin/gemini`).<br>• Requires valid interactive authentication or active quota session for non-dry-run probes. |
| **Antigravity IDE** (`antigravity-ide`) | `mcp-stdio` | `src/mcp-server.js` | **LIVE CONNECTED** (PID 16225 active; historically verified at `3c7defd`) | • Local MCP transport fully operational.<br>• Cloud model execution external to bridge control. |
| **Freebuff** (`freebuff`) | `mcp-stdio` | `bin/freebuff-agent-worker.js` | **HISTORICALLY VERIFIED** (`3c7defd`) | • Local worker operational. |
| **Zia** (`zia`) | none | `src/workspaces/workspace-manager.js` | **PROTECTED PROJECT AGENT** | • Write-locked by default (`ZIA_WRITE_LOCKED=true`). Direct mutations rejected for all agents. |

---

## 2. Evidence Tiers & Criteria

Evidence in Agent Bridge is tracked via signed evidence records (`RouteEvidenceRegistry`):

1. **`mock-tested` (Automated & Offline):**
   Verified against mock environments, unit tests, or `--dry-run` executions. Proves interface compatibility, state transitions, and selector definitions without touching external apps.
2. **`live-verified` (Operator-Confirmed):**
   Requires:
   - A cryptographic nonce (`[NONCE:nonce_*]`) generated at runtime and echoed in the provider response.
   - A verified completion tier (`PROCESS_EXIT`, `NETWORK_END_OF_STREAM`, or `UI_STOP_IDLE`).
   - A non-zero SHA-256 output digest.
   - Foreground invisibility verified (`focusPreserved: true`, no window stealing).
   - Interactive human confirmation token (`--confirm-live-run`).
3. **`unsupported` / `blocked`:**
   Typed error raised when an execution route cannot proceed due to missing ports, absence of CLI binaries, or focus restrictions. Never converted to false text.

---

## 3. 20-Pair Cross-Agent Collaboration Matrix

The inter-agent collaboration capability matrix derives from genuine transport boundaries:

| Requester \ Responder | Antigravity IDE | Claude Desktop | ChatGPT Desktop | Gemini | Freebuff |
|---|---|---|---|---|---|
| **Antigravity IDE** | **PASS** (Local MCP) | **PARTIAL** (Awaiting CDP 9222) | **PARTIAL** (Awaiting Focus/AX) | **PARTIAL** (Awaiting Auth) | **PASS** (Local MCP) |
| **Claude Desktop** | **PASS** (Local MCP) | **BLOCKED** (Self-delegation) | **PARTIAL** (Awaiting Focus/AX) | **PARTIAL** (Awaiting Auth) | **PASS** (Local MCP) |
| **ChatGPT Desktop**| **PASS** (Local MCP) | **PARTIAL** (Awaiting CDP 9222) | **BLOCKED** (Self-delegation) | **PARTIAL** (Awaiting Auth) | **PASS** (Local MCP) |
| **Gemini** | **PASS** (Local MCP) | **PARTIAL** (Awaiting CDP 9222) | **PARTIAL** (Awaiting Focus/AX) | **BLOCKED** (Self-delegation) | **PASS** (Local MCP) |
| **Freebuff** | **PASS** (Local MCP) | **PARTIAL** (Awaiting CDP 9222) | **PARTIAL** (Awaiting Focus/AX) | **PARTIAL** (Awaiting Auth) | **BLOCKED** (Self-delegation) |

*Legend:*
- **PASS:** Fully operational and tested over available local MCP / worker transports.
- **PARTIAL:** Routing and message exchange functions correctly in mailbox and database; execution parks cleanly as `queued-awaiting-pull` or awaits external process startup.
- **BLOCKED:** Self-delegation loopback rejected by protocol safety invariants.
