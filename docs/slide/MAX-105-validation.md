# MAX-105：Token Estimation 与 Provider Context Window

## 执行契约与基线

范围 v1：估算 provenance、模型窗口/输出/capability、history/retrieval/schema/media 共用保守预算、校准与兼容回归。排除模型路由/fallback、供应商更换、Message Parts 新产品能力、部署和无关安全整改。硬预算未设定；代理数 0，最大深度 0，并发峰值 1；实际 input/cached/output token 和费用遥测不可用。验收失败先修范围内问题；不绕过远端合并门禁。

任务基线为 main `6c22d2a`。实际实现基线为已合并前七阶段的 main `9d7b0a0c42f02fb8cf554648e8edbb33455a6c96`：已包含 Canonical history、context authority、memory pipeline/retrieval 与 streaming boundary。原工作树有本地提交和用户修改，本次使用独立分支，不带入那些差异。

## 最终实现与兼容决定

- `countPromptTokens` 接口兼容旧 number 计数，增加带 method/model/version/rawTokens/margin 的返回值和可选 model 参数。每次估算核验返回值；undefined、异常、非法数字、模型不符降为明确原因的 conservative heuristic。接口存在本身不构成 exact 证据。旧 number 保留其“默认模型精确计数”的契约；内置供应商没有伪造 exact 实现。
- 原生 OpenAI 已知文本家族使用固定 `js-tiktoken@1.0.21`，标为 family-tokenizer。编码的对象是序列化 payload，不等于供应商完整聊天模板。margin 为 15% + 128 tokens，**并保留原 UTF-8 上界作为 floor**；本次没有凭未经校准比例降低生产预算。
- encoder 最多两个，provider cache 最多 64 个哈希键、TTL 五分钟、单 payload 上限 1 MB，可显式失效；不缓存 prompt 正文。型号、版本和 payload 均参与键。非原生 URL、未知型号、超大 payload 降为 heuristic；SDK 环境变量配置的 endpoint 同样被核验。
- 输入预算 = 实际窗口 − 输出上限 − 1024 安全预留，另受显式 contextBlockLimit 限制。较小显式窗口继续生效，超过已知模型限制的值被收紧。输出配置超出已知限制时拒绝，不静默路由其他模型。未知窗口 fallback 为 8192，必须由部署方配置小于该值的实际限制；fallback 不证明任意未知部署都有 8192。
- DirectAdapter chat/invoke 不再固定 200k/4096，capabilities 返回当前窗口和工具能力。factory 保留已存 context_window/max_tokens/capability，目录只收紧配置；自定义 endpoint 不因模型同名就继承较大窗口。没有更改 scene 路由或 fallback。
- Session/history、memory retrieval 与 memory extraction 共用 UTF-8 prompt 上界，包含 framing/schema/reference；历史仍按完整 user turn 投影，canonical 不变。提取请求增加模型窗口准入。保留最新完整 turn 不表示它一定能发送，最终 assertFits 负责拒绝超限。
- 图像/未知媒体的固定 allowance 只作 heuristic 信息，**不能证明其成本有界**。ContextManager 对未经校准媒体以完整窗口为 floor，发送前拒绝。本阶段不新增图像 projection；后续 MAX-106 需提供可证明成本的 capability projection 才能放行。
- 普通与 summary 未知 usage 请求均预留完整窗口；窗口已包含输入+输出，不再额外重复加输出预留。已有 cumulative usage/reservedTokens 原样恢复，不重算或重置历史账本；后续请求使用当前配置。实测吞吐仍是 prompt + completion，cached 是 prompt 子集，估算写入独立 `context_estimate_v1/context_config_v1`，不混入 usage。

## 冻结校准集

`packages/agent-core/src/__tests__/fixtures/token-calibration-v1.json`：140 个合成样本，英文、中文、SQL、JSON、tool schemas、未知模型、图像各 20 个。

SHA-256：`2f18171fbdb22a73e87df6f97e4ad3f969a2274c8c92894d53cff4fbd6cf1291`。

100 个已知文本/schema 样本的 ground truth 来自独立 **Python tiktoken 0.12.0** 对同一序列化 payload 的 cl100k_base/o200k_base 编码。测试核验 corpus hash、JS/Python 序列化一致性和原始计数一致性。**此 ground truth 不是供应商完整 chat prompt usage**；没有真实 exact provider 样本。未知模型和图像的 ground truth 为空，误差和低估率为 null，不能算零。

| 方法 | 有 ground truth 样本 | 原始 p50 / p95 绝对相对误差 | margin 后 p50 / p95 | margin 后低估率 |
|---|---:|---:|---:|---:|
| exact provider | 0 | 未验证 | 未验证 | 未验证 |
| family-tokenizer | 100 | 0% / 0% | 280.84% / 378.57% | 0% |
| conservative-heuristic | 100（另 40 无 truth） | 280.84% / 378.57% | 280.84% / 378.57% | 0% |

margin 后误差较大是保留 byte floor 的结果，本次未宣称提升完整 prompt 计费精度或降低生产 token 消耗。分类及逐样本数据见 `docs/slide/token-calibration-v1.json`。

复现：

```bash
pnpm --filter slide-api exec tsx ../../tests/qualification/token-calibration.ts ../../docs/slide/token-calibration-v1.json
# 仅重新冻结数据时需要 Python tiktoken==0.12.0；正常 CI 无 Python 依赖。
python tests/qualification/freeze-token-calibration.py
```

## 当前环境证据

本地 MySQL 的启用默认配置读回：`deepseek-v4-flash`，context_window 128000，max_tokens 2048，tools=true，vision=false。已存配置没有该型号的确切 tokenizer，故当前部署走 conservative heuristic；没有将 OpenAI-compatible 等同于 OpenAI tokenizer。

新代码对该配置得出输入预算 124928；代表请求上界 142 tokens、输出 2048、安全预留 1024，满足窗口。超大 schema 拒绝。只读取 provider 元数据，不从 provider store 解密/取用供应商密钥，不调用供应商；详情见 `docs/slide/token-provider-context-v1.json`。

检查时 3000/28888 无监听，MySQL 3306 为 Docker 暴露端口。因此**没有正在运行的新后端实例、真实供应商请求/usage 或生产请求不超窗的端到端证据**。历史父任务已记录供应商 HTTP 402；本次未追加付费尝试。SDK 本地 HTTP fixture 已证明配置输出被发送、prompt 准入、未知 usage 保守预留，以及超大 schema 在 HTTP 前拒绝；它不能替代真实供应商验证。

## 验证结果与门禁

- 隔离基线 focused checks：74 项通过。
- agent-core 全量 614 项通过，后端全量 2779 项通过、129 个环境相关测试跳过，两模块 typecheck 通过；未将跳过计为通过。新估算与边界回归覆盖错误/非法/undefined tokenizer、TTL/cache、CJK、媒体、超大 attachment/schema、窗口、summary、重启累计预算和 SDK request。
- 确定性 Runtime qualification：210 个正常控制样本，无误拒、无漏拒、无额外正常请求。不会据此宣称生产 rollout 通过。
- contracts:check、qualification:matrix（37/37）、secret scan 通过；lint 无 error（已有 warning）。
- 原先以隐式 200k 为条件的 long-runtime/streaming/policy fixture 改为显式 200k。旧冻结兼容 trace 只更新本次明确改变的未知 usage 预留数，原历史 trace 不变。
- 初始提交 `9a03947` 的 `pnpm security:audit` 被既有 DOMPurify 3.4.13 的 low 漏洞 `GHSA-p98j-92pf-mc4p` 阻塞，修复版本 >=3.4.16。该阶段新增依赖为 js-tiktoken，DOMPurify pin 未变；没有降低审计级别或绕过合并门禁。后续最小门禁修复见下面的范围增量记录。

验收 1/2 已有冻结数据及边界证据；3 有控制运行/SDK/累计账本证据；4 的配置准入、兼容和不降低旧上界已验证，**真实当前部署调用仍未验证**。无部署、无付费模型请求、无父任务整链验收。

## 范围 v1.1：最小合并门禁修复（2026-10-01）

保留上述 Token 范围、排除项及初始验证记录。CI run `36762919722` 的 backend 在生产依赖审计处退出 1；GitHub 实际为 4 项成功、1 项失败、3 项跳过，不能把平台的 7 passed 概括当作八项全部成功。失败与 Token 逻辑无关，但直接阻塞本任务明确要求的完整仓库合并门禁，按 AGENTS.md「控制范围扩张」的直接阻塞验收例外，仅将 DOMPurify override 从 3.4.13 升级到 3.4.16，并更新对应 lockfile；没有升级其他依赖、降低审计门槛或扩大部署/付费权限。

修复前再次运行 `pnpm security:audit`，复现同一 advisory；修复后：

- `pnpm install --frozen-lockfile --ignore-scripts` 成功。
- `pnpm security:audit` 成功，No known vulnerabilities found。
- `pnpm --filter slide-frontend exec vitest run src/app/ui/views/ai-analysis-result.test.ts src/app/ui/views/alerts-analysis.test.ts`：26 项通过，含 script/iframe/event handler 清理验证。
- `pnpm --filter slide-frontend test`：80 文件、542 项通过。
- `pnpm --filter slide-frontend typecheck` 成功。
- `pnpm --filter slide-frontend build` 成功，CSP 检查通过；既有 chunk 大小/动态导入警告保留。
- `git diff --check` 成功。Token/core/backend 实现未改变，复用初始有效验证证据；新 head 的完整 CI 仍须单独核验后才可合并。

未使用子代理，硬预算仍未设定；实际累计 token/费用遥测不可用，此范围增量不重置原任务统计。真实供应商与父任务整链验收仍未验证。
