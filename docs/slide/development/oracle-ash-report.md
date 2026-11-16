# Oracle ASH 报告时间与目标契约

`slide_oracle_ash_report` 仅报告 `instance_id` 对应的**当前连接实例**。通过同一连接读取 `V$DATABASE` 和 `V$INSTANCE`，校验 DBID、实例号及名称，再将实际实例号绑定至报告函数。没有跨 RAC 实例选择能力；未知参数（包括实例号覆盖参数）明确拒绝。成功和空报告都带实际数据库、实例、服务身份。

时间支持两种明确语义，不依赖 API 进程本地时区，也不修改共享连接的会话时区：

- 无偏移输入是**数据库墙钟读数**，例如 `2026-05-19 10:00:00` 或 `2026-05-19T10:00:00.123456789`，原值保持。ISO 日期和省略秒的日期时间也接受。
- 带 `Z`、`+08:00`、`-0600` 等偏移的输入是**绝对时刻**。保留原始输入，以纳秒精度标准化为 UTC，然后通过 Oracle `TO_TIMESTAMP_TZ ... AT TIME ZONE` 转为数据库主机墙钟。会话时区和 DBTIMEZONE 都不会作为主机时区替代品。
- 可选 `database_time_zone` 是调用方确认的**实际数据库主机时区**（如 `Asia/Shanghai`、`Europe/London` 或 `+08:00`）。区域名使用 Oracle 时区文件的历史夏令时规则。省略时按同一连接 `SYSTIMESTAMP` 的**当前主机偏移**转换，元数据明确注明该来源与限制；当前偏移无法推断历史 DST/主机时区变更，历史范围受其影响时应传入实际区域名。该参数不改变无偏移输入的含义。

兼容性：保留带时区和小数秒支持，不再通过禁止旧输入修复时区问题。最多支持 9 位小数秒；Oracle ASH 的 `l_btime/l_etime` 是 DATE（整秒），因此开始向下、结束向上取整，明确包含请求范围。例如 `.123456789` 到同秒 `.123456790` 的请求会查询该整秒，而不会因截断变成零时长。`requested_*` 保留原始输入，`converted_*` 保留转换后的九位小数墙钟，`start_time/end_time` 和 `precision_policy=outward_to_seconds` 显示实际查询边界；扩展小于两秒。不是声称原生报告具有纳秒筛选能力。

同语义输入先按完整精度校验递增及不超过七日（绝对输入按真实经过时长，无偏移输入按墙钟时长）；混合输入在转换到同一墙钟后校验。夏令时回拨导致转换后墙钟不递增时明确报错，因为 DATE 无法区分重叠的同一读数。`time_semantics=database_wall_clock` 描述最终报告查询语义；`start_input_semantics/end_input_semantics`、`conversion_time_zone`、`conversion_time_zone_source` 说明输入及转换策略。

报告保留 Oracle 原生 HTML。权限、对象、参数和连接失败保留原始诊断码及原文；不根据包名或权限错误推断 Diagnostics Pack 许可证。调用者仍须自行确认许可，工具执行成功也不是许可证明。

Oracle 19c [ASH_REPORT_HTML 官方签名](https://docs.oracle.com/en/database/oracle/oracle-database/19/arpls/DBMS_WORKLOAD_REPOSITORY.html) 的时间参数是 `l_btime/l_etime`（DATE），实例参数是 `l_inst_num`。

## 验证入口

从仓库根目录执行（使用仓库指定的 pnpm 版本）：

```bash
pnpm --filter slide-api exec vitest run src/tools/generated/slide-self-mgmt/oracle_ash_report.test.ts src/tools/generated/slide-self-mgmt/oracle-tools.test.ts src/__tests__/oracle-agent-tools.test.ts
```

真实验收显式注入 `SLIDE_MAX534_ORACLE_CONFIG` JSON（`user/password/connectString`，由安全凭据来源在内存注入，不写明文文件、命令或日志）。连接账号须能生成 ASH 报告，并创建/删除任务专用用户、授予 CREATE SESSION 和 SELECT_CATALOG_ROLE。测试只改任务用户和测试独占连接的会话配置，结束后删除用户并核对清理。默认测试收集不连接数据库；显式启用但缺配置时失败。

```bash
SLIDE_MAX534_ORACLE=1 pnpm --filter slide-api exec vitest run src/tools/generated/slide-self-mgmt/oracle_ash_report.oracle.test.ts
```

Max 于 2026-11-16 豁免真实 Oracle 集群环境测试；真实 RAC 非 1 号实测不再是验收、合并或交付阻塞，不宣称已实测集群。既有单实例真实证据和非 1 号模拟回归保留。以下入口仅供将来有资源时选择使用，不是本批必需门禁：

```bash
SLIDE_MAX534_ORACLE=1 SLIDE_MAX534_REQUIRE_RAC=1 pnpm --filter slide-api exec vitest run src/tools/generated/slide-self-mgmt/oracle_ash_report.oracle.test.ts
```

该入口要求 `V$INSTANCE.PARALLEL=YES` 且实例号大于 1，单实例环境会失败，不能冒充 RAC 验收。
