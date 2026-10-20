# MAX-203 原调查临时 operator 提案（准确本地候选，尚未执行）

Max于2026-10-18 13:57Z在父任务明确要求“放开以上约束”，已授权前述原调查临时operator、4小时受信材料、2～4小时专属调试会话及统一预算内隔离LLM验证；不再索取相同范围批准。当前交付仍为本地候选及自有合成数据验证，父正在协调准确版本和会话配置。没有对真实源/恢复副本执行 SQL，没有安装、签发或消费新的真实父凭据。这不恢复旧现场签名或旧allocation。

## 准确对象与前置证据

只允许父后续核准的专属 schema `slide_v23_source_fbc68c25`、原调查 `2db38cfd-4dce-43d5-afc5-f7e1d39680fd`、原 JWT user1/sessionVersion1、原 service7。原 membership 必须逐字段等于 `{role:viewer,granted_by:7,expires_at:NULL}`；不插入成员、不改全局角色、用户、原调查 owner、session 或旧 partial/死信。

父已核 runtime10 的最新失败为 c49be5ca，完整 hash `f92fb2fac7e5b588dca43e3d345b97c6698c4e9846d629c2adde954d726da4eb`。b877 是已消费历史前驱，不能重用。原 review01d9d14b 和所有旧 operation/signature/port/allocation 均无效。当前 lock 为 released_unassigned，runtime/environmentPreparation/targetRecovery 写均 false。

真正执行前，父必须先审本候选、新 head 必要 gate 与角色语义，核其落在Max已授权的准确原调查临时operator范围内；不再要求Max重复批准。再核原 owner 无在途、全部旧记录/用量/租约与未知状态，协调 P07 原 owner 刷新原签发链材料，最后绑定新互斥 allocation、动态 DB port/UUID、精确 head、脚本/配置/锁的 SHA256、新 operation/review 与不超过600秒的期限。Max的产品/环境授权和准确技术绑定分别记录，旧技术签名不能替代新绑定。未审定准确版本时不能生成可执行现场授权包；交付 manifest 仅绑定本地代码和提案，不是现场锁。

## 权限变化的完整含义

| 项 | 当前 viewer | 拟临时 operator |
|---|---|---|
| JWT 全局权限、角色、sessionVersion | 原值不变；admin 名称/全局权限不绕过调查角色 | 完全相同，零全局提升 |
| 原调查 membership | viewer / granted_by7 / expires_at NULL | operator / granted_by7 / 明确 UTC 到期秒 |
| 调查操作 | read / watch / content | 另外允许 patch / admit / continue / cancel（现有 operator 角色的固有语义） |
| JWT 在本调查的工具权限上界 | 按完整实时全局权限与 ops profile 交集，当前全局身份可能拥有全部7项 | 同一交集，membership 升级不增加工具名或全局资源权限 |
| 实际自动后继的身份 | 原 service7/sessionVersion1 | 仍为原 service7；绝不切 JWT 或新 service 执行 |
| 后继有效权限 | chat:view、servers:view | 完全相同 |
| 后继资源 | server3；instanceIds=[]、networkDeviceIds=[] | 完全相同，server4/任意数据库均拒绝 |
| 后继有效工具 | get_server_metrics、get_server_alerts、get_resource_observations、get_resource_relations | 完全相同；原 frozen ceiling ∩ live ACL ∩ profile ∩ 实时 Agent 策略 |
| 工具参数 | serverId3，最大1h窗口；全量证据/结果/出站复核 | 完全相同；无任意 SQL/SSH、凭据读取、行动或批准消费 |

ops profile 全部7工具为 get_instance_summary、query_metrics、list_active_alerts、get_server_metrics、get_server_alerts、get_resource_observations、get_resource_relations。JWT 全局身份的理论上界不是后继的执行权限；原 service 四工具及原实际资源才是后继上界。

**现有角色不支持只授 continue。** 临时 operator 同时拥有原调查 patch/cancel 等能力，不能声称技术上只增加 POST runs 权限。该角色语义须由父核对并明确记入已有授权的具体执行范围；本 runner 只调用原调查 runs，不调用 patch/cancel。若授权要求在权限系统层面禁止其他调查操作，则本提案不足，必须保持 viewer 并另审更窄的支持方案，不能偷偷新增接口或以 admin 绕过。

## 最小 CAS 与回退

精确待审SQL字节为 `scripts/qualification/v23-source-membership-grant.sql` 和 `v23-source-membership-restore.sql`，不挂迁移、启动或HTTP路由；真实SQL测试直接读取这两份字节执行。参数化SQL本身不是现场授权包，调用方必须固定下述身份、事务和准确绑定。controller 先核 schema/UUID、调查/owner、准确 user/session、完整原成员行与资源/工具集合；锁原调查和 membership，事务中复核一致。membership期限取 `min(新4小时调试会话截止,allocation截止,now+4小时)`；独立phase仍<=600秒 并向下取整至 DATETIME 秒，必须未来且覆盖预定后继窗口。

```sql
UPDATE investigation_members SET role='operator', expires_at=?
WHERE investigation_id=? AND user_id=1 AND role='viewer'
  AND granted_by=? AND expires_at IS NULL
  AND ?>UTC_TIMESTAMP() AND ?<=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 4 HOUR) AND ?<=?;
```

参数严格依次为 `[本轮到期,原调查ID,原授予者7,同到期,同到期,同到期,新会话截止]`，所有到期参数相同，调查参数只能为上述原调查、原授予者参数必须7；affectedRows 必须1，否则 rollback、停发。并发 CAS 仅一方成功，不能补 INSERT。grantor7 原值保留，记录授权主体与本轮 operation 到受保护交付审计；不冒充一次新的 service7 授权。若父要求授予者改为实际批准人，则重新审不同 CAS/回退，不能静默改值。

授予后立即运行同生产 JWT/InvestigationAuthorization 的 READ ONLY 前检，核 operator、当前成员有效期、完整原调查资源，以及原 service snapshot 的 live session/ACL/四工具。CLI 在父审计文件读取/消费、工作 intent/租约写、API 启动和目标连接之前执行此门禁；HTTP 的原事务再次核实时权限。前检不是可复用凭据，HTTP 拒绝仍可能发生。

```sql
UPDATE investigation_members SET role='viewer', granted_by=7, expires_at=NULL
WHERE investigation_id=? AND user_id=1 AND role='operator'
  AND granted_by=7 AND expires_at=?;
```

回退绑定本轮准确到期值，affectedRows1后逐字段比较原行，并验证 viewer 再次拒绝 continue。失配绝不覆盖新授权/其他人的变动。到期只使操作拒绝，并不自动恢复历史 viewer 行；必须显式回退。撤回权限前先停新派发并核后继在途/unknown；实时撤权会令在途后继停发，此影响必须记录。

## unknown、拒绝与收尾

grant/回退 commit ACK 丢失：只读核准确 tuple/版本/本轮审计，不能重试写。HTTP 已发而回执丢失仍 unknown，不能因为权限过期或换 operation 再发。已收到 HTTP 拒绝只保留 status 与严格白名单产品错误码；不存正文/头/任意错误文本。runtime10 原现场未记录状态的历史缺口保留，不能用隔离403补写。

发生任何异常停止新 phase，保留全部旧 partial、c49/b877、review、预算和已发送记录，集中交实际状态。finally 各自关闭自有 API/log、lease、DB/SSH 与容器；不动 P07/3308/共享服务。不因清理成功自动释放/续期现场 allocation，由父按实际无在途/恢复证据处置。正式新来源/同调查后继/immutable pending plan、两真实分离主体once及完整P07/P08/P09/P10/P12资格均未完成。

## 本地验证范围

`authorization.mysql.test.ts` 在新建独占合成 schema 上验证真实 JWT 与生产授权器、真实 CLI 反例、全部表 hash 不变、operator 四工具正例、撤权后的真实 HTTP403，以及上述 CAS 失配/到期/并发/精确回退。`execution-recovery.mysql.test.ts` 复用原真实隔离 SQL/HTTP partial 接续 once/并发/重用/unknown 反例，并验证最终 HTTP403 的受限回执与传输 unknown 不重放。测试签名均为合成密钥，不读改真实父信任锚；没有真实模型发送。
