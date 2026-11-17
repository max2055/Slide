# 固定密码消费者调查与修复

输入 a759dad6fceef8e5bbe249866dedbf9a033c92c3。373 条中优先调查的 22 个固定认证输入 ID 已绑定 consumerReview，覆盖实际调用方、地址默认/覆盖、初始化与隔离约束。其余 351 条消费者链仍未完成，不属于权限阻塞；本报告不声称完成全部技术包。

deep-smoke 的 localhost API 固定地址和密码被确认是实际认证消费者。现改用 SMOKE_BASE_URL/SMOKE_USER/SMOKE_PASS，缺密码在 fetch 前失败；CLI 不初始化账号，实际目标授权仍由调用方负责。实际 CLI 回归覆盖缺配置拒绝及注入地址/账号/密码正确转发，不发送真实请求。

Playwright 默认配置在非 managed 模式连接已有前端；PLAYWRIGHT_BASE_URL 可覆盖 managed 地址。managed 模式启动 serve-e2e 且 reuseExistingServer=false，bootstrap 要求显式密码及 qualification 数据库前缀，并初始化 admin/qualification-viewer。CI 注入对应密码与 managed 标记，但该事实不能限制直接运行或地址覆盖。

三份消费者 spec（release-critical-paths、release-security、lazy-loaded-routes）移除原固定管理员密码，统一读取 QUALIFICATION_ADMIN_PASSWORD，与既有 bootstrap 输入一致。helper 在实际使用时校验，不使仅收集用例依赖私有环境。缺值/注入的实际函数检查通过；未运行真实浏览器或共享数据库业务验收。

构建映射：原 artifact14302744472 包可读，受控 artifact-audit.json 仅保留 path/line/rule，没有匹配偏移、值指纹或规则实现。已查原 max-681 受控目录中的脚本文件，未找到 independent-paired-field 的实现。缺失输入为原 Reviewer 的独立扫描正则/遍历和排序规则（持有人 15-Reviewer）；需要 Chief 协调交接后才能忠实重跑，不以自拟规则冒充原规则。旧九 ID 保持不可唯一追溯，原包及已发现源码文字位置仍可复用其有限证据。

A1/D2：22 条共用消费者证据与实际缺陷修复；351 条调查未完，九处需原规则。B2 增加缺凭据拒绝回归；B1/C1–C3 真实注入、窗口和业务未变。E1 历史下载暂停/shallow缺父边界保持；F1 新候选 CI、发布物证据未取得，旧 CI 不迁移。受影响安全与新增前端测试入口需由 Chief 统一交原 Reviewer 复核，尚未放行。
