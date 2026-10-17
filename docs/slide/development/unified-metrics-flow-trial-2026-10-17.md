# MAX-189 试采证据与发布门禁回归

2026-10-17，接续原 PR #202；本次只修改 A 所有的 `apps/db-ops-api/src/metrics/config/flow.mysql.test.ts`，没有修改产品运行逻辑或 B 前端。既有 status1267 修复为 `8e29135d`，真实 MySQL／VM实采证据仍对应 `f0fa1e8d`，均不重复执行。

## 问题与 RED

Chief 在准确组合 A0935＋Bc69f（`3a8696ac`，CI38990072857）发现 flow 仍强求“试采成功，可以发布”。该问题与 status JOIN 排序规则500独立。

本轮在独立工作树按 A54bd＋B `c69f2f5f1618b54c8097039b25a0779449ba6c86` 复现，使用本任务 MySQL8.4端口23389、完整迁移、临时schema、Fastify HTTP与真实浏览器组件；远端SQL结果为固定测试输入，认证为测试admin，不代表完整真实登录或生产实采。

RED checkpoint `5944af43b4fa6d5f6164d911e35ed5f4a0aa6231`：增加实际 trial POST 响应与有效样本断言，保留原全成功文案要求；4项中3通过，1项准确失败于旧文案。trial HTTP200，decision=attempted、persisted=false；mysql-status succeeded。样本为 uptime1000、Queries精确uint64 `9007199254740993`，以及 null／unknown 的速率（counter_baseline）。即使 attempts 全部 succeeded，也不能把这些样本称为全部成功。

## GREEN与受影响验证

GREEN测试提交 `6cbcade172cc520bfe6f3326210aaa7b7740c9fe`：

- 桌面1440与窄屏375，断言实际JSON中的有效值和counter_baseline；UI必须准确显示部分失败／待验证提示、逐项成功与待验证原因，不能出现全成功文案；发布按钮启用且实际激活HTTP200。保留应用待确认、正式无样本、CAS409、只读权限、设置入口与焦点验证。
- 另用本测试registry内的不可变 `mysql-basic@1.0.1`（继承相同MySQL8适用范围与transport，移除首次rate派生）构造全好样本；仅在所有attempts成功且两个样本均非null/good时允许全成功文案。该包仅存在本测试，不进入产品目录或用户配置。
- 同一流程把模拟目标改为空结果，真实runner报告parse_error／无有效样本；界面显示具体错误，发布禁用，不把失败伪装成unbound或成功。
- focused flow：1文件5项全部通过。受影响 config 模块（含flow和混合排序规则status实库回归）：9文件65项通过、4文件6项按环境条件跳过。API typecheck、secret scan通过。公开契约与产品源码未变，复用上轮contracts通过证据；未运行覆盖率。

准确测试组合 tree `a66e449283a9b27d419eda317d6dffb8728a5ea0`，由A `6cbcade1`＋B `c69f2f5f`计算得到，与隔离验证工作树的实际index tree相同。flow文件blob `24b91747e364a1d28d491c75c4756d0449e423bd`。交付后续仅新增本文档。没有运行或替代B完整组合gate。

```sh
METRICS_TEST_MYSQL_PORT=23389 METRIC_TEST_ARTIFACT_DIR=<outputs/evidence> pnpm --filter slide-api exec vitest run src/metrics/config/flow.mysql.test.ts
METRICS_TEST_MYSQL_PORT=23389 METRIC_TEST_ARTIFACT_DIR=<outputs/evidence> pnpm --filter slide-api exec vitest run src/metrics/config
pnpm --filter slide-api typecheck
pnpm security:scan
```

## 接续边界

A54bd 的 CI38991159060本轮读取时9成功、2失败、API资格1项仍运行，release／ci-gate尚未创建，不能称全部完成。已读失败日志：browser仍导入不存在的旧registry路径；browser-qualification在max157-business.spec.ts:134要求旧值92.4。均属于A/B组合依赖。API旧前端缺按钮与本次已修的组合文案断言不可混为一项；不从aggregate failure推定所有检查结束。

B／Chief应取本次新A测试修复与最新B组合，继续真实完整认证的status200、试采／发布、至少3正式周期、正式API／列表／详情／设置一致、R1逐页验收和最终必要gate。此前SQL1267已修、B部分成功门禁已修；本次解除已知flow文案阻塞。独立兼容审查、最终业务与合并仍未完成，保持blocked／draft。未越界改B、未重跑VM、未合并、未启动C/D或子代理。产品LLM调用0，共享预算未清零。
