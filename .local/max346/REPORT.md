# MAX-346 / GitHub #497 验收证据

候选 head：824f8a8992f05bf6899f7b0b322059138aa808cb
base：e39663f08c608d207d4a751617cdfa9191fee139 (main)
固定起点：134208f355fe8ec7935404c0dda134d670296e4f，已验证为 HEAD 祖先。
PR：https://github.com/max2055/Slide/pull/807
环境：macOS，本地 Node v24.18.0，pnpm 11.19.0；无部署；模型调用/预算预留均为 0。

验收：
- 边界外全局权限与普通 scope 均拒绝，空边界拒绝；非法实例 ID 拒绝。
- 边界内 * / instance:* / admin 三类全局授权通过所有有效 minLevel，无需 scope。
- 普通 scope 仍执行 minLevel；边界不会增加 scope 授权。
- getAccessibleInstanceIds 返回合法边界 ID 集合（去重、排序），普通 actor 返回 scope 与边界交集；不受限 actor 仍返回 null。
- requireUnrestrictedInstanceAccess 对带边界 actor 仍拒绝。
- 真实 Fastify listener + fetch：边界内 200、边界外 403、非法 ID 400、全局操作 403，列表 [1]。该用例构造 actor，不是 JWT/MySQL 业务端到端。
- 实际 get_instance_summary handler：单实例、汇总过滤及拒绝前不查询数据库；数据库读取由 spy 提供，不是数据库实测。

验证命令与输出：
- RED：修复前 pnpm --filter slide-api exec vitest run src/auth/require-instance-access.test.ts，3 failed / 21 passed：三类全局授权列表预期 [7,9] 实际 []。此项为当次终端结果摘要，无单独原始日志。
- pnpm --filter slide-api exec vitest run src/auth/require-instance-access.test.ts src/tools/policy.test.ts src/tools/resource-filtering.test.ts src/resources/resource-service.test.ts：4 文件 87/87 通过（targeted.log）。
- pnpm --filter slide-api typecheck：退出 0（typecheck.log）。
- pnpm security:scan：退出 0（security-scan.log）。
- pnpm security:test：35 文件 478/478 通过（security-tests.log）。
- pnpm --filter slide-api test：主动中止，退出 130；会启动多组 MySQL 容器，与并行资源约束冲突；未完成，不计通过（api-tests.log）。
- pnpm --filter slide-api exec vitest run --exclude '**/*.mysql.test.ts'：仍含真实依赖套件，桥接套件存在跳过；collector singleton 5763ms 失败；剩余 worker/发布清单子进程久未完成后主动中止，退出 130，不计通过（api-unit.log）。
- pnpm --filter slide-api exec vitest run src/collectors/__tests__/task2.test.ts：6/6 通过，1.94s（collector-recheck.log）；广泛回归失败未稳定复现，按并发环境相关候选分类，不改无关代码。
- git diff --check：通过；PR 净改动仅两个访问授权文件。修复提交还恢复起点快照中的技能删除，内容与 main 一致，无 PR 差异。AGENTS.md 原有工作区修改未提交。

自查：授权顺序为有效 ID → 资源边界 → 全局权限 → scope 等级；全局操作仍单独检查 unrestricted。无存储、事务、Provider、契约或前端改动。真实数据库及模型依赖不属于此次纯判定缺陷的必要验证；未声称生产验证或完整认证链验证。
限制：全量 gate 未通过，不绕过 CI/分支保护；Chief 独立复核、CI 与合并关闭仍待完成。广泛测试曾启动自动清理容器，未对归属不明的并行容器执行删除；当前无本任务测试 worker 或发布清单子进程运行。
文件交接：停止写入 require-instance-access.ts 及直接测试，交 Chief 复核。无需下级代理。
