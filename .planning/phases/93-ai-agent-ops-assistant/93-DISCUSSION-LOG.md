# Phase 93: AI Agent Ops Assistant — Discussion Log

**Date:** 2026-05-14

## Areas Discussed

### 1. Ops Context Injection

| # | Question | User Choice | Notes |
|---|----------|-------------|-------|
| 1.1 | Context injection approach | On-demand tools only | Agent calls tools when needed, no pre-loading |
| 1.2 | System prompt strategy | Dynamic by intent (LLM classification) | Classify user message first, then match prompt template |
| 1.3 | Tool set for chat | Add new lightweight tools | list_active_alerts, get_instance_summary etc. + existing db_* tools |
| 1.4 | Session greeting behavior | Proactive intro + capability hints | Agent greets and tells user what it can do |
| 1.5 | Tool failure handling | Direct failure reporting | Tell user what failed and why |
| 1.6 | Tool display in UI | OpenClaw native, no changes | Follow existing tool-cards rendering |
| 1.7 | Intent classification mechanism | LLM classification | Use lightweight LLM call for intent detection |

### 2. Ops Event Notification

| # | Question | User Choice | Notes |
|---|----------|-------------|-------|
| 2.1 | Event scope | NOT in Phase 93 | Reuse existing notification channels (DingTalk/WeCom/Feishu/Webhook) |
| 2.2 | Confirmed scope reduction | Confirmed | Phase 93 = Chat AI Q&A only |

### 3. Data Scope & RBAC

| # | Question | User Choice | Notes |
|---|----------|-------------|-------|
| 3.1 | Data permission model | Inherit user RBAC | Agent tools execute with user's permissions |

### 4. Architecture Approach

| # | Question | User Choice | Notes |
|---|----------|-------------|-------|
| 4.1 | Integration strategy | Minimal — enhance agent-service.ts | No Gateway changes, no new bridge layer |
| 4.2 | New tools registration | Independent in toolCatalog | Follow Phase 92 complete_analysis registration pattern |

## Deferred Ideas

None.
