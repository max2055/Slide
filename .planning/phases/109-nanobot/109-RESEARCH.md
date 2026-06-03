# Phase 109: Agent Engine 补全 & DirectAdapter 接管 — Research

**Researched:** 2026-05-25
**Domain:** Agent engine completion, nanobot-to-TypeScript port, Gateway dependency removal, frontend WebSocket adaptation
**Confidence:** HIGH

## Summary

Phase 109 completes `@slide/agent-core` by porting 7 missing subsystems from nanobot Python to TypeScript, then wires DirectAdapter to use the completed engine independently (no OpenClaw Gateway dependency). Finally removes Gateway protocol and adapts frontend.

The implementation dependency order is strict: timeout layering (no deps) -> Session management + SkillsLoader + MemoryStore (independent) -> ContextBuilder (depends on Memory + Skills) -> Checkpoint recovery (depends on Session + Runner) -> Subagent integration (code already exists) -> Gateway removal + frontend.

**Primary recommendation:** Execute in 3 waves following dependency order. Wave 1: timeout layering + Session management (agent-core port). Wave 2: ContextBuilder + Skills + Memory + Checkpoint (engine completion). Wave 3: Subagent integration + Gateway removal + frontend adaptation.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Global principles:**
- D-01: nanobot 和 OpenClaw 都有的功能和机制，采用 nanobot 的实现（移植到 TypeScript）
- D-02: OpenClaw 独有的机制（Gateway 协议），本阶段移除，前端同步适配
- D-03: 已有但未接入的 Slide 代码（subagent, session-manager, ContextManager）优先复用而非重写
- D-04: 从 nanobot Python 源码移植，保持架构和命名一致。移植后用 TypeScript 惯用写法

**Timeout layering:**
- D-05: 移植 nanobot 的两层超时：LLM 请求超时（NANOBOT_LLM_TIMEOUT_S，默认 300s）+ 流式空闲超时（NANOBOT_STREAM_IDLE_TIMEOUT_S）
- D-06: 超时后返回 error_kind="timeout" 的错误响应，不抛异常

**Session management:**
- D-07: 移植 nanobot 的 Session 模型（nanobot/session/manager.py）到 agent-core
- D-08: MySQL chatDatabaseService 保留不动（互补关系）
- D-09: JSONL session-manager.ts 和 ContextManager 已存在，评估后复用或替换为 nanobot 移植版

**Context building:**
- D-10: 移植 nanobot 的 ContextBuilder（nanobot/agent/context.py）到 agent-core
- D-11: 保留 SOUL.md, AGENTS.md, HEARTBEAT.md 作为 context 源文件
- D-12: DirectAdapter 的 DEFAULT_SYSTEM_PROMPT 硬编码替换为 ContextBuilder

**Skills:**
- D-13: 采用 nanobot 的 SkillsLoader 模式（扫描 skills/ + builtin, 解析 frontmatter, 过滤, 注入）
- D-14: .agents/skills/ 中 33 个现有 skill 全部保留作为 workspace skills

**Memory:**
- D-15: 采用 nanobot 的简化版 Memory（MemoryStore + Consolidator），不做 OpenClaw QMD 复杂管道
- D-16: MEMORY.md 文件保留作为长期记忆载体

**Checkpoint:**
- D-17: 移植 nanobot 的 checkpoint 恢复机制（_set_runtime_checkpoint / _restore_runtime_checkpoint），改为双向

**Subagent:**
- D-18: Slide 已有完整 subagent 基础设施，只做集成接入
- D-19: spawn_subagent 和 access_subagent 工具注册到 agent-core 的 ToolRegistry

**Gateway removal & frontend:**
- D-20: 移除 OpenClaw Gateway 协议依赖，DirectAdapter WS 直接服务前端
- D-21: 前端清理 frontend/src/openclaw/ 依赖
- D-22: 前端 WS 消息协议简化为 DirectAdapter 原生格式

**Tool registration:**
- D-23: 采用 nanobot 的 pkgutil/entry-point 模式模拟（文件自注册，loader 动态 import）
- D-24: Slide 数据库工具保持 TS 实现，接入 agent-core ToolRegistry

### Claude's Discretion
- None explicitly noted in 109-CONTEXT.md

### Deferred Ideas (OUT OF SCOPE)
- OpenClaw QMD dreaming/ingestion 复杂管道 — 不需要，nanobot 简化版够用
- 多租户 session 隔离 — 当前单用户场景不需要
- Plugin marketplace / remote skill installation — 不在本阶段范围
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| MIG-02 | Port nanobot Session management, ContextBuilder, SkillsLoader, Memory, Checkpoint to agent-core TypeScript | 7 nanobot subsystems analyzed with exact line counts and dependency order. Session manager JSONL format compatible. ContextBuilder assembles system prompts from SOUL/AGENTS/HEARTBEAT files. |
| MIG-03 | Complete DirectAdapter as standalone agent engine with all 7 subsystems integrated | DirectAdapter already has AgentRunner, ToolRegistry, LLMProvider, WS transport. Needs ContextBuilder replacing DEFAULT_SYSTEM_PROMPT, session model replacing in-memory Map, checkpoint wiring. |
| MIG-04 | Remove Gateway protocol dependency from DirectAdapter | DirectAdapter WS transport already uses minimal protocol (chat.send/chat.history). Gateway protocol file structure documented for safe removal. |
| MIG-05 | Adapt frontend Chat to use new DirectAdapter WS protocol, clean openclaw dependency | Frontend openclaw directory has ~75 files. Main dependency is openclaw/ui/app.js entry and openclaw/ui/gateway.ts WS client. Protocol schema identified for simplification. |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Session management | API (agent-core package) | JSONL filesystem | Session is agent-engine-internal state (in-memory + JSONL). MySQL chatDatabaseService is complementary (platform persistence). agent-core owns session model and CRUD. |
| Context building | API (agent-core package) | Filesystem (SOUL/MD files) | ContextBuilder reads SOUL.md, AGENTS.md, HEARTBEAT.md from filesystem, assembles system prompt dynamically. This replaces the hardcoded DEFAULT_SYSTEM_PROMPT in DirectAdapter. |
| Skills loading | API (agent-core package) | Filesystem (skills/ dirs) | SkillsLoader scans .agents/skills/ and any builtin skills directories, parses SKILL.md frontmatter. |
| Memory | API (agent-core package) | Filesystem (MEMORY.md, history.jsonl) | MemoryStore reads/writes MEMORY.md and history.jsonl. No database dependency. |
| Checkpoint recovery | API (agent-core package) | Session metadata | Checkpoint state stored in Session.metadata (in-memory + JSONL persisted). AgentRunner checkpointCallback becomes bidirectional. |
| Subagent | API (db-ops-api) | agent-core ToolRegistry | Subagent infrastructure (registry, capabilities, spawn tool) already exists in db-ops-api/src/agents/. Only needs tool registration into agent-core. |
| WebSocket transport | API (DirectAdapter) | Browser/Client | DirectAdapter.start() already has minimal WS server. Frontend connects directly. No Gateway protocol layer. |
| Chat history persistence | API (db-ops-api) | MySQL (chatDatabaseService) | MySQL stores conversation history for frontend queries. Complementary to agent-core session. |
| Frontend Chat rendering | Browser/Client | WebSocket | Frontend Lit components display chat streaming events. Needs adaptation from Gateway protocol to DirectAdapter native format. |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@slide/agent-core` | 0.1.0 (workspace) | LLM-tool execution loop, ToolRegistry, types | Already built (1523 lines TS, compiles cleanly). Target for 7 nanobot subsystem ports. |
| `DirectAdapter` | existing (adapter/direct-adapter.ts) | IAgentEngine implementation wrapping AgentRunner | Already implements chat(), invoke(), listTools(), capabilities(), start(). Needs subsystem integration. |

### Supporting
| Module | Version | Purpose | When to Use |
|--------|---------|---------|-------------|
| nanobot `agent/context.py` | reference (PY) | ContextBuilder pattern | Port to agent-core/src/context.ts |
| nanobot `session/manager.py` | reference (PY) | Session + SessionManager pattern | Port to agent-core/src/session.ts |
| nanobot `agent/skills.py` | reference (PY) | SkillsLoader pattern | Port to agent-core/src/skills.ts |
| nanobot `agent/memory.py` | reference (PY) | MemoryStore + Consolidator pattern | Port MemoryStore + simplified Consolidator to agent-core/src/memory.ts |
| nanobot `agent/runner.py` | reference (PY) | Timeout layering + checkpoint patterns | Port timeout logic to agent-core/src/runner.ts |
| nanobot `agent/loop.py` | reference (PY) | Checkpoint restore pattern | Port checkpoint restore to agent-core |
| nanobot `agent/subagent.py` | reference (PY) | SubagentManager pattern | Reference only — Slide has its own implementation |
| nanobot `agent/tools/loader.py` | reference (PY) | Auto-discovery pattern | Adapt to TypeScript dynamic import() |

### Existing Slide Code to Reuse
| Module | Lines | Purpose | How It's Used |
|--------|-------|---------|---------------|
| `apps/db-ops-api/src/sessions/session-manager.ts` | 463 | JSONL session storage | Evaluate vs nanobot port — different API surface |
| `apps/db-ops-api/src/sessions/context-manager.ts` | 252 | Token estimation + context truncation | Only token estimation may be merged. Builder logic comes from nanobot. |
| `apps/db-ops-api/src/skills/loader.ts` | 449 | Skill directory scanning + frontmatter parsing | Already parses SKILL.md. Integrate with agent-core SkillsLoader. |
| `apps/db-ops-api/src/agents/subagent-spawn-tool.ts` | 272 | spawn_subagent + access_subagent tool defs | Register into ToolRegistry directly |
| `apps/db-ops-api/src/agents/subagent-registry.ts` | 302 | Subagent run tracking | Keep as-is, register tools |
| `apps/db-ops-api/src/agents/subagent-capabilities.ts` | 251 | Subagent role/control resolution | Keep as-is |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| nanobot Session model port | Reuse existing session-manager.ts | session-manager.ts has different API (parentId DAG, EventEmitter). Using nanobot model aligns with CONTEXT.md D-07. |
| nanobot ContextBuilder port | Extend existing context-manager.ts | context-manager.ts only does token truncation, not system prompt assembly. New ContextBuilder needed per D-10. |
| nanobot MemoryStore port | OpenClaw QMD pipeline | Per D-15, explicitly deferring QMD. nanobot MemoryStore is simpler. |

**Version verification:**
```bash
# agent-core compiles cleanly
cd /Users/max/Coding/39-Slide && npx tsc --noEmit --project packages/agent-core/tsconfig.json
```

## Package Legitimacy Audit

> All packages are workspace-internal or existing. slopcheck not applicable — no new registry packages introduced in this phase.

| Package | Registry | slopcheck | Disposition | Notes |
|---------|----------|-----------|-------------|-------|
| `@slide/agent-core` | npm (workspace) | N/A — workspace package | Approved | Custom in-house package, already in monorepo |
| `ws` | npm | N/A — existing dep | Approved | Already in package.json |

**Packages removed due to slopcheck:** none
**Packages flagged as suspicious:** none

## Architecture Patterns

### System Architecture Diagram

```
Wave 1 ─────────────────────────────────────
agent-core (packages/agent-core/src/)
├── runner.ts      ← ADD timeout layering (NANOBOT_LLM_TIMEOUT_S, stream idle timeout)
├── types.ts       ← ADD Session types
├── session.ts     ← NEW: nanobot Session + SessionManager port
│                    (JSONL persistence, in-memory cache, get_history with token budgets)
├── index.ts       ← EXPORT new types

Wave 2 ─────────────────────────────────────
agent-core/src/
├── context.ts     ← NEW: nanobot ContextBuilder port
│   ├── build_system_prompt()  ← SOUL.md + AGENTS.md + HEARTBEAT.md + memory + skills
│   ├── build_messages()       ← history + current_message + runtime context
│   └── replaces DirectAdapter DEFAULT_SYSTEM_PROMPT
├── skills.ts      ← NEW: nanobot SkillsLoader port
│   ├── list_skills()          ← scan skills/ dirs + SKILL.md frontmatter
│   ├── load_skills_for_context()
│   └── get_always_skills()
├── memory.ts      ← NEW: nanobot MemoryStore + simplified Consolidator port
│   ├── MemoryStore            ← MEMORY.md + history.jsonl CRUD
│   └── Consolidator           ← LLM-based old-message summarization
├── runner.ts      ← UPDATE: bidirectional checkpoint (restore from session metadata)

Wave 3 ─────────────────────────────────────
agent-core/src/
├── runner.ts      ← UPDATE: spawn_subagent/access_subagent tool registration path
├── index.ts       ← EXPORT ContextBuilder, SkillsLoader, MemoryStore, Consolidator

DirectAdapter (apps/db-ops-api/src/adapter/direct-adapter.ts)
├── constructor    ← ADD ContextBuilder, SkillsLoader, MemoryStore wiring
├── chat()         ← REPLACE in-memory Map with SessionManager get_or_create()
├── chat()         ← REPLACE hardcoded DEFAULT_SYSTEM_PROMPT with ContextBuilder
├── chat()         ← ADD checkpoint restore at turn start (bidirectional)
└── chat()         ← ADD timeout parameters to AgentRunSpec

Frontend (frontend/src/)
├── REMOVE: openclaw/protocol/ directory (~15 schema files)
├── REMOVE: openclaw/ui/gateway.ts (Gateway protocol client)
├── UPDATE: openclaw/ui/app.js import → remove Gateway protocol
├── REPLACE: DirectAdapter WS native protocol (chat.send + ChatEvent types)
└── KEEP: openclaw/ui/chat/ (rendering components — only transport changes)
```

### Data Flow (After Phase 109)

```
Frontend (Lit 3.3)                        External LLMs (Anthropic/OpenAI/Ollama)
     |                                         |
     | WS: {"type":"chat.send",                |
     |  "sessionKey":"...","message":"..."}     |
     v                                         |
+--------------------------------------------------+
| DirectAdapter (WS transport on port 28789)       |
|                                                    |
|  WS message -> chat() -> SessionManager           |
|    -> ContextBuilder.build_messages()              |
|    -> AgentRunner.run({llmTimeoutS, ...})          |
|    -> SkillsLoader -> memory context -> tools      |
|    -> checkpoint callback (bidirectional)          |
|    -> ChatEvent stream -> WS -> Frontend          |
|                                                    |
| Session metadata (JSONL)   MEMORY.md .agents/     |
| ~/.slide/sessions/*.jsonl      skills/ dirs       |
+--------------------------------------------------+

Platform code (server.ts, chat-handler.ts):
  agent = getAgentEngine()    ← unchanged from Phase 108
  agent.chat(sessionKey, msg, onEvent)  ← same interface
  agent.invoke(sessionKey, msg)          ← same interface
```

### Recommended Project Structure (agent-core additions)
```
packages/agent-core/src/
├── index.ts          # UPDATE: export new modules
├── types.ts          # UPDATE: add Session, SessionManager types
├── runner.ts         # UPDATE: timeout layering + checkpoint restore
├── tool-registry.ts  # (unchanged)
├── session.ts        # NEW: Session + SessionManager (nanobot port)
├── context.ts        # NEW: ContextBuilder (nanobot port)
├── skills.ts         # NEW: SkillsLoader (nanobot port)
└── memory.ts         # NEW: MemoryStore + Consolidator (nanobot port)
```

### Pattern 1: nanobot Session port
**What:** Port `nanobot/session/manager.py` Session dataclass + SessionManager to TypeScript. Session stores conversation messages, metadata, checkpoint state in session.metadata. SessionManager manages JSONL file persistence + in-memory LRU cache.

**When to use:** Always. DirectAdapter's current `Map<string, Message[]>` replaces with `get_or_create(sessionKey)`.

**Key differences from Slide's existing session-manager.ts:**
- nanobot Session is simpler: no parentId DAG, no EventEmitter, no compaction entries
- nanobot SessionManager uses `safe_key()` for filename mapping
- nanobot Session has `metadata: dict` for checkpoint, goal_state, last_summary
- nanobot Session.get_history() has token-budget slicing

### Pattern 2: nanobot ContextBuilder port
**What:** Port `nanobot/agent/context.py` (250 lines). ContextBuilder assembles the system prompt from: identity section (role, workspace, runtime), bootstrap files (SOUL/AGENTS/HEARTBEAT), memory context (MEMORY.md), active skills (always-injected), skills summary, recent history, and session summary. Runtime context (time, channel, goal state) appended after user message.

**When to use:** In DirectAdapter's `chat()`, replace `{ role: 'system', content: this.systemPrompt }` with `contextBuilder.build_messages(history, message, ...)`.

**Note:** nanobot uses `AGENTS.md`, `SOUL.md`, `USER.md`. Slide uses `SOUL.md`, `AGENTS.md`, `HEARTBEAT.md`. Adjust bootstrap file list accordingly (D-11).

### Pattern 3: nanobot SkillsLoader port
**What:** Port `nanobot/agent/skills.py` (243 lines). Scan `skills/` directories (workspace + builtin) for SKILL.md files, parse YAML frontmatter, filter unavailable skills (requires.bins, requires.env), build context injection content.

**When to use:** At DirectAdapter construction, load skills into ContextBuilder for system prompt assembly.

**Note:** Slide already has `skills/loader.ts` (449 lines) with frontmatter parsing. Evaluate whether to integrate existing Slide loader into agent-core SkillsLoader, or rewrite based on nanobot pattern. The nanobot version is simpler (no tools.ts file loading, no command dispatch specs) but Slide version has more features. Per D-13, use nanobot pattern.

### Anti-Patterns to Avoid
- **Porting nanobot Dream system:** Dream (lines 860-1162 of memory.py) is a heavyweight cron-scheduled memory consolidation pipeline. D-15 explicitly defers it. Only port MemoryStore + simplified Consolidator.
- **Porting nanobot loop.py TurnState machine:** loop.py (1598 lines) is the full AgentLoop with state machine (RESTORE->COMPACT->COMMAND->BUILD->RUN->SAVE->RESPOND->DONE). agent-core already has AgentRunner which is the execution core. Do NOT port the full loop — only port the checkpoint restore functions (lines 1473-1552).
- **Porting nanobot tool types:** nanobot tools are Python classes with `enabled()`, `create()`, `execute()` methods. agent-core already has `Tool` interface. Do not port tool implementations — only port the loader pattern.
- **Duplicating session manager:** Evaluate Slide's session-manager.ts vs nanobot port. If their JSONL format and key features are redundant, keep only one.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| System prompt assembly | Custom if/else string concatenation | ContextBuilder (context.py port) | 250 lines of tested logic: bootstrap file loading, memory injection, skills injection, runtime context, session summary merge. Many edge cases (missing files, empty memory, no active skills). |
| Session history with token budgets | Custom message slicing | Session.get_history(max_messages, max_tokens) | Handles: user-turn alignment, orphan tool result cleanup, assistant replay sanitization, image breadcrumb synthesis, CLI/MCP attachment markers. |
| Skill requirement checking | Hardcoded skill enable/disable | SkillsLoader._check_requirements() | Scans YAML frontmatter `requires.bins` and `requires.env` automatically. Already handles shutil.which for CLI tools, os.environ for env vars. |
| Checkpoint recovery | Manual turn state tracking | nanobot _set_runtime_checkpoint / _restore_runtime_checkpoint | Handles overlap detection (dedup already-restored messages), pending tool call backfill with "[Task interrupted]" error messages, timestamp alignment. |
| Tool auto-discovery | Manually listing all tool imports | Dynamic `import()` scanning | nanobot uses pkgutil. TS can scan directory listing + dynamic import(). Adding a new tool = creating a new file, no registration step. |

**Key insight:** The most dangerous subsystem to get wrong is checkpoint recovery. If an in-flight turn crashes (server restart, network error), the checkpoint restore must produce exactly the right messages — one missing tool result means the LLM sees partial context and produces wrong output. nanobot's dedup logic (`_checkpoint_message_key` overlap detection) took multiple iterations to stabilize.

## Runtime State Inventory

> Phase 109 is a rename/refactor/migration phase involving Gateway protocol removal.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | MySQL `chat_messages` table — references sessionKeys, no old Gateway protocol data | No data migration. Session keys unchanged. |
| Live service config | DirectAdapter WS port is 28789 (same as Gateway). `.env` may have `AGENT_WS_PORT`. | AGENT_WS_PORT env var stays. DirectAdapter.start() already reads it. |
| OS-registered state | None — no OS-level registrations contain "gateway" or "openclaw" beyond env vars | None |
| Secrets/env vars | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc. in `.env` | No key rename needed. |
| Build artifacts | No build artifacts referencing old names. `packages/agent-core/` compiled separately. | Run rebuild after code changes. |

**Nothing found in category:** No stored data, OS registrations, or secrets reference Gateway protocol names that would break after removal.

## Common Pitfalls

### Pitfall 1: Session Model Incompatibility
**What goes wrong:** DirectAdapter's current `Map<string, Message[]>` session store is replaced with nanobot Session + SessionManager, but existing code elsewhere (chat-handler.ts, frontend) expects the old in-memory format.
**Why it happens:** DirectAdapter.chat() currently stores `Message[]` arrays keyed by sessionKey. Replacing with nanobot Session (which stores `dict[]` messages with `timestamp`, `metadata`) changes the internal representation.
**How to avoid:** SessionManager.get_history() should return the same `Message[]` format agent-core expects. The Session is internal — external callers see the same IAgentEngine interface. Keep compatibility layer in DirectAdapter.
**Warning signs:** Chat messages appear but timestamps or metadata fields are missing.

### Pitfall 2: ContextBuilder Breaking Existing Sessions
**What goes wrong:** Replacing `DEFAULT_SYSTEM_PROMPT` hardcoded string with ContextBuilder.build_system_prompt() changes the system instruction — existing sessions get a different persona mid-conversation.
**Why it happens:** The hardcoded prompt says "database operations assistant" but ContextBuilder reads SOUL.md which may have different identity text. If SOUL.md is not found, ContextBuilder produces a generic prompt.
**How to avoid:** Verify SOUL.md exists and has appropriate content before cutover. For existing sessions, keep the original system prompt (store in session.metadata on creation). New sessions use ContextBuilder.
**Warning signs:** Assistant behavior changes mid-conversation after update.

### Pitfall 3: SkillsLoader Not Finding Skills
**What goes wrong:** agent-core SkillsLoader scans for skills but doesn't find `.agents/skills/` directory (wrong relative path from `packages/agent-core/`).
**Why it happens:** agent-core is in `packages/agent-core/` — it can't use relative paths to reach the monorepo root's `.agents/skills/`. Unlike nanobot which runs from workspace root, agent-core needs workspace path injection.
**How to avoid:** Pass `workspace: string` to SkillsLoader constructor (and ContextBuilder, MemoryStore). DirectAdapter knows the workspace root and injects it. This is similar to existing pattern where DirectAdapter passes paths.
**Warning signs:** SkillsLoader.list_skills() returns empty array; no skill context in system prompt.

### Pitfall 4: Checkpoint Restore Overlap Mismatch
**What goes wrong:** On server restart, checkpoint restore inserts duplicate messages because the overlap detection doesn't match the existing session history format.
**Why it happens:** `_checkpoint_message_key()` compares message fields (role, content, tool_call_id, etc.) to find overlap between existing session.messages and restored checkpoint messages. If any field format differs (e.g., content is string vs null), overlap is zero and all messages are duplicated.
**How to avoid:** Use the exact same message format in Session.add_message() as what the checkpoint produces. Test with actual crash-recovery scenarios.
**Warning signs:** After server restart, chat history shows repeated messages.

### Pitfall 5: Frontend Gateway Protocol Removal Breaking Legacy Features
**What goes wrong:** Removing `openclaw/ui/gateway.ts` and protocol schema files breaks features that depend on the Gateway's richer protocol (device auth, heartbeat, state sync).
**Why it happens:** The Gateway protocol handles more than just chat — it manages connection auth, device pairing, server state synchronization, push events. DirectAdapter's minimal WS only handles `chat.send` and `chat.history`.
**How to avoid:** Audit frontend code to find all imports from `openclaw/protocol/` and `openclaw/ui/gateway.ts`. If any non-chat features depend on them, stub those imports before deleting files. Focus Phase 109 on the chat path — defer non-chat Gateway cleanup to Phase 111 (as stated in 108-CONTEXT.md).
**Warning signs:** Frontend fails to load with import errors after openclaw/ cleanup.

### Pitfall 6: Timeout Regressions in Streaming
**What goes wrong:** Adding `llmTimeoutS` to AgentRunner breaks long-running streaming responses (e.g., Claude extended thinking, Ollama slow models).
**Why it happens:** The nanobot runner explicitly skips wall-clock timeout for streaming requests (`outer_timeout_s = None if wants_streaming else timeout_s`). If this distinction is not replicated, streaming will be killed mid-response.
**How to avoid:** Follow the exact pattern: timeout only applies to non-streaming `provider.chat()`, not to `provider.chatStream()`. Streaming has its own idle timeout (`NANOBOT_STREAM_IDLE_TIMEOUT_S`).
**Warning signs:** Long streaming responses are cut off with timeout errors while streaming is still active.

## Code Examples

### nanobot Session port to TypeScript (pattern)

```typescript
// Source: nanobot/session/manager.py Session dataclass + get_history()
// Port to: packages/agent-core/src/session.ts

export interface SessionEntry {
  role: string;
  content: string | null;
  timestamp?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  reasoning_content?: string | null;
  thinking_blocks?: unknown[];
  [key: string]: unknown;
}

export interface SessionMetadata {
  [key: string]: unknown;
  _last_summary?: { text: string; last_active: string };
  runtime_checkpoint?: Record<string, unknown>;
}

export class Session {
  constructor(
    public readonly key: string,
    public messages: SessionEntry[] = [],
    public created_at: Date = new Date(),
    public updated_at: Date = new Date(),
    public metadata: SessionMetadata = {},
    public last_consolidated: number = 0,
  ) {}

  addMessage(role: string, content: string, extra?: Record<string, unknown>): void {
    this.messages.push({
      role,
      content,
      timestamp: new Date().toISOString(),
      ...extra,
    });
    this.updated_at = new Date();
  }

  getHistory(maxMessages = 120, maxTokens = 0): SessionEntry[] {
    const unconsolidated = this.messages.slice(this.last_consolidated);
    const sliced = unconsolidated.slice(-maxMessages);
    // Pad to align with first user turn
    const firstUser = sliced.findIndex(m => m.role === 'user');
    if (firstUser > 0) sliced.splice(0, firstUser);
    // Drop orphan tool results at front
    const start = sliced.findIndex(m => m.role !== 'tool');
    if (start > 0) sliced.splice(0, start);
    // Token budget truncation
    if (maxTokens > 0 && sliced.length > 0) {
      let total = 0;
      for (let i = sliced.length - 1; i >= 0; i--) {
        total += estimateMessageTokens(sliced[i]);
        if (total > maxTokens) { sliced.splice(0, i + 1); break; }
      }
    }
    return sliced;
  }
}
```

### ContextBuilder port skeleton

```typescript
// Source: nanobot/agent/context.py (250 lines)
// Port to: packages/agent-core/src/context.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from './memory.js';
import { SkillsLoader } from './skills.js';

export class ContextBuilder {
  private static BOOTSTRAP_FILES = ['AGENTS.md', 'SOUL.md', 'HEARTBEAT.md'];

  constructor(
    private workspace: string,
    private timezone?: string,
  ) {
    this.memory = new MemoryStore(workspace);
    this.skills = new SkillsLoader(workspace);
  }

  buildSystemPrompt(skillNames?: string[], sessionSummary?: string): string {
    const parts: string[] = [this.getIdentitySection()];
    const bootstrap = this.loadBootstrapFiles();
    if (bootstrap) parts.push(bootstrap);
    // ... memory context, skills, etc.
    return parts.join('\n\n---\n\n');
  }

  buildMessages(
    history: SessionEntry[],
    currentMessage: string,
    skillNames?: string[],
  ): Message[] {
    const systemPrompt = this.buildSystemPrompt(skillNames);
    const runtimeContext = this.buildRuntimeContext();
    const mergedContent = currentMessage + '\n\n' + runtimeContext;
    return [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: mergedContent },
    ];
  }

  // ... helper methods
}
```

### Timeout layering — the exact pattern to add to AgentRunner.requestModel()

```typescript
// Source: nanobot/agent/runner.py lines 610-739
// Pattern to add to agent-core/src/runner.ts

private async requestModel(
  spec: AgentRunSpec,
  messages: Message[],
  hook: AgentHook,
  context: AgentHookContext,
): Promise<LLMResponse> {
  // Determine timeout
  let timeoutS = spec.llmTimeoutS;
  if (timeoutS === undefined) {
    const raw = process.env['NANOBOT_LLM_TIMEOUT_S'] || '300';
    timeoutS = parseFloat(raw) || 300;
  }
  if (timeoutS <= 0) timeoutS = undefined;

  const wantsStreaming = hook.wantsStreaming();

  // KEY: streaming requests SHARE the streaming timeout, NOT the wall-clock timeout
  // Only apply asyncio.wait_for wrapper for non-streaming requests
  const outerTimeoutS = wantsStreaming ? undefined : timeoutS;

  try {
    const response = wantsStreaming
      ? await this.provider.chatStream(/* ... */)
      : await this.provider.chat(/* ... */);
    return response;
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      return {
        content: `Error calling LLM: timed out after ${outerTimeoutS ?? timeoutS}s`,
        finishReason: 'error',
        errorKind: 'timeout',
        toolCalls: [],
        usage: {},
        shouldExecuteTools: false,
        hasToolCalls: false,
      } as LLMResponse;
    }
    throw err;
  }
}
```

### Checkpoint restore — bidirectional wiring

```typescript
// Source: nanobot/agent/loop.py lines 1473-1552
// ADD to packs/agent-core/src/runner.ts — _set_runtime_checkpoint already called via checkpointCallback
// ADD restore logic to DirectAdapter.chat() before AgentRunner.run()

// In DirectAdapter.chat() or new SessionAwareRunner:

// 1. Before running, restore from session metadata:
if (session.metadata.runtimeCheckpoint) {
  const restored = restoreCheckpoint(session);
  // restored messages are now in session.messages
  delete session.metadata.runtimeCheckpoint;
}

// 2. Checkpoint callback persists to session metadata:
const checkpointCallback = async (payload: Record<string, unknown>) => {
  session.metadata.runtimeCheckpoint = payload;
  sessionManager.save(session);
};

// 3. After successful run, clear checkpoint:
delete session.metadata.runtimeCheckpoint;
sessionManager.save(session);
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| DirectAdapter hardcoded DEFAULT_SYSTEM_PROMPT | ContextBuilder dynamic assembly from SOUL.md + memory + skills | Phase 109 | System prompt adapts to project context automatically. Skills/memory changes reflect without code edits. |
| DirectAdapter in-memory Map for sessions | SessionManager with JSONL persistence + session metadata | Phase 109 | Session state survives server restarts. Checkpoint stored in metadata survives crashes. |
| AgentRunner timeout: none | AgentRunner timeout: NANOBOT_LLM_TIMEOUT_S + stream idle timeout | Phase 109 | Stuck LLM calls cleanly timeout. Streaming not affected by wall-clock limit. |
| AgentRunner checkpoint: one-way (send only) | AgentRunner checkpoint: bidirectional (send + restore) | Phase 109 | In-flight turn survives server restart. Network failure recovery works. |
| Frontend connects via Gateway protocol | Frontend connects via DirectAdapter native WS | Phase 109 | No Gateway dependency in DirectAdapter path. Protocol simplified to chat.send/ChatEvent. |

**Deprecated/outdated:**
- Gateway protocol schema files in `frontend/src/openclaw/protocol/` (~15 schema files) — replaced by DirectAdapter native WS protocol
- `frontend/src/openclaw/ui/gateway.ts` — Gateway WS client, replaced by simple WS connection
- OpenClaw QMD memory system — deferred by D-15
- nanobot AgentLoop full state machine — agent-core AgentRunner is sufficient

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Slide's existing session-manager.ts (JSONL format) can be replaced by nanobot SessionManager port | Session | If existing code depends on parentId DAG or EventEmitter, the replacement breaks it. Verify all callers. |
| A2 | Slide's existing context-manager.ts token estimation functions are only used by caller that will use ContextBuilder | Context | If other code imports `estimateTokens()` or `estimateMessageTokens()` from context-manager.ts, removing it breaks those imports. |
| A3 | All frontend openclaw/ protocol schema files are only used for Gateway protocol | Frontend | Some schema files (agent.ts, config.ts) may be used by non-Gateway features. Verify imports before deleting. |
| A4 | Slide's skills/loader.ts frontmatter parsing can be integrated into agent-core SkillsLoader | Skills | If the Slide loader has significant differences from nanobot (different frontmatter fields, different tool loading), integration may be complex. |
| A5 | Subagent tools (spawn_subagent, access_subagent) can be registered into agent-core ToolRegistry by importing from their current locations | Subagent | If subagent code imports from `../../gateway/` or similar, the import path must be adapted. |

## Open Questions

1. **How to handle nanobot Session port vs existing Slide session-manager.ts?**
   - What we know: Both use JSONL format. Slide version has parentId DAG, EventEmitter, compaction entries. nanobot version is simpler and nested in nanobot's full session lifecycle.
   - What's unclear: Should we port nanobot SessionManager from scratch, or adapt the existing Slide session-manager.ts to match nanobot's API? The nanobot version integrates tightly with Session.get_history() token budget slicing, but the Slide version is already functional.
   - Recommendation: Port nanobot SessionManager. It's ~300 lines of well-structured Python that maps cleanly to TS. The existing Slide version was a first attempt — D-07 says use nanobot's. Keep Slide version as reference for JSONL format but don't reuse directly.

2. **Where should agent-core subsystems live — in the agent-core package itself, or in a new adapter/subsystems/ layer?**
   - What we know: D-08 says agent-core is independent reusable package with no Slide coupling. ContextBuilder reads SOUL.md — is that "Slide coupling" or generic?
   - What's unclear: Bootstrap files are workspace-specific. agent-core should accept file paths/readers as input, not hardcode file names. Same for skills dir.
   - Recommendation: agent-core subsystems take configuration parameters (workspace path, bootstrap file list) via constructor injection. No hardcoded paths. ContextBuilder, SkillsLoader, and MemoryStore live in `agent-core/src/` and are configured by DirectAdapter at construction.

3. **Frontend openclaw/ cleanup scope — what's in vs out of Phase 109?**
   - What we know: D-21 says "前端清理 frontend/src/openclaw/ 依赖". D-22 says protocol simplified to chat.send/chat.history.
   - What's unclear: openclaw/ directory has ~75 files including i18n, styles, chat components, device auth, etc. Full cleanup is Phase 112 per 108-CONTEXT. Phase 109 scope: only the Gateway protocol dependency + WS transport.
   - Recommendation: Phase 109 scope is: (1) remove `openclaw/protocol/` schema files, (2) remove/replace `openclaw/ui/gateway.ts`, (3) keep chat rendering components, i18n, styles, device auth. Full openclaw/ cleanup is Phase 112.

4. **nanobot StreamIdleTimeout — how does provider-level idle timeout work in TS?**
   - What we know: The `NANOBOT_STREAM_IDLE_TIMEOUT_S` env var is a provider-level timeout, not in AgentRunner. The Anthropic SDK and OpenAI SDK both have their own timeout settings.
   - What's unclear: The exact mechanism. In nanobot it's handled by the provider's `chat_stream_with_retry()`. In agent-core, the LLMProvider interface needs to pass the timeout to the SDK.
   - Recommendation: Add `streamIdleTimeoutS?: number` to LLMCallOptions. The AnthropicProvider passes it as `maxRetries` or SDK timeout config. Document that it's provider-dependent.

5. **Subagent spawn tool — how does it trigger the actual subagent execution?**
   - What we know: `spawn_subagent` tool registers a run record and returns an "accepted" response. Currently Slide has the tool definition but no execution path.
   - What's unclear: In nanobot, `SubagentManager.spawn()` creates `asyncio.create_task(_run_subagent(...))` which runs a full AgentRunner turn. Slide's tool needs a similar execution path.
   - Recommendation: Create a SubagentManager class (in db-ops-api, not agent-core) that wraps AgentRunner for subagent execution. Register spawn_subagent with handler that calls SubagentManager.spawn(). This keeps agent-core independent of async lifecycle management.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | All code | yes | v22.x | -- |
| TypeScript | Type compilation | yes | (via npx tsc) | -- |
| `ws` | DirectAdapter WS transport | yes | (in node_modules) | -- |
| `@slide/agent-core` | DirectAdapter runtime | yes | 0.1.0 workspace | -- |
| Anthropic SDK | LLM streaming | yes | (existing dep) | -- |

**Missing dependencies with no fallback:** None identified.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest (existing in project) |
| Config file | (project-level vitest config) |
| Quick run command | `npx vitest run packages/agent-core/src/` |
| Full suite command | `npx vitest run --reporter=verbose` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| MIG-02 | Session get_history() returns correct message slice | unit | vitest session.test.ts | -- (needs writing) |
| MIG-02 | ContextBuilder.build_system_prompt() reads SOUL.md | integration | vitest context.test.ts | -- (needs writing) |
| MIG-02 | SkillsLoader.list_skills() scans workspace skills | integration | vitest skills.test.ts | -- (needs writing) |
| MIG-02 | MemoryStore reads/writes MEMORY.md | unit | vitest memory.test.ts | -- (needs writing) |
| MIG-02 | Checkpoint _restore_runtime_checkpoint dedup | integration | vitest runner.test.ts | -- (needs writing) |
| MIG-02 | Timeout returns error_kind="timeout" not exception | unit | vitest runner.test.ts | -- (needs writing) |
| MIG-03 | DirectAdapter.chat() uses ContextBuilder not hardcoded prompt | integration | direct-adapter.test.ts | ✅ (existing) |
| MIG-03 | DirectAdapter.chat() persists and restores session | integration | direct-adapter.test.ts | ✅ (existing) |
| MIG-04 | No Gateway imports in adapter/direct-adapter.ts | smoke | grep | -- (grep check) |
| MIG-05 | Frontend connects to DirectAdapter WS port 28789 | e2e | manual | -- (manual verification) |

### Sampling Rate
- **Per task commit:** `npx vitest run packages/agent-core/src/` (agent-core tests)
- **Per wave merge:** Full agent-core test suite + DirectAdapter tests
- **Phase gate:** Full suite green + frontend chat works via DirectAdapter WS

### Wave 0 Gaps
- [ ] `packages/agent-core/src/__tests__/session.test.ts` — Session + SessionManager tests
- [ ] `packages/agent-core/src/__tests__/context.test.ts` — ContextBuilder tests
- [ ] `packages/agent-core/src/__tests__/skills.test.ts` — SkillsLoader tests
- [ ] `packages/agent-core/src/__tests__/memory.test.ts` — MemoryStore + Consolidator tests
- [ ] `packages/agent-core/src/__tests__/runner.test.ts` — Timeout + checkpoint restore tests

## Security Domain

### Applicable ASVS Categories
| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V5 Input Validation | yes | Tool parameters validated by ToolRegistry.validateJsonSchema() |
| V6 Cryptography | no | No crypto operations in agent-core or DirectAdapter |

### Known Threat Patterns for TypeScript Agent Engine
| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Tool handler injection via malformed params | Tampering | ToolRegistry JSON Schema validation runs before every execute(). Invalid params rejected. |
| Unbounded LLM invocation (cost attack) | Denial of Service | AgentRunner maxIterations=10 default. Timeout layering (300s wall-clock, stream idle timeout). |
| Session metadata corruption | Tampering | JSONL atomic writes with tmp + replace pattern. No user-facing metadata write path. |

## Sources

### Primary (HIGH confidence)
- [nanobot-reference/nanobot/session/manager.py] — Session + SessionManager (705 lines). Full session lifecycle with JSONL persistence.
- [nanobot-reference/nanobot/agent/context.py] — ContextBuilder (250 lines). System prompt assembly and message building.
- [nanobot-reference/nanobot/agent/skills.py] — SkillsLoader (243 lines). SKILL.md scanning, frontmatter parsing, requirement checking.
- [nanobot-reference/nanobot/agent/memory.py] — MemoryStore + Consolidator + Dream (1163 lines). MemoryStore (lines 41-425) is port target.
- [nanobot-reference/nanobot/agent/runner.py] — AgentRunner (1318 lines, timeout logic at 610-739, checkpoint at 1055-1060).
- [nanobot-reference/nanobot/agent/loop.py] — Checkpoint restore at lines 1473-1552.
- [nanobot-reference/nanobot/agent/subagent.py] — SubagentManager (357 lines). Reference for subagent execution pattern.
- [nanobot-reference/nanobot/agent/tools/loader.py] — ToolLoader (117 lines). pkgutil auto-discovery pattern.
- [packages/agent-core/src/runner.ts] — Current AgentRunner (959 lines). Timeout and checkpoint targets.
- [packages/agent-core/src/types.ts] — All type definitions (215 lines). LLMProvider, AgentHook, AgentRunSpec, Message.
- [apps/db-ops-api/src/adapter/direct-adapter.ts] — DirectAdapter (285 lines). Integration target for all subsystems.
- [apps/db-ops-api/src/adapter/types.ts] — IAgentEngine interface (143 lines). Unchanged from Phase 108.
- [apps/db-ops-api/src/sessions/session-manager.ts] — Existing Slide session manager (463 lines). Evaluation reference.
- [apps/db-ops-api/src/sessions/context-manager.ts] — Existing Slide context manager (252 lines). Evaluation reference.
- [apps/db-ops-api/src/skills/loader.ts] — Existing Slide skills loader (449 lines). Integration reference.
- [apps/db-ops-api/src/agents/subagent-spawn-tool.ts] — Subagent tool definitions (272 lines).
- [apps/db-ops-api/src/agents/subagent-registry.ts] — Subagent registry (302 lines).
- [apps/db-ops-api/src/agents/subagent-capabilities.ts] — Subagent capabilities (251 lines).
- [.planning/phases/109-nanobot/109-CONTEXT.md] — 24 decisions (D-01 through D-24), dependency chart, canonical references.

### Secondary (MEDIUM confidence)
- [nanobot-reference/nanobot/session/goal_state.py] — Goal state helpers (118 lines). Runtime context lines for ContextBuilder.
- [frontend/src/openclaw/ui/gateway.ts] — Gateway protocol client (frontend). Removal target.

### Tertiary (LOW confidence)
- None — all source files read directly.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all codebases read directly. Agent-core compiles cleanly. nanobot source files confirmed on disk.
- Architecture: HIGH — 3-wave execution plan follows strict dependency order. Each subsystem has clear nanobot source reference and TS equivalent.
- Pitfalls: HIGH — Based on direct codebase inspection and documented patterns from CONTEXT.md and nanobot sources.

**Research date:** 2026-05-25
**Valid until:** 2026-06-25 (30 days — codebase changes could affect import graph assumptions and frontend file structure)
