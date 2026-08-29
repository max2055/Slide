# AGENTS.md

**Slide** - AI-Powered Database Operations Platform

## Architecture
- **Frontend** - Lit 3.3 + Vite (Web Components), port 5173
- **Backend** - Fastify + TypeScript, port 3000
- **Agent Engine** - @slide/agent-core (原 nanobot 为 Python；项目组以 TypeScript 重写 Agent 核心), DirectAdapter WS on port 28888
- **Databases** - MySQL (primary) + Elasticsearch + MongoDB + Redis
- **Auth** - JWT
- **LLM** - Anthropic SDK / OpenAI SDK / Ollama

## Key Commands
```bash
# Start backend
cd apps/db-ops-api && npx tsx server.ts &

# Start frontend
cd frontend && npm run dev &

# Kill ports
lsof -ti:3000 | xargs kill -9 2>/dev/null
lsof -ti:5173 | xargs kill -9 2>/dev/null

# Health check
curl http://localhost:3000/api/health
```

## Credentials & URLs
- Admin: `admin` / `Tpam1234`
- Frontend: http://localhost:5173
- Backend: http://localhost:3000
- Agent WS: ws://127.0.0.1:28888/ws

## Configuration (apps/db-ops-api/.env)
```bash
DB_HOST=localhost; DB_PORT=3306; DB_USER=root; DB_PASSWORD=your_password; DB_NAME=db_ops_ai
ANTHROPIC_API_KEY=sk-ant-...; ANTHROPIC_MODEL=claude-sonnet-4-20250929
JWT_SECRET_KEY=your-secret-key-min-32-chars
```

## Working Principles
1. DirectAdapter 自管理 WS 传输，不依赖外部 Gateway
2. 完整开发 → 验证 → 修复循环，自动验证不等待确认
3. 遇到问题先排查根因再修复

## Goal 范围、委派与资源治理

### 1. 启动前冻结执行契约

- 实施前明确并记录：目标范围、排除项、验收清单、测试层级、资源预算和停止条件。
- 验收项必须能由具体命令、运行时行为或产物证明，不能只写“完成优化”等模糊描述。
- 后续范围调整必须形成显式版本记录；保留历史范围、决策原因和累计资源用量，不得通过改写 Goal 重置统计。

### 2. 控制范围扩张

- 新发现的工作只有在以下情况才能进入当前 Goal：直接阻塞既定验收、存在确认的数据损坏风险，或属于本次变更引入/触达的确认安全漏洞。
- 无关测试失败、通用架构优化、无关安全整改、文档补全和顺手重构默认进入 backlog，不得自动成为当前 Goal 的阻塞项。
- 扩展范围前先说明新增工作与既定验收的直接关系；无法证明关系时不实施。

### 3. 最小化代理委派

- 仅将边界清晰、可独立并行且能显著缩短关键路径的任务委派给子代理。
- 子代理只接收完成其任务所需的最小上下文、明确的文件所有权和可验证交付物；默认不传递完整对话历史。
- 默认最大代理深度为 `1`、并发数不超过 `4`、单个 Goal 累计子代理不超过 `8`。突破任一上限前必须记录必要性和预计收益。
- 子代理默认不得继续派生代理；同一问题不得交给多个代理重复实现或重复审查，除非明确要求独立交叉验证。

### 4. 分层运行测试

- 开发阶段只运行与当前改动直接相关的 focused checks。
- 阶段边界运行受影响模块的测试；形成最终集成候选后统一运行一次完整 gate。
- 完整 gate 通过后若代码未变化，不得重复运行；若发生变化，只重跑受影响门禁和最终必要回归。
- 测试失败时先确认其与当前改动及验收标准的关系，再决定修复、记录为既有问题或移入 backlog。

### 5. 统一资源统计口径

- 聚合追踪主线程及全部后代线程的 raw input、cached input、output、估算费用、代理总数、最大深度和并发峰值。
- `cached_input_tokens` 是 `input_tokens` 的子集，计算总吞吐时不得再次相加；总吞吐统一按 `input_tokens + output_tokens` 计算。
- 子线程必须记录开始执行自身任务时的累计基线，只统计基线后的单调增量；不得把继承的父线程历史计入子线程用量。
- 重复 token 快照按零增量处理；Goal 的范围调整、暂停、恢复和上下文压缩不得重置累计用量。
- Goal 账本值与模型实际吞吐量必须分开展示，不得用内部预算计数冒充实际 token 消耗。

### 6. 预算阈值动作

- 达到预算 `50%`：报告已用资源、剩余范围、主要风险和预计完工成本。
- 达到预算 `80%`：停止扩展范围和新增代理，重新评估方案并压缩到既定完成标准。
- 达到预算 `100%`：停止新增工作，保存可恢复检查点并执行最小安全收尾；只有获得明确追加预算后才能继续。
- 无人值守执行同样受上述阈值约束，不得以“持续执行直到完成”为由突破硬预算。

### 7. 允许机制演进

- 未来 Codex 原生能力可以替代当前流程或限制，但必须使用相同验收集证明成本更低，并且安全性、可追溯性和验收覆盖不下降。
- 新机制应先在有界任务上验证，再替换项目级默认规则。

## 前端共享组件规则

### 核心原则

**第一次出现**：可以用自定义样式实现。
**第二次出现**：必须提取为共享组件，或者检查是否已有共享组件可复用。

### 已有共享组件清单

新增 UI 时，**优先查此表**，避免手写同类样式：

| 元素类型 | 共享组件/样式 | 禁止做法 |
|---------|-------------|---------|
| Primary 按钮 | `class="btn-primary"` (shared-btn-styles.ts) | ❌ `class="btn primary"`, ❌ 内联 `background:var(--accent)` |
| 次要按钮 | `class="btn"` | ❌ 手写 `.my-btn` |
| Ghost 按钮 | `class="btn-ghost"` | |
| 卡片容器 | `<app-card>` | ❌ `.card` CSS 类, ❌ `<div class="card">` |
| 弹窗/对话框 | `<app-dialog>` | ❌ `.modal-overlay`, ❌ `.dialog` |
| 表单字段 | `<app-form-field>` | ❌ 手写 label+input 布局 |
| 数据表格 | `<app-data-table>` | ❌ 手写 `<table class="table">` |
| 空状态 | `<app-empty-state>` | ❌ `<div>暂无数据</div>` |
| 徽章/标签 | `<app-badge>` | ❌ `.badge`, `.tag`, `.status-badge` |
| Toast 通知 | `showToast()` (app-toast-container) | ❌ `alert()`, ❌ 手写 toast |
| 统计卡片 | `<stat-card>` | |
| 加载态 | `.skeleton` 类 | ❌ `<div>加载中...</div>` (表格场景) |

### 样式变量

- **主色调**：`var(--accent)` = `#409eff`（蓝色），不用紫色 `#7c5cff`
- **圆角**：`var(--radius-sm)` / `var(--radius-md)` / `var(--radius-lg)`（不用硬编码 px）
- **间距**：`var(--space-xs)` ~ `var(--space-xl)`（不用硬编码 px）
- **颜色**：`var(--text)` / `var(--text-strong)` / `var(--muted)` / `var(--border)`（不用 `#000`, `#ccc`）

### Lit 组件规范

- **共享组件**（app-card, app-dialog 等）：用 Shadow DOM + inline `<style>` 在 render 内
- **视图子组件**（instance-overview-tab 等）：如用 Light DOM (`createRenderRoot() { return this; }`)，样式必须用 inline `<style>` 在 render 开头注入，**不能用 `static styles`**（adoptedStyleSheets 不支持普通 HTMLElement）
- **Boolean 属性绑定**：必须用 `.property=${value}`（property binding），不用 `property=${value}`（attribute binding 会把 `"false"` 字符串转成 true）

### 代码审查要点

- 新视图是否使用了已有共享组件？
- 是否有重复的 CSS 模式应该提取为共享组件？
- 颜色是否使用了 token 而非硬编码？
- Boolean 属性是否用了 `.` 前缀？

## Karpathy 编码指南

### 1. 编码前思考
- 明确说明假设，不确定时询问而不是猜测
- 存在歧义时呈现多种解释，不默默选择
- 有更简单的方法时提出异议

### 2. 简洁优先
- 不添加要求之外的功能
- 不为一次性代码创建抽象
- 如果 200 行可以写成 50 行，重写它

### 3. 精准修改
- 只改必要的代码，不"改进"相邻的代码、注释或格式
- 不重构没坏的东西，匹配现有风格

### 4. 目标驱动执行
- 将指令式任务转化为可验证的目标
- 多步骤任务说明简短计划并逐项验证
