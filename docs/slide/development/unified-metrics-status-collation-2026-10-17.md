# MAX-189 配置状态跨排序规则修复

2026-10-17，接续原草稿 PR #202。此前真实 MySQL／VM 验收对应 `f0fa1e8d`，记录于 `unified-metrics-existing-sources-2026-10-17.md`，本次不重复采集。B 已在 `c69f2f5f` 修复部分成功试采被错误禁止发布；当前新阻塞是 A 的 status 查询返回 HTTP500。

## 问题与最小修复

`config/status-store.ts` 直接 JOIN `workflow_jobs.id` 与 `metric_schedule.job_id`。现有部署两列分别为 `utf8mb4_0900_ai_ci`／`utf8mb4_unicode_ci`，比较会产生 MySQL 1267（Illegal mix of collations），即使两表为空也失败。不能将此错误当作未绑定。

修复源码 `8e29135d21ab35f9b507063c4961fc8856a790f4`：两侧 job ID 均 `CAST(... AS BINARY)` 后比较，按精确标识符匹配，同时保留资源、revision 与 running 状态条件。无数据迁移、异常吞掉、认证／Provider 改动或前端修改。单侧 CAST 不能保证大小写精确比较，因此使用双侧比较。

## RED／GREEN 实库证据

新增 `config/status-store.mysql.test.ts`，隔离 MySQL8.4（本任务容器23389）。先运行完整 MigrationRunner，然后明确把 schedule 的 job_id 设置为真实故障所用 unicode_ci，保留 workflow_jobs 的0900；断言两列实际不同。此处有意构造部署的混合排序规则，不通过统一 fixture 排序规则隐藏错误。本机全新0900 schema 的完整迁移会让两列均继承0900，不能把该环境本身误写为自然复现混合排序规则。

- RED checkpoint `3f529c2965b446b804502fdec8af8d106d1642e9`：12项中11失败、1权限检查通过。空表直接 reader 在生产 JOIN 抛 Illegal mix of collations，其余 HTTP status 返回500；不是初始化失败。
- GREEN源码 `8e29135d`：同一回归12项全部通过。空表返回 HTTP200/unbound；准确当前 running job 返回 in_flight=true；其他资源、错误revision、大小写不同、尾随空格、孤立／null job、queued／completed／cancelled均不误报在途。正式值仍pending／last_success与观测时间null，不制造成功。
- 受影响 config／scheduler 测试（排除 B 组合 `flow.mysql.test.ts`）：11文件94项通过，4文件6项按环境条件跳过；含上述真实库回归与调度实库测试。
- 后端 typecheck、contracts:check、security:scan通过。未测覆盖率，不以此冒称覆盖率门禁完成。

命令：

```sh
METRICS_TEST_MYSQL_PORT=23389 pnpm --filter slide-api exec vitest run src/metrics/config/status-store.mysql.test.ts
METRICS_TEST_MYSQL_PORT=23389 pnpm --filter slide-api exec vitest run src/metrics/config src/metrics/scheduler --exclude '**/flow.mysql.test.ts'
pnpm --filter slide-api typecheck
pnpm contracts:check
```

## 交接与边界

旧 A `0935f723` 的 CI38988167093已全部结束：9成功、5失败。browser旧registry路径、browser-qualification旧history断言、API资格等待B按钮均是组合依赖，release与ci-gate为连带失败。该结果不代表修复后head的CI结论。

B／Chief需将本次新A与B最新 `c69f2f5f` 组合，接续完整认证导航的status200、真实试采／发布、至少3正式周期、唯一正式API与list/detail/settings一致、R1逐页对照及最终必要gate。B旧候选 `3a8696ac` 仍以A0935为父提交。本次不重复B完整组合工作、不重跑VM、不合并、不启动C/D。独立PR兼容审查仍未完成，保持blocked／draft；网络counter生命周期未知的原失败结论不变。产品LLM调用0，共享预算未清零。
