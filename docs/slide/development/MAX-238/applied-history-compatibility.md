# 连续正式采集的历史配置兼容

本次只修复 MAX238 的 `templateHistoryPayload`：对原始 payload 再执行严格解码，并克隆原 envelope。不能将已生效 envelope 重编码为 pending，否则第二次正式采集会报 `BINDING_PAYLOAD_REVISION_INVALID`，且重建过程可能掩盖损坏的 applied proof。未修改 MAX239 解码器、writer、事件处理或 MAX240 消费者。

## 可复现验证

先按根 package.json 的 pnpm 版本安装冻结依赖，然后从仓库根执行：

```sh
pnpm install --frozen-lockfile
python3 scripts/max238/prepare.py .max238-check
cd .max238-check/frontend
MAX238_HISTORY_MYSQL_TEST=1 MAX238_API_PORT=51859 bash e2e/max238-unbind-preview.sh
```

目标目录必须不存在；已存在时拒绝覆盖。prepare 私有装配固定 MAX239 安全头 `0a9eec2e13b03c7665c025080fce799f769247fe`，合入已接受 MAX238 安全头 `b5c140c1d646bfb5581ff88da7498b4793e7322d` 相对 `88fc15e2bce814218ff2f1836a33d57ff236eef6` 的 API 源码，再覆盖当前任务的历史 helper 和测试；保留原完整 strict decoder。依赖复用当前安装，工作区代码解析到私有副本。未切换任务分支，也未将 MAX239 文件并入 MAX238 产品提交。`max238-sources.json` 记录固定来源、三方合并路径及全部 API 源文件 SHA256；测试源码也在清单内。该装配不是独立发布物或最终产品集成。

命令复用既有 nonce/容器ID/label/预写 handle 生命周期，随机 loopback 非3306端口、独占 MySQL，测试创建的 schema 以 owned-fixture 精确句柄清理。成功退出前核验容器消失；失败保留容器 handle 供排查。测试仅使用受控 SQL transport，无远程目标、产品模型或外部通知。

## 覆盖与边界

- 两个原始反例在修复前均失败：合法 applied envelope 被拒绝；缺 proof 的伪 applied 被重建为合法 pending。
- 修复后2项契约回归通过。真实 MySQL 1项完整流程通过：发布原生单指标模板、probe/trial/apply、首个正式任务、第二个正式任务、修改周期后重新 trial/apply/collect。真实队列、租约、正式 writer、配置历史服务与数据库事务均执行；collector transport 为受控返回。
- 连续采集后样本行增加，绑定 applied revision 和 formal proof 保全，旧历史读取完整响应不变；新 revision 返回120s，旧 revision 仍60s。缺 formal proof 继续被原 strict decoder 拒绝。
- 原任务分支6项隔离 MySQL 回归覆盖失败保留、CAS、撤权、事务回滚及历史损坏拒绝。直接内部 writer 测试只适用于原分支；MAX239 新门禁要求真实已发布 live binding，因此私有装配使用上面的完整流程验证，不运行旧内部捷径测试。
- 最终 API 受影响模块609项通过、168项条件集成跳过；双端 typecheck、私有装配API typecheck及公开契约检查通过；有条件集成测试未启用时的 skip 不视为业务通过。

此前安全头 CI 中5个 MAX238 MySQL 文件的发布审计计数仍假定一行。历史配置已在同事务追加专用快照，因此将成功发布断言调整为精确两行；幂等重放/拒绝/回滚的原始总行数检查保留，没有过滤掉配置快照。

本次未重复650资源测量、真实目标采集或UI验收，未实际解绑、写共享3306、部署或合并。MAX238整单及MAX239/MAX240最终集成仍需独立验收，安全PR继续draft。

审计计数修正对应原安全头 CI run `41260531267` 的 shards 1/3/5/7。隔离复现时5文件11项失败，均为快照加入后原始总行数变化；修正后与历史6项一起执行27项门禁。两次成功发布精确4行，单次成功发布精确2行，拒绝和重放保持总行数不变。证据日志和最终结果见本轮附件，不覆盖原历史证据包。
