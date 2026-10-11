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
