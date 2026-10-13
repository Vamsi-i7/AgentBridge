# Agent Bridge Security Threat Model & Trust Boundaries

*Document Version: 1.2.0 (Mission 4 Production Hardening)*
*Status: Enforced by automated regression and authorization matrix tests*

---

## 1. Executive Summary

Agent Bridge is a local-first coordination plane connecting desktop AI applications (ChatGPT Desktop, Claude Desktop, Antigravity IDE, Google Gemini, CLI processes). Because Agent Bridge grants connected AI agents access to local tools (filesystem, git, process execution, inter-agent messaging), security boundaries must assume that connected models may attempt prompt injections, unprivileged escalations, or unauthorized cross-agent access.

Agent Bridge follows a **strict default-deny architecture**: no agent can promote itself, widen permissions, install unapproved skills, or execute out-of-boundary filesystem or network operations.

---

## 2. Core Assets

1. **Host Filesystem Integrity:** Files outside explicitly configured `ALLOWED_ROOTS` must remain strictly inaccessible.
2. **Git Version Control & Credentials:** Repositories, SSH keys, credentials, and remotes.
3. **Bridge State & Event Ledger:** SQLite database (`bridge.db`), audit logs, request queues, and attempt records.
4. **Inter-Agent Message Integrity:** Correlated tasks and requests (`ResponseCorrelatorV2`, nonces, epochs, and cryptographically verified attempts).
5. **Control Plane Tokens & Keys:** `AGENT_BRIDGE_KEY`, session tokens, and MCP authentication headers.
6. **Local Host Resources:** CPU, memory, socket descriptors, child process tree bounds.

---

## 3. Trust Boundaries

```
[ External Internet / Untrusted Web ]
                |
           (BLOCKED: No remote incoming connections; Loopback only 127.0.0.1)
                |
                v
+------------------------------------------------------------------------------------+
| Local Host (macOS Darwin)                                                          |
|                                                                                    |
|  +------------------------+      Host & Origin Guard     +----------------------+  |
|  | Local Web Browsers     | ---------------------------> | Agent Bridge HTTP/SSE|  |
|  | (DNS Rebinding / CSRF) |   403 Forbidden on Origin    | (Port 8765 / 8768)   |  |
|  +------------------------+                              +----------------------+  |
|                                                                     |              |
|  +------------------------+      V2 Nonce & Epoch Fencing           |              |
|  | Connected AI Agents    | ----------------------------------------+              |
|  | (ChatGPT, Claude, etc.)|     Default-Deny PermissionGuard        |              |
|  +------------------------+                                         v              |
|                                                          +----------------------+  |
|  +------------------------+                              | Tool Registry &      |  |
|  | Skills / Extensions    | ---------------------------> | PermissionGuard      |  |
|  | (Untrusted code/yaml)  |   Human Approval Required    +----------------------+  |
|  +------------------------+                                         |              |
|                                                                     v              |
|                                                          +----------------------+  |
|                                                          | Local Filesystem &   |  |
|                                                          | Sandboxed Execution  |  |
|                                                          +----------------------+  |
+------------------------------------------------------------------------------------+
```

---

## 4. Attacker Profiles & Threat Vectors

### Threat 1: Malicious or Prompt-Injected Agent
- **Description:** A connected LLM receives a prompt injection instructing it to read `~/.ssh/id_rsa`, run destructive commands (`rm -rf /`), or add itself as a `system` admin.
- **Mitigation:**
  - `PermissionGuard`: Path canonicalization via `fs.realpathSync()`. Lexical traversal (`../../`) is resolved and blocked if outside `ALLOWED_ROOTS`.
  - Self-Widening Prohibition: Agents cannot modify `CONFIG.AGENT_IDENTITIES`, alter `agentPolicies`, or grant themselves new capabilities.
  - Command allowlists: Shell executions are validated; sensitive commands require explicit human approval.

### Threat 2: Malicious Webpage via DNS Rebinding or CSRF
- **Description:** An attacker tricks the operator into browsing an attacker website that attempts requests to `http://localhost:8765` or `http://localhost:8768` (Dashboard).
- **Mitigation:**
  - **Host Header Enforcement:** Strict validation against `127.0.0.1`, `localhost`, or configured host. Non-loopback Host headers return `403 Forbidden`.
  - **Origin Header Rejection:** Browser requests carrying an untrusted `Origin` header are blocked (`403 Forbidden`).
  - **CSRF Tokens:** All state-changing dashboard calls require cryptographically secure random session tokens verified with constant-time equality (`crypto.timingSafeEqual`).
  - **Strict CSP:** Dashboard serves `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'`.

### Threat 3: Malicious or Untrusted Skill / Plugin
- **Description:** A third-party skill injects malicious instructions or tools into the bridge.
- **Mitigation:**
  - `SignedSkillRegistry`: Single source of truth with SHA-256 integrity verification.
  - **Mandatory Human Approval:** Seed and dynamically added skills start in `pending-user-approval`. Agents cannot approve skills (only authenticated human operators via CLI `bridge skill approve <name>` or dashboard).
  - Agent self-approval is rejected by cryptographic identity verification.

### Threat 4: Compromised CLI Output / Shell Injection
- **Description:** Hostile output from a child process attempts escape via terminal control sequences or argument injection.
- **Mitigation:**
  - CLI Process Adapters use argument arrays (`execFile` / `spawn`), never unsanitized shell concatenation (`sh -c`).
  - Scrubbed child environments: Child processes receive minimal, sanitized environment variables without sensitive secrets or tokens.
  - Output size limits: Process stdout/stderr bounded at 5MB to prevent memory exhaustion / DoS.

### Threat 5: Hostile Remote A2A Peer
- **Description:** An external peer sends forged A2A JSON-RPC 2.0 messages attempting task creation or identity spoofing.
- **Mitigation:**
  - Authenticated A2A endpoints require bearer API keys and valid agent identity binding.
  - Cryptographic V2 nonces (`nonce_*`), correlation IDs (`a2a_corr_*`), and attempt fencing (`att_*`) prevent replay attacks and out-of-order execution.

### Threat 6: Local Unprivileged Process Contention
- **Description:** Another local unprivileged process attempts to corrupt or lock the shared SQLite store.
- **Mitigation:**
  - SQLite WAL mode with `busy_timeout = 10000ms`.
  - Ephemeral PID lock files for single-process bridge daemon coordination.
  - Forward schema migrations (`SchemaMigrator`) and online-safe backups (`VACUUM INTO`).

---

## 5. Security Invariant Regression Guarantees

The following 10 invariants are verified by automated regression and invariant mutation tests (in `tests/mutation-invariants.test.js` and `tests/v2-adversarial-integration.test.js`):
1. `INV-01`: Path traversal outside `ALLOWED_ROOTS` is rejected.
2. `INV-02`: Agent self-elevation or permission expansion is blocked.
3. `INV-03`: Stale attempts cannot settle active or completed tasks (attempt/epoch fencing).
4. `INV-04`: Cryptographic nonce replay attacks are rejected.
5. `INV-05`: Unauthenticated requests to protected control plane endpoints fail closed (HTTP 401).
6. `INV-06`: Browser DNS rebinding and cross-origin requests are blocked (HTTP 403).
7. `INV-07`: Stored artifacts use content-addressed SHA-256 CAS; tampering is immediately detected.
8. `INV-08`: Agent skill installation requires explicit human approval; agent self-approval throws.
9. `INV-09`: Cheap-first router never substitutes an explicitly declared target.
10. `INV-10`: Sensitive credentials (`API_KEY`, private tokens) are redacted from logs, traces, and display managers.
