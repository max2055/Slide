/**
 * DB-Ops 工具集 — 入口
 *
 * 每个工具文件通过 module-side effect 调用 toolCatalog.register()，
 * 只需 import 此文件即可触发全部注册。
 */
import './get_instance_summary.js';
import './list_active_alerts.js';
import './query_metrics.js';
