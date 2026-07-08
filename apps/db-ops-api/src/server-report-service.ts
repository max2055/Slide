/**
 * Server Report Service
 *
 * Generates health inspection reports for SSH-managed servers.
 * Produces CPU/memory/disk/load dimension scores with HTML and Markdown output.
 *
 * Requirements: RPT-01, RPT-02, RPT-03, RPT-04
 */
import { dbConnection } from './db-connection';
import { serverDatabaseService } from './server-database-service';

// ── Types ───────────────────────────────────────────────────────────────────────

export interface ServerReportEntry {
  host: string;
  label: string | null;
  status: string;
  cpu_score: number;
  memory_score: number;
  disk_score: number;
  load_score: number;
  overall_score: number;
  metrics_summary: {
    cpu_usage_pct: number | null;
    memory_usage_pct: number | null;
    disk_usage_pct: number | null;
    load_1min: number | null;
  };
}

export interface ReportData {
  generated_at: string;
  server_count: number;
  healthy_count: number;
  warning_count: number;
  critical_count: number;
  servers: ServerReportEntry[];
}

export type ReportFormat = 'html' | 'md';

// ── Scoring helpers ─────────────────────────────────────────────────────────────

/**
 * Score a percentage-based metric (cpu, memory):
 * <50% → 100, 50-80% → 60, >80% → 20
 */
function scorePercentile(value: number | null): number {
  if (value === null) return 0;
  if (value < 50) return 100;
  if (value <= 80) return 60;
  return 20;
}

/**
 * Score load_1min relative to CPU count (assume 4 cores).
 * <1 → 100, 1-2 → 60, >2 → 20
 */
function scoreLoad(value: number | null): number {
  if (value === null) return 0;
  if (value < 1) return 100;
  if (value <= 2) return 60;
  return 20;
}

/**
 * Score a value (green/amber/red) — used for all dimension scores.
 */
function scoreClass(value: number): string {
  if (value > 80) return 'good';
  if (value >= 60) return 'warning';
  return 'critical';
}

// ── Service ─────────────────────────────────────────────────────────────────────

class ServerReportService {
  /**
   * Generate a health report for all servers with their latest metrics.
   */
  async generateReport(): Promise<ReportData> {
    const pool = dbConnection.getPool();
    if (!pool) {
      throw new Error('数据库未连接');
    }

    // Get all servers
    const servers = await serverDatabaseService.getAllServers();

    // Fetch latest metrics per server
    const serverEntries: ServerReportEntry[] = [];

    for (const server of servers) {
      // Get latest metric values
      const [rows] = await pool.execute(
        `SELECT sm.server_id, sm.metric_name, sm.metric_value, sm.recorded_at
         FROM server_metrics sm
         INNER JOIN (
           SELECT metric_name, MAX(recorded_at) AS max_time
           FROM server_metrics
           WHERE server_id = ?
           GROUP BY metric_name
         ) latest ON sm.metric_name = latest.metric_name AND sm.recorded_at = latest.max_time
         WHERE sm.server_id = ?
         ORDER BY sm.metric_name`,
        [server.id, server.id]
      ) as any;

      const metrics: Record<string, number> = {};
      const diskMetrics: { mount: string; value: number }[] = [];

      for (const row of rows) {
        const name: string = row.metric_name;
        if (row.metric_value === null || row.metric_value === undefined) continue;
        const value = Number(row.metric_value);

        if (name === 'cpu_usage') {
          metrics.cpu_usage = value;
        } else if (name === 'memory_usage') {
          metrics.memory_usage = value;
        } else if (name === 'load_1min') {
          metrics.load_1min = value;
        } else if (name.startsWith('disk_usage_')) {
          diskMetrics.push({
            mount: name.replace('disk_usage_', ''),
            value,
          });
        }
      }

      // Compute dimension scores
      const cpu_score = scorePercentile(metrics.cpu_usage ?? null);
      const memory_score = scorePercentile(metrics.memory_usage ?? null);

      // Disk: avg across mount points
      let disk_score = 0;
      if (diskMetrics.length > 0) {
        const avgDisk = diskMetrics.reduce((s, m) => s + m.value, 0) / diskMetrics.length;
        disk_score = scorePercentile(avgDisk);
      }

      const load_score = scoreLoad(metrics.load_1min ?? null);

      // Overall: avg of dimension scores
      const scoredDimensions = [cpu_score, memory_score, disk_score, load_score].filter(
        (s) => s > 0
      );
      const overall_score =
        scoredDimensions.length > 0
          ? Math.round(scoredDimensions.reduce((a, b) => a + b, 0) / scoredDimensions.length)
          : 0;

      serverEntries.push({
        host: server.host,
        label: server.label,
        status: server.status,
        cpu_score,
        memory_score,
        disk_score,
        load_score,
        overall_score,
        metrics_summary: {
          cpu_usage_pct: metrics.cpu_usage ?? null,
          memory_usage_pct: metrics.memory_usage ?? null,
          disk_usage_pct:
            diskMetrics.length > 0
              ? Math.round(diskMetrics.reduce((s, m) => s + m.value, 0) / diskMetrics.length * 100) / 100
              : null,
          load_1min: metrics.load_1min ?? null,
        },
      });
    }

    // Sort by overall_score ascending (worst first)
    serverEntries.sort((a, b) => a.overall_score - b.overall_score);

    // Count categories
    let healthy_count = 0;
    let warning_count = 0;
    let critical_count = 0;

    for (const entry of serverEntries) {
      if (entry.overall_score > 80) healthy_count++;
      else if (entry.overall_score >= 60) warning_count++;
      else critical_count++;
    }

    return {
      generated_at: new Date().toISOString(),
      server_count: serverEntries.length,
      healthy_count,
      warning_count,
      critical_count,
      servers: serverEntries,
    };
  }

  /**
   * Format report data as an HTML document.
   */
  generateHtml(reportData: ReportData): string {
    const { generated_at, server_count, healthy_count, warning_count, critical_count, servers } = reportData;
    const genDate = new Date(generated_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    const rows = servers
      .map(
        (s) => `
      <tr>
        <td>${this._escapeHtml(s.host)}${s.label ? `<br><small>${this._escapeHtml(s.label)}</small>` : ''}</td>
        <td>${this._statusBadge(s.status)}</td>
        <td class="score score-${scoreClass(s.cpu_score)}">${s.cpu_score}</td>
        <td class="score score-${scoreClass(s.memory_score)}">${s.memory_score}</td>
        <td class="score score-${scoreClass(s.disk_score)}">${s.disk_score}</td>
        <td class="score score-${scoreClass(s.load_score)}">${s.load_score}</td>
        <td class="score score-${scoreClass(s.overall_score)}"><strong>${s.overall_score}</strong></td>
      </tr>`
      )
      .join('\n');

    const overallHealthClass =
      critical_count > 0 ? 'critical' : warning_count > 0 ? 'warning' : 'good';

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>服务器健康巡检报告</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif; padding: 40px 20px; background: #f5f7fa; color: #333; }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    .subtitle { color: #666; font-size: 14px; margin-bottom: 24px; }
    .summary-cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 32px; }
    .card { padding: 20px; border-radius: 12px; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,0.08); text-align: center; }
    .card .num { font-size: 32px; font-weight: 700; }
    .card .label { font-size: 13px; color: #888; margin-top: 4px; }
    .card.good { border-top: 3px solid #4caf50; }
    .card.good .num { color: #4caf50; }
    .card.warning { border-top: 3px solid #ff9800; }
    .card.warning .num { color: #ff9800; }
    .card.critical { border-top: 3px solid #f44336; }
    .card.critical .num { color: #f44336; }
    .card.neutral { border-top: 3px solid #2196f3; }
    .card.neutral .num { color: #2196f3; }
    table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    th { background: #f5f7fa; padding: 12px 16px; text-align: left; font-size: 13px; font-weight: 600; color: #555; border-bottom: 2px solid #e8eaed; }
    td { padding: 12px 16px; border-bottom: 1px solid #f0f0f0; font-size: 14px; }
    tr:last-child td { border-bottom: none; }
    .score { text-align: center; font-weight: 600; padding: 6px 10px; border-radius: 6px; }
    .score-good { background: #e8f5e9; color: #2e7d32; }
    .score-warning { background: #fff3e0; color: #e65100; }
    .score-critical { background: #ffebee; color: #c62828; }
    small { color: #999; font-size: 12px; }
    .status-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; }
    .status-badge.online { background: #e8f5e9; color: #2e7d32; }
    .status-badge.offline { background: #eceff1; color: #607d8b; }
    .status-badge.error { background: #ffebee; color: #c62828; }
    .status-badge.unreachable { background: #fce4ec; color: #ad1457; }
    .overall-health { font-size: 14px; margin-bottom: 24px; padding: 12px 16px; border-radius: 8px; font-weight: 600; }
    .overall-health.good { background: #e8f5e9; color: #2e7d32; }
    .overall-health.warning { background: #fff3e0; color: #e65100; }
    .overall-health.critical { background: #ffebee; color: #c62828; }
    @media (max-width: 640px) {
      .summary-cards { grid-template-columns: repeat(2, 1fr); }
      table { font-size: 12px; }
      th, td { padding: 8px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>服务器健康巡检报告</h1>
    <p class="subtitle">生成时间: ${genDate}</p>

    <div class="summary-cards">
      <div class="card neutral">
        <div class="num">${server_count}</div>
        <div class="label">服务器总数</div>
      </div>
      <div class="card good">
        <div class="num">${healthy_count}</div>
        <div class="label">健康</div>
      </div>
      <div class="card warning">
        <div class="num">${warning_count}</div>
        <div class="label">警告</div>
      </div>
      <div class="card critical">
        <div class="num">${critical_count}</div>
        <div class="label">严重</div>
      </div>
    </div>

    ${
      critical_count > 0 || warning_count > 0
        ? `<div class="overall-health ${overallHealthClass}">${
            critical_count > 0
              ? `${critical_count} 台服务器存在严重问题，需要立即关注`
              : `${warning_count} 台服务器存在警告，建议检查`
          }</div>`
        : ''
    }

    <table>
      <thead>
        <tr>
          <th>服务器</th>
          <th>状态</th>
          <th>CPU</th>
          <th>内存</th>
          <th>磁盘</th>
          <th>负载</th>
          <th>综合评分</th>
        </tr>
      </thead>
      <tbody>
        ${rows || '<tr><td colspan="7" style="text-align:center;color:#999;">暂无可用的服务器数据</td></tr>'}
      </tbody>
    </table>

    <p style="margin-top: 24px; color: #999; font-size: 12px; text-align: center;">
      Slide — 服务器健康巡检报告 &middot; ${genDate}
    </p>
  </div>
</body>
</html>`;
  }

  /**
   * Format report data as Markdown.
   */
  generateMarkdown(reportData: ReportData): string {
    const { generated_at, server_count, healthy_count, warning_count, critical_count, servers } = reportData;
    const genDate = new Date(generated_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    let md = `# 服务器健康巡检报告\n\n`;
    md += `**生成时间:** ${genDate}\n\n`;

    md += `## 概览\n\n`;
    md += `| 项目 | 数量 |\n`;
    md += `| --- | --- |\n`;
    md += `| 服务器总数 | ${server_count} |\n`;
    md += `| 健康 | ${healthy_count} |\n`;
    md += `| 警告 | ${warning_count} |\n`;
    md += `| 严重 | ${critical_count} |\n\n`;

    if (critical_count > 0) {
      md += `> **警告:** ${critical_count} 台服务器存在严重问题，需要立即关注\n\n`;
    } else if (warning_count > 0) {
      md += `> **提示:** ${warning_count} 台服务器存在警告，建议检查\n\n`;
    }

    md += `## 服务器详情\n\n`;
    md += `| 服务器 | 标签 | 状态 | CPU评分 | 内存评分 | 磁盘评分 | 负载评分 | 综合评分 | CPU% | 内存% | 磁盘% | 负载 |\n`;
    md += `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n`;

    for (const s of servers) {
      const statusIcon =
        s.status === 'online'
          ? '🟢'
          : s.status === 'offline'
          ? '⚪'
          : s.status === 'error'
          ? '🔴'
          : '⚫';
      md += `| ${s.host} | ${s.label || '-'} | ${statusIcon} ${s.status} | ${s.cpu_score} | ${s.memory_score} | ${s.disk_score} | ${s.load_score} | **${s.overall_score}** | ${s.metrics_summary.cpu_usage_pct ?? '-'}% | ${s.metrics_summary.memory_usage_pct ?? '-'}% | ${s.metrics_summary.disk_usage_pct ?? '-'}% | ${s.metrics_summary.load_1min ?? '-'} |\n`;
    }

    md += `\n---\n*由 Slide 服务器健康巡检系统自动生成 — ${genDate}*\n`;

    return md;
  }

  // ── Private helpers ────────────────────────────────────────────────────────────

  private _escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  private _statusBadge(status: string): string {
    const cssMap: Record<string, string> = {
      online: 'online', offline: 'offline',
      error: 'error', unreachable: 'unreachable',
    };
    const cssClass = cssMap[status] || 'offline';
    return `<span class="status-badge ${cssClass}">${this._escapeHtml(status)}</span>`;
  }
}

// Singleton
export const serverReportService = new ServerReportService();
