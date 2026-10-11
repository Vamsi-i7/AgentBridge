---
name: bridge-multi-agent-testing
description: Interoperability testing methodology, separate-process responders, unpredictable nonces, and avoiding synthetic simulation traps.
version: 1.0.0
author: Antigravity IDE & Jayanth
license: MIT
riskTier: A
---

# Bridge Multi-Agent Testing Skill

## Overview
Testing multi-agent systems is prone to false positives when synthetic stubs simulate peer responses within the same memory space. This skill defines the testing discipline required for genuine verification across processes and applications.

## Testing Hierarchy

| Level | Execution Class | Description | Acceptable Use |
| :--- | :--- | :--- | :--- |
| **L0** | `[MOCK]` | In-memory unit mock or stub. | Fast protocol parsing, edge cases, unit tests. |
| **L1** | `[LOCAL-STUB]` | Local deterministic probe or adapter. | UI state machine tests, timeout recovery. |
| **L2** | `[LOCAL-ENGINE]` | Genuine separate-process worker on loopback. | End-to-end task delegation and durable recovery. |
| **L3** | `[REAL-APP]` | OS accessibility control over desktop app. | Real pair testing (ChatGPT, Claude, Gemini). |
| **L4** | `[REAL-API]` | Live cloud model provider endpoint. | Opt-in quota gated benchmark (`AGENT_BRIDGE_LIVE_MODELS=1`). |

## Ground Truth Rules

1. **No Synthetic Fabrication**: Never create a mock that returns a hardcoded "success" string while claiming it represents a live desktop app.
2. **Cryptographic Nonce Challenge**: Any inter-agent test claiming real communication must pass an unpredictable nonce in the prompt and verify the peer echoed that exact nonce in the result.
3. **Separate Process Boundary**: Multi-process event delivery tests must spawn or connect to a distinct OS process (different PID) to verify durable state recovery.
4. **Quota Gating**: Live model tests must check `process.env.AGENT_BRIDGE_LIVE_MODELS === '1'`. Without the flag, tests must skip honestly rather than failing or silently synthesizing answers.
