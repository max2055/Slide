# 受控诊断阶段记录

base `451ab8c9969f18d94f17392a74301294de82b5e1`；本轮起点 `8de7da987b143d09d028d20da9b9305157ee8242`。新版本见所在提交。PR1010远端开工回读为该起点且draft。

只增加测试入口/失败路径观测，没有修改产品fatal、权限、退出语义、锁、超时或恢复逻辑。Inspector测试入口只消费引擎帧，不读异常对象name/stack/message/cause；输出固定unknown类型与校验后的仓库相对路径/行列。Proxy、getter、路径外泄、URL/query及真实子进程退出测试2项通过。但在原fatal场景尚未取得有效帧，不宣称已具备完整fatal定位能力。

真实验证（Node24.22.1/pnpm11.19.0，任务独占MySQL8.4，动态端口63401）：

- execution全文件：138 PASS、1 FAIL、1 SKIP。bounded三个混合场景均通过，没有重现completed/running，亦无3308断连；唯一失败是长度回执子进程缺JWT密钥。显式注入测试JWT后该用例1 PASS。全文件没有按完整配置重新跑，不能拼成完整PASS。原bounded失败分类仍未知，资源稳定下未复现；本轮环境缺配置单列，不更改产品。
- bounded定向：1 PASS。新增tick/state观测未在本轮日志看到输出，尚不能用作有效因果证据；保留原业务断言。
- server-composition：仍401期望收到503。此前认证请求200且standby=true；失败finally仅见standby→stopping，退出0。排除简单“没有进入standby”的解释；失败匿名请求尚无稳定响应码/细分授权状态，根因/引入分类未知，不改断言。下一步将同一匿名请求响应码与认证后端依赖状态关联。
- startup真实qualification：leader liveness超时；有界只读诊断显示waitingLocks=1、activeLeases=1、子进程未退出。证明已有lease且仍有锁等待，不证明锁对象与健康请求之间的唯一因果关系。尚需按连接关联元数据锁对象及监听状态；不解锁、不增加总超时。
- Edge4项：2PASS、2FAIL。首个环境失败分别为certutil缺失、未启用托管前端导致5173拒绝连接。补托管配置和测试管理员口令后登录启动停于LLM_CREDENTIAL_NOT_CONFIGURED，未触达原CI fatal。需要与CI相同的受控Provider及NSS环境才能继续原场景，不使用共享生产模型绕过。无付费模型调用。
- typecheck、source-policy、diff检查通过；异常诊断测试2PASS。完整CI仍未通过，原Reviewer尚未复核新候选。

原始本机证据在共享outputs/max684-controlled-diagnostics：execution.log、bounded.log、length-configured.log、composition.log、composition-state.json、startup.log、edge.log、login-managed.log、login-configured.log、redaction-tests.log、typecheck.log、source-policy.log。上述日志含既有产品输出，不直接作为已脱敏日志附件；本文为可跨环境访问的脱敏结果索引。诊断自身失败不覆盖业务断言。未知问题不请求重复授权；后续需要补齐观测及CI等效环境，产品修复须有具体因果差异。
