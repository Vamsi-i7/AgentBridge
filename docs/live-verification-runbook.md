# Agent Bridge Live Verification Runbook

*Document Version: 1.2.0 (Mission 4 - Part D)*
*Safety Notice: LIVE GATE ACTIVE. Never run against live applications without explicit human operator presence.*

---

## 1. Safety Invariants & Live Gate Rules

1. **Explicit Human Presence:** The live harness refuses to execute without interactive human confirmation or `--confirm-live-run`.
2. **Loopback Only:** Debug ports are bound strictly to `127.0.0.1` with hard lifetime limits and automatic cleanup traps on process exit.
3. **Invisibility Guarantee:** No windows are stolen or activated into the foreground during execution.
4. **Harmless Benign Probes:** Only benign mathematical or factual probe strings containing a cryptographic nonce `[NONCE:nonce_*]` are dispatched.
5. **Redacted Evidence:** No prompt text, conversation history, or personal tokens are stored. Only cryptographic hashes, completion evidence tiers, latency measurements, and timestamped HMAC signatures are recorded.
6. **Rollback Safety:** If a probe fails, times out, or produces ambiguous output, evidence level remains strictly capped at `mock-tested`.

---

## 2. Pre-Requisites & Operator Setup

Before running live verification, ensure:
1. Agent Bridge is built and ready in `/Users/jayanthpranaykonada/agent-bridge`.
2. The operator is present at the console.
3. Target applications to be verified are open (or installed):
   - **ChatGPT Desktop:** macOS native application open.
   - **Claude Desktop:** Claude Desktop application running with remote debugging enabled (`--remote-debugging-port=9222`) if CDP route is tested, or Accessibility permissions granted for macOS AX route.
   - **Google Gemini:** Headless CLI adapter / local session.
   - **Antigravity IDE:** IDE running with local MCP bridge.

---

## 3. Per-App Live Verification Instructions

### A. ChatGPT Desktop (Route: `macos-ax`)
- **Route Evidence Status:** Currently `mock-tested`. Native macOS application with Accessibility (AX) primary.
- **Run Command:**
  ```bash
  node bin/bridge.js live-verify chatgpt-desktop macos-ax --confirm-live-run
  ```
- **Execution Steps:**
  1. Harness discovers Accessibility tree elements (`AXTextArea`, `AXButton` with "Send").
  2. Sends benign probe turn: `Calculate 42 * 2 [NONCE:<nonce>]`.
  3. Awaits completion evidence tier (`UI_STOP_IDLE` or `AUTHENTICATED_SUBMIT`).
  4. Confirms frontmost window did not change.
  5. Computes SHA-256 result hash and writes signed record to `data/evidence/chatgpt-desktop_macos-ax.json`.

### B. Claude Desktop (Route: `chromium-cdp` and `macos-ax`)
- **Route Evidence Status:** Currently `mock-tested`.
- **Run Command (CDP):**
  ```bash
  node bin/bridge.js live-verify claude-desktop chromium-cdp --confirm-live-run
  ```
- **Run Command (AX):**
  ```bash
  node bin/bridge.js live-verify claude-desktop macos-ax --confirm-live-run
  ```
- **Execution Steps:**
  1. Harness connects to loopback CDP port (`http://127.0.0.1:9222/json`).
  2. Performs read-only DOM inspection to locate composer textarea and send button.
  3. Dispatches benign probe turn and monitors network stream / UI stop indicator.
  4. Confirms completion tier (`NETWORK_END_OF_STREAM`).

### C. Gemini / Freebuff (Route: `cli-process`)
- **Route Evidence Status:** Currently `mock-tested`. Headless CLI process adapter.
- **Run Command:**
  ```bash
  node bin/bridge.js live-verify gemini cli-process --confirm-live-run
  ```
- **Execution Steps:**
  1. Spawns CLI process with argument array and scrubbed environment.
  2. Sends prompt on stdin and awaits `PROCESS_EXIT` (exit code 0).
  3. Verifies zero focus changes.

### D. Offline Dry-Run Simulation (Safe Anytime)
- To verify the harness logic without touching any real apps:
  ```bash
  node bin/bridge.js live-verify gemini cli-process --dry-run
  node bin/bridge.js live-verify claude-desktop chromium-cdp --dry-run
  node bin/bridge.js live-verify chatgpt-desktop macos-ax --dry-run
  ```

---

## 4. Rollback & Remediation

If an unexpected error occurs during a live probe:
1. **Kill Switch:** Press `Ctrl+C`. All child processes and debug sessions are terminated immediately by signal handlers.
2. **Remove Partial Evidence Records:**
   ```bash
   rm -f data/evidence/*.json
   ```
3. **Inspect Logs & Explainer:**
   ```bash
   node bin/bridge.js explain <requestId>
   ```
4. **Reset Manifest to Fallback:**
   ```bash
   node bin/bridge.js agent reload
   ```

---

## 5. Compliance & Terms of Service Notice

When performing UI automation on desktop applications:
- Ensure automated turns adhere to the respective platform Terms of Service.
- Desktop automation via Accessibility APIs (AX) and loopback Chrome DevTools Protocol (CDP) are intended strictly for local operator-authorized assistant interoperation.
