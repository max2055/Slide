# Phase 117: OpenClaw收尾 - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-06-02
**Phase:** 117-openclaw
**Areas discussed:** 类型重命名策略, docs/ 更新深度, Branding Settings 设计

---

## 类型重命名策略

| Option | Description | Selected |
|--------|-------------|----------|
| 全局替换 | config/types.ts 改名 + 97 文件 search-replace | |
| 重命名 + 拆分配置类型 | 审视 OpenClawConfig shape 是否合理，删死者字段 | ✓ |
| 仅重命名类型 | 保持 interface 结构不变 | |

**User's choice:** 重命名 + 拆分配置类型 — 在重命名同时审视 interface shape，删除死字段。
**Notes:** 经代码分析确认，4 个字段中仅 `agents` 被实际使用。`session`/`update`/`bindings` 无 indexed access 引用。删除这 3 个死字段。

---

## 配置拆分（子决策）

| Option | Description | Selected |
|--------|-------------|----------|
| 删除死字段 | SlideConfig 只保留 agents | ✓ |
| 保留全部字段 | 不改 shape，纯重命名 | |

**User's choice:** 删除死字段。
**Notes:** `agents` 被 10+ 模块访问（compaction、model selection、block streaming 等），是唯一的活跃字段。

---

## 文档更新深度

| Option | Description | Selected |
|--------|-------------|----------|
| 精准替换 + 架构章节重写 | 重写 ARCHITECTURE.md 为 DirectAdapter 架构 | |
| 仅术语替换 | 5 个文档全局 search-replace | |
| 完整重写 | 按当前实际架构全面重写所有文档 | |
| 推迟 | 等项目稳定后再做 | ✓ |

**User's choice:** 推迟文档更新。项目直接架构还在变化中，等整体告一段落再更新。
**Notes:** Claude 同意 — 项目架构还在变动，现在写死的文档很快会过时。`docs/slide/` 下 5 个文档 ~79 处 OpenClaw/Gateway 引用暂不处理。

---

## Branding Settings — 持久化方案

| Option | Description | Selected |
|--------|-------------|----------|
| 新建 system_config 表 | 通用 key-value 配置表 | ✓ |
| 复用现有 settings 机制 | 扩展已有 API 模式 | |

**User's choice:** 发现 `system_config` 表已存在（`apps/db-ops-api/sql/schema.sql` L797），直接复用。
**Notes:** `scoring-config-service.ts` 和 `ai-analysis-config-service.ts` 已提供 `REPLACE INTO` + `SELECT WHERE config_key = ?` 读写参考。

---

## Branding Settings — 默认值策略

| Option | Description | Selected |
|--------|-------------|----------|
| branding.ts 保留为默认值 | 硬编码兜底 + DB 覆盖 | ✓ |
| 仅从 DB 读取 | 无默认值 fallback | |

**User's choice:** branding.ts 保留为编译时默认值。DB 不可用时 fallback。
**Notes:** 双层架构 — 硬编码提供编译时安全网，DB 提供运行时灵活性。

---

## Branding Settings — 生效机制

| Option | Description | Selected |
|--------|-------------|----------|
| 即时生效 | 写 DB + 刷新内存缓存 | ✓ |
| 需要重启 | 启动时读取一次 | |

**User's choice:** 即时生效。getter 函数 + 内存缓存，修改时刷新。

---

## Branding Settings — 可配置范围

| Option | Description | Selected |
|--------|-------------|----------|
| 全部 4 个字段 + DB 持久化 | CLI_NAME, PRODUCT_NAME, ENV_PREFIX, STATE_DIR | ✓ |
| 仅用户可见字段 + DB 持久化 | 只暴露 PRODUCT_NAME + CLI_NAME | |

**User's choice:** 全部 4 个字段。

---

## Claude's Discretion

- 类型重命名的执行策略（全局 sed 一键替换 vs 按模块逐步替换）
- `system_config` 读取 API 的实现方式（新建 vs 扩展）
- Branding Settings 前端 form UI 设计
- 内存缓存的刷新策略

## Deferred Ideas

- **文档更新** — `docs/slide/` 下 5 个文档（ARCHITECTURE.md 等）推迟到项目稳定后单独开 phase
