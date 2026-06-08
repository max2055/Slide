# Slide — AI 驱动的数据库运维平台

**Shipped:** v1.4 (2026-06-09)
**Status:** Complete — v1.4 Agent 解耦与替换 shipped (Phases 108-118)

## What This Is

Slide 是一个 AI 驱动的数据库运维管理平台，提供实时监控、告警通知、性能分析、SQL 审核和智能运维工具。通过 @slide/agent-core (DirectAdapter) 集成 LLM 能力，实现告警根因自动分析、故障诊断、慢查询优化建议等 AI 辅助运维。

## Core Value

**AI 原生的数据库运维** — Agent 自动采集数据、分析问题、给出建议，将 DBA 从重复性工作中释放。

## Architecture

- **Frontend** — Lit 3.3 + Vite (Web Components) + ECharts
- **Backend** — Fastify + TypeScript + MySQL + Elasticsearch + MongoDB + Redis
- **Agent Engine** — @slide/agent-core (DirectAdapter WebSocket)
- **AI** — Anthropic/OpenAI/Ollama via @slide/agent-core providers

## Key Capabilities

| Capability | Description |
|-----------|-------------|
| Multi-DB Monitoring | MySQL + PostgreSQL metrics collection at 30s interval |
| Alert Engine | 50+ metric rules, 3-level thresholds, cron-based evaluation |
| Multi-Channel Notification | DingTalk, WeCom, Feishu, Webhook with SSRF protection |
| Report Generation | Health, performance, slow query, capacity reports (PDF/HTML/JSON/MD) |
| SQL Audit | LLM-driven pre-execution SQL review with risk detection |
| Query Analytics | QAN fingerprint analysis + EXPLAIN JSON visualization |
| AI Analysis | RCA, fault diagnosis, TopSQL analysis via ai-agent-bridge |
| RBAC | JWT auth + role-based access control (admin/dba/viewer) |
| Approval Workflow | SQL execution approval with LLM risk assessment |
| Capacity Prediction | Linear regression on metrics history |

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| OpenClaw Agent for AI | Reuse native streaming, tool calling, session management | ✓ Working |
| ai-agent-bridge.ts | Unified dispatch with TTL caching per analysis type | ✓ Working |
| CronJob for collection | Standard crontab syntax, timezone support, built-in status | ✓ Working |
| ECharts over Chart.js | Richer interactivity, better Chinese ecosystem support | ✓ Working |
| Parameterized queries | Prevent SQL injection across all DB operations | ✓ Verified |
| JWT + requireRole middleware | Consistent auth pattern across all write endpoints | ✓ Working |
| RBAC (Phase 84) | Replaced role ENUM with role-permission-user tables + wildcard + instance access | ✓ Validated in Phase 84 |
| DB Connection Auto-Recovery (Phase 99) | Auto-detect dead connections + reconnect on next query, restore health status | ✓ Validated in Phase 99 |
| IAgentEngine abstraction (Phase 108) | Platform code depends only on interface, not concrete Agent implementation | ✓ Validated in Phase 108 |
| DirectAdapter replaces Gateway (Phase 109-110) | Agent engine runs in-process via WebSocket, no external Gateway dependency | ✓ Validated in Phase 110 |
| AI Agent Cron (Phase 113) | Natural language driven cron tasks replace 13 hardcoded handlers | ✓ Validated in Phase 113 |
| OpenClaw fully removed (Phase 115-117) | All OpenClaw references, configs, runtime paths replaced with Slide branding | ✓ Validated in Phase 117 |
| Agent DB tools (Phase 118) | Agent can discover and connect to database instances via tools | ✓ Validated in Phase 118 |

## Constraints

- Database access is read-only (no DDL execution)
- No OS-level access (log collection via SQL queries only)
- LLM available for AI features (Anthropic/OpenAI/Ollama)

## Current Milestone: v1.4 Agent 解耦与替换 ✅ Complete

**Goal:** 将 OpenClaw Agent 框架替换为自研 @slide/agent-core，实现完全自主可控

**Shipped features (Phases 108-118):**
- Phase 108: IAgentEngine 抽象层 + DirectAdapter 基础
- Phase 109: Agent 引擎补全（Session/Context/Memory/Checkpoint/Subagent/Skills）
- Phase 110: DirectAdapter 默认切换 + 端到端验证
- Phase 111: Gateway 简化（删除失效 controller/view/slash command）
- Phase 112: 前端清理 + 定时任务可配置化
- Phase 113: AI Agent Cron（自然语言驱动定时任务）
- Phase 114: Verification 清账（12 项遗留验证）
- Phase 115-117: 去 OpenClaw 清理、运行时引用替换、收尾
- Phase 118: Agent DB 连接工具 + 告警机制完善

## Known Issues / Tech Debt

See `01-SECURITY.md` accepted risks:
- Instance-level authorization deferred (all users are trusted operators)
- PDF concurrency limiting deferred (low traffic internal tool)
- Alert rate limiting deferred to hardening phase
- GET /api/alerts missing JWT auth (documented, accepted)

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---

*Last updated: 2026-06-09 after Phase 118 completion — v1.4 milestone shipped*
