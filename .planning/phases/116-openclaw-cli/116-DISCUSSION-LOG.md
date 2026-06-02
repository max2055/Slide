# Phase 116 Discussion Log

**Phase:** 116 — 去 OpenClaw 运行时引用
**Date:** 2026-06-02
**Mode:** discuss

## Areas Discussed

### 1. CLI 依赖调查
**Question:** 前端是否仍在运行时实际调用 openclaw CLI？
**Finding:** `update-startup.ts` 是唯一会 spawn 进程的文件，但它只被 `import type` 引用，且导入了 5 个不存在的模块。`tool-display-exec.ts` 的 "run openclaw" 是显示文本，不执行。绝大部分 CLI 引用是死代码或 UI 文本。
**Decision:** 删除死代码，重命名显示文本和运行时标识。

### 2. Naming / Branding 配置
**Question:** 用什么名字替代 openclaw？
**Decision:** 创建集中配置 `branding.ts`，初始值使用 `slide`。后续可随时改名。
**Rationale:** 避免硬编码，单一配置源控制所有运行时标识。

### 3. update-startup.ts 死代码
**Question:** 如何处理？
**Decision:** 直接删除 `update-startup.ts`，清理 2 个 type import 引用。
**Rationale:** 文件无法运行（依赖不存在），仅被 type import 引用，删除无副作用。

### 4. 环境变量兼容性
**Question:** 要不要 fallback 支持旧名？
**Decision:** 干净切割，只认新名，不做 fallback。
**Rationale:** update-startup.ts 已删除，旧 env var 已无消费者。直接切换减少维护负担。

### 5. 测试文件
**Question:** 测试中的 OPENCLAW_* 也一起改？
**Decision:** 一起改，保证统一。
