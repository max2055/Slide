# Requirements: Slide v1.3

**Defined:** 2026-05-20
**Core Value:** AI 原生的数据库运维 — Agent 自动采集数据、分析问题、给出建议

## v1.3 Requirements

### Phase 0: 安全紧急修复

- [x] **SEC-01**: 4 个未受保护的路由添加 auth 中间件（GET /api/alerts、GET /api/metrics/:instanceId、GET /api/database/instances、GET /api/chat/history）
- [x] **SEC-02**: 修复 login-gate 中 eyeOff 图标缺失导致登录页运行时崩溃
- [x] **SEC-03**: 移除 monitor-collector.ts 中重复的 checkAlerts()，统一由 alert-engine 产生告警
- [x] **SEC-04**: 修复 report-service.ts 中 health_score 硬编码为 100，替换为实际计算值

### 认证权限

- [x] **AUTH-01**: 实现 JWT refresh token 机制（新增 /api/auth/refresh 路由、refresh_tokens 表、token rotation）
- [x] **AUTH-02**: 前端 ApiClient 添加 401 拦截器，自动透明刷新 token
- [x] **AUTH-03**: 实现时效性角色授权（grant_expiry 列，到期自动回收）
- [x] **AUTH-04**: 实现实例级访问级别控制（read-only / read-write / admin）
- [x] **AUTH-05**: 前端导航根据用户权限感知隐藏不可访问的菜单项

### UI 统一

- [x] **UI-01**: 合并两个图标文件（styles/icons.ts + openclaw/ui/icons.ts）为一个规范文件
- [x] **UI-02**: 补充 33 个缺失的图标引用（包括 eyeOff、barChart、fileText、checkCircle 等）
- [x] **UI-03**: 统一图标命名规范（解决 kebab-case 与 camelCase 混用问题）
- [x] **UI-04**: 提取 ov-card 重复 CSS 为共享 `<stat-card>` Lit 组件，应用到 6 个视图
- [x] **UI-05**: 替换所有 emoji 和 inline SVG 为共享图标调用

### 报表重构

- [ ] **RPT-01**: 将 report-service.ts 中 638 行内联 HTML 提取为 EJS 模板文件（新增 ejs@5.0.2）
- [ ] **RPT-02**: 新增 report_configs 表，支持定时报表生成调度
- [ ] **RPT-03**: 修复报表类型命名不一致（slow-query vs slow_query），统一命名并迁移现有数据
- [ ] **RPT-04**: 在报表视图中使用共享 `<stat-card>` 组件替换 ov-card（依赖 UI-04）

### 告警系统增强

- [ ] **ALERT-01**: 告警规则阈值可编辑（3 级阈值：warning / error / critical），修复 PUT 路由持久化
- [ ] **ALERT-02**: 告警规则启用/禁用 toggle 开关前后端完整实现
- [ ] **ALERT-03**: threshold_type 和 silence_minutes 持久化到数据库（新增列 + migration + updateAlertRule 修复）
- [ ] **ALERT-04**: 修复事件聚合 5 分钟固定桶边界碰撞问题

### 数据质量

- [ ] **QUAL-01**: 实现多维度实例评分算法（可用性 0.35、性能 0.35、容量 0.20、安全性 0.10，权重可配置）
- [ ] **QUAL-02**: 基于 health_check_history 实现评分趋势图表
- [ ] **QUAL-03**: 实现每实例采集能力检测（collection_capabilities JSON 列 + 权限检测端点）
- [ ] **QUAL-04**: 健康状态展示增加逐检查项详情（非仅总分）

## v2+ Requirements

Deferred to future milestone.

### 告警系统

- **ALERT-05**: AI 自适应阈值学习（alert-threshold-learner.ts cron，基于 baseline-calculator 的 z-score 算法）
- **ALERT-06**: 多会话事件聚合（跨指标关联：CPU + 内存 + 连接 → 实例压力事件）
- **ALERT-07**: 基于告警频率的自适应静默期
- **ALERT-08**: 用 MetricDefinition.category 替换硬编码 metric-to-alert-type 映射

## Out of Scope

| Feature | Reason |
|---------|--------|
| SSO / OAuth / LDAP 集成 | 内网运维工具，用户名密码认证已满足需求 |
| Puppeteer/Playwright HTML-to-PDF | 现有 PDFKit 已处理 4 种报告类型，无需 300MB Chromium |
| 外部图标库 (@material/web, lucide-static) | 已有 60+ Lucide-style SVG icons，继续扩展自有图标集 |
| OS 级指标采集（agent） | 当前只读 SQL 采集已覆盖 v1.3 需求 |
| 完全可视化主题重设计 | 打磨性工作，延后到 v2+ |
| 自定义报表模板和 ad-hoc 构建器 | 复杂度高，非核心运维场景 |
| 权限继承链（100+ 超细粒度权限码） | 现有 RBAC 表结构已足够 |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| SEC-01 | Phase 100 | Complete |
| SEC-02 | Phase 100 | Complete |
| SEC-03 | Phase 100 | Complete |
| SEC-04 | Phase 100 | Complete |
| AUTH-01 | Phase 101 | Complete |
| AUTH-02 | Phase 101 | Complete |
| AUTH-03 | Phase 101 | Complete |
| AUTH-04 | Phase 101 | Complete |
| AUTH-05 | Phase 101 | Complete |
| UI-01 | Phase 102 | Complete |
| UI-02 | Phase 102 | Complete |
| UI-03 | Phase 102 | Complete |
| UI-04 | Phase 102 | Complete |
| UI-05 | Phase 102 | Complete |
| RPT-01 | Phase 103 | Pending |
| RPT-02 | Phase 103 | Pending |
| RPT-03 | Phase 103 | Pending |
| RPT-04 | Phase 103 | Pending |
| ALERT-01 | Phase 104 | Pending |
| ALERT-02 | Phase 104 | Pending |
| ALERT-03 | Phase 104 | Pending |
| ALERT-04 | Phase 104 | Pending |
| QUAL-01 | Phase 105 | Pending |
| QUAL-02 | Phase 105 | Pending |
| QUAL-03 | Phase 105 | Pending |
| QUAL-04 | Phase 105 | Pending |

**Coverage:**
- v1.3 requirements: 26 total
- Mapped to phases: 26
- Unmapped: 0 ✓

---
*Requirements defined: 2026-05-20*
*Last updated: 2026-05-20 after research and scoping*
