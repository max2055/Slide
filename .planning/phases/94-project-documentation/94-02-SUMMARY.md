---
phase: 94-project-documentation
plan: 02
subsystem: documentation
tags: [operations, user-guide, v1.2]
requires: [01]
provides: [OPERATIONS.md, USER-GUIDE.md]
affects: [docs/slide]
tech-stack:
  added: []
  patterns: [GFM tables, Mermaid flowcharts, markdownlint]
key-files:
  created:
    - docs/slide/OPERATIONS.md
    - docs/slide/USER-GUIDE.md
    - docs/slide/assets/screenshots/ai-analysis-config.txt
    - docs/slide/assets/screenshots/ai-settings-page.txt
    - docs/slide/assets/screenshots/ai-settings.txt
    - docs/slide/assets/screenshots/alert-analysis-result.txt
    - docs/slide/assets/screenshots/alert-detail.txt
    - docs/slide/assets/screenshots/alert-list.txt
    - docs/slide/assets/screenshots/alert-settings.txt
    - docs/slide/assets/screenshots/approval-list.txt
    - docs/slide/assets/screenshots/approval-review.txt
    - docs/slide/assets/screenshots/chat-agent-selector.txt
    - docs/slide/assets/screenshots/chat-interface.txt
    - docs/slide/assets/screenshots/dashboard-capacity-trend.txt
    - docs/slide/assets/screenshots/dashboard-overview.txt
    - docs/slide/assets/screenshots/index-analysis.txt
    - docs/slide/assets/screenshots/instance-add-form.txt
    - docs/slide/assets/screenshots/instance-detail.txt
    - docs/slide/assets/screenshots/instance-list.txt
    - docs/slide/assets/screenshots/instance-metrics.txt
    - docs/slide/assets/screenshots/rbac-config.txt
    - docs/slide/assets/screenshots/report-generate.txt
    - docs/slide/assets/screenshots/report-list.txt
    - docs/slide/assets/screenshots/role-management.txt
    - docs/slide/assets/screenshots/schema-changes.txt
    - docs/slide/assets/screenshots/sql-audit-panel.txt
    - docs/slide/assets/screenshots/sql-console.txt
    - docs/slide/assets/screenshots/sql-history.txt
    - docs/slide/assets/screenshots/user-management.txt
  modified: []
decisions:
  - "OPERATIONS.md organized by startup flow following server.ts sequence"
  - "USER-GUIDE.md oriented around user workflow: dashboard -> instance -> SQL -> alerts -> AI -> Chat -> reports -> approval -> RBAC -> AI settings"
  - "Screenshot placeholders use .txt files describing capture scenarios rather than .png placeholders"
metrics:
  duration: "~10 min"
  completed: "2026-05-17"
  ops_bytes: 15370
  guide_bytes: 17600
---

# Phase 94 Plan 02: Operations & User Guide Summary

**One-liner:** Wrote full-stack operations manual (OPERATIONS.md, 15KB) covering deployment, configuration, Gateway mechanism, and troubleshooting; wrote user manual (USER-GUIDE.md, 18KB) covering all 10+ v1.2 feature modules with step-by-step instructions, screenshot placeholders, and FAQ.

## Accomplishments

### Task 1: OPERATIONS.md — Full-Stack Operations Document (15,370 bytes)

- **System overview** with component/port table and Mermaid architecture diagrams for dev and production
- **Prerequisites** section with required (Node.js 20+, MySQL 8) and optional (Elasticsearch, Redis, MongoDB) dependencies
- **Configuration items** grouped and tables covering: database, Redis, Elasticsearch, MongoDB, LLM (Anthropic/OpenAI/Azure/Ollama), JWT, ports, AI toggle, logging
- **8-step startup procedure** from dependency checks to UI login, referencing specific server.ts line numbers
- **Gateway runtime** mechanism: WebSocket lifecycle (connect -> auth -> session -> message exchange -> disconnect), Agent config (Slide Database Assistant, model/temperature/system prompt), tool allowlist/denylist, session management (100 max messages, 1MB max bytes), environment variables
- **Backend component table**: monitor collector (30s), alert engine (60s), escalation (cron), auto-analysis triggers (10s)
- **Startup/shutdown commands table** covering all npm scripts
- **Health check** endpoint and logging configuration
- **Troubleshooting table** (9 common issues) and diagnostic commands
- **Maintenance strategy** section (D-15)

### Task 2: USER-GUIDE.md — User Manual (17,600 bytes)

- 12 sections organized by user workflow per D-09:
  1. Dashboard (stat cards, capacity trend)
  2. Instance management (CRUD, detail tabs with metrics/TopSQL/QAN/explain/slow queries/capacity/sessions)
  3. SQL console (CodeMirror editor, execution, AI audit, query history, approval workflow)
  4. Alert management (list, detail, RCA analysis, escalation, maintenance window, silence, events)
  5. AI analysis (RCA, TopSQL, fault diagnosis; auto/manual triggers; config management)
  6. Chat assistant (WebSocket-based AI agent with streaming responses, agent selector)
  7. Reports (health, performance, slow query, capacity; PDF/HTML/JSON/MD export)
  8. SQL approval (review, approve/reject, batch operations)
  9. RBAC (user management, role creation, permission binding)
  10. AI settings (global toggle, severity filter, instance whitelist, time window)
  11. Schema management and index analysis
  12. FAQ (8 Q&A entries)
- Each module: functional overview + step-by-step instructions + screenshot references + notes
- 27 screenshot placeholder .txt files with capture scenario descriptions

### Deviations from Plan

**None** — plan executed exactly as written. Minor markdown formatting corrections (table alignment, heading levels, blockquote spacing) applied during lint pass per normal document quality control.

### Self-Check: PASSED

- [x] OPERATIONS.md exists (15,370 bytes)
- [x] USER-GUIDE.md exists (17,600 bytes)
- [x] Modifications verified: OPERATIONS.md and USER-GUIDE.md both present
- [x] All commits exist: 2435afb (OPERATIONS.md), 4284f36 (USER-GUIDE.md + screenshots), 140bc2a (missing placeholder)
- [x] markdownlint passes for both documents (0 errors)
- [x] 27 screenshot placeholder .txt files exist in docs/slide/assets/screenshots/

### Known Stubs

None — both documents are complete with no placeholder code or "coming soon" sections. Screenshot placeholder .txt files are intentional (require human capture against a running dev environment) and are not stubs within the documentation itself.
