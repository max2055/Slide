1	# Phase 108: Agent Abstraction Layer — Research
2	
3	**Researched:** 2026-05-25
4	**Domain:** Agent engine abstraction, adapter pattern, TypeScript interface design, OpenClaw decoupling
5	**Confidence:** HIGH
6	
7	## Summary
8	
9	Phase 108 defines the `IAgentEngine` interface to decouple Slide's platform code from any specific agent engine, with three planned adapters: `DirectAdapter` (default, wrapping the already-built `@slide/agent-core` package), `OpenClawAdapter` (legacy compatibility), and `nanobotAdapter` (Phase 109). The interface covers two execution paths -- streaming chat (`.chat()`) and fire-and-forget task dispatch (`.invoke()`) -- plus tool lifecycle management and capability discovery.
10	
11	The `@slide/agent-core` package (1523 lines TS, compiles cleanly) is already built and provides `AgentRunner`, `ToolRegistry`, and the `LLMProvider`/`AgentHook` interfaces. The key implementation work is bridging agent-core's rich internal API to a simplified `IAgentEngine` surface, migrating existing OpenClaw integration code into the OpenClawAdapter directory, and ensuring zero OpenClaw imports remain in platform code.
12	
13	**Primary recommendation:** Execute in the stated 3-plan order (interface + agent-core integration -> OpenClawAdapter + file migration -> platform switch + dual-run verification). The biggest unknown is the `LLMProvider` implementation for DirectAdapter -- Slide's existing provider configurations are metadata-only, not SDK-level wrappers. This must be built from scratch or adapted from existing `llm-service.ts` patterns.
14	
15	<user_constraints>
16	## User Constraints (from CONTEXT.md)
17	
18	### Locked Decisions
19	
20	**IAgentEngine interface:**
21	- D-01: Two execution methods: `.chat(sessionKey, message, onEvent)` for streaming, `.invoke(sessionKey, message, systemPrompt?)` for fire-and-forget
22	- D-02: Unified `ChatEvent` type: `text_delta | tool_start | tool_result | tool_error | complete | error`
23	- D-03: `listTools(): ToolSchema[]` + `capabilities(): AgentCapabilities` (streaming, toolCalling, maxContextTokens, supportsCustomSystemPrompt)
24	- D-04: Standard `Error` throw on errors -- no Result pattern or structured error codes
25	- D-05: Interface method signatures must be generic enough for WebSocket, HTTP, or in-process transport (nanobot-compatible)
26	
27	**Agent engine:**
28	- D-06: `@slide/agent-core` is the default engine -- port of nanobot's AgentRunner + ToolRegistry to TS (1523 lines, compiled)
29	- D-07: Six key mechanisms ported: parallel tool execution, mid-turn message injection, interrupt recovery (checkpoint), context budget (microcompact+snip), timeout layering, structured tracing
30	- D-08: agent-core is independent reusable package -- no Slide business logic coupling
31	
32	**Tool system:**
33	- D-09: All tool definitions in `tools/catalog.ts` -- single entry point for name, description, parameters
34	- D-10: Unified `ToolHandler` signature `(params: Record<string, unknown>) => Promise<unknown>`
35	- D-11: Slide DB tools in catalog.ts through platform code; pi-agent base tools (bash, read, write, etc.) are OpenClawAdapter-internal only
36	- D-12: OpenClaw native tools (createOpenClawTools) loaded by OpenClawAdapter internally
37	- D-13: Tools registered once at startup, no runtime dynamic registration
38	- D-14: `ALL_TOOL_DEFINITIONS` in agent-service.ts migrates to catalog.ts; agent-service.ts keeps only `getAgentGreeting()`
39	
40	**Instance management:**
41	- D-15: Factory function pattern: `getAgentEngine(): IAgentEngine` -- module-level lazy singleton, same as current `getOpenClawRuntime()`
42	- D-16: Adapter config via constructor injection: `new DirectAdapter({ tools, llmProvider })` -- no env vars/config files
43	
44	**Adapter isolation:**
45	- D-17: ZERO OpenClaw imports in platform code
46	- D-18: All OpenClaw files in `apps/db-ops-api/src/adapter/openclaw/` -- delete directory to remove dependency
47	- D-19: gateway/server.ts moves into adapter; platform uses `adapter.start()` instead of `startGatewayServer`
48	- D-20: gateway-client.ts (`sendGatewayChat`) moves into adapter; ai-agent-bridge.ts uses `agent.invoke()`
49	- D-21: chat-methods.ts rewritten as platform-level RPC handler calling `agent.chat()`
50	- D-22: LLM-to-OpenClaw config sync moved into adapter as internal
51	- D-23: No frontend changes; frontend WebSocket still connects to backend
52	- D-24: Adapter imports OpenClaw source via relative path
53	
54	**WebSocket:**
55	- D-25: Two options for DirectAdapter WebSocket -- extract shared framework from Gateway (option A) or DirectAdapter ships its own ~100 line WS service (option B). Decision deferred to Plan.
56	- D-26: Gateway protocol/error-code parts unrelated to OpenClaw extracted to shared layer
57	
58	**Migration:**
59	- D-27: 3-plan execution: Plan 1 (interface+agent-core), Plan 2 (OpenClawAdapter+file move), Plan 3 (platform switch+dual-run)
60	- D-28: Files moved directly, no re-export shims
61	- D-29: Feature flags `ENABLE_AGENT_ADAPTER_CHAT` and `ENABLE_AGENT_ADAPTER_ANALYSIS` for toggle-by-caller
62	- D-30: Dual-run comparison verification after Plan 3
63	
64	**Dead code:**
65	- D-31: Remove handleAgentRequest, classifyIntent, OPS_SYSTEM_PROMPTS, ALL_TOOL_DEFINITIONS, executeTool from agent-service.ts; delete agent-service-v2.ts entirely; remove sendMessageToAgent from openclaw-bridge.ts
66	
67	**Testing:**
68	- D-32: openclaw-integration.test.ts rewritten to test IAgentEngine interface
69	
70	### Claude's Discretion
71	- D-25: WebSocket transport strategy for DirectAdapter (extract shared framework vs. build minimal standalone)
72	- No other discretion areas noted
73	
74	### Deferred Ideas (OUT OF SCOPE)
75	- Schedule/cron triggers -- platform infrastructure, not Agent interface
76	- Session management -- platform infrastructure (chatDatabaseService), Agent interface has no session CRUD
77	- Frontend OpenClaw UI cleanup -- Phase 112
78	- Full Gateway dependency removal -- Phase 111
79	- nanobotAdapter implementation -- Phase 109
80	- Publishing @slide/agent-core as standalone npm package -- future
81	</user_constraints>
82	
83	<phase_requirements>
84	## Phase Requirements
85	
86	| ID | Description | Research Support |
87	|----|-------------|------------------|
88	| MIG-01 | Define IAgentEngine interface contract to decouple platform code from Agent implementation | Interface design (D-01 through D-05) fully specified. agent-core types available for mapping. Three-adapter architecture documented. |
89	</phase_requirements>
90	
91	## Architectural Responsibility Map
92	
93	| Capability | Primary Tier | Secondary Tier | Rationale |
94	|------------|-------------|----------------|-----------|
95	| Chat message processing | API (db-ops-api) | Browser/Client | Chat is a server-side RPC. The frontend sends/receives WebSocket frames; the backend orchestrates LLM calls, tool execution, and persistence. |
96	| AI analysis / invoke | API (db-ops-api) | Database (MySQL) | Fire-and-forget analysis tasks run in a background async path on the server. Results are persisted to MySQL via aiAnalysisDatabaseService. |
97	| Tool registration | API (db-ops-api) | -- | Tools are a server-side concern. catalog.ts is the single entry point. Adapters consume tool lists from the platform. |
98	| WebSocket transport | API (db-ops-api) | Browser/Client | Both the existing Gateway and the new DirectAdapter WS server run in the same OS process. The frontend connects to one WS endpoint. |
99	| Tool execution | API (db-ops-api) | -- | All tool handlers run server-side with injected service instances. No client-side access to tool handlers. |
100	
101	## Standard Stack
102	
103	### Core
104	| Library | Version | Purpose | Why Standard |
105	|---------|---------|---------|--------------|
106	| `@slide/agent-core` | 0.1.0 (workspace) | LLM-tool execution loop, ToolRegistry, context governance | Already built (1523 lines TS, compiles cleanly). Zero external AI framework dependencies. Ported from nanobot's proven patterns. |
107	| `IAgentEngine` interface | NEW (adapter/types.ts) | Platform contract for agent abstraction | Defines `.chat()`, `.invoke()`, `.listTools()`, `.capabilities()` -- the only API surface platform code depends on. |
108	
109	### Supporting
110	| Library | Version | Purpose | When to Use |
111	|---------|---------|---------|-------------|
112	| Anthropic SDK / OpenAI SDK / Ollama | (existing) | LLM provider implementations | DirectAdapter's internal LLMProvider implementation wraps one of these behind agent-core's LLMProvider interface |
113	| `ws` | (existing) | WebSocket server for chat streaming | Both OpenClawAdapter (reuses existing gateway server) and DirectAdapter (D-25 decision) |
114	| `fast-deep-equal` | NEW (dev) | Deep equality for adapter parity testing | Structured comparison of ToolSchema arrays across adapters in CI |
115	
116	### Alternatives Considered
117	| Instead of | Could Use | Tradeoff |
118	|------------|-----------|----------|
119	| `@slide/agent-core` | LangChain / LangGraph | Python-only for core features; abstraction overhead; vendor lock-in |
120	| `@slide/agent-core` | OpenAI Agents SDK | Vendor lock-in; Slide needs Anthropic + Ollama |
121	| `@slide/agent-core` | Claude Agent SDK | Claude-only; Slide needs model-agnostic |
122	
123	**Installation:**
124	```bash
125	# @slide/agent-core is a workspace package; already in packages/agent-core/
126	# No npm install needed within monorepo
127	
128	# For adapter parity testing:
129	npm install -D fast-deep-equal
130	```
131	
132	**Version verification:**
133	```bash
134	# agent-core compiles cleanly
135	npx tsc --noEmit --project packages/agent-core/tsconfig.json
136	# No output = no errors
137	```
138	
139	## Package Legitimacy Audit
140	
141	> Required per Package Legitimacy Gate protocol. slopcheck unavailable at research time -- all packages tagged `[ASSUMED]`. Planner must gate each install behind `checkpoint:human-verify` before install.
142	
143	| Package | Registry | slopcheck | Disposition | Notes |
144	|---------|----------|-----------|-------------|-------|
145	| `@slide/agent-core` | npm (workspace) | N/A -- not a registry package | Approved | Custom in-house package, already in monorepo |
146	| `ws` | npm | N/A -- existing dep | Approved | Already in package.json, used by gateway/server.ts |
147	| `fast-deep-equal` | npm | [ASSUMED] | Planner gated | Dev dependency for adapter parity testing |
148	
149	**Packages removed due to slopcheck:** none
150	**Packages flagged as suspicious:** none
151	
152	*Since slopcheck was unavailable at research time, any new install packages are tagged `[ASSUMED]` and the planner must gate each install behind a `checkpoint:human-verify` task.*
153	
154	## Architecture Patterns
155	
156	### System Architecture Diagram
157	
158	```
159	Frontend (Lit 3.3)                        External LLMs
160	     |                                    (Anthropic, OpenAI,
161	     | WebSocket (WS)                     DeepSeek, Ollama...)
162	     v                                        |
163	+-----------+                                  |
164	| Platform  |                                  |
165	| Code      |                                  v
166	|           |     getAgentEngine()       +-----------------+
167	| server.ts | ------------------------>  | IAgentEngine     |
168	| chat-methods.ts       |              | (factory lazy     |
169	| ai-agent-bridge.ts    |              |  singleton)       |
170	| tools/catalog.ts      |              |                  |
171	+-----------+           |              +--------+---------+
172	     ^                  |                       |
173	     |                  |            +----------+-----------+
174	     |                  |            |          |           |
175	     |                  |            v          v           v
176	     |                  |     +-----------+ +--------+ +--------+
177	     |                  |     | Direct    | |OpenClaw| |Nanobot |
178	     |  MySQL           |     | Adapter   | |Adapter | |Adapter |
179	     | (chat history,   |     | (default) | |(legacy)| |(Ph109) |
180	     |  analysis)       |     +-----------+ +--------+ +--------+
181	     |                  |          |              |
182	     v                  |          v              v
183	+-----------+           |   +-----------+  +-----------------+
184	|chatDB     |           |   |AgentRunner|  |dispatchInbound  |
185	|Service    |           |   |ToolReg    |  |Message (OpenClaw)|
186	|           |           |   |LLMProvider|  |Gateway Server   |
187	+-----------+           |   +-----------+  +-----------------+
188	```
189	
190	Data flow:
191	1. **Chat path:** Frontend WebSocket -> platform RPC handler -> `agent.chat()` -> adapter -> LLM stream -> events loop -> frontend
192	2. **Analysis path:** AI trigger -> ai-agent-bridge.ts -> `agent.invoke()` -> adapter -> LLM single-turn -> tool results -> MySQL persistence
193	3. **Tools:** catalog.ts definition -> adapter.registerTool() -> ToolRegistry -> AgentRunner.run() -> LLM calls tool -> ToolRegistry.execute() -> handler with injected services
194	
195	### Recommended Project Structure
196	```
197	apps/db-ops-api/src/
198	├── adapter/                          # NEW -- IAgentEngine + adapters
199	│   ├── types.ts                      # IAgentEngine, ChatEvent, AgentCapabilities, ChatResult, InvokeResult
200	│   ├── get-agent-engine.ts           # getAgentEngine() factory + lazy singleton
201	│   ├── direct-adapter.ts             # DirectAdapter (wraps AgentRunner behind IAgentEngine)
202	│   │                                  # includes LLMProvider implementation
203	│   ├── openclaw/                     # MOVED from src/gateway/
204	│   │   ├── openclaw-adapter.ts       # OpenClawAdapter (wraps dispatchInboundMessage)
205	│   │   ├── server.ts                 # Moved from gateway/server.ts
206	│   │   ├── chat-methods.ts           # Moved from gateway/chat-methods.ts (rewritten)
207	│   │   ├── openclaw-runtime.ts       # Moved from gateway/openclaw-runtime.ts
208	│   │   ├── gateway-client.ts         # Moved from gateway/gateway-client.ts
209	│   │   ├── streaming.ts              # Moved from gateway/streaming.ts
210	│   │   ├── openclaw-bridge.ts        # Moved from gateway/openclaw-bridge.ts
211	│   │   ├── config-service.ts         # Moved from gateway/config-service.ts
212	│   │   ├── protocol.ts               # Moved from gateway/protocol.ts (shared parts extracted)
213	│   │   └── error-codes.ts            # Moved from gateway/error-codes.ts (shared parts extracted)
214	│   └── __tests__/
215	│       ├── adapter-parity.ts         # AdapterParityTestHarness
216	│       ├── direct-adapter.test.ts    # DirectAdapter unit tests
217	│       └── openclaw-adapter.test.ts  # OpenClawAdapter unit tests (rewritten from openclaw-integration.test.ts)
218	├── gateway/                          # REMOVED after migration
219	│   └── ...                           # All files moved to adapter/openclaw/
220	├── tools/
221	│   ├── catalog.ts                    # KEEP -- single tool definition entry point
222	│   └── ...                           # (unchanged)
223	├── agent-service.ts                  # TRIM -- keep getAgentGreeting() only
224	├── agent-service-v2.ts               # DELETE
225	├── ai-agent-bridge.ts                # REWRITE -- use agent.invoke() instead of sendGatewayChat
226	└── llm/config-sync.ts                # MOVE logic into OpenClawAdapter internal
227	```
228	
229	### Pattern 1: Factory + Lazy Singleton
230	**What:** `getAgentEngine()` creates the adapter instance on first call and returns the cached instance on subsequent calls. Adapter selection is controlled by feature flags or environment variables.
231	
232	**When to use:** This is the standard pattern for globally-shared services in the Slide codebase. Already used for `getOpenClawRuntime()`, `getGatewayServer()`.
233	
234	**Example:**
235	```typescript
236	// Source: Pattern from openclaw-runtime.ts (existing) + AI-SPEC Section 4
237	import type { IAgentEngine } from './types.js';
238	
239	let engine: IAgentEngine | null = null;
240	
241	export async function getAgentEngine(): Promise<IAgentEngine> {
242	  if (!engine) {
243	    const tools = await loadPlatformTools();  // from catalog.ts
244	    const useDefault = process.env.ENABLE_AGENT_ADAPTER_CHAT !== 'openclaw';
245	
246	    if (useDefault) {
247	      const provider = createLLMProvider();    // new LLMProvider impl
248	      engine = new DirectAdapter({ tools, llmProvider: provider });
249	    } else {
250	      engine = new OpenClawAdapter({ tools });
251	    }
252	  }
253	  return engine;
254	}
255	```
256	
257	### Pattern 2: Adapter Event Mapping
258	**What:** Each adapter maps its internal event format to the unified `ChatEvent` type. The mapping happens inside the adapter's `.chat()` method before dispatching to `onEvent`.
259	
260	**When to use:** Always in `.chat()` implementation. Each adapter has different internal event formats (AgentRunner hooks vs. OpenClaw ReplyDispatcher callbacks vs. nanobot SSE streams).
261	
262	**Example:**
263	```typescript
264	// DirectAdapter -- maps AgentHook callbacks to ChatEvent
265	async chat(sessionKey: string, message: string, onEvent: (e: ChatEvent) => void): Promise<ChatResult> {
266	  const hook = {
267	    wantsStreaming: () => true,
268	    onStream: async (_ctx, delta) => {
269	      onEvent({ type: 'text_delta', delta });
270	    },
271	    beforeExecuteTools: async (ctx) => {
272	      for (const tc of ctx.toolCalls) {
273	        onEvent({ type: 'tool_start', toolName: tc.name, args: tc.arguments });
274	      }
275	    },
276	    // ... tool_result, tool_error, complete mapping
277	  };
278	
279	  const result = await this.runner.run({ ...spec, hook });
280	  onEvent({ type: 'complete', finalContent: result.finalContent });
281	  return { finalContent: result.finalContent, usage: result.usage };
282	}
283	```
284	
285	### Anti-Patterns to Avoid
286	- **Leaking adapter internals to platform code:** Platform code must never import from `adapter/openclaw/` or `@slide/agent-core`. The only import is `getAgentEngine()` from `adapter/types.ts` or a thin `adapter/get-agent-engine.ts`.
287	- **Re-export shims:** D-28 explicitly forbids keeping old files that re-export from new locations. Delete originals after move.
288	- **Putting session persistence in the adapter:** The adapter returns results; the platform persists via `chatDatabaseService`. The adapter should not call database services (D-14).
289	
290	## Don't Hand-Roll
291	
292	| Problem | Don't Build | Use Instead | Why |
293	|---------|-------------|-------------|-----|
294	| LLM-to-tool execution loop | Custom message dispatch loop | `@slide/agent-core` AgentRunner | 6 ported mechanisms (parallel tools, checkpointing, context budget, timeout layering, tracing, injection handling) -- each took months to stabilize in nanobot |
295	| Tool parameter validation | Hand-written validation per tool | `ToolRegistry.validateJsonSchema()` | Built-in JSON Schema validation with type coercion. Consistent error format that LLMs can understand and retry from. |
296	| WebSocket auth + connection management | Full custom WS protocol | Extracted shared layer from Gateway (option A) or minimal standalone (option B) | Current Gateway has working connect/handshake/auth/challenge implementation. If extracted, DirectAdapter reuses auth without duplicating OpenClaw-specific RPC handlers. |
297	| Context window management | Manual token counting and truncation | AgentRunner built-in microcompact + snip | Handles tool result compaction, orphan detection, and history truncation. Tuning knobs available. |
298	
299	**Key insight:** The most dangerous thing to hand-roll is the LLM-tool loop. The `AgentRunner` already handles 6 non-trivial edge cases that would be easy to miss in a custom implementation.
300	
301	## Runtime State Inventory
302	
303	> Phase 108 is a refactoring/migration phase. The following inventory identifies runtime state that references old file paths, import patterns, or service names.
304	
305	| Category | Items Found | Action Required |
306	|----------|-------------|------------------|
307	| Stored data | Chat history in MySQL (chat_messages table) -- references sessionKeys, not file paths | No data migration needed. The IAgentEngine interface takes sessionKey as-is. |
308	| Live service config | `OPENCLAW_STATE_DIR` env var in server.ts:7 -- used by config-sync.ts to write models.json to `~/.openclaw-slide/` | The config-sync logic moves into OpenClawAdapter. Env var stays. No data migration. |
309	| OS-registered state | None -- no OS-level registrations containing "gateway" or "openclaw" beyond env vars | None |
310	| Secrets/env vars | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, JWT stuff in .env | No key rename needed. DirectAdapter's LLMProvider implementation reads from env vars. |
311	| Build artifacts | `packages/agent-core/` -- already compiled separately. `apps/db-ops-api/` -- will need rebuild after file moves. | Run rebuild after file migrations (Plan 2). |
312	
313	**Nothing found in category:** No OS-registered state or stored data that references file paths or import patterns. All state is either in MySQL (data content) or environment variables (keys/config).
314	
315	## Common Pitfalls
316	
317	### Pitfall 1: LLMProvider Implementation Missing
318	**What goes wrong:** DirectAdapter cannot run because no `LLMProvider` implementation exists that wraps Anthropic/OpenAI SDK calls.
319	**Why it happens:** agent-core's `LLMProvider` interface requires `chat()` and `chatStream()` SDK-wrapping methods. Slide's existing provider configs (`llm/providers/*.ts`) are metadata-only (model names, base URLs, cost info) -- they do not implement LLMProvider. The template pattern in AI-SPEC Section 4b shows the AnthropicProvider stub, but it is not implemented.
320	**How to avoid:** This is the highest-priority technical risk for Plan 1. Build the `LLMProvider` implementation in parallel with the IAgentEngine interface. It takes ~100-200 lines per provider (Anthropic, then OpenAI/Ollama as needed).
321	**Warning signs:** DirectAdapter test files exist but cannot be run because `new DirectAdapter({ llmProvider })` has no provider to pass.
322	
323	### Pitfall 2: Streaming Event Translation Fidelity
324	**What goes wrong:** The adapter maps AgentHook callbacks to ChatEvent types but misses or misorders events. The frontend shows incomplete output or hangs.
325	**Why it happens:** The AgentHook interface has `onStream`, `onStreamEnd`, `beforeExecuteTools`, `afterIteration` -- each maps to different ChatEvent types. Missing `onStreamEnd` means no `complete` event. Ordering matters (tool_start before tool_result before complete).
326	**How to avoid:** Start by defining the ChatEvent type with strict discriminated unions. Unit test the hook-to-event mapping in isolation. Use the AdapterParityTestHarness to compare event sequences across adapters.
327	**Warning signs:** Chat starts streaming but never shows a "done" indicator. Tool calls appear in logs but not in the frontend.
328	
329	### Pitfall 3: Dead Code Removal Breaking Live Features
330	**What goes wrong:** Removing `handleAgentRequest`, `classifyIntent`, or `ALL_TOOL_DEFINITIONS` from `agent-service.ts` causes import errors in server.ts or other platform files.
331	**Why it happens:** CONTEXT.md D-31 lists what to delete, but the import graph must be verified first. server.ts currently imports `getAgentGreeting` from agent-service.ts (line 60). If other files import deleted exports, the build breaks.
332	**How to avoid:** Before Plan 1 cleanup, grep all files that import from agent-service.ts. Confirm the import graph matches D-31's assumptions. Compile-check after every deletion batch.
333	**Warning signs:** `npx tsc --noEmit` fails after dead code removal.
334	
335	### Pitfall 4: Feature Flag Toggle Mid-Session Inconsistency
336	**What goes wrong:** Toggling `ENABLE_AGENT_ADAPTER_CHAT` mid-conversation causes the new adapter to handle a request that references context from the old adapter's session state -- which the new adapter doesn't share.
337	**Why it happens:** Each adapter has its own in-memory session cache. Toggling switches which cache is read. Session history in MySQL is unaffected (chatDatabaseService stores messages), but in-memory agent state (current tool iteration, recent messages not yet persisted) is lost.
338	**How to avoid:** Feature flags only apply to NEW sessions. In-flight sessions complete on their original adapter. Document this as the expected behavior. The flag check should be at session creation time, not per-request.
339	**Warning signs:** Session continuity tests fail after adapter toggle. User reports "the assistant forgot what we were discussing."
340	
341	### Pitfall 5: WebSocket Transport for DirectAdapter Not Decided
342	**What goes wrong:** Plan 1 completes with interface + agent-core integration, but Plan 2 cannot proceed because the WebSocket transport strategy (D-25) is unresolved.
343	**Why it happens:** D-25 explicitly defers the decision to Plan level. But the choice affects server.ts (line 3528: `startGatewayServer`), the adapter's `start()` method, and whether shared protocol code is extracted.
344	**How to avoid:** Make the WebSocket decision early in the research phase (before Plan 1). Evaluate option A vs B with actual LOC estimates.
345	**Warning signs:** The adapter `start()` method signature is undefined because `adapter.start(...)` needs different arguments depending on the WebSocket approach.
346	
347	## Code Examples
348	
349	Verified patterns from existing codebase:
350	
351	### IAgentEngine Interface Definition
352	```typescript
353	// Source: CONTEXT.md D-01 through D-05 + AI-SPEC Section 4
354	// To be defined in: apps/db-ops-api/src/adapter/types.ts
355	
356	export type ChatEventType = 'text_delta' | 'tool_start' | 'tool_result' | 'tool_error' | 'complete' | 'error';
357	
358	export interface TextDeltaEvent { type: 'text_delta'; delta: string; }
359	export interface ToolStartEvent { type: 'tool_start'; toolName: string; args: Record<string, unknown>; }
360	export interface ToolResultEvent { type: 'tool_result'; toolName: string; result: unknown; }
361	export interface ToolErrorEvent { type: 'tool_error'; toolName: string; error: string; }
362	export interface CompleteEvent { type: 'complete'; finalContent?: string; }
363	export interface ErrorEvent { type: 'error'; error: string; }
364	
365	export type ChatEvent = TextDeltaEvent | ToolStartEvent | ToolResultEvent | ToolErrorEvent | CompleteEvent | ErrorEvent;
366	
367	export interface AgentCapabilities {
368	  streaming: boolean;
369	  toolCalling: boolean;
370	  maxContextTokens: number;
371	  supportsCustomSystemPrompt: boolean;
372	}
373	
374	export interface ChatResult {
375	  finalContent: string | null;
376	  usage?: Record<string, number>;
377	}
378	
379	export interface InvokeResult {
380	  content: string | null;
381	  usage?: Record<string, number>;
382	}
383	
384	export interface IAgentEngine {
385	  chat(sessionKey: string, message: string, onEvent: (event: ChatEvent) => void): Promise<ChatResult>;
386	  invoke(sessionKey: string, message: string, systemPrompt?: string): Promise<InvokeResult>;
387	  listTools(): ToolSchema[];
388	  capabilities(): AgentCapabilities;
389	}
390	
391	// ToolSchema is reused from @slide/agent-core types
392	import type { ToolSchema } from '@slide/agent-core';
393	```
394	
395	### DirectAdapter -- chat() implementation pattern
396	```typescript
397	// Source: AI-SPEC Section 4 implementation guidance
398	// Uses AgentRunner internally with a streaming hook
399	import { AgentRunner, ToolRegistry, NoopHook } from '@slide/agent-core';
400	import type { LLMProvider, AgentHook, AgentHookContext } from '@slide/agent-core';
401	
402	class DirectAdapter implements IAgentEngine {
403	  private runner: AgentRunner;
404	  private registry: ToolRegistry;
405	  private sessions: Map<string, Message[]>;
406	
407	  constructor(opts: { tools: ToolRegistry; llmProvider: LLMProvider }) {
408	    this.runner = new AgentRunner(opts.llmProvider);
409	    this.registry = opts.tools;
410	    this.sessions = new Map();
411	  }
412	
413	  async chat(sessionKey: string, message: string, onEvent: (e: ChatEvent) => void): Promise<ChatResult> {
414	    let history = this.sessions.get(sessionKey) || [];
415	    history.push({ role: 'user' as const, content: message });
416	
417	    const hook: AgentHook = {
418	      wantsStreaming: () => true,
419	      beforeIteration: async () => {},
420	      onStream: async (_ctx, delta) => { onEvent({ type: 'text_delta', delta }); },
421	      onStreamEnd: async (_ctx, _resuming) => {},
422	      beforeExecuteTools: async (ctx) => {
423	        for (const tc of ctx.toolCalls) {
424	          onEvent({ type: 'tool_start', toolName: tc.name, args: tc.arguments });
425	        }
426	      },
427	      emitReasoning: async () => {},
428	      emitReasoningEnd: async () => {},
429	      afterIteration: async (ctx) => {
430	        // Map tool results from ctx
431	        for (const te of ctx.toolEvents) {
432	          if (te.status === 'ok') {
433	            onEvent({ type: 'tool_result', toolName: te.name, result: te.detail });
434	          } else {
435	            onEvent({ type: 'tool_error', toolName: te.name, error: te.detail });
436	          }
437	        }
438	      },
439	      finalizeContent: (_ctx, content) => content,
440	    };
441	
442	    try {
443	      const result = await this.runner.run({
444	        initialMessages: history,
445	        tools: this.registry,
446	        model: provider.getDefaultModel(),
447	        maxIterations: 10,
448	        maxToolResultChars: 20000,
449	        hook,
450	        contextWindowTokens: 200_000,
451	        maxTokens: 4096,
452	      });
453	
454	      history.push({ role: 'assistant' as const, content: result.finalContent });
455	      onEvent({ type: 'complete', finalContent: result.finalContent ?? undefined });
456	      return { finalContent: result.finalContent, usage: result.usage };
457	    } catch (err) {
458	      onEvent({ type: 'error', error: err instanceof Error ? err.message : String(err) });
459	      throw err;
460	    }
461	  }
462	}
463	```
464	
465	### Adapter Parity Test Harness
466	```typescript
467	// Source: AI-SPEC Section 5 -- adapter parity testing pattern
468	// To be defined in: apps/db-ops-api/src/adapter/__tests__/adapter-parity.ts
469	// Used for Plan 3 dual-run validation
470	
471	class AdapterParityTestHarness {
472	  constructor(private adapterA: IAgentEngine, private adapterB: IAgentEngine) {}
473	
474	  async assertToolParity(): Promise<void> {
475	    const toolsA = this.adapterA.listTools().sort((a, b) => a.name.localeCompare(b.name));
476	    const toolsB = this.adapterB.listTools().sort((a, b) => a.name.localeCompare(b.name));
477	
478	    assert.strictEqual(toolsA.length, toolsB.length, `Tool count mismatch`);
479	    for (let i = 0; i < toolsA.length; i++) {
480	      assert.deepStrictEqual(toolsA[i], toolsB[i], `Tool ${toolsA[i].name} schema mismatch`);
481	    }
482	  }
483	}
484	```
485	
486	### getOpenClawRuntime() -- the current singleton pattern to replace
487	```typescript
488	// Source: apps/db-ops-api/src/gateway/openclaw-runtime.ts (lines 257-268)
489	// This EXACT pattern is replicated for getAgentEngine()
490	let openClawRuntime: { config: OpenClawConfig; tools: ReturnType<typeof createOpenClawTools> } | null = null;
491	
492	export async function getOpenClawRuntime() {
493	  if (!openClawRuntime) {
494	    openClawRuntime = await initializeOpenClawRuntime();
495	  }
496	  return openClawRuntime;
497	}
498	```
499	
500	### Platform chat.send RPC handler -- the integration point to rewrite
501	```typescript
502	// Source: apps/db-ops-api/src/gateway/chat-methods.ts (lines 74-341)
503	// The handleChatSend function currently:
504	// 1. Imports dispatchInboundMessage directly from OpenClaw source (line 18)
505	// 2. Creates MsgContext via OpenClaw types
506	// 3. Creates ReplyDispatcher via OpenClaw
507	// After Phase 108, this function:
508	// 1. Imports getAgentEngine() from adapter layer
509	// 2. Calls agent.chat(sessionKey, message, onEvent)
510	// 3. Persists results via chatDatabaseService
511	// The message validation and persistence logic is KEPT in the platform handler.
512	// Only the dispatch mechanism changes.
513	```
514	
515	### Platform invoke() caller -- the AI analysis bridge
516	```typescript
517	// Source: apps/db-ops-api/src/ai-agent-bridge.ts (lines 43-53)
518	// Currently calls sendGatewayChat via WebSocket to port 28789:
519	//   sendGatewayChat({ sessionKey, message: fullMessage }).catch(err => {...})
520	//
521	// After migration, calls agent.invoke():
522	//   const engine = await getAgentEngine();
523	//   engine.invoke(sessionKey, fullMessage, systemPrompt)
524	//     .then(result => { /* save result */ })
525	//     .catch(err => { /* fail analysis */ });
526	```
527	
528	## State of the Art
529	
530	| Old Approach | Current Approach | When Changed | Impact |
531	|--------------|------------------|--------------|--------|
532	| Platform code imports OpenClaw directly (`../../src/auto-reply/dispatch.js`) | Platform code imports `getAgentEngine()` from adapter layer | Phase 108 | Platform code is decoupled from implementation. Can swap adapters without changing platform imports. |
533	| `openclaw-runtime.ts` builds full OpenClawConfig | OpenClawAdapter encapsulates all OpenClaw config internally | Phase 108 | OpenClaw-specific config (agent model, workspace, tools) no longer leaks into platform |
534	| `chat-methods.ts` creates MsgContext + ReplyDispatcher | chat-methods.ts calls `agent.chat()` with IAgentEngine interface | Phase 108 | Platform handler only does validation, streaming event forwarding, and persistence -- no OpenClaw internals |
535	| `sendGatewayChat()` uses WebSocket to port 28789 | `agent.invoke()` calls adapter directly in-process | Phase 108 | No network hop for AI analysis tasks. Latency drops from ~50ms to ~1ms per invocation. |
536	| `agent-service.ts` has 861 lines with tool definitions and agent logic | agent-service.ts trimmed to `getAgentGreeting()` only (~5 lines) | Phase 108 | Tool definitions move to catalog.ts. Agent logic moves to adapters. |
537	
538	**Deprecated/outdated:**
539	- `@mariozechner/pi-agent-core` tools (read, write, bash, etc.) -- used by agent-service.ts `executeBaseTool()`, but pi-agent base tools are deprecated in favor of OpenClaw or platform-native tool implementations
540	
541	## Assumptions Log
542	
543	| # | Claim | Section | Risk if Wrong |
544	|---|-------|---------|---------------|
545	| A1 | No platform code outside of `src/gateway/` imports OpenClaw directly (besides server.ts lines 71-72) | Architecture | Missing imports would break CI after D-28 file moves. Must grep-verify before Plan 2. |
546	| A2 | `agent-service-v2.ts` (351 lines) is truly dead -- no file imports it | Dead Code | If something imports it, Plan 1 deletion breaks build. Verified by D-31 but should double-check via grep. |
547	| A3 | `sendMessageToAgent` from openclaw-bridge.ts is truly dead | Dead Code | Same as A2. Verified by D-31, should grep-verify. |
548	| A4 | The `@slide/agent-core` build target (ES2022 + NodeNext) is compatible with the main app's TSConfig | Standard Stack | If module resolution differs, import errors occur. Currently both use NodeNext. |
549	| A5 | The existing `llm-service-openclaw.ts` does not exist / has been replaced by `llm-service.ts` | LLMProvider | If `llm-service-openclaw.ts` exists with different interface, DirectAdapter might need its own provider wrapper. |
550	
551	## Open Questions (RESOLVED)
552	
553	1. **RESOLVED: LLMProvider implementation for DirectAdapter -- where to start?**
554	   - What we know: agent-core defines `LLMProvider` interface with `chat()` and `chatStream()`. Slide has provider config files (aliyun-bailian, deepseek, ollama, etc.) that are config-only. No SDK-wrapping provider exists.
555	   - What's unclear: Should we build a single AnthropicProvider first (targeting `claude-sonnet-4-20250929` as the default chat model), or build a provider factory that reuses existing provider configs? The simplest path is a standalone AnthropicProvider that reads `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` from env vars -- like the pattern shown in AI-SPEC Section 3 entry point example.
556	   - Decision: Build AnthropicProvider in Plan 1. It needs Anthropic SDK for streaming. OpenAI provider can be added later.
557	
558	2. **RESOLVED: WebSocket transport for DirectAdapter -- option A or B?**
559	   - What we know: Option A extracts WS framework from Gateway into `gateway/shared/` (connection management, auth challenge, protocol types). Option B ships a ~100 line minimal WS server inside DirectAdapter.
560	   - What's unclear: Option A requires untangling Gateway server into shared parts (framework) and OpenClaw-specific parts (RPC handlers). Option B duplicates auth logic and protocol handling. Neither is trivially quick.
561	   - Decision: Choose **Option B** for Phase 108. A ~100 line standalone WS server in DirectAdapter is cheaper to build and maintain than refactoring Gateway. Port the existing `handleConnect` auth logic (~50 lines from server.ts:193-328) into a reusable function. The Gateway stays unchanged for OpenClawAdapter. DirectAdapter.start() spins up this minimal WS transport eagerly so the frontend Chat always has a WebSocket endpoint.
562	
563	3. **RESOLVED: Session persistence ownership -- adapter vs platform boundary?**
564	   - What we know: D-14 states session management is platform infrastructure. chatDatabaseService should be called by the platform, not the adapter.
565	   - What's unclear: For DirectAdapter's `.chat()`, the adapter loads session history from the platform (passed in, or loaded by adapter?), runs the agent loop, and returns the result. The platform saves to MySQL. But "load history" means either the platform passes `Message[]` to the adapter, or the adapter calls a callback to persist messages mid-run.
566	   - Decision: The platform passes `systemPrompt: string` and `history: Message[]` as parameters to `chat()`. The adapter uses them as initial messages and returns the updated messages (including tool results) as part of `ChatResult`. The platform persists after `chat()` returns. This keeps the adapter stateless between calls.
567	
568	4. **RESOLVED: Feature flag awareness -- how do platform handlers know which adapter to use?**
569	   - What we know: D-29 defines two flags: `ENABLE_AGENT_ADAPTER_CHAT` and `ENABLE_AGENT_ADAPTER_ANALYSIS`.
570	   - What's unclear: Do the flags live in environment variables or in a config database? Do they control adapter selection at the `getAgentEngine()` factory level, or is there an `AdapterSelector` that routes individual calls?
571	   - Decision: Simple approach -- both flags are env vars. If unset, default to DirectAdapter (new behavior, matching D-06). The `getAgentEngine()` factory checks both flags separately, potentially returning different adapters per capability. Chat method checks `ENABLE_AGENT_ADAPTER_CHAT`; ai-agent-bridge checks `ENABLE_AGENT_ADAPTER_ANALYSIS`. Each adapter can be independently active.
572	
573	## Environment Availability
574	
575	| Dependency | Required By | Available | Version | Fallback |
576	|------------|------------|-----------|---------|----------|
577	| Node.js | All adapter code | yes | v22.x (estimated) | -- |
578	| TypeScript | Type compilation | yes | (via npx) | -- |
579	| ws | WebSocket server/client | yes | (in node_modules) | -- |
580	| Anthropic SDK | DirectAdapter LLMProvider | yes | (existing dep?) | OpenAI SDK as fallback |
581	| @slide/agent-core | DirectAdapter runtime | yes | 0.1.0 workspace | OpenClawAdapter (legacy path) |
582	
583	**Missing dependencies with no fallback:** None identified. All dependencies are either existing workspace packages or standard npm libraries already in use.
584	
585	**Missing dependencies with fallback:** Anthropic SDK for DirectAdapter -- if not installed, the adapter can use OpenAI SDK with function-calling-compatible models as first fallback, or fall through to OpenClawAdapter which uses the existing OpenClaw dispatch pipeline.
586	
587	## Validation Architecture
588	
589	### Test Framework
590	| Property | Value |
591	|----------|-------|
592	| Framework | vitest (existing in project) |
593	| Config file | (project-level vitest config) |
594	| Quick run command | `npx vitest run apps/db-ops-api/src/adapter/__tests__/` |
595	| Full suite command | `npx vitest run --reporter=verbose apps/db-ops-api/src/adapter/__tests__/` |
596	
597	### Phase Requirements -> Test Map
598	| Req ID | Behavior | Test Type | Automated Command | File Exists? |
599	|--------|----------|-----------|-------------------|-------------|
600	| MIG-01 | IAgentEngine interface compiles | unit | `npx tsc --noEmit` | -- (type check only) |
601	| MIG-01 | .chat() returns ChatResult for streaming input | integration | vitest adapter test | -- (needs writing) |
602	| MIG-01 | .invoke() returns InvokeResult for fire-and-forget | integration | vitest adapter test | -- (needs writing) |
603	| MIG-01 | .listTools() returns tools from catalog.ts | unit | vitest adapter-parity | -- (needs writing) |
604	| MIG-01 | No OpenClaw imports in platform code | smoke | grep "openclaw" src/ --exclude=adapter/ | -- (grep check) |
605	| MIG-01 | Dual-run chat comparison (Plan 3) | integration | vitest adapter-parity | -- (needs writing) |
606	
607	### Sampling Rate
608	- **Per task commit:** `npx vitest run apps/db-ops-api/src/adapter/__tests__/ -t "IAgentEngine"` (quick subset)
609	- **Per wave merge:** Full adapter test suite + type check
610	- **Phase gate:** Full suite green before `/gsd:verify-work`
611	
612	### Wave 0 Gaps
613	- [ ] `apps/db-ops-api/src/adapter/__tests__/adapter-parity.ts` -- AdapterParityTestHarness
614	- [ ] `apps/db-ops-api/src/adapter/__tests__/direct-adapter.test.ts` -- DirectAdapter unit tests
615	- [ ] `apps/db-ops-api/src/adapter/__tests__/openclaw-adapter.test.ts` -- rewritten from openclaw-integration.test.ts
616	- [ ] `apps/db-ops-api/src/adapter/__tests__/ia-agent-engine.test.ts` -- interface compliance tests (mock adapter)
617	
618	## Security Domain
619	
620	### Applicable ASVS Categories
621	| ASVS Category | Applies | Standard Control |
622	|---------------|---------|-----------------|
623	| V2 Authentication | yes | Gateway WebSocket connect/handshake auth (username+password or session token) -- reused or ported from existing Gateway server.ts:193-328 |
624	| V3 Session Management | yes | Session tokens stored in-memory Map with 24h expiry. Token rotation on each connect. |
625	| V4 Access Control | no | Access control is platform-level (rbac-service.ts, requireInstanceAccess). Adapter layer is a passthrough. |
626	| V5 Input Validation | yes | Tool parameters validated by ToolRegistry.validateJsonSchema() before reaching handler |
627	| V6 Cryptography | no | No cryptographic operations in the adapter layer |
628	
629	### Known Threat Patterns for ts-agent-core/WebSocket
630	| Pattern | STRIDE | Standard Mitigation |
631	|---------|--------|---------------------|
632	| Unauthenticated WebSocket connection | Spoofing | Connect/handshake with username+password or session token (already implemented in Gateway server.ts:193-328) |
633	| Tool handler injection via malformed params | Tampering | ToolRegistry JSON Schema validation runs before every tool execute(). Invalid params rejected with error string. |
634	| Unbounded LLM invocation (cost attack) | Denial of Service | AgentRunner maxIterations=10 default. Context governance (microcompact+snip) limits token usage. |
635	| DirectAdapter bypassing RBAC | Elevation of Privilege | DirectAdapter is in-process and uses same service instances. RBAC is handled at the platform API layer, not the adapter. |
636	
637	## Sources
638	
639	### Primary (HIGH confidence)
640	- [packages/agent-core/src/] - AgentRunner (959 lines), ToolRegistry (297 lines), Types (215 lines), Index (55 lines). Compiled cleanly.
641	- [apps/db-ops-api/src/gateway/server.ts] - WebSocket Gateway server (533 lines). Auth, connect, RPC handler, event broadcast.
642	- [apps/db-ops-api/src/gateway/chat-methods.ts] - chat.send + chat.history RPC handlers (358 lines). Current dispatchInboundMessage integration.
643	- [apps/db-ops-api/src/gateway/openclaw-runtime.ts] - OpenClaw config + singleton (268 lines). Pattern to replicate.
644	- [apps/db-ops-api/src/gateway/gateway-client.ts] - WebSocket sendGatewayChat (49 lines). Used by ai-agent-bridge.
645	- [apps/db-ops-api/src/ai-agent-bridge.ts] - AI analysis dispatch (64 lines). Current sendGatewayChat call.
646	- [apps/db-ops-api/src/agent-service.ts] - Agent tools + handler (861 lines). Dead code to trim.
647	- [apps/db-ops-api/src/agent-service-v2.ts] - Dead code (351 lines). Delete.
648	- [apps/db-ops-api/src/tools/catalog.ts] - Tool registry (394 lines). Single entry point for tool definitions.
649	- [apps/db-ops-api/src/tools/types.ts] - Tool type definitions (233 lines). AnyAgentTool interface.
650	- [apps/db-ops-api/server.ts] - Server entry (3893 lines). Lines 60, 71-72, 3509-3533 are integration points.
651	- [apps/db-ops-api/src/llm/config-sync.ts] - LLM config sync (157 lines). Move to adapter.
652	- [apps/db-ops-api/src/gateway/protocol.ts] - WS protocol types (286 lines). Shared parts to extract.
653	- [apps/db-ops-api/src/gateway/error-codes.ts] - Error codes (111 lines). Shared parts to extract.
654	- [apps/db-ops-api/src/gateway/openclaw-bridge.ts] - OpenClaw adapter compat layer (140 lines). Partial dead code.
655	- [apps/db-ops-api/src/gateway/streaming.ts] - Streaming response handler (259 lines). Move to adapter.
656	- [apps/db-ops-api/src/gateway/config-service.ts] - Config file management (245 lines). Move to adapter.
657	- [apps/db-ops-api/src/gateway/openclaw-integration.test.ts] - Existing tests (56 lines). Rewrite.
658	- [appls/db-ops-api/src/llm/config-sync.ts] - LLM sync (157 lines). Move to adapter.
659	- [.planning/phases/108-agent/108-CONTEXT.md] - 36 decisions (D-01 through D-32), canonical references
660	- [.planning/phases/108-agent/108-AI-SPEC.md] - Framework selection, implementation guidance, evaluation strategy (5 dimensions), guardrails
661	- [.planning/REQUIREMENTS.md] - MIG-01 requirement definition
662	- [.planning/STATE.md] - Project state, phase progress
663	
664	### Secondary (MEDIUM confidence)
665	- [.planning/phases/106-指标采集可配置化/106-CONTEXT.md] - Registry<T> pattern reference (Phase 106 D-02)
666	- [.planning/phases/107-实例详情页指标动态化/107-CONTEXT.md] - Dynamic metrics architecture (Phase 108 dependency)
667	
668	## Metadata
669	
670	**Confidence breakdown:**
671	- Standard stack: HIGH -- agent-core compiles cleanly, interface design fully specified
672	- Architecture: HIGH -- 3-plan execution order, file migration targets, and integration points all identified
673	- Pitfalls: HIGH -- based on direct codebase inspection and documented patterns from CONTEXT.md/AI-SPEC
674	
675	**Research date:** 2026-05-25
676	**Valid until:** 2026-06-25 (30 days -- codebase changes could affect import graph assumptions)
