# MAX-75 验证记录

执行分支：`agent/15astra/de4cc83cb4de`。基线：main `9ec6eae`。实现、fixture、截图与本报告一起提交；PR head 为交付版本，最终评论记录准确 commit。

## 前置证明

GitHub 直接回读 PR 的 state/mergedAt/mergeCommit，四项均 MERGED：

- MAX-68：[#81](https://github.com/max2055/Slide/pull/81)，`809853320c56903ed60c1a3fea61281fa07ccbaf`
- MAX-71：[#84](https://github.com/max2055/Slide/pull/84)，`222f577cca14099bfe9560ebdede95d78794803a`
- MAX-73：[#85](https://github.com/max2055/Slide/pull/85)，`5b48e0f5813a4c306e753c53c0057f349d5c9ea1`
- MAX-72：[#86](https://github.com/max2055/Slide/pull/86)，`1ac24d183f7242310a3541747c0601de1295586d`

Multica 关联表对以上四项返回空列表，未将此解释为未合并；以 GitHub 直接状态及 Git ancestry 为证据。

## 本地检查

| 命令（仓库根目录） | 结果 |
| --- | --- |
| `pnpm --filter slide-api test` | 276 文件、2584 测试通过；13 文件、103 测试跳过（opt-in 外部/MySQL/browser） |
| `pnpm --filter slide-frontend test` | 78 文件、523 测试通过 |
| `METRICS_V2_BROWSER=1 pnpm --filter slide-api exec vitest run src/metrics-v2/consumers/flow.browser.test.ts` | 独立运行通过：1440/375 两种宽度，实际 HTTP+Vite+Chromium、固定内存观测 |
| `pnpm --filter slide-api typecheck` | 通过 |
| `pnpm --filter slide-frontend typecheck` | 通过 |
| `pnpm --filter slide-frontend build` | 通过（现有大 chunk 提示；CSP 检查通过） |
| `pnpm contracts:check` | 通过 |
| `pnpm lint` | 0 errors；263 warnings，未通过放宽规则消除警告 |
| `pnpm --filter slide-api exec vitest run tests/phase-94-docs-structure.test.ts` | 通过 |
| `git diff --check` | 通过 |

初轮新增共享服务合同测试 10 项通过；随后增加冻结 AlertPolicy/语义版本校验及服务器独立恢复测试，纳入最终后端完整 gate。前端定向覆盖精确大整数、临时失败保留、403 清空、迟到响应丢弃、固定列。浏览器截图人工检查后，将长质量徽章分拆并换行，以改善窄屏阅读。

## 验收与证据映射

- 同窗口数值、单位、质量、覆盖率、sources 一致：`apps/db-ops-api/src/metrics-v2/consumers/service.test.ts` 的 HTTP/Agent/evaluate 对比；browser 测试从同一 API 挂载实际组件。
- missing/stale/estimated/分母未知不会健康：`service.test.ts` 参数化回归；`evaluation.ts` 对持续、恢复、质量、单位与语义版本逐项检查。
- CoreProfile 固定、Extension 按绑定：服务 profile schema 校验、模板切换测试及 `frontend/src/app/ui/components/semantic-metrics.test.ts` 全失败仍固定列测试。
- 资源权限：读取之前拒绝无 scope actor；Agent 无 actor 拒绝；浏览器 403 清除旧值。
- 迁移：`migration.ts` 和 `operational.test.ts` 保留原计数阈值、资源身份和旧策略；不支持的评分口径明确 unknown，未假装生成等价公式。
- 告警运行接入：数据库、服务器及网络 evaluator 引入 operational adapter；服务器测试验证独立恢复时长、未知不恢复；原网络告警回归通过。
- 回退及限制：见 `README.md`。没有 schema/生产配置写入；没有外部通知 exactly-once 验收。

CI 为外部触发检查，创建 PR 后记录其当时状态，不将尚未结束的 CI 写为通过。

资源：硬预算未设定；raw input/cached input/output/实际费用遥测不可用，不给出虚构用量。子代理数 0，最大深度 0，代理并发峰值 1。
