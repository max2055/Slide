# Phase 90: OpenClaw Upstream Merge - Context

**Gathered:** 2026-05-13
**Status:** Ready for planning

## Phase Boundary

将上游 OpenClaw (openclaw/openclaw main) 自 fork 点（2026-04-15）以来的更新合并到 slide-custom 分支。解决冲突，验证核心功能无回归。

## Key Facts

- Fork 点: `9b1b56aad1` (2026-04-15)
- 上游领先: ~17,435 commits
- 主要冲突类型: Slide 删除了 docs/、Dockerfile、docker-compose.yml（上游有修改）
- 代码冲突: .gitignore, CHANGELOG.md, package.json, pnpm-lock.yaml

## Locked Decisions

**D-01:** 使用 `git merge upstream/main` 合并，非 rebase
**D-02:** Slide 删除的文件（docs/、Dockerfile、docker-compose.yml）保持删除
**D-03:** package.json/pnpm-lock.yaml 以 Slide 为主，手动添加上游新增依赖
**D-04:** CHANGELOG.md 保留 Slide 的版本 + 追加上游条目
**D-05:** 合并后验证: gateway 启动 → WebSocket 连接 → chat.send → instance list API

## Strategy

1. 解决冲突：accept Slide deletions, merge code changes
2. 更新依赖：对比上游 package.json 新增依赖
3. 回归测试：启动 gateway + 后端，验证核心功能
