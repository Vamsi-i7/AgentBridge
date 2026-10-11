---
name: bridge-completion-verification
description: Nonce and correlation verification, accessibility UI probe signals, and distinguishing heuristic stillness from confirmed completion.
version: 1.0.0
author: Antigravity IDE & Jayanth
license: MIT
riskTier: A
---

# Bridge Completion Verification Skill

## Overview
When interacting with desktop application agents via OS accessibility (AX) APIs or headless engines, determining when the model has genuinely finished generating is essential to prevent partial response settlement. This skill details the verification mechanisms used across Agent Bridge.

## Verification Signals

### 1. Cryptographic Nonce Correlation (`ResponseCorrelatorV2`)
- Every dispatched prompt embeds an unpredictable token marker:
  `<!-- [AgentBridge Correlation: ABN-<hex>-<timestamp>] -->`
- The receiving worker or observer verifies that the returned assistant text echoes this exact nonce.
- The nonce is consumed atomically on first verification; subsequent duplicate responses with the same nonce are flagged as replays.

### 2. UI Indicator Transitions
- Accessibility probes monitor target application windows for dynamic elements:
  - `hasStopButton`: True while the application presents a "Stop Generating" or square button.
  - `isGenerating` / `streaming`: True while AX text element is actively changing or cursor is pulsating.
  - `isThinking`: True during extended reasoning phases (e.g. Claude 3.7 or o1/o3 thinking blocks).
- When these indicators clear AND text remains stable over consecutive ticks, `INDICATOR_BASED` confidence is awarded.

### 3. Grace Re-Checks for Thinking Pauses
- Models with extended thinking often pause output for 1-10 seconds between paragraphs.
- Observers must never settle immediately on the first stillness tick.
- A grace check probe is scheduled (`graceRecheckIntervalMs`). If text grows or generation indicators reappear during grace re-check, settlement is aborted and streaming continues.

## Truthfulness Invariants
- If an application provides no accessibility indicators or turn signals, the result MUST be labeled `STABILITY_HEURISTIC`.
- Never label heuristic results as `EXPLICIT_END_OF_TURN` or "independently verified".
