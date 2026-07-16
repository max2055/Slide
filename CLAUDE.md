# CLAUDE.md

**Slide** - AI-Powered Database Operations Platform

## Architecture
- **Frontend** - Lit 3.3 + Vite (Web Components), port 5173
- **Backend** - Fastify + TypeScript, port 3000
- **Agent Engine** - @slide/agent-core (nanobot port), DirectAdapter WS on port 28888
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
