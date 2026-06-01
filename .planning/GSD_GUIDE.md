# GSD 工作流指南 - Slide 项目

## 开启新会话后的操作

### 1. 查看当前状态
```bash
# 查看项目状态和待办
cat .planning/STATE.md

# 查看路线图
cat .planning/ROADMAP.md
```

### 2. 继续开发流程

```
┌─────────────────────────────────────────────────────────────┐
│  严格 GSD 工作流                                             │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. /gsd-plan-phase [阶段号]                                 │
│     → 创建 PLAN.md（任务分解、依赖关系）                      │
│                                                              │
│  2. /gsd-execute-phase [阶段号]                              │
│     → 创建 worktree，执行任务，自动提交                       │
│                                                              │
│  3. /gsd-verify-phase [阶段号]                               │
│     → 验收标准验证，生成 VERIFICATION.md                      │
│                                                              │
│  4. /gsd-review                                              │
│     → 代码审查，生成 REVIEW.md                                │
│                                                              │
│  5. 合并回 main 分支，更新 STATE.md                           │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## 常用命令

| 命令 | 用途 |
|------|------|
| `/gsd-plan-phase 1.1` | 规划阶段 1.1 |
| `/gsd-execute-phase 1.1` | 执行阶段 1.1 |
| `/gsd-verify` | 验证当前阶段 |
| `/gsd-review` | 代码审查 |
| `/gsd-add-todo` | 添加待办 |
| `/gsd-note` | 记录笔记 |
| `/gsd-stats` | 查看统计 |

---

## Worktree 使用说明

启用 Git 隔离后，每个阶段在独立分支开发：

```bash
# 执行阶段时自动创建
.claude/worktrees/phase-1-1/
├── 独立的工作目录
└── git 分支：phase/1.1

# 完成后合并到 main
git checkout main
git merge phase/1.1
```

---

## 会话检查清单

### 开始会话
- [ ] 阅读 `.planning/STATE.md` 了解当前进度
- [ ] 确认当前阶段号
- [ ] 运行 `/gsd-plan-phase` 或 `/gsd-execute-phase`

### 结束会话
- [ ] 确保代码已提交
- [ ] 更新 `.planning/STATE.md` 的"已完成"部分
- [ ] 记录下次会话的起点

---

## 当前项目信息

| 配置项 | 值 |
|--------|-----|
| 工作区 | slide |
| 主模型 | kimi-k2.5 |
| Git 隔离 | 启用（基于 main 分支） |
| 规划目录 | .planning/ |
| 当前里程碑 | M1 - 数据库管理基础功能 |
| 下一阶段 | Phase 1.1 - 完善后端数据采集 |
