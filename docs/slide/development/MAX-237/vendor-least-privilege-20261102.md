# Oracle root / 达梦最小权限补验

承接最新 `dispatch_handoff`，授权来源为父 MAX-235 成员评论 `01a19bf9-3af0-7316-bfc2-9e28af62d6c1`。不重做已接受的默认入口、模板应用、正式持久化及页面阶段；本次只补数据库权限缺口，交 Chief 独立验收。

## 可复现入口与边界

从仓库根目录执行：

```bash
pnpm --filter slide-api exec tsx e2e/max237-vendor-least-privilege.ts
```

脚本使用已有成员凭据引用读取方式，仅连接授权的本地 Oracle19c、达梦容器。账号名为每次随机生成的 `C##MAX237_<nonce>` / `MAX237_<nonce>`；密码仅在内存生成并用于连接和创建账号，不进入输出、文件或命令行参数。失败只保留错误码，不打印含原始 SQL 的错误。脚本需 Docker 容器管理入口，因为已有 Oracle DBA 不能转授 SYS 动态视图权限。

Oracle root 必须使用 common user：通过标准 `CREATE USER ... CONTAINER=ALL` 创建临时身份，所有 `CREATE SESSION` 和视图授权都只在 CDB$ROOT、CURRENT 范围生效，不授予 PDB 登录/采集权限，不连接、查询或测试 PDB。没有使用隐藏参数创建 root 本地用户。SYS 入口为既有容器 oracle 用户的 OS 认证，SQL allowlist 仅允许给本次账号授予四个固定视图的 SELECT。测试后关闭全部原生连接和池，删除本次新账号，不使用 CASCADE；管理员重新查询 DBA_USERS，确认账号不存在。不修改原账号、业务数据或全局 PUBLIC 权限。

## 实际结果

最终实测源码 `054cced93`，证据 `max237-least-privilege-E62F328FA4/evidence.json`。每个引擎两次运行原注册包、默认 `trialDatabaseTransport`、固定 SQL 与原归一化器，三项采集全部成功，共 12 个真实 raw observation。此补验没有平台 schema、scheduler/writer 或新页面截图，12 个值不声称为新增持久化样本；原正式采集/页面证据继续复用 `c6eb74ad70ec97bd6628b84d915b5a6abb04b32e`。

| 引擎 | 发布 pin | 系统权限 | 显式查询权限 | 数据库原生拒绝 |
| --- | --- | --- | --- | --- |
| Oracle 19.19.0.0.0 / CDB$ROOT | oracle-representative 1.3.0 | CREATE SESSION | SYS.V_$SESSION、V_$PARAMETER、V_$SYSSTAT、V_$INSTANCE | `SELECT 1 FROM SYS.USER$ WHERE 1=0` → ORA-00942 |
| 达梦 8.1.3.62（版本复用已接受实测） | dameng-representative 1.2.0 | CREATE SESSION | SYS.V$SESSIONS、V$PARAMETER、V$SYSSTAT、V$INSTANCE | `SELECT 1 FROM SYS.SYSUSER$ WHERE 1=0` → -5504，原生消息匹配权限拒绝 |

管理员先确认受保护对象实际存在；拒绝测试只选择常量且 WHERE 1=0，不读取账号内容，也不尝试可能成功的目标写入。Oracle 没有角色；DM 仅隐式 PUBLIC，未授予 DBA、VTI、RESOURCE、CONNECT。直接系统授权由 DBA_SYS_PRIVS 校验，Oracle 四个对象授权由 DBA_TAB_PRIVS 校验。此 DM 版本的动态视图授权在 SESSION_PRIVS 显示四条 SELECT，DBA_TAB_PRIVS 返回空；脚本分别断言这两类原生结果，未把空结果写成无授权。[DM 官方权限说明](https://eco.dameng.com/document/dm/zh-cn/pm/discretionary-access-control.html)描述 PUBLIC 与动态视图角色；实际授权结果以本次证据为准。

最终两账号均已删除并经管理员回查不存在。没有修改既有账号或其授权，没有访问 PDB、共享3306、生产worker、部署、解绑、模型调用或子代理。

## 验证、失败分类及复用

- 最终脚本两引擎实跑退出0，完整包结果、pin摘要、原始值/单位/质量、授权查询、原生错误码、清理均在证据中。
- 相关三个回归文件9项通过；API typecheck与新增脚本lint结果见证据包。
- 生产源码、公开契约、锁文件及已有前端均未改动；复用此前完整 API 5213通过/1045跳过/0失败，以及起点 `39b726461d8dce051e6291254ea0871c2a085808` CI run41421956361的30项成功。新头CI需按当前SHA另行核对，不能以旧头结果替代最终合并门禁。
- 早期脚本适配失败包括 root local/common身份、原生口令长度、Oracle DBA无转授权、容器非login环境、DM隐式PUBLIC/动态授权布局和原生拒绝码；均保留脱敏失败证据，已创建账号均有清理不存在记录。一次授权引用读取失败发生在创建账号之前，未发送目标请求。没有修改产品代码、降低角色隔离断言或跳过拒绝测试来解决这些差异。

本记录替代此前“等待受限账号”的局部限制；Oracle19.3仍是未验证候选，不以19.19替代。PDB按成员决定排除。整单验收、发布及合并由 Chief 依据既有范围和当前门禁收口。
