---
phase: 92-ai-analysis-visibility
plan: 01
subsystem: "API / Backend (tools + skills)"
tags:
  - ai-analysis
  - markdown
  - skill-files
  - agent-tools
depends_on: []
provides:
  - "slide_complete_analysis tool accepting Markdown input"
  - "3 Agent skill files defining analysis workflows"
affects:
  - apps/db-ops-api/src/tools/generated/slide-self-mgmt/complete_analysis.ts
  - apps/db-ops-api/src/skills/generated/alert-rca/SKILL.md
  - apps/db-ops-api/src/skills/generated/fault-diagnosis/SKILL.md
  - apps/db-ops-api/src/skills/generated/topsql-analysis/SKILL.md
tech-stack:
  added: []
  patterns:
    - "AnyAgentTool interface for tool definition"
    - "SKILL.md YAML frontmatter + Markdown body pattern"
key-files:
  created:
    - apps/db-ops-api/src/skills/generated/alert-rca/SKILL.md
    - apps/db-ops-api/src/skills/generated/fault-diagnosis/SKILL.md
    - apps/db-ops-api/src/skills/generated/topsql-analysis/SKILL.md
  modified:
    - apps/db-ops-api/src/tools/generated/slide-self-mgmt/complete_analysis.ts
decisions: []
metrics:
  duration: ""
  completed_date: "2026-05-14"
---

# Phase 92 Plan 01: AI Analysis Markdown Output Summary

Rewrote `slide_complete_analysis` tool to accept Markdown format and created 3 Agent skill files defining analysis workflows for alerts, fault diagnosis, and TopSQL analysis.

## Tasks

### Task 1: Rewrite slide_complete_analysis tool to accept Markdown

- **Commit:** `949c0e1400b`
- **File:** `apps/db-ops-api/src/tools/generated/slide-self-mgmt/complete_analysis.ts`
- **Changes:**
  - Removed `summary`, `findings[]`, `recommendations[]` parameters
  - Added `markdown: string` parameter (alongside existing `analysisId: number`)
  - Both `analysisId` and `markdown` are required
  - Handler passes `markdown` string directly as `result` to `aiAnalysisDatabaseService.completeAnalysis()`
  - Return `{ success: true, data: { saved: true, analysisId }, summary: '分析结果已保存' }` on success
  - Return `{ success: false, error: '保存分析结果失败: ' + error.message }` on error
  - Preserved: export name `completeAnalysisTool`, tool name `slide_complete_analysis`, group `db_ops`, `toolCatalog.register()` call

### Task 2: Create 3 Agent skill files

- **Commit:** `083043145f5`
- **Files:**
  - `apps/db-ops-api/src/skills/generated/alert-rca/SKILL.md` (41 lines)
  - `apps/db-ops-api/src/skills/generated/fault-diagnosis/SKILL.md` (42 lines)
  - `apps/db-ops-api/src/skills/generated/topsql-analysis/SKILL.md` (46 lines)
- **Each includes:**
  - YAML frontmatter (`name`, `description`, `metadata.openclaw.emoji`)
  - `## Tool Flow` section listing db_* tools to call in order
  - `## Output Format` section with Chinese ## section headings for structured Markdown output
  - `## Completion` section calling `slide_complete_analysis` as the final save step

## Deviations from Plan

None -- plan executed exactly as written.

## Known Stubs

None -- all files are complete implementations.

## Threat Flags

None -- no new network endpoints, auth paths, or trust boundary changes introduced.

## Verification

- [x] complete_analysis.ts tool accepts { analysisId, markdown } parameters
- [x] 3 SKILL.md files exist with proper YAML frontmatter and section structure
- [x] Key links verified: completeAnalysis() + slide_complete_analysis references + toolCatalog.register()

## Self-Check

- [x] complete_analysis.ts file exists and is 44 lines (min 40 required)
- [x] 3 skill files exist: alert-rca/SKILL.md (41 lines), fault-diagnosis/SKILL.md (42 lines), topsql-analysis/SKILL.md (46 lines) (min 30 required)
- [x] No references to old summary/findings/recommendations parameters in complete_analysis.ts
- [x] All git commits verified: `949c0e1400b`, `083043145f5`
