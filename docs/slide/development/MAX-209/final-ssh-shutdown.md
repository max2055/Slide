## 最终退出回归（2026-10-21）

统一候选1644c0d0的完整应用诊断后，API收到SIGTERM，worker、HTTP及平台数据库关闭已完成，但进程仍存活。最小隔离验证区分了两条路径：未取得SSH会话时34ms自然退出；增加一个本机SSH测试端的真实认证连接并释放回生产sshSessionPool后，13秒仍不退出。

预加载async_hooks诊断表明：dbConnection.close已完成，7秒后只剩本机SSH的TCPWRAP和ssh2的60秒keepalive引用定时器。shutdown正常结束并清除10秒deadline，因此原deadline不会处理遗漏的连接池。该事实解释本轮症状，不推断所有历史停机问题。

修复仅在最终HTTP drain后调用已有sshSessionPool.closeAll，再关闭平台数据库；新请求已停止，在途诊断已排空，不在worker恢复时擅自关闭别代连接，不放宽租约、fencing或权限。没有增加process.exit(0)来掩盖资源泄漏。

新增可重复的完整API进程回归：一次性MySQL库、仅绑定本机私有IP的SSH测试端、真实生产SSH连接池和SIGTERM。沿既有安全策略拒绝loopback，不修改目标策略；SSH只完成认证，不发命令。Provider、通知、cron关闭，未连接正式资产、不调用模型、不重演停库。

```bash
RUN_SERVER_SHUTDOWN_TEST=true \
RELEASE_OUTPUT_DIR=/Users/max/Coding/40-Slide/outputs/MAX-209-shutdown-check \
node apps/db-ops-api/tests/server-shutdown.real.mjs
```

隔离端口33210/31210/28210/32210须空闲。脚本记录PID、端口、cwd、命令、commit和日志，结束清理本轮进程与容器；私密agent-workspace不交付。

RED：旧生产代码13秒内未退出，断言“API must exit naturally after SIGTERM with a released SSH session”失败。GREEN：相同回归24ms退出，code0、signal null、SSH命令数0。4文件19项生命周期/SSH/装配相关测试及API typecheck通过；当前准确集成候选仍须最终完整gate，未沿用旧head绿CI。
