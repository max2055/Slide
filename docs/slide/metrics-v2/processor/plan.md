# Counter 与派生执行实施计划（MAX-66）

> **Execution:** 在已有实施授权及仓库规则内执行；验收使用确定性 fixture，不委派子代理。

**Goal:** 在 MAX-64 的 1.0.0 契约上提供单位转换、counter delta/rate、受限派生 DAG 和基线状态适配契约。

**Architecture:** 纯函数计算与持久化分离。整数/单位换算/中间算术使用 BigInt 有理数，最后按定义编码；状态按序列锁定，并携带来源、版本、累计周期签名。窗口、新鲜度及输入版本放在计算结果 envelope，保持冻结的 NormalizedObservation 不变。

**Tech Stack:** TypeScript、现有 Zod 契约、Vitest。

## 执行契约 v1

- 基线 main `980d236d62533423d7fad811dd01e69c2337d588`，MAX-64 PR #76 已合并；分支 `agent/15astra/max66-processor`。
- 排除厂家响应解析、模板实际接入（MAX-67）、数据库/调度/双 worker 集成（MAX-70）、全链路（MAX-76）、生产发布及无关重构。
- 硬预算未设定；实际 input/cached input/output/费用遥测不可用；子代理 0、深度 0、并发峰值 1。
- 停止条件：依赖不成立、冻结契约无法兼容或缺少外部授权时停止受影响步骤；既定验收通过后交付 PR，不等待外部 CI。

## 实施与验收

1. `apps/db-ops-api/src/metrics-v2/arithmetic.ts`：规范有理数及单位白名单；测试 s/ms、By/s 与 bit/s、% 与 1、单位冲突、超过 2^53 和不可精确编码。
2. `observation.ts`：复用契约验证和幂等 ID；输出 NormalizedObservation，传播最差质量/准确性、最旧输入 freshness、时间窗口和来源版本。schema 保持不变。
3. `counter.ts`、`state.ts`：纯基线转移与 CAS/fencing 接口。测试首样本、真实时间差、重复/乱序、来源切换再切回、重启、转换版本、长缺口、维度分离、32 位有证据的单次 wrap/不确定多次 wrap、64 位大数；异常输入不推进有效基线。
4. `derived.ts`：复用 validateDerived 校验，拓扑执行 sum/difference/scale/ratio/rate；拒绝未知依赖/循环/多源，检查资源与维度、时间偏差及窗口，失败产生 null 不造零；精确派生仍 exact。
5. `processor.test.ts` 加载 `docs/slide/metrics-v2/processor/fixtures.json`，验证数值、reason、状态、血缘和 schema。记录状态所有权、重放、窗口/版本传播规则与回退方式。
6. 开发运行 `pnpm --filter slide-api exec vitest run src/metrics-v2/processor.test.ts`；阶段运行契约及处理器测试；最终运行后端 test/typecheck、定向 oxlint、`pnpm contracts:check`、MAX-63 fixture 校验和必需目录门禁 `pnpm --filter slide-api exec vitest run tests/phase-94-docs-structure.test.ts`。只修复范围内失败，报告实际结果。

## 设计取舍

复用旧采集器算法会保留多套规则；直接接入数据库会越过独立关闭边界；选择独立纯计算模块并复用已冻结验证器。禁止 eval/脚本表达式，仅开放契约中的五个操作。无可靠单次回绕证据时返回 null；不通过猜测最大速率恢复值。
