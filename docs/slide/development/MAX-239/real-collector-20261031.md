# MAX239 实际只读 collector → 正式 writer → 事件/历史

本包只增加可显式启用的实机验收脚本和复用现有事件中心的浏览器入口，没有修改产品 collector、writer、规则算法或历史读取方法。

## 授权与隔离

复用 MAX235 成员 2026-10-27 授权：既有 `instance:1/mysql3306`、`server:3/192.168.49.130:22` 用于采集，网络设备先功能、部署后由成员实机验证。资源和加密凭据从既有平台配置引用取得，不重新索取或写入源码。读取源库使用 `START TRANSACTION READ ONLY`，只复制两个资产记录到 nonce 独占的非3306平台库；目标端只运行既有 SQL/SSH collector。没有生产 worker、目标负载/配置变更、共享库写入、实际解绑或外发通知。

## 可复现入口

先启动本 run 独占非3306 MySQL 8.4；记录确切容器ID/nonce/映射端口。以下变量只在本地环境提供，凭据文件不提交：

```bash
MAX239_REAL_FLOW=1 MAX239_REAL_BROWSER=1 \
MAX238_TEST_MYSQL_PORT=<exclusive-port> \
SLIDE_DEBUG_ENV_FILE=<existing-env-reference> \
MAX239_EVIDENCE_DIR=<outputs-directory> MAX239_RUN_NONCE=<owned-nonce> \
pnpm --filter slide-api exec vitest run \
  src/metrics/templates/real-collector-flow.mysql.test.ts --maxWorkers=1
```

默认跳过，避免普通测试连接真实目标。两项分别执行，某目标失败不会被另一个目标成功掩盖。网络未恢复时可用 Vitest `-t "'instance'"` 仅运行数据库，报告必须保留服务器未验收。

使用已注册运行时长：MySQL 9.6 `mysql-basic@2.0.0/db.uptime_seconds`，Linux `linux-basic@1.0.0/linux.uptime.seconds`。实际 collector 读取基线后，把基线+15秒固定为模板参数：问题 `last < boundary`，独立恢复 `last >= boundary`。完成真实发布、probe/trial/apply、collect-now入队与现有前台 `WorkerRuntime.runOnce`，用正常正式 writer 的实际样本触发；等待真实墙钟16.5秒后再次采集，自然运行时长越界恢复。不使用 collect/clock override，不改任务 available_at，不制造95/85/60。固定值语义复用已接受受控证据。

正式样本、尝试、规则/模板/item/config版本、episode、事件和日志导出到 `real-collector-evidence.json`；浏览器使用真实JWT、Fastify生产共用读取路由及 Lit event-center，核对同一episode/恢复事实、三个桌面尺寸和基本焦点。该入口是隔离验收宿主，不宣称整个生产server已部署。

## 2026-10-31 实际结果

- MySQL整链和浏览器通过：阈值251449s；251435s触发，251452s恢复一次；模板v2、规则v1、item v1、config r1。完整ID/UTC时间及源样本身份在附件证据中。
- VM实际collector返回connection_error、无观测；额外TCP探测为`No route to host`，当前宿主路由为bridge101。属于环境网络限制，未验收、未伪造替代；恢复条件是当前运行机到既有VM22端口可达，继续复用现有凭据。
- 既有统一通知通道全部禁用，飞书告警为channel9；未核实明确接收对象和外发授权，本轮未复制/启用/发送通道。负责人为成员/通知配置owner；仅暂停正式送达与回执证据。
- 初次脚本修正了scalar编码读取、证据查询JSON列、浏览器组件导入和队列墙钟可用边界等待。这些属于新增验收宿主修正，不改产品逻辑。所有nonce schema与浏览器/Vite子进程按准确句柄清理，容器另按完整ID和owner标签清理。

本包不是三类实机或整单完成。VM网络、成员部署网络设备、正式外部通知/回执仍未验收；产品模型调用0。
