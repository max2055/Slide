---
phase: 108-agent
plan: 01
subsystem: adapter
tags:
  - IAgentEngine
  - DirectAdapter
  - AnthropicProvider
  - LLMProvider
  - WebSocket
  - dead-code-cleanup
requires: []
provides:
  - IAgentEngine interface contract (adapter/types.ts)
  - ChatEvent discriminated union (6 variants)
  - AnthropicProvider (LLMProvider implementation)
  - DirectAdapter (IAgentEngine implementation with WS transport)
  - getAgentEngine() lazy singleton factory
  - AdapterParityTestHarness (cross-adapter comparison)
  - Shared protocol types (adapter/shared/protocol-types.ts)
  - Shared error codes (adapter/shared/error-codes.ts)
affects:
  - apps/db-ops-api/src/adapter/types.ts (NEW)
  - apps/db-ops-api/src/adapter/llm-provider.ts (NEW)
  - apps/db-ops-api/src/adapter/direct-adapter.ts (NEW)
  - apps/db-ops-api/src/adapter/get-agent-engine.ts (NEW)
  - apps/db-ops-api/src/adapter/__tests__/ (NEW)
  - apps/db-ops-api/src/agent-service.ts (TRIMMED)
  - apps/db-ops-api/src/agent-service-v2.ts (DELETED)
  - apps/db-ops-api/src/gateway/openclaw-bridge.ts (CLEANED)
  - apps/db-ops-api/src/adapter/shared/ (NEW)
tech-stack:
  added:
    - '@slide/agent-core' workspace package (symlinked)
  patterns:
    - Lazy singleton factory (getAgentEngine)
    - Adapter pattern (IAgentEngine interface)
    - Minimal WS transport (D-25 Option B)
key-files:
  created:
    - apps/db-ops-api/src/adapter/types.ts (142 lines)
    - apps/db-ops-api/src/adapter/llm-provider.ts (255 lines)
    - apps/db-ops-api/src/adapter/direct-adapter.ts (259 lines)
    - apps/db-ops-api/src/adapter/get-agent-engine.ts (53 lines)
    - apps/db-ops-api/src/adapter/__tests__/adapter-parity.ts
    - apps/db-ops-api/src/adapter/__tests__/ia-agent-engine.test.ts
    - apps/db-ops-api/src/adapter/__tests__/direct-adapter.test.ts
    - apps/db-ops-api/src/adapter/shared/protocol-types.ts (117 lines)
    - apps/db-ops-api/src/adapter/shared/error-codes.ts (90 lines)
  modified:
    - apps/db-ops-api/src/agent-service.ts (861 -> 25 lines)
    - apps/db-ops-api/src/gateway/openclaw-bridge.ts (removed sendMessageToAgent)
    - apps/db-ops-api/vitest.config.ts (added @slide/agent-core alias)
    - apps/db-ops-api/package.json (added @slide/agent-core dependency)
    - apps/db-ops-api/node_modules/@slide/agent-core (symlink)
  deleted:
    - apps/db-ops-api/src/agent-service-v2.ts (351 lines)
decisions:
  - '@slide/agent-core' resolved via symlink instead of pnpm install (patch file issue)
  - DirectAdapter WS transport uses D-25 Option B (minimal standalone ~80 lines)
  - ES2022 + bundler moduleResolution compatible with agent-core workspace package
metrics:
  duration: 30 min
  files_created: 9
  files_modified: 3
  files_deleted: 1
  tests_passing: 22
---

# Phase 108 Plan 1: IAgentEngine Interface + DirectAdapter + Dead Code Cleanup

**One-liner:** 定义 IAgentEngine 接口契约（含 .start() WS 传输层），实现 DirectAdapter（包装 @slide/agent-core AgentRunner），接入 AnthropicProvider LLM 实现，完成死代码清理和共享层提取。

## Tasks Completed

### Task 1: IAgentEngine 接口 + ChatEvent 类型 + 测试支架

**What:** 创建了 adapter/types.ts 定义 IAgentEngine 接口（5 个方法：start, chat, invoke, listTools, capabilities）、ChatEvent 联合类型（6 个变体）、AgentCapabilities/ChatResult/InvokeResult。创建了 AdapterParityTestHarness 和 10 个接口合规性测试。

**Key details:**
- ToolSchema 从 @slide/agent-core 导入（非 tools/types.ts）
- start() 幂等——重复调用不重复启动
- ChatEvent 6 变体: text_delta, tool_start, tool_result, tool_error, complete, error
- IAgentEngine 接口设计兼容 WebSocket/HTTP/进程内传输
- start() 方法用于 server.ts 启动后确保 WS 端口就绪

**Commit:** 3e8b14e5031

### Task 2: AnthropicProvider + DirectAdapter + getAgentEngine() 工厂

**What:** 创建了 AnthropicProvider（实现 @slide/agent-core LLMProvider，包装 Anthropic SDK），DirectAdapter（实现 IAgentEngine 接口，包装 AgentRunner，含 D-25 Option B 最小 WS 传输层），getAgentEngine() 懒加载单例工厂，12 个 DirectAdapter 测试。

**Key details:**
- AnthropicProvider: 从 ANTHROPIC_API_KEY/ANTHROPIC_MODEL 环境变量读取配置
- DirectAdapter.start(): 在 AGENT_WS_PORT（默认 28789）创建 WebSocketServer，支持 chat.send 和 chat.history RPC
- DirectAdapter.chat(): 流式会话，通过 AgentHook 映射到 ChatEvent
- DirectAdapter.invoke(): 非流式单次执行，使用 NoopHook
- getAgentEngine(): 与现有 getOpenClawRuntime() 一致的单例工厂模式
- MockLLMProvider 用于测试（无真实 SDK 调用）

**Commit:** 8949fd0ad85

### Task 3: 死代码清理 + 共享层提取

**What:** agent-service.ts 从 861 行缩减到 25 行（仅 AGENT_GREETING + getAgentGreeting），删除 agent-service-v2.ts，清理 openclaw-bridge.ts，创建 adapter/shared/ 共享类型和错误码。

**Key details:**
- agent-service.ts: 删除 ALL_TOOL_DEFINITIONS, handleAgentRequest, classifyIntent, OPS_SYSTEM_PROMPTS, executeTool, 所有工具实现, OpenAI/pi-agent-core 等 import
- agent-service-v2.ts: 完全删除（无人 import）
- openclaw-bridge.ts: 删除 agent-service import 和 sendMessageToAgent 函数
- adapter/shared/protocol-types.ts: 从 gateway/protocol.ts 提取非 OpenClaw 通用 WS 协议类型
- adapter/shared/error-codes.ts: 从 gateway/error-codes.ts 提取非 OpenClaw 错误码常量
- gateway/protocol.ts 和 gateway/error-codes.ts 本身未修改

**Commit:** a915859c9b4

## Verification

### Test Results

```
 Test Files  2 passed (2)
      Tests  22 passed (22)
```

### TypeScript Compilation

Zero adapter-specific errors in `tsc --noEmit`.

### Dead Code Verification

- Zero references to handleAgentRequest, classifyIntent, ALL_TOOL_DEFINITIONS, executeTool in src/
- agent-service-v2.ts confirmed deleted
- openclaw-integration.ts already absent (not in gateway directory)
- agent-service.ts exports ONLY AGENT_GREETING and getAgentGreeting

### Must-Have File Sizes

| File | Lines | Required | Status |
|------|-------|----------|--------|
| adapter/types.ts | 142 | >= 85 | PASS |
| adapter/llm-provider.ts | 255 | >= 120 | PASS |
| adapter/direct-adapter.ts | 259 | >= 200 | PASS |
| adapter/get-agent-engine.ts | 53 | >= 30 | PASS |
| adapter/shared/protocol-types.ts | 117 | >= 30 | PASS |
| adapter/shared/error-codes.ts | 90 | >= 30 | PASS |

## Deviations from Plan

### Rule 2 - Missing Critical Functionality

**1. Added `dispose()` method to DirectAdapter**
- **Found during:** Task 2 test writing
- **Issue:** WS server from test was left running on port, causing EADDRINUSE errors in subsequent tests
- **Fix:** Added `dispose()` method on DirectAdapter to close the WS server for test cleanup
- **Files modified:** apps/db-ops-api/src/adapter/direct-adapter.ts
- **Commit:** 8949fd0ad85

### Rule 2 - Missing Infrastructure Setup

**2. @slide/agent-core package resolution**
- **Found during:** Task 1 compilation
- **Issue:** `@slide/agent-core` workspace package not linked in node_modules (pnpm install failed due to missing patch file)
- **Fix:** Created symlink in apps/db-ops-api/node_modules/@slide/agent-core + added vitest resolve alias + added workspace:* to package.json
- **Files modified:** apps/db-ops-api/vitest.config.ts, apps/db-ops-api/package.json
- **Commit:** 3e8b14e5031

### Plan Detail Adjustments

**3. Protocol `ContentBlockParam` type fix in llm-provider.ts**
- **Found during:** Task 2 tsc compilation
- **Issue:** Anthropic SDK exports `ToolUseBlockParam` and `ToolResultBlockParam` (not `ContentBlockParam`)
- **Fix:** Updated llm-provider.ts to use correct SDK type names
- **Files modified:** apps/db-ops-api/src/adapter/llm-provider.ts
- **Commit:** 8949fd0ad85

## Success Criteria

| Criterion | Status |
|-----------|--------|
| IAgentEngine 接口定义完整（含 .start() 方法） | PASS |
| AnthropicProvider 实现 LLMProvider | PASS |
| DirectAdapter 通过 getAgentEngine() 工厂可实例化 | PASS |
| start() 启动 WS 传输层 | PASS (port 28789, idempotent) |
| chat() 产生事件序列 | PASS |
| invoke() 返回结果 | PASS |
| agent-service.ts 缩减到仅保留 getAgentGreeting + AGENT_GREETING | PASS (861 -> 25 lines) |
| agent-service-v2.ts 已删除 | PASS |
| openclaw-bridge.ts 精简（sendMessageToAgent 删除） | PASS |
| adapter/shared/ 包含通用类型和错误码 | PASS |
| 22 个测试全部通过 | PASS |
| tsc --noEmit 编译通过（adapter 文件无错误） | PASS |

## Threat Surface Scan

No new security-relevant surface introduced beyond plan's threat model:
- DirectAdapter.start() WS transport matches T-108-01 disposition (mitigated by idempotency guard)
- AnthropicProvider error wrapping matches T-108-03 disposition (generic error messages)
- AgentRunner constraints match T-108-04 disposition (maxIterations=10)
- No new packages installed (agent-core is workspace, already compiled)

## Self-Check: PASSED

- [x] types.ts exists (142 lines), exports IAgentEngine, ChatEvent, AgentCapabilities, ChatResult, InvokeResult
- [x] llm-provider.ts exists (255 lines), exports AnthropicProvider
- [x] direct-adapter.ts exists (259 lines), exports DirectAdapter
- [x] get-agent-engine.ts exists (53 lines), exports getAgentEngine
- [x] protocol-types.ts exists (117 lines), exports shared WS types
- [x] error-codes.ts exists (90 lines), exports shared error constants
- [x] agent-service-v2.ts confirmed deleted
- [x] agent-service.ts exports only AGENT_GREETING and getAgentGreeting
- [x] openclaw-bridge.ts no longer imports from agent-service.ts
- [x] 22 tests pass
- [x] Zero dead code references remaining
- [x] All 3 commits exist (3e8b14e, 8949fd0, a915859)
