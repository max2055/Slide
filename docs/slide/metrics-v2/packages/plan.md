# MAX-67 内置采集包实施计划

> Execution: 在任务已有实施授权内执行，按仓库规则验证；本项不委派。

Goal: 在 MAX-64/66 已合并契约上交付同一 CollectorPackage 的不可变发行物、内置协议实现、版本固定/回退和独立运行覆盖。

Architecture: 包发行物以已有 CollectorPackage 为身份，附带 Extension、公共派生引用、权限/发现/推荐参数元数据；整体内容摘要纳入 package.digest。注册表只允许代码内固定实现和已核对语义映射，不执行包提供的 SQL/Shell/OID。公共 normalize/executeDerived 负责计算与质量传播。

Tech Stack: TypeScript、Zod、Vitest；复用 MySQL pool、SSH session pool、SnmpClient。

## 执行契约 v1

- 基线 main bf64502，已包含 MAX-64 #76、MAX-66 #78。
- 范围：MySQL 状态批量输出、Linux SSH 基础指标、标准 IF-MIB 接口发现/状态；可复用包校验、精确版本选择、用户覆盖保持、错误与能力分离。
- 排除：持久绑定/策略解析（MAX-69）、调度/状态持久化（MAX-70）、UI、生产发布、私有 OID、任意 Shell/Zabbix 导入、推荐告警/图表。
- 硬预算未设定；实际 input/cached/output/费用遥测不可用；子代理 0。
- 停止条件：前置未合并、共享契约存在影响验收且无法兼容的歧义，或需生产发布。可恢复依赖/测试问题在范围内处理。

## 实施与验收

1. `apps/db-ops-api/src/metrics-v2/packages/model.ts`：严格包附件 schema、完整 digest、固定实现与语义校验、依赖/重复输出校验、不可变 registry、精确 pin 与覆盖。测试篡改、缺失 transform、同版本重写、跨 collector 冲突、升级/降级不改用户配置。
2. 同目录 `builtins.ts`、`adapters.ts`：声明 SQL/SSH/SNMP 支持边界、权限与发现，复用现有读操作/解析。拒绝未知实现、越界响应、不支持版本；未知厂商不访问 enterprise OID；凭据只通过运行时引用解析。
3. 同目录 `runner.ts`：批量 Raw → normalize → executeDerived；失败尝试独立、权限不足与 unsupported 分开，超时保留已有能力；验证 Extension 单位/维度/类型/质量/身份。包不修改 Canonical/CoreProfile。
4. 同目录 `packages.test.ts` 和 `docs/slide/metrics-v2/packages/fixtures.json`：fixture 覆盖版本、权限、厂家、真实公共处理器路径、精确大整数与 rate 首样本/重启、传输失败和升级/降级。
5. focused：`pnpm --filter slide-api exec vitest run src/metrics-v2/packages`；阶段：contracts + metrics-v2；最终一次后端全量、typecheck、定向 lint、API 契约检查和目录门禁。fixture/schema 路径相对模块，测试不依赖 cwd。
6. `README.md`/`validation.md` 记录运行边界、使用方式、实际证据及回退。提交独立分支并创建 PR；未完成 CI 如实标注。

回退：绑定选择原精确版本/digest，用户覆盖不变；代码撤回本项提交，无数据库迁移或运行时自动接入。
