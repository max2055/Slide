# Phase 123: AI 功能打磨 — Research

**Researched:** 2026-06-30
**Domain:** Agent management UI, session management, skill/tool registry, LLM provider configuration
**Confidence:** HIGH

## Summary

Phase 123 focuses on adding management UIs and UX polish for the Agent subsystem that was built in Phases 108-118 (v0.6). The backend infrastructure is largely in place: `chatDatabaseService` handles session/message persistence in MySQL, `SessionManager` manages JSONL-persisted agent sessions with auto-compaction, `ToolRegistry` provides dynamic tool registration, `SkillsLoader` scans workspace directories for SKILL.md files, and `llmDatabaseService` provides full CRUD for LLM providers. The frontend already has an `llm-config.ts` page for provider management.

The main gaps are: (1) no frontend UI to browse/manage agent sessions, (2) no UI to view/enable/disable skills, (3) no UI to list registered tools with call statistics, (4) no automatic session cleanup mechanism, and (5) chat UX needs error readability and thinking visualization improvements. Most backend APIs partially exist (e.g., `/api/sessions`, `/api/llm/configs`) and need extension rather than creation from scratch.

**Primary recommendation:** Extend existing backend services with new API endpoints for session management (list/detail/delete), skill listing, tool listing with stats, and session cleanup. Build new Lit management pages following the existing `llm-config.ts` pattern. Add thinking visualization and error handling improvements to `app-chat.ts`.

## Project Constraints (from CLAUDE.md)

- Frontend: Lit 3.3 + Vite (Web Components), port 5173
- Backend: Fastify + TypeScript, port 3000
- Agent Engine: @slide/agent-core (nanobot port), DirectAdapter WS on port 28888
- Primary DB: MySQL (mysql2/promise)
- Auth: JWT
- Shared components: `<app-card>`, `<app-dialog>`, `<app-data-table>`, `<app-badge>`, `<app-form-field>`, `<app-empty-state>`, `showToast()`
- Style tokens: `var(--accent)`, `var(--radius-*)`, `var(--space-*)`, `var(--text)`, `var(--muted)`, `var(--border)`
- Boolean attributes: must use `.property=${value}` (property binding)
- Light DOM views: inline `<style>` in render, NOT `static styles`
- Color: `var(--accent)` = `#409eff` (blue), never purple

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Session list/detail/delete | API / Backend | Database / Storage | Backend queries MySQL `chat_sessions` table |
| Session message history | API / Backend | Database / Storage | Backend queries MySQL `chat_messages` table |
| Skill listing & enable/disable | API / Backend | — | Backend reads skill files from disk + registry |
| Tool listing & call stats | API / Backend | — | Backend reads from ToolRegistry in-memory |
| LLM Provider config | API / Backend | Database / Storage | Already exists in `llmDatabaseService` |
| Session cleanup (auto) | API / Backend | Database / Storage | Cron job or startup sweep on MySQL rows |
| Chat UX improvements | Browser / Client | — | Frontend-only changes in `app-chat.ts` |
| Thinking visualization | Browser / Client | — | Frontend rendering of thinking blocks |

## Standard Stack

### Core (already installed, no new packages needed)

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| Lit | 3.3 | Web Components | Existing frontend framework |
| Fastify | latest | REST API | Existing backend framework |
| mysql2/promise | latest | DB queries | Existing DB driver |
| @slide/agent-core | workspace | Agent engine | Existing agent package |
| ws | latest | WebSocket | Existing WS transport |

### No new packages required

All functionality can be built using existing dependencies. Session cleanup uses MySQL queries + `setInterval`. Skill/tool listing reads from existing registries. LLM provider management already has full CRUD.

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     Frontend (Lit 3.3)                       │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ app-chat.ts  │  │ llm-config   │  │ NEW: sessions/   │  │
│  │ (improve UX) │  │ (exists)     │  │ skills/tools     │  │
│  └──────┬───────┘  └──────┬───────┘  │ pages            │  │
│         │                  │          └────────┬─────────┘  │
└─────────┼──────────────────┼───────────────────┼────────────┘
          │ REST/WS          │ REST              │ REST
          ▼                  ▼                   ▼
┌─────────────────────────────────────────────────────────────┐
│                  Backend (Fastify, port 3000)                 │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │ chat-handler │  │ llm-database │  │ NEW: agent-mgmt  │  │
│  │ .ts          │  │ -service.ts  │  │ routes           │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘  │
│         │                  │                   │             │
│  ┌──────┴──────────────────┴───────────────────┴──────────┐ │
│  │              Service Layer                               │ │
│  │  chatDatabaseService │ skillRegistry │ ToolRegistry     │ │
│  │  SessionManager      │ llmDatabaseService               │ │
│  └──────────────────────────┬───────────────────────────────┘ │
└──────────────────────────────┼───────────────────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                    ▼
   ┌─────────────┐    ┌──────────────┐    ┌──────────────┐
   │ MySQL       │    │ JSONL files  │    │ Skill files  │
   │ chat_*      │    │ .slide/      │    │ src/skills/  │
   │ llm_*       │    │ sessions/    │    │ SKILL.md     │
   └─────────────┘    └──────────────┘    └──────────────┘
```

### Recommended Project Structure

```
apps/db-ops-api/
├── server.ts                          # Add new API routes
├── src/
│   ├── agent-management-service.ts    # NEW: unified agent mgmt queries
│   ├── session-cleanup.ts             # NEW: auto session cleanup
│   ├── chat-database-service.ts       # Extend with delete/status methods
│   ├── skills/loader.ts               # Already has skillRegistry
│   ├── adapter/
│   │   ├── direct-adapter.ts          # Expose sessionManager, skillsLoader
│   │   └── get-agent-engine.ts        # Add accessor methods
│   └── tools/catalog.ts               # Already has toolCatalog

frontend/src/app/ui/
├── views/
│   ├── llm-config.ts                  # EXISTS: LLM provider page
│   ├── agent-sessions.ts              # NEW: session management
│   ├── agent-skills.ts                # NEW: skill management
│   └── agent-tools.ts                 # NEW: tool management
├── app-chat.ts                        # Improve error/thinking UX
├── app-render.ts                      # Add new tab entries
└── navigation.ts                      # Add new tab definitions
```

### Pattern 1: Existing LLM Config Page (reference for new management pages)

**What:** Two-column layout with provider list on left, detail form on right. Uses Shadow DOM, `apiClient` for HTTP, shared components.
**When to use:** All new management pages should follow this pattern.
**Source:** `frontend/src/app/ui/views/llm-config.ts`

```typescript
// Pattern from llm-config.ts
@customElement("llm-config-page")
export class LLMConfigPage extends LitElement {
  @state() private providers: LLMProvider[] = [];
  
  async connectedCallback() {
    super.connectedCallback();
    await this.loadProviders();
  }
  
  async loadProviders() {
    const res = await apiClient.get('/api/llm/configs');
    this.providers = res.data;
  }
  
  render() {
    return html`
      <div class="page-container">
        <div class="sidebar"><!-- provider list --></div>
        <div class="detail"><!-- form/detail --></div>
      </div>
    `;
  }
}
```

### Pattern 2: Existing Session List API

**What:** `GET /api/sessions` returns sessions from `chatDatabaseService.getSessions()` with `key`, `kind`, `label`, `updatedAt` fields.
**When to use:** Extend this endpoint with more fields (message_count, status, instance_id) rather than creating a new one.
**Source:** `server.ts:861-886`

### Pattern 3: Skill Registry Access

**What:** `skillRegistry` singleton in `skills/loader.ts` provides `getAll()`, `get(name)`, `has(name)`, `getSkillNames()`.
**When to use:** New `/api/agent/skills` endpoint reads from this registry.
**Source:** `apps/db-ops-api/src/skills/loader.ts:329-396`

### Pattern 4: Tool Registry Access

**What:** `ToolRegistry` in `@slide/agent-core` provides `getDefinitions()` returning `ToolSchema[]` with name/description/parameters. `DirectAdapter` holds the registry as `this.registry`.
**When to use:** New `/api/agent/tools` endpoint calls `engine.listTools()` which already exists on `IAgentEngine`.
**Source:** `packages/agent-core/src/tool-registry.ts:41-63`, `apps/db-ops-api/src/adapter/types.ts:147`

### Pattern 5: Chat Thinking Events

**What:** `ChatEvent` union already includes `ThinkingDeltaEvent` and `ThinkingEndEvent` types. `DirectAdapter` hook emits reasoning via `emitReasoning` and `emitReasoningEnd`.
**When to use:** Frontend `app-chat.ts` needs to handle these events for thinking visualization.
**Source:** `apps/db-ops-api/src/adapter/types.ts:48-55`

### Anti-Patterns to Avoid

- **Do not create a separate agent management database table** — use existing `chat_sessions`/`chat_messages` MySQL tables and extend them.
- **Do not build a new WebSocket endpoint** — use existing REST APIs for management operations; WS is for chat streaming only.
- **Do not use `static styles` in Light DOM views** — per CLAUDE.md, views with `createRenderRoot() { return this; }` must inject inline `<style>` in render.
- **Do not hardcode provider types** — the provider system supports arbitrary providers via DB config; UI should be provider-agnostic.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Session cleanup | Custom cron framework | `setInterval` + MySQL DELETE query | Simple timer + SQL is sufficient |
| Skill enable/disable | Custom file watcher | In-memory registry flag + reload on toggle | Skills are loaded at startup; toggle marks them for next load |
| Tool call stats | Custom analytics DB | In-memory counter in `ToolRegistryEntry` | Already defined in types, just needs tracking |
| LLM provider switching | Custom provider abstraction | `createLLMProvider()` in `get-agent-engine.ts` | Already handles DB-configured provider selection |
| Thinking visualization | Custom markdown parser | CSS collapsible `<details>` + raw text | Thinking content is plain text, no special parsing needed |

## Common Pitfalls

### Pitfall 1: DirectAdapter singleton holds stale LLM provider

**What goes wrong:** When user switches LLM provider via UI, the running `DirectAdapter` singleton still uses the old provider.
**Why it happens:** `getAgentEngine()` caches the singleton; `createLLMProvider()` is only called once.
**How to avoid:** Add a `reloadProvider()` method that recreates the provider on the DirectAdapter, or document that provider switch requires server restart.
**Warning signs:** After switching provider, chat still uses old model.

### Pitfall 2: Session cleanup deletes active sessions

**What goes wrong:** Auto-cleanup removes sessions that users are actively using.
**Why it happens:** Cleanup query doesn't check `last_message_at` properly.
**How to avoid:** Only delete sessions where `last_message_at < NOW() - INTERVAL ? DAY` AND session is not currently subscribed in DirectAdapter's `sessionSubscribers`.
**Warning signs:** Users report losing chat history mid-conversation.

### Pitfall 3: Tool call stats lost on server restart

**What goes wrong:** In-memory tool call counters reset to zero on restart.
**Why it happens:** Stats are stored in `ToolRegistryEntry` objects in memory.
**How to avoid:** Accept this as expected behavior for v1; if persistence is needed later, add a `tool_call_stats` MySQL table.
**Warning signs:** Users expect historical stats after restart.

### Pitfall 4: Skill toggle doesn't take effect immediately

**What goes wrong:** User disables a skill in UI but it's still available in chat.
**Why it happens:** Skills are loaded into `AgentRunner`'s context at startup; toggling a flag doesn't rebuild the context.
**How to avoid:** Either (a) rebuild context on toggle, or (b) document "takes effect on next session". Option (b) is simpler and acceptable for v1.
**Warning signs:** User reports skill still working after disabling.

### Pitfall 5: Session list performance with many sessions

**What goes wrong:** `/api/sessions` becomes slow with thousands of sessions.
**Why it happens:** `getSessions()` does `SELECT * FROM chat_sessions ORDER BY last_message_at DESC LIMIT ?` which is fine with index on `last_message_at`.
**How to avoid:** Ensure `chat_sessions` has an index on `last_message_at`. Add pagination (offset/limit) to the API.
**Warning signs:** API response time > 1s with > 1000 sessions.

## Code Examples

### Example 1: Extend Session List API (server.ts)

```typescript
// Extend existing GET /api/sessions with more fields
fastify.get('/api/sessions', { preHandler: [verifyToken] }, async (request, reply) => {
  const { activeMinutes, limit: limitStr, offset: offsetStr } = request.query as {
    activeMinutes?: string; limit?: string; offset?: string;
  };
  const limit = limitStr ? parseInt(limitStr, 10) : 50;
  const offset = offsetStr ? parseInt(offsetStr, 10) : 0;
  const chatDb = chatDatabaseService;
  const sessions = await chatDb.getSessions(null, limit);
  // ... return with message_count, instance_id, status
});
```

### Example 2: New Agent Management Service

```typescript
// agent-management-service.ts
export class AgentManagementService {
  async listSkills(): Promise<SkillInfo[]> {
    const engine = await getAgentEngine();
    // Access skillsLoader from DirectAdapter
    // Return skill name, description, filePath, enabled status
  }

  async listTools(): Promise<ToolInfo[]> {
    const engine = await getAgentEngine();
    const tools = engine.listTools(); // Already exists on IAgentEngine
    // Return tool name, description, parameters schema
  }

  async toggleSkill(name: string, enabled: boolean): Promise<void> {
    // Mark skill as disabled in a skip-set
    // ContextBuilder checks skip-set when building prompts
  }

  async cleanupSessions(retentionDays: number): Promise<number> {
    // DELETE FROM chat_sessions WHERE last_message_at < NOW() - INTERVAL ? DAY
    // Also delete corresponding chat_messages
  }
}
```

### Example 3: Thinking Visualization in app-chat.ts

```typescript
// In the WS message handler, handle thinking events:
case 'thinking_delta':
  this._thinkingText += msg.delta;
  this.requestUpdate();
  break;
case 'thinking_end':
  this._thinkingComplete = true;
  this.requestUpdate();
  break;

// In render():
${this._thinkingText ? html`
  <details class="thinking-block" ?open=${!this._thinkingComplete}>
    <summary>💭 思考过程${this._thinkingComplete ? '' : '中...'}</summary>
    <pre>${this._thinkingText}</pre>
  </details>
` : ''}
```

### Example 4: Session Cleanup Cron

```typescript
// session-cleanup.ts
export function startSessionCleanup(intervalMs: number = 24 * 60 * 60 * 1000) {
  const retentionDays = parseInt(process.env.SESSION_RETENTION_DAYS || '30', 10);
  
  setInterval(async () => {
    const chatDb = chatDatabaseService;
    const deleted = await chatDb.deleteOldSessions(retentionDays);
    console.log(`[SessionCleanup] Deleted ${deleted} sessions older than ${retentionDays} days`);
  }, intervalMs);
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Gateway WS relay | DirectAdapter self-managed WS | Phase 110 | Simpler architecture, no external dependency |
| OpenClaw agent engine | @slide/agent-core | Phase 109 | Full control over agent behavior |
| In-memory sessions only | JSONL + MySQL dual persistence | Phase 97 | Sessions survive restarts |
| Single LLM provider | Multi-provider DB config | Phase 92 | Runtime provider switching |

**Deprecated/outdated:**
- OpenClaw CLI references: removed in Phase 116
- Gateway-based session management: replaced by DirectAdapter + chatDatabaseService

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `engine.listTools()` returns all registered tools with schemas | Code Examples | May need to expose ToolRegistry differently |
| A2 | `skillRegistry.getAll()` returns all loaded skills at runtime | Code Examples | Skills may be loaded differently than expected |
| A3 | Tool call stats can be tracked in-memory without DB persistence | Don't Hand-Roll | Users may expect persistent stats |
| A4 | Session cleanup can use simple `setInterval` | Don't Hand-Roll | May need proper cron if server restarts frequently |

## Open Questions

1. **Should skill toggle take effect immediately or on next session?**
   - What we know: Skills are loaded into context at session start
   - What's unclear: Whether users expect immediate effect
   - Recommendation: Document "takes effect on next session" for v1

2. **Should tool call stats persist across server restarts?**
   - What we know: `ToolRegistryEntry` has `callCount` and `avgExecutionTime` fields already defined
   - What's unclear: Whether these need DB persistence
   - Recommendation: In-memory for v1, add DB persistence if users request it

3. **What is the default session retention period?**
   - What we know: `AutoCompact` has `sessionTtlMinutes` but it's for compaction, not deletion
   - What's unclear: What retention period users expect
   - Recommendation: Default 30 days, configurable via `SESSION_RETENTION_DAYS` env var

4. **Should the DirectAdapter expose its internal components (sessionManager, skillsLoader)?**
   - What we know: `IAgentEngine` interface currently only has `start()`, `chat()`, `invoke()`, `listTools()`, `capabilities()`
   - What's unclear: Whether to extend the interface or cast to DirectAdapter
   - Recommendation: Add accessor methods to DirectAdapter class (not to IAgentEngine interface) to avoid breaking the abstraction

## Sources

### Primary (HIGH confidence)
- `apps/db-ops-api/src/chat-database-service.ts` — session/message DB operations
- `apps/db-ops-api/src/adapter/direct-adapter.ts` — DirectAdapter implementation
- `apps/db-ops-api/src/adapter/types.ts` — IAgentEngine interface, ChatEvent types
- `apps/db-ops-api/src/adapter/get-agent-engine.ts` — provider factory, tool loading
- `apps/db-ops-api/src/adapter/llm-provider.ts` — AnthropicProvider implementation
- `apps/db-ops-api/src/skills/loader.ts` — skill loading and registry
- `apps/db-ops-api/src/tools/types.ts` — tool type definitions
- `apps/db-ops-api/src/llm-database-service.ts` — LLM provider CRUD
- `packages/agent-core/src/session.ts` — SessionManager, AutoCompact
- `packages/agent-core/src/tool-registry.ts` — ToolRegistry implementation
- `frontend/src/app/ui/views/llm-config.ts` — existing LLM config page pattern
- `apps/db-ops-api/server.ts` — existing API routes

### Secondary (MEDIUM confidence)
- `apps/db-ops-api/src/chat-handler.ts` — chat message handling

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new packages needed, all existing
- Architecture: HIGH — based on direct codebase reading
- Pitfalls: HIGH — based on actual code patterns observed

**Research date:** 2026-06-30
**Valid until:** 2026-07-30 (stable codebase, no fast-moving dependencies)

---

## Detailed Findings by Success Criterion

### SC1: Agent Session Management UI

**Current state:**
- `chatDatabaseService.getSessions(userId, limit)` returns `ChatSessionRecord[]` from MySQL `chat_sessions` table
- `chatDatabaseService.getMessages(sessionId, limit)` returns `ChatMessageRecord[]` from MySQL `chat_messages` table
- `GET /api/sessions` returns `{ ok, sessions: [{ key, kind, label, updatedAt }] }` — minimal fields
- `GET /api/chat/history?sessionKey=...` returns formatted messages with thinking block parsing
- `PATCH /api/sessions/:key` updates model/thinkingLevel settings
- `SessionManager` (agent-core) manages JSONL files in `.slide/sessions/` with `listSessions()`, `deleteSession()`
- No "end session" or "delete session" API exists for chat_sessions MySQL table
- `chatDatabaseService.deleteSession(sessionId)` exists but is not exposed via API

**Gap analysis:**
- Need: `DELETE /api/sessions/:key` endpoint (calls `chatDatabaseService.deleteSession()`)
- Need: Extend `GET /api/sessions` with `message_count`, `instance_id`, `status` fields
- Need: New frontend page `agent-sessions.ts` with `<app-data-table>` listing sessions
- Need: Session detail view showing message history (reuse `/api/chat/history`)

**DB schema (existing):**
```sql
chat_sessions: id, session_id, user_id, title, instance_id, message_count, last_message_at, metadata, created_at, updated_at
chat_messages: id, message_id, parent_id, session_id, role, content, related_tool, related_skill, metadata, created_at
```

### SC2: Skills Management Page

**Current state:**
- `SkillsLoader` in `@slide/agent-core` loads skills from workspace
- `skillRegistry` in `skills/loader.ts` is a singleton `Map<string, SkillEntry>` with `register()`, `getAll()`, `get()`, `has()`
- `SkillEntry` contains: `skill.name`, `skill.description`, `skill.filePath`, `skill.source` (body), `frontmatter`, `metadata`, `invocation`, `exposure`
- Skills loaded from: `./src/skills`, `../../../db-ops-skills`, `~/.slide/skills`
- No enable/disable mechanism exists
- No API endpoint to list skills

**Gap analysis:**
- Need: `GET /api/agent/skills` endpoint reading from `skillRegistry.getAll()`
- Need: `POST /api/agent/skills/:name/toggle` endpoint with in-memory disabled set
- Need: New frontend page `agent-skills.ts` listing skills with content viewer
- Need: Frontend shows skill file path, description, frontmatter, source content

### SC3: Tools Management Page

**Current state:**
- `IAgentEngine.listTools(): ToolSchema[]` already exists — returns `[{ name, description, parameters }]`
- `ToolRegistry` in agent-core has `getDefinitions()`, `toolNames`, `size`
- `ToolRegistryEntry` type (in `tools/types.ts`) has `callCount`, `lastCalledAt`, `avgExecutionTime` — but these are NOT tracked by `ToolRegistry` in agent-core (that's a different class)
- `toolCatalog` in `tools/catalog.ts` manages `AnyAgentTool` instances with groups
- No API endpoint to list tools
- No call statistics tracking

**Gap analysis:**
- Need: `GET /api/agent/tools` endpoint calling `engine.listTools()`
- Need: In-memory call counter wrapper around tool execution
- Need: New frontend page `agent-tools.ts` with tool list, schema viewer, stats display

### SC4: LLM Provider Management Page

**Current state:**
- `llmDatabaseService` provides full CRUD: `getAllProviders()`, `getEnabledProviders()`, `configureProvider()`, `deleteProvider()`, `toggleProvider()`, `setDefaultProvider()`
- Full API already exists: `GET/POST/PUT/DELETE /api/llm/configs`, `POST /api/llm/configs/:id/toggle`, `POST /api/llm/configs/:id/default`, `POST /api/llm/test`, `GET /api/llm/models`
- Frontend page `llm-config.ts` already exists with two-column layout, provider templates (Anthropic, OpenAI, DeepSeek, Google, Ollama), brand colors, form editing
- `createLLMProvider()` in `get-agent-engine.ts` reads DB for enabled provider, creates AnthropicProvider or OpenAIProvider

**Gap analysis:**
- **Mostly done.** The LLM config page exists and is functional.
- Need: Verify "switch provider" flow works end-to-end (may need DirectAdapter provider reload)
- Need: Possibly add "test connection" button on the page (backend `POST /api/llm/test` exists)

### SC5: Agent Interaction UX Improvements

**Current state:**
- `ChatEvent` union includes: `text_delta`, `tool_start`, `tool_result`, `tool_error`, `thinking_delta`, `thinking_end`, `complete`, `error`
- `DirectAdapter` hook emits `emitReasoning` and `emitReasoningEnd` events
- Error events are plain `{ type: 'error', error: string }` — raw error messages
- Frontend `app-chat.ts` handles WS messages but thinking events may not be visualized

**Gap analysis:**
- Need: Thinking block visualization in `app-chat.ts` (collapsible `<details>` element)
- Need: Readable error messages (map `provider_error`, `timeout`, `rate_limit` to user-friendly text)
- Need: Timeout/reconnect indicators in chat UI
- Need: Tool execution status display (already has `tool_start`/`tool_result` events)

### SC6: Session Cleanup Mechanism

**Current state:**
- `AutoCompact.isExpired()` checks TTL for compaction purposes (not deletion)
- `SessionManager.deleteSession()` removes JSONL file + cache entry
- `chatDatabaseService.deleteSession()` removes MySQL row + related messages
- No automatic cleanup mechanism exists
- No retention configuration

**Gap analysis:**
- Need: `session-cleanup.ts` module with `startSessionCleanup()` function
- Need: `chatDatabaseService.deleteOldSessions(retentionDays)` method
- Need: `SESSION_RETENTION_DAYS` env var (default 30)
- Need: Called from `server.ts` startup
- Need: UI to configure retention period (optional, can be env-only for v1)
