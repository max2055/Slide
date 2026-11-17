## 失败关闭链的定位与最小诊断补丁

共享运行进程保留的错误链确认：`WORKER_DRAIN_FAILED` 的 cause 为
`DRIVER_CLOSE_PENDING:oraclePool`，栈位于 `DatabaseService.closeConnection`，
来自原 `Promise.allSettled` 第 9 项。通过临时本机 Inspector 只读查询保留的
Error 对象取得，未暂停执行、调用清理或修改业务对象；调试通道已关闭。
第一次查询因 DOMException 的 message getter 失败，改用自有属性描述符后成功，
两次记录均留在受控本地。这证明历史失败来源，不能证明 Oracle pool 当前终态。

原日志没有逐消费者结果，不能从整体失败反推其他消费者全部成功。
本补丁为每个清理入口记录稳定名称和 stopping/drained/failed，等待全部清理，
仍抛 WORKER_DRAIN_FAILED；不输出驱动错误文本、连接参数或秘密。
同步清理异常也进入独立结果，避免阻断其他消费者清理。
不改变失败 generation 的自动恢复策略，不释放失败 generation 的租约或启动后继。

## 与运行 main 的关系

诊断时运行目录磁盘 main 为 `92aa557b887729e19ce2aa4a9e8a957d4e2935ac`；
原候选 `7b7f26b627dc3958877fcdf3ce420e17476ccbac` 的 server.ts 与该磁盘文件一致。
补丁仅增加命名清理编排和诊断测试，不修改共享 main，不加载新候选。
磁盘版本不能证明现进程全部已加载模块的版本。

## 原失败 generation 的后续路径及停点

原进程的 stopWorkersPromise 和 WorkerStartup.closing 已保留拒绝，
新源码不会修复旧内存状态。不能通过清除缓存 Promise、吞错、重启或 exit1
将它变成成功排空。本补丁只能改善后续运行的诊断，原进程仍须保留。

下一受控修复须先核对该 Oracle pool 的在途调用、连接和关闭 Promise 当前状态，
以及所有其他消费者的终态。DatabaseService 对尚在关闭的 handle 保留
driverCloses Promise，不能在结果未知时并行重发 close。若已失败或超时，
先区分关闭仍在途、已关闭和真实拒绝，再形成同一 generation 的明确修复方案，
交原 Reviewer 复核后才操作。未取得这些结果前不调用 TERM、停止监督者或停库。
本次未声称所有消费者终态已取得，未交付可执行的原 generation 恢复补丁。

## 验证与证据边界

- 受影响测试：drain-workers、worker-startup、worker-recovery、metrics lifecycle，22项通过。
- 标准 pnpm ci:source-policy 和 slide-api typecheck 已通过；使用仓库声明的 pnpm 11.19.0，
  补齐本机命令入口及安装依赖后执行，旧失败记录保留。不是最终完整 gate。
- 受控证据：项目 outputs/max-681-drain-diagnosis-20261117，原始 Error/cause 不上传。
- 真实共享恢复、切换及整体验收仍未通过。I1/I2和旧候选代码/CI/包证据仅保留原适用版本，
  不自动迁移为本补丁的新候选 CI/发布物结论。
