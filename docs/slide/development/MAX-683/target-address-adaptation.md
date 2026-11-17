# 指定验证地址的离线适配

2026-11-16。适配起点及性能证据版本为 `9dd41b8ff9822dbc82f7405f858839acaea7a93f`；本次适配独立提交，最终 SHA 记录在交付评论和证据清单。性能四次固定对比不重复执行，不将其作为新候选完整 CI 通过的证据。

## 精确边界

用户指定的新验证地址为 `172.16.51.128`。原准备层和执行适配器都固定 `192.168.49.130`；现在共用 `demo-target-hosts.ts` 的两个精确值，继续拒绝其他 IP、主机名、后缀变体和 IPv6 地址。不存在任意主机开关、HTTP 地址参数、自动改址、回退或重定向。

地址可出现在配置中，不等于目标已经登记可信。运行时仍只使用当前受信部署文件中的一份精确目标：

1. 准备层验证受保护文件、Ed25519 manifest 签名、精确目标/工具/策略/验证器/有效期与完整配置哈希；锁定的服务器行必须匹配地址、端口、主机指纹。
2. SSH继续使用独立非root账号、固定端口22、严格指纹验证和固定helper命令。现场检查返回的完整目标配置、helper、unit和serverId必须吻合。
3. 执行层单独验证目标签名，并把计划和调用能力绑定到该完整目标哈希。即便旧/新地址都在值域中，互换地址也必须更换签名、哈希、登记和新计划；原批准不能跨目标沿用。
4. 批准、实时授权、一次性执行能力及未知回执约束未改。新的地址值不授予执行能力。

进一步核对发现目标端 `action-demo-helper.sh` 的 `configuration()` 也固定旧地址。仅改TypeScript会造成第三层继续拒绝。因此同步将helper的地址判断最小改为同两个精确值，文件所有权、完整字段、指纹格式、helper/unit实际文件哈希及有效unit检查保持。离线测试运行实际Python函数并比较其配置哈希与TypeScript结果。

本次未部署helper。升级helper将改变文件哈希，现场必须核实实际安装文件并重新绑定；不能把新源码哈希当作现场观测。未升级的旧helper及其旧地址登记不因本次代码自动迁移；部署新helper时旧哈希不匹配仍应拒绝。

## 待核验材料

`kylin-registration.pending.json` 是意图草案，不是可部署manifest或目标登记。serverId、主机指纹、helper/unit哈希、健康源、有效期及两种签名均为空，eligible为false，没有复制旧指纹或旧签名。只记录现有Ed25519的签名输入规则：分别签署完整manifest和target的 `UTF8(operationsContentHash(...))`，不提前签署未核验内容。针对性测试将这份实际草案分别送入准备与执行边界，均拒绝，且不读取SSH凭据、不发命令。

网络恢复后依次核对实际地址、主机身份与旧目标对应关系，检查专用账号/forced-command、root拥有的helper和unit、实际配置哈希、健康源及当前采样；再绑定隔离候选环境服务器行，生成完整新配置，签署manifest及目标。共享MySQL3306仅是已授权模型配置来源，本轮未读写该源，不以其作为测试库。

必须继续形成当前调查、结果和新计划，由不同授权身份重新批准后显式执行，才能补真实恢复/未改善/证据不足及详情/审批返回验收。地址适配和签名能力存在都不能替代这些步骤。

## 针对性验证

| 场景 | 证据 |
|---|---|
| 旧/新地址各自正确签名与完整绑定 | 准备层完整矩阵分别运行；执行层只连接该配置地址；实际回环SSH正确指纹通过。 |
| 两个允许地址互换 | 原manifest/目标签名拒绝；SQL地址或helper配置哈希不一致拒绝；旧计划配置哈希不能用于新目标。 |
| 未登记地址、主机名或后缀变体 | 即便由测试签名密钥签署，准备、执行及实际Python helper仍拒绝。 |
| 没有服务器行、指纹/签名/有效期/权限不匹配 | 保持拒绝；实际服务端、JWT、隔离SQL及回环SSH覆盖身份、来源证据和实时ACL。 |
| 草案被误当部署配置 | 两层均拒绝，无SSH命令或凭据读取。 |
| helper/unit身份替换 | 实际Python配置校验拒绝错误哈希和无效指纹；现有固定路径、持久化意图和回执测试保留。 |

从 `apps/db-ops-api` 运行。SQL项先设置并导出本任务独占的两个测试变量，端口不得指向共享配置源3306；密码变量可为空但必须显式设置：

```sh
pnpm exec vitest run src/operations/action-environment.test.ts src/operations/actions/adapters/restart-demo-service.test.ts
: "${OPERATIONS_TEST_MYSQL_PORT:?required isolated MySQL port}"
: "${OPERATIONS_TEST_MYSQL_PASSWORD?required isolated MySQL password variable}"
export OPERATIONS_TEST_MYSQL_PORT OPERATIONS_TEST_MYSQL_PASSWORD
pnpm exec vitest run src/operations/action-readiness.mysql.test.ts --maxWorkers=1
pnpm exec tsc --noEmit
```

从仓库根目录运行 `pnpm contracts:check` 和 `pnpm ci:source-policy`。最终退出码、各地址HTTP检查和SHA见交付附件。SQL夹具使用独占MySQL8.4及随机schema，全部SSH重定向至回环地址；只允许inspect，未派发执行，批准记录保持pending/used_count=0。这些是受控准备证据，不是实际Kylin身份或业务闭环证据。

本轮没有探测不可达主机、签发真实新配置、远端变更、共享库变更或实际模型调用。真实环境网络阻塞沿用上一轮观测，不把旧结果标作本轮重新测量。整体仍未验收、未合并、未部署，独立复核交Chief，不增加人工听读门禁。
