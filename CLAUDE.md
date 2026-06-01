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
