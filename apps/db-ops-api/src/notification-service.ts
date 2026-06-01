/**
 * 通知推送服务
 * 每 10 秒轮询 alerts 表，发现未推送的告警，匹配通知渠道，格式化消息并发送
 */
import { CronJob } from 'cron';
import * as crypto from 'crypto';
import * as net from 'net';
import * as dns from 'dns';
import { notificationDatabaseService } from './notification-database-service';
import type { PendingAlert, NotificationChannel } from './notification-database-service';
import { maintenanceWindowService } from './maintenance-window-service';

class NotificationService {
  private pollingJob: CronJob | null = null;
  private running = false;
  private lastRun: Date | null = null;
  // 内存中已处理的告警 key（实例+等级+指标），防止短时间内重复推送
  private processedKeys = new Map<string, number>();
  private readonly STORM_WINDOW_MS = 5 * 60 * 1000; // 5 分钟

  /**
   * 启动轮询
   */
  start(): void {
    if (this.running) {
      console.log('⚠️ 通知推送服务已在运行中');
      return;
    }

    try {
      this.pollingJob = new CronJob(
        '*/10 * * * * *', // 每 10 秒
        async () => {
          try {
            await this.pollLoop();
            this.lastRun = new Date();
          } catch (error) {
            console.error('通知轮询失败:', error);
          }
        },
        null,
        true,
        'Asia/Shanghai'
      );

      this.running = true;
      console.log('✅ 通知推送任务已启动（每 10 秒）');
    } catch (error) {
      console.error('启动通知推送服务失败:', error);
      this.running = false;
    }
  }

  /**
   * 停止轮询
   */
  stop(): void {
    if (this.pollingJob) {
      this.pollingJob.stop();
      this.pollingJob = null;
      this.running = false;
      console.log('🛑 通知推送任务已停止');
    }
  }

  /**
   * 轮询循环
   */
  async pollLoop(): Promise<void> {
    try {
      const pendingAlerts = await notificationDatabaseService.getPendingAlerts();
      if (pendingAlerts.length === 0) {
        return;
      }

      console.log(`📬 发现 ${pendingAlerts.length} 条待推送告警`);

      const enabledChannels = await notificationDatabaseService.getEnabledChannels();
      if (enabledChannels.length === 0) {
        console.log('⚠️ 没有已启用的通知渠道');
        return;
      }

      for (const alert of pendingAlerts) {
        // 告警风暴保护：内存去重
        const stormKey = this.getStormKey(alert);
        const lastProcessed = this.processedKeys.get(stormKey);
        if (lastProcessed && Date.now() - lastProcessed < this.STORM_WINDOW_MS) {
          console.log(`⏭️ 跳过告警风暴: ${alert.title}`);
          continue;
        }

        // DB 层面去重检查
        const hasRecent = await notificationDatabaseService.hasRecentNotification(
          alert.instance_id,
          alert.level,
          alert.metric_name,
          5
        );
        if (hasRecent) {
          console.log(`⏭️ DB 去重跳过: ${alert.title}`);
          continue;
        }

        const matchedChannels = this.routeAlert(alert, enabledChannels);
        if (matchedChannels.length === 0) {
          console.log(`⚠️ 告警 ${alert.id} 没有匹配的渠道（level=${alert.level}）`);
          continue;
        }

        // 维护窗口检查：抑制通知
        if (alert.instance_id) {
          const mw = await maintenanceWindowService.isActiveMaintenanceWindow(alert.instance_id);
          if (mw.active && mw.window?.suppress_evaluation) {
            console.log(`🔇 维护窗口抑制通知: ${alert.title} (窗口: ${mw.window.name})`);
            await notificationDatabaseService.markAlertAsNotified(alert.id);
            continue;
          }
        }

        for (const channel of matchedChannels) {
          const message = this.buildMessage(
            channel.type,
            alert,
            alert.instance_name,
            alert.instance_host
          );

          const result = await this.sendWithRetry(channel, message);
          if (result.success) {
            this.processedKeys.set(stormKey, Date.now());
            await notificationDatabaseService.recordNotification({
              alert_id: alert.id,
              channel_id: channel.id,
              status: 'sent',
              sent_at: new Date(),
            });
          } else {
            await notificationDatabaseService.recordNotification({
              alert_id: alert.id,
              channel_id: channel.id,
              status: 'failed',
              error: result.error || '未知错误',
            });
          }
        }
      }
    } catch (error) {
      console.error('轮询循环异常:', error);
    }
  }

  /**
   * 生成告警风暴 key
   */
  private getStormKey(alert: PendingAlert): string {
    return `${alert.instance_id ?? 'none'}:${alert.level}:${alert.metric_name ?? 'none'}`;
  }

  /**
   * 路由告警到匹配渠道
   * level 匹配规则：
   * - info → info
   * - warning → info, warning
   * - error → info, warning, error
   * - critical → info, warning, error, critical
   */
  routeAlert(alert: PendingAlert, channels: NotificationChannel[]): NotificationChannel[] {
    const levelOrder = ['info', 'warning', 'error', 'critical'];
    const alertLevelIndex = levelOrder.indexOf(alert.level);

    return channels.filter((ch) => {
      const channelSeverity = ch.config?.severity || 'info';
      const channelLevelIndex = levelOrder.indexOf(channelSeverity);

      // 渠道的 severity 级别要能覆盖 alert 的级别
      // 例如：渠道 severity=warning 能接收 warning/error/critical
      //      渠道 severity=info 能接收所有
      return channelLevelIndex <= alertLevelIndex;
    });
  }

  /**
   * 构建通知消息
   */
  buildMessage(
    channelType: string,
    alert: PendingAlert,
    instanceName?: string | null,
    instanceHost?: string | null
  ): any {
    const vars: Record<string, string> = {
      alert_id: String(alert.id),
      alert_title: alert.title,
      alert_level: alert.level,
      alert_type: alert.alert_type,
      instance_name: instanceName || '未知实例',
      instance_host: instanceHost || 'N/A',
      metric_name: alert.metric_name || 'N/A',
      metric_value: alert.metric_value || 'N/A',
      threshold: alert.threshold_value || 'N/A',
      created_at: alert.created_at instanceof Date
        ? alert.created_at.toISOString()
        : String(alert.created_at),
    };

    const replace = (template: string): string => {
      return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] || `{${key}}`);
    };

    switch (channelType) {
      case 'dingtalk': {
        const title = `[${alert.level.toUpperCase()}] ${alert.title}`;
        const text = replace(
          `### [${alert.level.toUpperCase()}] ${alert.title}\n\n` +
          `- **实例**: ${instanceName || '未知实例'} (${instanceHost || 'N/A'})\n` +
          `- **类型**: ${alert.alert_type}\n` +
          `- **等级**: ${alert.level}\n` +
          `- **指标**: ${alert.metric_name || 'N/A'} = ${alert.metric_value || 'N/A'}\n` +
          `- **阈值**: ${alert.threshold_value || 'N/A'}\n` +
          `- **时间**: {created_at}\n\n` +
          `${alert.message}`
        );
        return {
          msgtype: 'markdown',
          markdown: { title, text },
          at: { isAtAll: false },
        };
      }

      case 'wecom': {
        const content = replace(
          `### [${alert.level.toUpperCase()}] ${alert.title}\n\n` +
          `> **实例**: ${instanceName || '未知实例'}\n` +
          `> **主机**: ${instanceHost || 'N/A'}\n` +
          `> **类型**: ${alert.alert_type}\n` +
          `> **等级**: ${alert.level}\n` +
          `> **指标**: ${alert.metric_name || 'N/A'} = ${alert.metric_value || 'N/A'}\n` +
          `> **阈值**: ${alert.threshold_value || 'N/A'}\n` +
          `> **时间**: {created_at}\n\n` +
          `${alert.message}`
        );
        return {
          msgtype: 'markdown',
          markdown: { content },
        };
      }

      case 'feishu': {
        const colorMap: Record<string, string> = {
          info: 'blue',
          warning: 'orange',
          error: 'red',
          critical: 'red',
        };
        return {
          msg_type: 'interactive',
          card: {
            header: {
              title: {
                tag: 'plain_text',
                content: `[${alert.level.toUpperCase()}] ${alert.title}`,
              },
              template: colorMap[alert.level] || 'blue',
            },
            elements: [
              {
                tag: 'div',
                text: {
                  tag: 'lark_md',
                  content: replace(
                    `**实例**: ${instanceName || '未知实例'} (${instanceHost || 'N/A'})\n` +
                    `**类型**: ${alert.alert_type}\n` +
                    `**等级**: ${alert.level}\n` +
                    `**指标**: ${alert.metric_name || 'N/A'} = ${alert.metric_value || 'N/A'}\n` +
                    `**阈值**: ${alert.threshold_value || 'N/A'}\n` +
                    `**时间**: {created_at}`
                  ),
                },
              },
              {
                tag: 'content',
                content: [
                  [
                    {
                      tag: 'plain_text',
                      content: alert.message,
                    },
                  ],
                ],
              },
            ],
          },
        };
      }

      case 'email':
        // Email 渠道暂未实现，抛出明确的错误信息
        throw new Error('Email notification channel not yet implemented');

      case 'webhook':
      default: {
        return {
          alert_id: alert.id,
          instance_name: instanceName || '未知实例',
          instance_host: instanceHost || 'N/A',
          alert_type: alert.alert_type,
          level: alert.level,
          title: alert.title,
          message: alert.message,
          metric_value: alert.metric_value,
          threshold_value: alert.threshold_value,
          created_at: alert.created_at instanceof Date
            ? alert.created_at.toISOString()
            : String(alert.created_at),
          url: `${instanceHost || 'N/A'}:${alert.id}`,
        };
      }
    }
  }

  /**
   * 构建带钉钉签名的 URL
   */
  private buildSignedUrl(webhookUrl: string, secret?: string): string {
    if (!secret) {
      return webhookUrl;
    }

    const timestamp = Date.now();
    const stringToSign = `${timestamp}\n${secret}`;
    const sign = crypto.createHmac('sha256', secret).update(stringToSign).digest('base64');
    const encodedSign = encodeURIComponent(sign);

    const separator = webhookUrl.includes('?') ? '&' : '?';
    return `${webhookUrl}${separator}timestamp=${timestamp}&sign=${encodedSign}`;
  }

  /**
   * 验证 Webhook URL 防止 SSRF
   */
  private async validateWebhookUrl(urlStr: string): Promise<boolean> {
    try {
      const url = new URL(urlStr);
      const hostname = url.hostname.toLowerCase();

      // 屏蔽已知内网主机名模式
      if (hostname === 'localhost' || hostname === '::1' ||
          hostname.endsWith('.internal') || hostname.endsWith('.local') ||
          hostname.endsWith('.localhost')) {
        return false;
      }

      // 标准 IP 检测（net.isIP 识别 dotted-quad 和 IPv6 格式）
      if (net.isIP(hostname) !== 0) {
        if (this._isReservedIp(hostname)) return false;
      } else {
        // 展开数值/短格式 IP 表示（如 2130706433, 0x7f000001, 127.1）
        const expanded = this._expandNumericIp(hostname);
        if (expanded) {
          if (this._isReservedIp(expanded)) return false;
        } else {
          // DNS 主机名 — 解析并检查是否指向内网
          try {
            const addresses = await dns.promises.resolve4(hostname);
            for (const addr of addresses) {
              if (this._isReservedIp(addr)) return false;
            }
          } catch {
            /* DNS 解析失败不做拦截 */
          }
        }
      }

      return true;
    } catch { return false; }
  }

  /** 将数值/短格式 IP 展开为 dotted-quad 表示法 */
  private _expandNumericIp(hostname: string): string | null {
    // 十进制：2130706433 -> 127.0.0.1
    if (/^\d{1,10}$/.test(hostname)) {
      const num = Number(hostname);
      if (num >= 0 && num <= 0xFFFFFFFF && Number.isSafeInteger(num)) {
        return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
      }
    }
    // 十六进制：0x7f000001 -> 127.0.0.1
    if (/^0x[0-9a-f]{1,8}$/i.test(hostname)) {
      const num = parseInt(hostname, 16);
      if (num >= 0 && num <= 0xFFFFFFFF) {
        return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
      }
    }
    // 短格式：127.1 -> 127.0.0.1
    if (/^\d{1,3}\.\d{1,3}$/.test(hostname)) {
      const [a, b] = hostname.split('.').map(Number);
      if (a >= 0 && a <= 255 && b >= 0 && b <= 255) {
        return `${a}.0.0.${b}`;
      }
    }
    return null;
  }

  /** 检查 IP 地址是否属于私有/保留地址段 */
  private _isReservedIp(ip: string): boolean {
    // 去除 IPv6 映射 IPv4 前缀
    const clean = ip.replace(/^::ffff:/, '');
    if (clean === '::1') return true;
    return /^(0$|0\.|127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.)/.test(clean);
  }

  /**
   * 发送通知
   */
  async send(channel: NotificationChannel, message: any): Promise<{ success: boolean; error?: string }> {
    const webhookUrl = channel.config?.webhook_url;
    if (!webhookUrl) {
      return { success: false, error: '渠道未配置 webhook_url' };
    }

    if (!(await this.validateWebhookUrl(webhookUrl))) {
      return { success: false, error: 'Webhook URL 指向内网地址，已拦截' };
    }

    try {
      const url = this.buildSignedUrl(webhookUrl, channel.config?.secret);
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      });

      if (!response.ok) {
        const text = await response.text();
        return { success: false, error: `HTTP ${response.status}: ${text}` };
      }

      const result = await response.json();
      // 检查各平台的错误码
      if (result.errcode !== undefined && result.errcode !== 0) {
        return { success: false, error: result.errmsg || `平台错误码: ${result.errcode}` };
      }
      if (result.code !== undefined && result.code !== 0) {
        return { success: false, error: result.msg || `平台错误码: ${result.code}` };
      }

      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  /**
   * 带重试的发送，最多 3 次，指数退避
   * delay = 5000 * 3^(attempt-1) → 5s, 15s, 45s
   */
  async sendWithRetry(
    channel: NotificationChannel,
    message: any,
    attempt: number = 1
  ): Promise<{ success: boolean; error?: string }> {
    const maxAttempts = 3;

    try {
      const result = await this.send(channel, message);
      if (result.success) {
        return result;
      }

      if (attempt >= maxAttempts) {
        return { success: false, error: `重试 ${maxAttempts} 次后仍失败: ${result.error}` };
      }

      // 指数退避
      const delay = 5000 * Math.pow(3, attempt - 1);
      console.log(`⏳ 发送失败，${delay / 1000}s 后重试（第 ${attempt + 1} 次）: ${channel.name}`);
      await new Promise((resolve) => setTimeout(resolve, delay));

      return this.sendWithRetry(channel, message, attempt + 1);
    } catch (error: any) {
      if (attempt >= maxAttempts) {
        return { success: false, error: `重试 ${maxAttempts} 次后仍失败: ${error.message}` };
      }

      const delay = 5000 * Math.pow(3, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));

      return this.sendWithRetry(channel, message, attempt + 1);
    }
  }

  /**
   * 发送升级通知到所有已启用的通知渠道
   * 失败时记录日志但不抛出异常，确保不阻断升级流程
   */
  async sendEscalationNotification(alertId: number, fromLevel: string, toLevel: string): Promise<void> {
    try {
      // 通过 database service 查询告警详情（含实例信息）
      const alert = await notificationDatabaseService.getAlertById(alertId);
      if (!alert) {
        console.log(`⚠️ 升级通知：告警 ${alertId} 不存在`);
        return;
      }
      const channels = await notificationDatabaseService.getEnabledChannels();
      if (channels.length === 0) return;

      // 复用已有的路由逻辑（按升级后的级别匹配渠道）
      const matchedChannels = this.routeAlert(alert, channels);
      if (matchedChannels.length === 0) {
        console.log(`⚠️ 升级通知：告警 ${alertId} 没有匹配的通知渠道`);
        return;
      }

      for (const channel of matchedChannels) {
        try {
          // 为每个渠道独立构建消息（各渠道格式不同）
          const message = this.buildEscalationMessage(
            channel.type,
            alert,
            fromLevel,
            toLevel
          );
          const result = await this.sendWithRetry(channel, message);
          if (result.success) {
            console.log(`🔺 升级通知已发送 [${channel.name}]: 告警 #${alertId} ${fromLevel} → ${toLevel}`);
          } else {
            console.error(`⚠️ 升级通知发送失败 [${channel.name}]: 告警 #${alertId} - ${result.error}`);
          }
        } catch (error: any) {
          console.error(`⚠️ 升级通知发送异常 [${channel.name}]: 告警 #${alertId} - ${error.message}`);
        }
      }
    } catch (error: any) {
      console.error(`升级通知发送异常: 告警 #${alertId} - ${error.message}`);
    }
  }

  /**
   * 构建升级通知消息（复用已有 buildMessage 的模板风格）
   */
  private buildEscalationMessage(
    channelType: string,
    alert: any,
    fromLevel: string,
    toLevel: string
  ): any {
    const instanceName = alert.instance_name || '未知实例';
    const instanceHost = alert.instance_host || 'N/A';
    const timeStr = alert.created_at instanceof Date
      ? alert.created_at.toISOString()
      : String(alert.created_at);

    switch (channelType) {
      case 'dingtalk': {
        const title = `[升级] [${toLevel.toUpperCase()}] ${alert.title}`;
        const text = `### [升级] [${toLevel.toUpperCase()}] ${alert.title}\n\n` +
          `- **实例**: ${instanceName} (${instanceHost})\n` +
          `- **类型**: ${alert.alert_type}\n` +
          `- **等级**: ${fromLevel} → **${toLevel}**\n` +
          `- **指标**: ${alert.metric_name || 'N/A'} = ${alert.metric_value || 'N/A'}\n` +
          `- **阈值**: ${alert.threshold_value || 'N/A'}\n` +
          `- **时间**: ${timeStr}\n\n` +
          `告警已自动升级，请及时处理。\n` +
          `${alert.message}`;
        return {
          msgtype: 'markdown',
          markdown: { title, text },
          at: { isAtAll: false },
        };
      }

      case 'wecom': {
        const content = `### [升级] [${toLevel.toUpperCase()}] ${alert.title}\n\n` +
          `> **实例**: ${instanceName}\n` +
          `> **主机**: ${instanceHost}\n` +
          `> **类型**: ${alert.alert_type}\n` +
          `> **等级**: ${fromLevel} → **${toLevel}**\n` +
          `> **指标**: ${alert.metric_name || 'N/A'} = ${alert.metric_value || 'N/A'}\n` +
          `> **阈值**: ${alert.threshold_value || 'N/A'}\n` +
          `> **时间**: ${timeStr}\n\n` +
          `告警已自动升级，请及时处理。\n` +
          `${alert.message}`;
        return {
          msgtype: 'markdown',
          markdown: { content },
        };
      }

      case 'feishu': {
        const colorMap: Record<string, string> = {
          info: 'blue',
          warning: 'orange',
          error: 'red',
          critical: 'red',
        };
        return {
          msg_type: 'interactive',
          card: {
            header: {
              title: {
                tag: 'plain_text',
                content: `[升级] [${toLevel.toUpperCase()}] ${alert.title}`,
              },
              template: colorMap[toLevel] || 'red',
            },
            elements: [
              {
                tag: 'div',
                text: {
                  tag: 'lark_md',
                  content: `**实例**: ${instanceName} (${instanceHost})\n` +
                    `**类型**: ${alert.alert_type}\n` +
                    `**等级**: ${fromLevel} → **${toLevel}**\n` +
                    `**指标**: ${alert.metric_name || 'N/A'} = ${alert.metric_value || 'N/A'}\n` +
                    `**阈值**: ${alert.threshold_value || 'N/A'}\n` +
                    `**时间**: ${timeStr}`,
                },
              },
              {
                tag: 'content',
                content: [[{ tag: 'plain_text', content: '告警已自动升级，请及时处理。' }]],
              },
            ],
          },
        };
      }

      case 'webhook':
      default: {
        return {
          alert_id: alert.id,
          instance_name: instanceName,
          instance_host: instanceHost,
          alert_type: alert.alert_type,
          from_level: fromLevel,
          to_level: toLevel,
          title: alert.title,
          message: `告警已从 ${fromLevel} 升级到 ${toLevel}`,
          metric_value: alert.metric_value,
          threshold_value: alert.threshold_value,
          created_at: timeStr,
          escalation: true,
        };
      }
    }
  }

  /**
   * 构建审批通知消息
   */
  buildApprovalMessage(
    channelType: string,
    approvalData: {
      action: 'approve' | 'reject';
      notes?: string;
      sqlSummary: string;
      instanceName: string;
      submitTime: string;
      reviewerName: string;
      riskLevel: string;
    }
  ): any {
    const actionLabel = approvalData.action === 'approve' ? '已通过' : '已驳回';
    const title = `[审批${approvalData.action === 'approve' ? '通过' : '驳回'}] ${approvalData.instanceName}`;
    const summary = approvalData.sqlSummary.substring(0, 100);

    switch (channelType) {
      case 'dingtalk': {
        const text =
          `### ${title}\n\n` +
          `- **结果**: ${actionLabel}\n` +
          `- **审批人**: ${approvalData.reviewerName}\n` +
          `- **实例**: ${approvalData.instanceName}\n` +
          `- **风险等级**: ${approvalData.riskLevel}\n` +
          `- **提交时间**: ${approvalData.submitTime}\n` +
          (approvalData.notes ? `- **备注**: ${approvalData.notes}\n` : '') +
          `\n\`\`\`sql\n${summary}\n\`\`\``;
        return {
          msgtype: 'markdown',
          markdown: { title, text },
          at: { isAtAll: false },
        };
      }

      case 'wecom': {
        const content =
          `### ${title}\n\n` +
          `> **结果**: ${actionLabel}\n` +
          `> **审批人**: ${approvalData.reviewerName}\n` +
          `> **实例**: ${approvalData.instanceName}\n` +
          `> **风险等级**: ${approvalData.riskLevel}\n` +
          `> **提交时间**: ${approvalData.submitTime}\n` +
          (approvalData.notes ? `> **备注**: ${approvalData.notes}\n` : '') +
          `\n\`\`\`sql\n${summary}\n\`\`\``;
        return {
          msgtype: 'markdown',
          markdown: { content },
        };
      }

      case 'feishu': {
        const template = approvalData.action === 'approve' ? 'green' : 'red';
        const mdContent =
          `**实例**: ${approvalData.instanceName}\n` +
          `**结果**: ${actionLabel}\n` +
          `**审批人**: ${approvalData.reviewerName}\n` +
          `**风险等级**: ${approvalData.riskLevel}\n` +
          `**提交时间**: ${approvalData.submitTime}\n` +
          (approvalData.notes ? `**备注**: ${approvalData.notes}\n` : '');
        return {
          msg_type: 'interactive',
          card: {
            header: {
              title: { tag: 'plain_text', content: title },
              template,
            },
            elements: [
              { tag: 'div', text: { tag: 'lark_md', content: mdContent } },
              { tag: 'hr' },
              { tag: 'note', elements: [{ tag: 'plain_text', content: summary }] },
            ],
          },
        };
      }

      case 'webhook':
      default: {
        return {
          type: 'approval',
          action: approvalData.action,
          instance_name: approvalData.instanceName,
          result: actionLabel,
          reviewer: approvalData.reviewerName,
          risk_level: approvalData.riskLevel,
          submit_time: approvalData.submitTime,
          notes: approvalData.notes || null,
          sql_summary: summary,
        };
      }
    }
  }

  /**
   * 获取服务状态
   */
  getStatus(): { running: boolean; lastRun: Date | null } {
    return {
      running: this.running,
      lastRun: this.lastRun,
    };
  }
}

// 单例
export const notificationService = new NotificationService();
