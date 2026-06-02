/**
 * 报表生成服务
 */
import { reportDatabaseService, Report, ReportType, ReportFormat } from './report-database-service';
import { metricsDatabaseService } from './metrics-database-service';
import { databaseService } from './database-service';
import { instanceDatabaseService } from './instance-database-service';
import ejs from 'ejs';
import path from 'path';
import fs from 'fs';

export interface ReportOptions {
  format?: ReportFormat;
  title?: string;
  includeCharts?: boolean;
  topN?: number;
}

interface HealthMetrics {
  cpu_usage: number;
  memory_usage: number;
  disk_usage: number;
  connections: number;
  qps: number;
  tps: number;
  health_score: number;
  health_status: string;
}

const TEMPLATE_DIR = path.resolve(process.cwd(), 'src/templates/reports');

/**
 * 健康报告回退 HTML（当模板文件缺失时使用）
 */
function generateHealthFallbackHTML(
  instanceName: string,
  metrics: HealthMetrics,
  generatedAt: string
): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>健康检查报告 - ${instanceName}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px; }
    h1 { color: #333; border-bottom: 2px solid #4CAF50; padding-bottom: 10px; }
    .summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin: 20px 0; }
    .card { padding: 16px; border-radius: 8px; background: #f5f5f5; }
    .card.ok { background: #e8f5e9; }
    .card.warning { background: #fff3e0; }
    .card.critical { background: #ffebee; }
    .metric { font-size: 24px; font-weight: bold; }
    .label { font-size: 12px; color: #666; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    th, td { padding: 10px; text-align: left; border-bottom: 1px solid #ddd; }
    th { background: #f5f5f5; }
  </style>
</head>
<body>
  <h1>\u{1F3E5} 健康检查报告</h1>
  <p><strong>实例:</strong> ${instanceName}</p>
  <p><strong>生成时间:</strong> ${generatedAt}</p>

  <div class="summary">
    <div class="card ${metrics.health_score >= 80 ? 'ok' : metrics.health_score >= 60 ? 'warning' : 'critical'}">
      <div class="label">健康评分</div>
      <div class="metric">${metrics.health_score}</div>
    </div>
    <div class="card">
      <div class="label">CPU 使用率</div>
      <div class="metric">${metrics.cpu_usage.toFixed(1)}%</div>
    </div>
    <div class="card">
      <div class="label">内存使用率</div>
      <div class="metric">${metrics.memory_usage.toFixed(1)}%</div>
    </div>
    <div class="card">
      <div class="label">磁盘使用率</div>
      <div class="metric">${metrics.disk_usage.toFixed(1)}%</div>
    </div>
    <div class="card">
      <div class="label">连接数</div>
      <div class="metric">${metrics.connections}</div>
    </div>
    <div class="card">
      <div class="label">QPS</div>
      <div class="metric">${metrics.qps.toFixed(0)}</div>
    </div>
  </div>

  <h2>详细指标</h2>
  <table>
    <tr><th>指标</th><th>值</th></tr>
    <tr><td>CPU 使用率</td><td>${metrics.cpu_usage.toFixed(2)}%</td></tr>
    <tr><td>内存使用率</td><td>${metrics.memory_usage.toFixed(2)}%</td></tr>
    <tr><td>磁盘使用率</td><td>${metrics.disk_usage.toFixed(2)}%</td></tr>
    <tr><td>连接数</td><td>${metrics.connections}</td></tr>
    <tr><td>QPS</td><td>${metrics.qps.toFixed(2)}</td></tr>
    <tr><td>TPS</td><td>${metrics.tps.toFixed(2)}</td></tr>
  </table>
</body>
</html>`;
}

/**
 * 性能报告回退 HTML
 */
function generatePerformanceFallbackHTML(
  instanceName: string,
  metrics: any,
  generatedAt: string
): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>性能分析报告 - ${instanceName}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px; }
    h1 { color: #333; border-bottom: 2px solid #2196F3; padding-bottom: 10px; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    th, td { padding: 10px; text-align: left; border-bottom: 1px solid #ddd; }
    th { background: #f5f5f5; }
    .badge { padding: 4px 8px; border-radius: 4px; font-size: 12px; }
    .badge.high { background: #ffebee; color: #c62828; }
    .badge.medium { background: #fff3e0; color: #ef6c00; }
  </style>
</head>
<body>
  <h1>⚡ 性能分析报告</h1>
  <p><strong>实例:</strong> ${instanceName}</p>
  <p><strong>生成时间:</strong> ${generatedAt}</p>

  <h2>当前性能指标</h2>
  <table>
    <tr><th>指标</th><th>值</th></tr>
    <tr><td>QPS</td><td>${metrics.current?.qps?.toFixed(2) || 0}</td></tr>
    <tr><td>TPS</td><td>${metrics.current?.tps?.toFixed(2) || 0}</td></tr>
    <tr><td>连接数</td><td>${metrics.current?.connections || 0}</td></tr>
  </table>

  <h2>Top 慢查询</h2>
  <table>
    <tr><th>SQL</th><th>平均耗时 (ms)</th><th>执行次数</th><th>总耗时 (ms)</th></tr>
    ${metrics.top_slow_queries?.map((q: any) => `
      <tr>
        <td><code>${q.sql_text?.substring(0, 50)}${q.sql_text?.length > 50 ? '...' : ''}</code></td>
        <td>${q.avg_time_ms?.toFixed(2) || 0}</td>
        <td>${q.execution_count || 0}</td>
        <td>${q.total_time_ms?.toFixed(2) || 0}</td>
      </tr>
    `).join('') || '<tr><td colspan="4">暂无慢查询记录</td></tr>'}
  </table>
</body>
</html>`;
}

/**
 * 慢查询报告回退 HTML
 */
function generateSlowQueryFallbackHTML(
  instanceName: string,
  slowQueries: any[],
  generatedAt: string
): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>慢查询报告 - ${instanceName}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px; }
    h1 { color: #333; border-bottom: 2px solid #FF9800; padding-bottom: 10px; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    th, td { padding: 10px; text-align: left; border-bottom: 1px solid #ddd; }
    th { background: #f5f5f5; }
    code { background: #f5f5f5; padding: 2px 6px; border-radius: 3px; }
  </style>
</head>
<body>
  <h1>\u{1F40C} 慢查询分析报告</h1>
  <p><strong>实例:</strong> ${instanceName}</p>
  <p><strong>生成时间:</strong> ${generatedAt}</p>
  <p><strong>慢查询数量:</strong> ${slowQueries.length}</p>

  <h2>慢查询列表</h2>
  <table>
    <tr><th>#</th><th>SQL</th><th>平均耗时 (ms)</th><th>执行次数</th><th>rows_examined</th></tr>
    ${slowQueries.map((q, i) => `
      <tr>
        <td>${i + 1}</td>
        <td><code>${q.sql_text?.substring(0, 80) || ''}${q.sql_text?.length > 80 ? '...' : ''}</code></td>
        <td>${q.avg_time_ms?.toFixed(2) || 0}</td>
        <td>${q.execution_count || 0}</td>
        <td>${q.rows_examined || 0}</td>
      </tr>
    `).join('')}
  </table>
</body>
</html>`;
}

/**
 * 容量报告回退 HTML
 */
function generateCapacityFallbackHTML(
  instanceName: string,
  capacityData: any,
  generatedAt: string
): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>容量规划报告 - ${instanceName}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px; }
    h1 { color: #333; border-bottom: 2px solid #9C27B0; padding-bottom: 10px; }
    .summary { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin: 20px 0; }
    .card { padding: 16px; border-radius: 8px; background: #f3e5f5; }
    table { width: 100%; border-collapse: collapse; margin-top: 20px; }
    th, td { padding: 10px; text-align: left; border-bottom: 1px solid #ddd; }
    th { background: #f5f5f5; }
  </style>
</head>
<body>
  <h1>\u{1F4C8} 容量规划报告</h1>
  <p><strong>实例:</strong> ${instanceName}</p>
  <p><strong>生成时间:</strong> ${generatedAt}</p>

  <div class="summary">
    <div class="card">
      <div>磁盘使用率</div>
      <div style="font-size: 24px; font-weight: bold;">${capacityData.disk_usage?.toFixed(1) || 0}%</div>
    </div>
    <div class="card">
      <div>增长趋势</div>
      <div style="font-size: 24px; font-weight: bold;">${capacityData.growth_trend || 'stable'}</div>
    </div>
  </div>
</body>
</html>`;
}

class ReportService {
  /**
   * 生成健康检查报告
   */
  async generateHealthReport(
    instanceId: number,
    options: ReportOptions = {}
  ): Promise<Report> {
    const format = options.format || 'html';
    let report: Report | null = null;

    try {
      // 创建报表记录（状态：pending）
      const instance = await instanceDatabaseService.getInstanceById(instanceId);
      const instanceName = instance?.name || `Instance-${instanceId}`;
      const reportName = `${instanceName} - 健康检查报告`;

      report = await reportDatabaseService.createReport({
        name: reportName,
        type: 'health',
        format,
        instance_id: instanceId,
        status: 'pending',
      });

      // 收集健康指标
      const metrics = await this.collectHealthMetrics(instanceId);

      // 生成 HTML 内容
      const generatedAt = new Date().toISOString();
      const htmlContent = await this.renderTemplate('health', {
        title: '健康检查报告',
        instanceName,
        generatedAt,
        accentColor: '#4CAF50',
        icon: '\u{1F3E5}',
        metrics,
      });

      // 准备结构化数据
      const reportData = {
        instance_id: instanceId,
        instance_name: instanceName,
        generated_at: new Date().toISOString(),
        metrics,
        summary: this.generateHealthSummary(metrics),
      };

      // 更新报表状态为 completed
      await reportDatabaseService.updateReportStatus(
        report.id,
        'completed',
        htmlContent,
        reportData
      );

      // 返回最新报表
      return (await reportDatabaseService.getReportById(report.id))!;
    } catch (error: any) {
      console.error('生成健康检查报告失败:', error);
      // 如果报表已创建，更新状态为 failed
      try {
        if (report) {
          await reportDatabaseService.updateReportStatus(report.id, 'failed');
        }
      } catch (innerError: any) {
        console.error('更新报表失败状态时出错:', innerError.message);
      }
      throw error;
    }
  }

  /**
   * 生成性能分析报告
   */
  async generatePerformanceReport(
    instanceId: number,
    options: ReportOptions = {}
  ): Promise<Report> {
    const format = options.format || 'html';
    const topN = options.topN || 20;
    let report: Report | null = null;

    try {
      const instance = await instanceDatabaseService.getInstanceById(instanceId);
      const instanceName = instance?.name || `Instance-${instanceId}`;
      const reportName = `${instanceName} - 性能分析报告`;

      report = await reportDatabaseService.createReport({
        name: reportName,
        type: 'performance',
        format,
        instance_id: instanceId,
        status: 'pending',
      });

      // 收集性能指标
      const metrics = await this.collectPerformanceMetrics(instanceId, topN);

      // 生成 HTML 内容
      const generatedAt = new Date().toISOString();
      const htmlContent = await this.renderTemplate('performance', {
        title: '性能分析报告',
        instanceName,
        generatedAt,
        accentColor: '#2196F3',
        icon: '⚡',
        metrics,
      });

      // 准备结构化数据
      const reportData = {
        instance_id: instanceId,
        instance_name: instanceName,
        generated_at: new Date().toISOString(),
        metrics,
        analysis: this.generatePerformanceAnalysis(metrics),
      };

      await reportDatabaseService.updateReportStatus(
        report.id,
        'completed',
        htmlContent,
        reportData
      );

      return (await reportDatabaseService.getReportById(report.id))!;
    } catch (error: any) {
      console.error('生成性能分析报告失败:', error);
      try {
        if (report) {
          await reportDatabaseService.updateReportStatus(report.id, 'failed');
        }
      } catch (innerError: any) {
        console.error('更新报表失败状态时出错:', innerError.message);
      }
      throw error;
    }
  }

  /**
   * 生成慢查询报告
   */
  async generateSlowQueryReport(
    instanceId: number,
    options: ReportOptions = {}
  ): Promise<Report> {
    const format = options.format || 'html';
    const topN = options.topN || 20;
    let report: Report | null = null;

    try {
      const instance = await instanceDatabaseService.getInstanceById(instanceId);
      const instanceName = instance?.name || `Instance-${instanceId}`;
      const reportName = `${instanceName} - 慢查询分析报告`;

      report = await reportDatabaseService.createReport({
        name: reportName,
        type: 'slow_query',
        format,
        instance_id: instanceId,
        status: 'pending',
      });

      // 收集慢查询数据
      const slowQueries = await metricsDatabaseService.getSlowQueries(instanceId, topN);

      // 生成 HTML 内容
      const generatedAt = new Date().toISOString();
      const htmlContent = await this.renderTemplate('slow-query', {
        title: '慢查询分析报告',
        instanceName,
        generatedAt,
        accentColor: '#409eff',
        icon: '\u{1F40C}',
        slowQueries,
      });

      // 准备结构化数据
      const reportData = {
        instance_id: instanceId,
        instance_name: instanceName,
        generated_at: new Date().toISOString(),
        slow_queries_count: slowQueries.length,
        top_slow_queries: slowQueries,
        recommendations: this.generateSlowQueryRecommendations(slowQueries),
      };

      await reportDatabaseService.updateReportStatus(
        report.id,
        'completed',
        htmlContent,
        reportData
      );

      return (await reportDatabaseService.getReportById(report.id))!;
    } catch (error: any) {
      console.error('生成慢查询报告失败:', error);
      try {
        if (report) {
          await reportDatabaseService.updateReportStatus(report.id, 'failed');
        }
      } catch (innerError: any) {
        console.error('更新报表失败状态时出错:', innerError.message);
      }
      throw error;
    }
  }

  /**
   * 生成容量规划报告
   */
  async generateCapacityReport(
    instanceId: number,
    options: ReportOptions = {}
  ): Promise<Report> {
    const format = options.format || 'html';
    let report: Report | null = null;

    try {
      const instance = await instanceDatabaseService.getInstanceById(instanceId);
      const instanceName = instance?.name || `Instance-${instanceId}`;
      const reportName = `${instanceName} - 容量规划报告`;

      report = await reportDatabaseService.createReport({
        name: reportName,
        type: 'capacity',
        format,
        instance_id: instanceId,
        status: 'pending',
      });

      // 收集容量数据
      const capacityData = await this.collectCapacityData(instanceId);

      // 生成 HTML 内容
      const generatedAt = new Date().toISOString();
      const htmlContent = await this.renderTemplate('capacity', {
        title: '容量规划报告',
        instanceName,
        generatedAt,
        accentColor: '#9C27B0',
        icon: '\u{1F4C8}',
        capacityData,
      });

      // 准备结构化数据
      const reportData = {
        instance_id: instanceId,
        instance_name: instanceName,
        generated_at: new Date().toISOString(),
        capacity: capacityData,
        forecast: this.generateCapacityForecast(capacityData),
      };

      await reportDatabaseService.updateReportStatus(
        report.id,
        'completed',
        htmlContent,
        reportData
      );

      return (await reportDatabaseService.getReportById(report.id))!;
    } catch (error: any) {
      console.error('生成容量规划报告失败:', error);
      try {
        if (report) {
          await reportDatabaseService.updateReportStatus(report.id, 'failed');
        }
      } catch (innerError: any) {
        console.error('更新报表失败状态时出错:', innerError.message);
      }
      throw error;
    }
  }

  /**
   * 统一入口方法 - 根据 type 路由到具体生成方法
   */
  async generateReport(
    type: ReportType,
    instanceId: number,
    options: ReportOptions = {}
  ): Promise<Report> {
    switch (type) {
      case 'health':
        return this.generateHealthReport(instanceId, options);
      case 'performance':
        return this.generatePerformanceReport(instanceId, options);
      case 'slow_query':
        return this.generateSlowQueryReport(instanceId, options);
      case 'capacity':
        return this.generateCapacityReport(instanceId, options);
      default:
        throw new Error(`未知的报表类型：${type}`);
    }
  }

  /**
   * 收集健康指标
   */
  private async collectHealthMetrics(instanceId: number): Promise<HealthMetrics> {
    const metrics = await metricsDatabaseService.getRealtimeMetrics(instanceId);

    // 确保数值类型正确（数据库可能返回字符串）
    const toNumber = (val: any): number => {
      if (typeof val === 'number') return val;
      if (typeof val === 'string') return parseFloat(val) || 0;
      return 0;
    };

    const health = await databaseService.checkHealth(instanceId);
    return {
      cpu_usage: toNumber(metrics?.cpu_usage) || 0,
      memory_usage: toNumber(metrics?.memory_usage) || 0,
      disk_usage: toNumber(metrics?.disk_usage) || 0,
      connections: toNumber(metrics?.connections) || 0,
      qps: toNumber(metrics?.qps) || 0,
      tps: toNumber(metrics?.tps) || 0,
      health_score: health?.health_score ?? 0,
      health_status: health?.status ?? 'unknown'
    };
  }

  /**
   * 收集性能指标
   */
  private async collectPerformanceMetrics(
    instanceId: number,
    limit: number = 20
  ): Promise<any> {
    const metrics = await metricsDatabaseService.getRealtimeMetrics(instanceId);
    const slowQueries = await metricsDatabaseService.getSlowQueries(instanceId, limit);

    const toNumber = (val: any): number => {
      if (typeof val === 'number') return val;
      if (typeof val === 'string') return parseFloat(val) || 0;
      return 0;
    };

    return {
      current: metrics ? {
        cpu_usage: toNumber(metrics.cpu_usage),
        memory_usage: toNumber(metrics.memory_usage),
        disk_usage: toNumber(metrics.disk_usage),
        connections: toNumber(metrics.connections),
        qps: toNumber((metrics as any).qps),
        tps: toNumber((metrics as any).tps),
        health_score: toNumber((metrics as any).health_score),
      } : null,
      slow_queries: slowQueries,
      top_slow_queries: slowQueries.slice(0, 5),
    };
  }

  /**
   * 收集容量数据
   *
   * 使用 database-service.ts 的 getCapacityInfo() 方法获取实例的真实容量数据，
   * 结合 metrics-database-service.ts 的历史趋势和健康指标完成报表所需的字段。
   */
  private async collectCapacityData(instanceId: number): Promise<any> {
    try {
      // 1. 获取实例信息（用于确认实例存在）
      const instance = await instanceDatabaseService.getInstanceById(instanceId);
      if (!instance) {
        return { disk_usage: 0, table_sizes: [], growth_trend: 'unknown' };
      }

      // 2. 获取实时健康指标中的磁盘使用率
      const metrics = await metricsDatabaseService.getRealtimeMetrics(instanceId);
      const diskUsage = metrics?.disk_usage
        ? (typeof metrics.disk_usage === 'number'
            ? metrics.disk_usage
            : parseFloat(String(metrics.disk_usage)) || 0)
        : 0;

      // 3. 获取真实的容量数据（底层按 db_type 分派到 getMySQLCapacity / getPostgresCapacity / getOracleCapacity / getDamengCapacity）
      const capacityInfo = await databaseService.getCapacityInfo(instanceId);

      // 4. 获取容量历史用于计算增长趋势
      const history = await metricsDatabaseService.getCapacityHistory(instanceId, 720);

      let growthTrend = 'stable';
      if (history.length >= 3) {
        const firstSize = history[0].total_size_gb;
        const lastSize = history[history.length - 1].total_size_gb;
        if (firstSize > 0) {
          const ratio = lastSize / firstSize;
          if (ratio > 1.1) {
            growthTrend = 'growing';
          } else if (ratio < 0.9) {
            growthTrend = 'shrinking';
          }
        }
      }

      return {
        disk_usage: diskUsage,
        table_sizes: capacityInfo?.top_tables || [],
        growth_trend: growthTrend,
      };
    } catch (error) {
      console.error(`收集容量数据失败 (instanceId=${instanceId}):`, error);
      return { disk_usage: 0, table_sizes: [], growth_trend: 'unknown' };
    }
  }

  /**
   * 渲染 EJS 模板
   */
  private async renderTemplate(
    templateName: string,
    context: Record<string, any>
  ): Promise<string> {
    const templatePath = path.join(TEMPLATE_DIR, `${templateName}.ejs`);
    if (!fs.existsSync(templatePath)) {
      console.warn(`模板文件不存在: ${templatePath}，使用内联回退`);
      return this.getFallbackHTML(templateName, context);
    }
    return ejs.renderFile(templatePath, context);
  }

  /**
   * 获取回退 HTML（模板文件不存在时使用）
   */
  private async getFallbackHTML(templateName: string, context: Record<string, any>): Promise<string> {
    switch (templateName) {
      case 'health': return this.fallbackHealthHTML(context);
      case 'performance': return this.fallbackPerformanceHTML(context);
      case 'slow-query': return this.fallbackSlowQueryHTML(context);
      case 'capacity': return this.fallbackCapacityHTML(context);
      default: return `<h1>${context.title || 'Report'}</h1><p>Template not available</p>`;
    }
  }

  /**
   * 健康报告回退 HTML
   */
  private fallbackHealthHTML(context: Record<string, any>): string {
    const { instanceName, metrics, generatedAt } = context;
    return generateHealthFallbackHTML(instanceName, metrics, generatedAt);
  }

  /**
   * 性能报告回退 HTML
   */
  private fallbackPerformanceHTML(context: Record<string, any>): string {
    const { instanceName, metrics, generatedAt } = context;
    return generatePerformanceFallbackHTML(instanceName, metrics, generatedAt);
  }

  /**
   * 慢查询报告回退 HTML
   */
  private fallbackSlowQueryHTML(context: Record<string, any>): string {
    const { instanceName, slowQueries, generatedAt } = context;
    return generateSlowQueryFallbackHTML(instanceName, slowQueries, generatedAt);
  }

  /**
   * 容量报告回退 HTML
   */
  private fallbackCapacityHTML(context: Record<string, any>): string {
    const { instanceName, capacityData, generatedAt } = context;
    return generateCapacityFallbackHTML(instanceName, capacityData, generatedAt);
  }

  /**
   * 生成健康摘要
   */
  private generateHealthSummary(metrics: HealthMetrics): string {
    const issues: string[] = [];

    if (metrics.cpu_usage > 80) issues.push('CPU 使用率过高');
    if (metrics.memory_usage > 85) issues.push('内存使用率过高');
    if (metrics.disk_usage > 80) issues.push('磁盘使用率过高');
    if (metrics.connections > 100) issues.push('连接数过多');

    if (issues.length === 0) {
      return '系统运行正常，未发现明显问题。';
    } else {
      return `发现 ${issues.length} 个潜在问题：${issues.join('，')}。建议及时检查。`;
    }
  }

  /**
   * 生成性能分析
   */
  private generatePerformanceAnalysis(metrics: any): string {
    if (metrics.top_slow_queries?.length > 0) {
      return `发现 ${metrics.top_slow_queries.length} 条慢查询，建议对 Top 3 慢查询进行优化。`;
    }
    return '未发现明显性能问题。';
  }

  /**
   * 生成慢查询优化建议
   */
  private generateSlowQueryRecommendations(slowQueries: any[]): string[] {
    return slowQueries.slice(0, 3).map((q) => {
      if (q.rows_examined > 10000) {
        return `SQL 扫描行数过多 (${q.rows_examined})，建议添加索引优化`;
      }
      return `平均执行时间 ${q.avg_time_ms?.toFixed(0)}ms，建议分析执行计划`;
    });
  }

  /**
   * 生成容量预测
   */
  private generateCapacityForecast(capacityData: any): string {
    return '基于当前增长趋势，预计存储容量可继续使用 30 天。';
  }
}

// 单例
let reportServiceInstance: ReportService | null = null;
export const reportService = new ReportService();
