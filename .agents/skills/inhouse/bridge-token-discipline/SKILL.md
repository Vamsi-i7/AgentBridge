---
name: bridge-token-discipline
description: Context efficiency, profile-capped tool advertisement, compact artifact envelopes, and zero redundant model calls.
version: 1.0.0
author: Antigravity IDE & Jayanth
license: MIT
riskTier: A
---

# Bridge Token Discipline Skill

## Overview
As agent capabilities scale, context window saturation becomes a major bottleneck. Bloated tool manifests and verbose inter-agent message histories rapidly consume token budgets. This skill details the optimization standards enforced across Agent Bridge.

## Optimization Strategies

### 1. Profile-Capped Tool Advertisement
Agent Bridge supports tool profiles (`minimal`, `collaborator`, `developer`, `skills`, `all`):
- **`minimal`** (3 tools): Core ping and request answering.
- **`collaborator`** (16 tools): Inbox, messaging, tasks, delegation.
- **`developer`** (33 tools): Filesystem, git, project snapshots.
- **`skills`** (4 tools): Skill discovery, retrieval, and search.
- **Savings**: Selecting `minimal` or `collaborator` saves over 70% of prompt tokens compared to advertising all 74 tools on every turn.

### 2. Compact Envelopes & Response Deduplication
- Large task results (>500 characters) are automatically stored in `ArtifactStore` and referenced via compact URI/ID pointers.
- Response payloads exclude repetitive transport metadata.
- When multiple agents request the same cached outcome, the bridge delivers the existing artifact without re-querying the model.

### 3. Progressive Retrieval
- **List -> Inspect -> Read**: Rather than loading all files or skills into context, agents should first list summary keys (`bridge_list_skills`), search with keywords (`bridge_search_skills`), and fetch specific sections on-demand (`bridge_get_skill_resource`).

### 4. Zero Re-Synthesis
- Inter-agent messages default to direct delivery. Do not route messages through an intermediate LLM summarization step unless explicitly flagged `mode: assist`.
