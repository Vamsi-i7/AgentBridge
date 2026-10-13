# Agent Bridge Security Architecture & Defense in Depth

*Document Version: 1.2.0 (Mission 4 Ship-Ready)*

---

## 1. Principles of Security

1. **Default-Deny Policy:** Unrecognized identities, unconfigured roles, or unallowlisted commands are denied immediately.
2. **Path Containment with Realpath Canonicalization:** All filesystem access must resolve inside `ALLOWED_ROOTS`. Symlink indirection is canonicalized via `fs.realpathSync()`; dangling links and missing leaf directories are resolved to verify true target containment.
3. **Cryptographic Identity & Nonces:** Inter-agent turns use cryptographically generated V2 nonces (`nonce_*`) and epoch fencing. Stale or duplicated attempts cannot settle transactions.
4. **Content-Addressed Storage (CAS):** Large payloads and artifacts are stored by SHA-256 hash in `data/artifacts/`. Tampering or corruption immediately fails verification.
5. **No Self-Elevation:** Agents have no tools or endpoints capable of adding allowed identities, modifying security policies, or approving skills. Only the human operator via local terminal commands can perform administrative actions.

---

## 2. Authorization Matrix Summary

- **Public Endpoints / Tools:** `bridge_ping`, `bridge_discover_agents`, `bridge_agent_presence`, `bridge_diagnostics`.
- **Protected MCP Tools:** All filesystem mutations (`bridge_create_file`, `bridge_edit_file`, `bridge_delete_file`), git commands, process executions, and inter-agent delegations require authenticated sessions and permission checks.
- **Protected HTTP Routes:** `/api/task`, `/api/message`, `/api/audit`, `/api/mcp/call` fail closed with `HTTP 401 Unauthorized` without a valid `x-api-key`.
- **Browser Protection:** Foreign `Origin` and non-loopback `Host` headers return `HTTP 403 Forbidden`.

For the complete attacker vectors and mitigations, refer to [threat-model.md](file:///Users/jayanthpranaykonada/agent-bridge/docs/threat-model.md).

---

## 3. HTTP Control Plane Authentication & Loopback Protection (AR-12)

The Agent Bridge HTTP server listens on loopback (`127.0.0.1:8765`) by default.

### Authentication Modes:
1. **Unauthenticated Loopback (`none-loopback`)**:
   - Default mode when `CONTROL_PLANE_API_KEY` is not set.
   - Emits a startup warning `[SECURITY WARNING]` to alert operators.
   - Local processes can access unauthenticated liveness endpoints, but protected endpoints (`/api/task`, `/api/message`, `/api/audit`, `/api/chatgpt/*`) enforce fail-closed credential checks.
   - `/health` reports `auth: "none-loopback"` and `authEnabled: false`.

2. **Authenticated (`api-key`)**:
   - Enabled by setting the environment variable `CONTROL_PLANE_API_KEY=<strong-secret>` or `AGENT_BRIDGE_API_KEY=<strong-secret>`.
   - All protected routes and MCP invocations require `x-api-key: <strong-secret>` or `Authorization: Bearer <strong-secret>`.
   - `/health` reports `auth: "api-key"` and `authEnabled: true`.

### Defense in Depth Controls:
- **Origin Header Guard:** All browser-originated requests containing an `Origin` header are rejected with `HTTP 403 Forbidden` to prevent Cross-Site Request Forgery (CSRF).
- **Host Header Guard:** ChatGPT brain endpoints reject non-loopback Host headers to prevent DNS-rebinding attacks.
- **Request Body Limits:** HTTP request payloads are strictly capped at 5 MB; oversized requests are rejected with `HTTP 413 Payload Too Large`.
