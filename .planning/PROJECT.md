# Slide — AI 驱动的数据库运维平台

**Shipped:** v1.2 (2026-05-20)
**Status:** v1.3 planning

## What This Is

Slide 是一个 AI 驱动的数据库运维管理平台，提供实时监控、告警通知、性能分析、SQL 审核和智能运维工具。通过 OpenClaw Agent 框架集成 LLM 能力，实现告警根因自动分析、故障诊断、慢查询优化建议等 AI 辅助运维。

## Core Value

**AI 原生的数据库运维** — Agent 自动采集数据、分析问题、给出建议，将 DBA 从重复性工作中释放。

## Architecture

- **Frontend** — Lit 3.3 + Vite (Web Components) + ECharts
- **Backend** — Fastify + TypeScript + MySQL + Elasticsearch + MongoDB + Redis
- **Gateway** — OpenClaw Agent Runtime (WebSocket + RPC)
- **AI** — Anthropic/OpenAI/Ollama via ai-agent-bridge

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

## Constraints

- Database access is read-only (no DDL execution)
- No OS-level access (log collection via SQL queries only)
- LLM available for AI features (Anthropic/OpenAI/Ollama)

## Current Milestone: v1.3 系统加固与体验优化

**Goal:** 解决告警泛滥、登录丢失等日常使用痛点，补齐报表功能和数据质量

**Target features:**
- 告警系统 — 阈值可编辑、AI 学习阈值、事件聚合去重、多会话聚合
- 认证权限 — 登录刷新不丢失、权限粒度控制
- 报表重构 — ov-card 移除、固定信息报表、报表/报告概念统一
- 数据质量 — 实例得分算法、CPU/内存采集权限
- UI 统一 — 图标风格一致化

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

*Last updated: 2026-05-27 after Phase 107 completion — dynamic instance detail metrics*
