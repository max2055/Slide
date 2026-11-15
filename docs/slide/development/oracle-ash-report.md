# Oracle ASH 报告时间与目标契约

`slide_oracle_ash_report` 仅报告 `instance_id` 对应的**当前连接实例**。通过同一连接读取 `V$DATABASE` 和 `V$INSTANCE`，校验 DBID、实例号及名称，再将实际实例号绑定至报告函数。没有跨 RAC 实例选择能力；未知参数（包括实例号覆盖参数）明确拒绝。成功和空报告都带实际数据库、实例、容器身份。

时间统一使用**目标数据库的墙钟读数**，精确到秒，接受 `YYYY-MM-DD HH:mm:ss` 或 `YYYY-MM-DDTHH:mm:ss`。例如目标数据库 ASH 时间为 `2026-05-19 10:00:00` 时直接传入该值。范围必须递增且不超过七个墙钟日，不经过 API 本地时区解析。数据库通过显式格式 `TO_DATE` 接收时间；处理器不修改共享连接的会话时区。

兼容性决定：旧实现声称接受 ISO 时间，但会将 API 本地时间转成 UTC 后丢弃时区。现在带 `Z`、显式偏移（如 `+08:00`）和小数秒的输入返回 `INVALID_ARGUMENTS`，不会猜测其数据库时间或静默丢失精度。调用方需要先确认目标数据库 ASH 的墙钟读数再提交；请勿直接删掉绝对时间的偏移。夏令时回拨重叠时刻也不能由该无时区 DATE 接口区分。

元数据 `time_semantics=database_wall_clock`、规范化的 `start_time/end_time` 标识实际查询范围。`session_timezone`、`database_timezone` 和 `database_host_current_offset` 分别记录会话配置、数据库存储时区和数据库主机当前偏移，三者不可互相替代；当前偏移不能充当历史时区转换规则。

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

RAC 验收使用相同配置变量连接指定非 1 号实例（确保连接服务固定到该实例），并启用额外环境断言：

```bash
SLIDE_MAX534_ORACLE=1 SLIDE_MAX534_REQUIRE_RAC=1 pnpm --filter slide-api exec vitest run src/tools/generated/slide-self-mgmt/oracle_ash_report.oracle.test.ts
```

该入口要求 `V$INSTANCE.PARALLEL=YES` 且实例号大于 1，单实例环境会失败，不能冒充 RAC 验收。
