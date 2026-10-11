# Agent Bridge Communication Protocol Specification

*Document Version: 2.0 (Mission 4 Protocol Hardening)*

---

## 1. Identifiers & Correlation Standards

Agent Bridge V2 mandates standard formats for all protocol entities:

| Entity | Identifier Format | Description |
|---|---|---|
| Request ID | `req_<timestamp>_<hex>` | Unique identifier for a correlated agent turn |
| Task ID | `task_<timestamp>_<hex>` | Durable asynchronous work item |
| Attempt ID | `att_<epoch>_<hex>` | Ephemeral execution attempt for fencing |
| Nonce | `nonce_<random_bytes_hex>` | Cryptographic turn nonce embedded in prompts |
| Correlation ID | `a2a_corr_<hex>` | Interoperability correlation token (A2A) |
| Content Reference | `ref_<sha256_hash>` | Content-addressed storage reference |

---

## 2. Request Envelope Format

Every inter-agent message carries an immutable `RequestEnvelope`:

```json
{
  "version": "2.0",
  "requestId": "req_1791734325_a1b2c3d4",
  "fromAgent": "gemini",
  "toAgent": "claude-desktop",
  "epoch": 1,
  "attemptId": "att_1_f8e7d6c5",
  "nonce": "nonce_992288337711",
  "mode": "direct",
  "payload": {
    "question": "Review security policy [NONCE:nonce_992288337711]",
    "contextRef": "ref_e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "contract": "review"
  },
  "cached": false,
  "timestamp": "2026-10-11T16:00:00.000Z"
}
```

---

## 3. Request States

Requests transition strictly through defined monotonic states:

```
[ PENDING ] ──> [ CLAIMED ] ──> [ IN_PROGRESS ] ──> [ COMPLETED ] (Terminal)
                      │                │
                      ├── [ CANCELLED ] ─────────────────> (Terminal)
                      └── [ FAILED / QUARANTINED ] ─────> (Terminal)
```

Terminal states (`completed`, `failed`, `cancelled`, `quarantined`) are permanent. Duplicate settlements are rejected by SQLite constraints and attempt ledger fencing.

---

## 4. Completion Evidence Tiers

Agent Bridge classifies response completion strictly into 6 ordered evidence tiers:

1. **`AUTHENTICATED_SUBMIT` (Confidence: 1.0 - HIGH):**
   Response submitted via `bridge_submit_task_result` tool call with matching cryptographic nonce, attempt ID, and epoch.
2. **`NETWORK_END_OF_STREAM` (Confidence: 0.9 - HIGH):**
   Underlying CDP network or HTTP transport-level stream closed cleanly.
3. **`A2A_COMPLETION` (Confidence: 0.85 - HIGH):**
   Agent2Agent protocol task completion handshake confirmed.
4. **`PROCESS_EXIT` (Confidence: 0.8 - MEDIUM):**
   Headless CLI child process exited with exit status code 0.
5. **`UI_STOP_IDLE` (Confidence: 0.7 - MEDIUM):**
   Desktop UI stop-generation element disappeared and composer returned to idle state.
6. **`STABILITY_HEURISTIC` (Confidence: 0.3 - LOW):**
   Polled response text stabilized over consecutive intervals. Always clearly labeled as low-confidence heuristic fallback.

---

## 5. Nonce Echo Protocol

When a turn carries `[NONCE:<nonce>]`, connected models or adapters are instructed to return `[[NONCE:<nonce>]]` in the output. `ResponseCorrelatorV2` verifies:
- Nonce matches expected turn nonce.
- Nonce has not been consumed previously (replay protection).
- Output is bound to the current attempt ID and epoch.
