# 网络模板到事件：受控 SNMP 协议验收

成员2026-11-01决定：本机不部署网络硬件，以受控SNMP协议端点收口功能；通知验证豁免。该证据不宣称硬件实测。MySQL/VM已接受证据复用。

## 官方参考与现有映射

- [Zabbix 7.0 SNMP agent文档](https://www.zabbix.com/documentation/7.0/en/manual/config/items/itemtypes/snmp)。
- [官方7.0.21 Network Generic Device模板](https://github.com/zabbix/zabbix/blob/7.0.21/templates/net/generic_snmp/template_net_generic_snmp.yaml)，源blob `e601216a7e6254247e8f3fd364a78605d27b49d6`。本次仅参考协议与映射，不引入Zabbix表达式或通用导入器。

| 对象 | Slide现有映射/边界 |
| --- | --- |
| sysUpTime `.1.3.6.1.2.1.1.3.0` | TimeTicks，百分之一秒转s；`snmp.agent.uptime_seconds`，表示管理子系统运行时间，不能当设备开机时间 |
| ifTable `.1.3.6.1.2.1.2.2` | Integer状态、OctetString身份、Counter32错误/丢弃等；ifOperStatus 1→1、2→0，其他状态未知；单位1 |
| ifXTable `.1.3.6.1.2.1.31.1.1` | Counter64收发字节优先，缺失时Counter32回退；无损uint64保存，By转bit/s，收发方向分别计算 |
| ifSpeed/ifHighSpeed | bps/Mbps转bit/s；接口身份、epoch、重启/断点/采样间隔不可信时速率未知 |
| 厂商指标 | 只有现有固定版本Huawei catalog；没有全厂商/温度单位等完整覆盖承诺 |

网络资源的当前 `snmp.version` 先前只在collector access中补入，模板配置resolver读取inventory时缺失，导致probe支持、trial却NOT_EXECUTABLE。本次在configurationInventory只读取当前凭据protocol列，沿用collector的ORDER BY protocol优先级，丢弃旧观测携带的版本。无凭据/SSH不能借旧版本得到SNMP支持。此最小MAX238生产者扩展直接服务本流程，无公开schema或MAX240历史读方法修改。

## 协议、安全与负例

当前产品默认支持v2c及v3 authPriv SHA/AES。v1拒绝；v3 noAuthNoPriv、authNoPriv及MD5/DES默认拒绝，底层显式选项不等于产品已开放。超时250–30000ms、重试0–3为v3配置边界；实际正常采集沿用既有默认超时/重试。v2c明文community仅保存在加密凭据行，v3密钥同样加密，不进入证据DTO。

本次v2c和v3 authPriv均通过真实UDP端点、资源凭据读取、模板发布/probe/trial/apply、collect-now前台handler、正常writeTemplateResults及唯一事件writer完成95触发、85保持、60恢复。控制的是本run拥有的协议端点值，不是collector返回对象；无clock override、fakeapplied或预种episode。每条规则问题>90、独立恢复<70，端点TimeTicks 9500/8500/6000映射95/85/60s，不能当真实设备负载语义。

NoSuchInstance通过移除端点provider产生；采集失败/无值不恢复已有问题，真实墙钟过期后现有clock入口将其标为unknown，再取得60后同episode恢复一次。独占UDP黑洞超时返回SNMP_TIMEOUT；错误v3密钥在本端点被丢弃，实际返回SNMP_TIMEOUT，不能伪称端点给出了可区分的认证拒绝。默认弱v3安全级别返回SNMP_UNSUPPORTED_SECURITY。资源边界在真实JWT后的限制性fixture上下文中注入，生产共用事件详情返回404、模板事实403；实时撤销session返回401。限制性上下文不是生产新增请求头。

既有IF-MIB UDP→正式writer→MySQL用例另验证Counter64无损值、收发速率、重启未知与脱敏；该旧用例是协议/包链验证，不能混称本次模板事件链或硬件实测。

## 基线兼容与复现

本次发现PR实际基线已从88fc15e2推进到MAX238 `b5c140c1d646bfb5581ff88da7498b4793e7322d`。合入其配置历史生产者契约，仅公开契约注册imports冲突，保留trigger及ConfigurationAt双方注册项。正式writer第二次采样暴露pending重编码拒绝applied envelope：改为把已严格解码的原payload传给现有历史记录器，保留formal commit证据，不修改历史读取方法或契约结构。真实整链回归覆盖该反例。

```bash
MAX239_SNMP_FLOW=1 MAX239_REAL_BROWSER=1 \
MAX239_SNMP_HOST=<本机独占端点绑定的非loopback地址> \
MAX238_TEST_MYSQL_PORT=<独占非3306端口> \
MAX239_RUN_NONCE=<本run随机nonce> MAX239_EVIDENCE_DIR=<outputs> \
pnpm --filter slide-api exec vitest run \
 src/metrics/templates/snmp-trigger-flow.mysql.test.ts \
 src/metrics/config/inventory-snmp.test.ts --maxWorkers=1
```

不改SSRF策略来允许loopback：端点绑定本机已有非loopback接口的临时UDP端口。平台schema使用nonce/服务器identity handle；所有agent/socket/Vite/browser/API均按准确句柄收尾。测试只写隔离平台，无共享3306、生产worker/deploy或实际解绑。精确sample/attempt/value/unit/UTC/version/episode、负例、截图、失败修正及对象审计见交付附件。最终安全与整体验收交Chief，done留成员。
