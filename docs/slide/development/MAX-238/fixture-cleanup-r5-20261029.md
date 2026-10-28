# MAX238-FIXTURE-CLEANUP-R5：inspect 报错不再等同于“容器不存在”

本包只修 R4 遗留的同一状态判定缺陷。R4 的 `ref_state` 在 `docker info` 成功后，把 `docker inspect` 的**所有非零结果**都当成“不存在”，于是初查、删除后、删除失败后、`--cleanup-handle` 四条路径在“daemon 能应答但查询失败”时仍然 exit 0，最后一条还会删掉处置文件。R5 只改这一处判定与受影响入口/回归，不重做生产协议、业务实现或 R3 已接受内容。整单 MAX238/MAX235 仍未完成。

- 任务分支：`agent/15coder1/max-238`（只在 R4 `39077b228` 上追加，未切换/重置/改写已接受提交）
- 基点：`39077b228f345171bef3289a2dbda4374df54c03`（R4 交付）
- 范围：`frontend/e2e/max238-real-api.sh`、`frontend/e2e/max238-fixture-cleanup.test.sh`、`.github/workflows/ci.yml`（仅新增一步回归）
- 未改：`apps/db-ops-api/src/metrics/` 生产代码与测试、MAX240 读路径（`metrics/query.ts`、`storage.ts`、`rollout/formal-store.ts`、`consumers/*`）、policy/config/codec/谓词/必要项名单、fixture server 与 spec

## 1. 状态判定

`ref_state <ref>` 现在有三种结论，只有第二种允许报成功：

| 结论 | 判据 | 退出码 |
| --- | --- | --- |
| present | `docker info` 应答且 `docker inspect --type container` 成功 | 0 |
| 证明不存在 | inspect 失败，且 stderr 是 Docker 自己的 not-found 答复（`No such object:` / `No such container:`） | 1 |
| 未知 | `docker info` 失败，或 inspect 失败但错误不是 not-found（断连、超时、服务端错误、查询被拒） | 2 |

- 非 not-found 的 inspect 错误会把原始错误与 inspect 退出码一起打进 stderr，并显式 `handle=<ref>`；不再静默归为 absent。
- 所有入口共用该函数：launcher 启动前的同名检查、`--cleanup`、`--cleanup-handle`、`remove_owned` 的删除失败后复查与删除后核验、EXIT trap；API fixture `shutdown` 与浏览器 spec `afterAll` 分别调用 `--cleanup` / `--cleanup-handle`，因此走同一条判定。
- 处置文件只在“已验证不存在”后删除；未知、错误 owner、删除失败、删除后无法核验都保留文件和确切句柄。
- 归属规则不变：仍只删除标签匹配本 run nonce 的确切容器 ID，API 只做核对，不扫前缀。

本机真实 Docker 的 not-found 文本已核对：`Error response from daemon: No such container: <name>`，命中上述判据。

## 2. 回归

`frontend/e2e/max238-fixture-cleanup.test.sh` 的假 `docker` 增加了一个“前 N 次 inspect 成功、之后报内部错误”的开关，用于表达“daemon 刚才还应答、紧接着查询失败”。四条独立反例：

| 反例 | 期望 |
| --- | --- |
| info 成功、inspect 内部错误、资源仍在 | exit 1，`could not answer whether … exists`，资源存活 |
| `--cleanup-handle` 初查即 inspect 内部错误、资源仍在 | exit 1，资源存活，**处置文件保留** |
| rm 成功、删除后 inspect 内部错误 | exit 1，`FAILED to verify removal`，处置文件保留 |
| rm 失败、后续查询也失败、资源仍在 | exit 1，`FAILED to remove`，资源存活 |

同时保留“真正 not-found 仍幂等”的覆盖：同一句柄再次清理 → exit 0、`verified absent`。原有正常删除、错误 owner、daemon 不可达、删除失败、同前缀并行邻居、handle 文件缺失/损坏/一致/不一致用例不变。

这些替身是受控命令替身，不连接真实 Docker daemon；它们证明脚本的状态判定与退出码，**不等于**真实 daemon 故障注入。

## 3. CI 接入

`.github/workflows/ci.yml` 的 `frontend` job 在 “Run tests” 之后新增一步 `bash frontend/e2e/max238-fixture-cleanup.test.sh`。该 job 已由 `scripts/ci/plan.mjs` 在 `frontend/e2e/**` 变更时选中（`code/browser/integration`），未新增 job、巡检或框架。

## 4. 验证

| 检查 | 结果 |
| --- | --- |
| `bash -n`（harness 与回归脚本） | 退出 0 |
| `bash frontend/e2e/max238-fixture-cleanup.test.sh` | **47 passed / 0 failed** |
| `node --test scripts/ci/*.test.mjs` | **22 pass / 0 fail**（CI 选择逻辑未受影响） |
| `ci.yml` YAML 解析 + frontend job 步骤回读 | 通过，新步骤在 “Run tests” 后 |
| 真实 Docker：不存在句柄 `--cleanup` | exit 0，`verified absent` |
| 真实 Docker：错误 owner | exit 1，`refusing to remove`，容器存活 |
| 真实 Docker：正确 owner 清理 + 再次清理 | exit 0 `removed … (id … owner …)`；再 exit 0 `verified absent` |
| 真实 Docker 残留 | 0（探针容器均已删除） |

R3 的公开 keyed 授权/完整协议、R4 的作者证据（Chromium 4 项、一次性 journal、shutdown、typechecks/contracts）未变，直接复用，本包不重跑浏览器/DB/typecheck。

## 5. 未覆盖与限制

- 只改 harness 状态判定、受控回归与 CI 接线；生产协议、DB、模块与前端行为未变，不重新声明 R3 已接受的生产结论。
- 受控替身不是真实 daemon 故障：真实断连/超时/服务端错误未在本机复现（不操作本机 daemon）；真实路径只剩 not-found 与正常删除两种状态得到实机验证。
- 试采边界仍是受控 fixture；不证明真实登录、真实目标、真实采集或正式 history/event 链。
- CI 观测到的 `portfolio.mysql.test.ts` / `coordinator.mysql.test.ts` 严格 binding payload 失败不在本包范围，未用放宽 codec、删断言或跳过测试掩盖。
- 未合并、未部署；MAX238/MAX235 保持 in_progress。
