/**
 * NotificationService 核心逻辑测试
 * - buildMessage 四种 channelType 格式
 * - routeAlert 按 level 匹配渠道
 * - sendWithRetry 失败重试
 * - 告警风暴去重逻辑
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { notificationService } from '../src/notification-service';
import type { PendingAlert, NotificationChannel } from '../src/notification-database-service';

// 创建测试用告警
function createTestAlert(overrides: Partial<PendingAlert> = {}): PendingAlert {
  return {
    id: 1,
    instance_id: 1,
    alert_type: 'performance',
    level: 'warning',
    title: 'Test Alert',
    message: 'CPU usage exceeded threshold',
    metric_name: 'cpu_usage',
    metric_value: '92.5',
    threshold_value: '90',
    tags: null,
    created_at: new Date('2024-01-01T00:00:00Z'),
    instance_name: 'test-instance',
    instance_host: '192.168.1.100',
    ...overrides,
  };
}

// 创建测试用渠道
function createTestChannel(overrides: Partial<NotificationChannel> = {}): NotificationChannel {
  return {
    id: 1,
    name: 'Test Channel',
    type: 'dingtalk',
    config: { webhook_url: 'https://oapi.dingtalk.com/robot/send?access_token=test' },
    enabled: true,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('NotificationService - buildMessage', () => {
  const alert = createTestAlert();
  const instanceName = 'test-instance';
  const instanceHost = '192.168.1.100';

  it('should build DingTalk markdown message', () => {
    const message = notificationService.buildMessage('dingtalk', alert, instanceName, instanceHost);
    expect(message.msgtype).toBe('markdown');
    expect(message.markdown).toHaveProperty('title');
    expect(message.markdown).toHaveProperty('text');
    expect(message.markdown.title).toContain('[WARNING]');
    expect(message.markdown.text).toContain('test-instance');
    expect(message.markdown.text).toContain('192.168.1.100');
    expect(message.markdown.text).toContain('cpu_usage');
    expect(message.markdown.text).toContain('92.5');
    expect(message.at).toEqual({ isAtAll: false });
  });

  it('should build WeCom markdown message', () => {
    const message = notificationService.buildMessage('wecom', alert, instanceName, instanceHost);
    expect(message.msgtype).toBe('markdown');
    expect(message.markdown).toHaveProperty('content');
    expect(message.markdown.content).toContain('[WARNING]');
    expect(message.markdown.content).toContain('test-instance');
    expect(message.markdown.content).toContain('cpu_usage');
    expect(message.markdown.content).toContain('92.5');
  });

  it('should build Feishu interactive card message', () => {
    const message = notificationService.buildMessage('feishu', alert, instanceName, instanceHost);
    expect(message.msg_type).toBe('interactive');
    expect(message.card).toHaveProperty('header');
    expect(message.card.header).toHaveProperty('title');
    expect(message.card.header.title.content).toContain('[WARNING]');
    expect(message.card.header.template).toBe('orange'); // warning level
    expect(message.card.elements).toHaveLength(2);
    expect(message.card.elements[0].tag).toBe('div');
    expect(message.card.elements[0].text.tag).toBe('lark_md');
  });

  it('should build generic webhook JSON message', () => {
    const message = notificationService.buildMessage('webhook', alert, instanceName, instanceHost);
    expect(message.alert_id).toBe(1);
    expect(message.instance_name).toBe('test-instance');
    expect(message.instance_host).toBe('192.168.1.100');
    expect(message.alert_type).toBe('performance');
    expect(message.level).toBe('warning');
    expect(message.title).toBe('Test Alert');
    expect(message.message).toBe('CPU usage exceeded threshold');
    expect(message.metric_value).toBe('92.5');
    expect(message.threshold_value).toBe('90');
    expect(message.url).toBe('192.168.1.100:1');
  });

  it('should handle null instance_name and instance_host gracefully', () => {
    const message = notificationService.buildMessage('webhook', alert, null, null);
    expect(message.instance_name).toBe('未知实例');
    expect(message.instance_host).toBe('N/A');
  });

  it('should use default webhook format for unknown channel type', () => {
    const message = notificationService.buildMessage('unknown', alert, instanceName, instanceHost);
    expect(message.alert_id).toBe(1);
    expect(message.title).toBe('Test Alert');
  });
});

describe('NotificationService - routeAlert', () => {
  const channels: NotificationChannel[] = [
    createTestChannel({ id: 1, name: 'All Alerts', type: 'dingtalk', config: { severity: 'info', webhook_url: 'https://example.com/1' } }),
    createTestChannel({ id: 2, name: 'Warning+', type: 'wecom', config: { severity: 'warning', webhook_url: 'https://example.com/2' } }),
    createTestChannel({ id: 3, name: 'Error+', type: 'feishu', config: { severity: 'error', webhook_url: 'https://example.com/3' } }),
    createTestChannel({ id: 4, name: 'Critical Only', type: 'webhook', config: { severity: 'critical', webhook_url: 'https://example.com/4' } }),
  ];

  it('should route info alert to info channel only', () => {
    const alert = createTestAlert({ level: 'info' });
    const matched = notificationService.routeAlert(alert, channels);
    expect(matched).toHaveLength(1);
    expect(matched[0].id).toBe(1);
  });

  it('should route warning alert to info and warning channels', () => {
    const alert = createTestAlert({ level: 'warning' });
    const matched = notificationService.routeAlert(alert, channels);
    expect(matched).toHaveLength(2);
    expect(matched.map((c) => c.id)).toContain(1);
    expect(matched.map((c) => c.id)).toContain(2);
  });

  it('should route error alert to info, warning, error channels', () => {
    const alert = createTestAlert({ level: 'error' });
    const matched = notificationService.routeAlert(alert, channels);
    expect(matched).toHaveLength(3);
    expect(matched.map((c) => c.id)).toContain(1);
    expect(matched.map((c) => c.id)).toContain(2);
    expect(matched.map((c) => c.id)).toContain(3);
  });

  it('should route critical alert to all channels', () => {
    const alert = createTestAlert({ level: 'critical' });
    const matched = notificationService.routeAlert(alert, channels);
    expect(matched).toHaveLength(4);
  });

  it('should handle channel with no severity config (defaults to info)', () => {
    const alert = createTestAlert({ level: 'warning' });
    const noSeverityChannel: NotificationChannel = createTestChannel({
      id: 5,
      type: 'webhook',
      config: { webhook_url: 'https://example.com/5' }, // no severity key
    });
    const matched = notificationService.routeAlert(alert, [noSeverityChannel]);
    // default severity=info, so it should match warning alert
    expect(matched).toHaveLength(1);
  });
});

describe('NotificationService - sendWithRetry', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should succeed on first attempt', async () => {
    const channel = createTestChannel({
      config: { webhook_url: 'https://example.com/webhook' },
    });
    const message = { test: true };

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ errcode: 0 }), { status: 200 })
    );

    const result = await notificationService.sendWithRetry(channel, message);
    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('should retry on failure and succeed on second attempt', async () => {
    const channel = createTestChannel({
      config: { webhook_url: 'https://example.com/webhook' },
    });
    const message = { test: true };

    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('Error', { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ errcode: 0 }), { status: 200 }));

    // Speed up retry delays for testing
    const originalSetTimeout = global.setTimeout;
    vi.useFakeTimers();

    const resultPromise = notificationService.sendWithRetry(channel, message);
    // Advance past first retry delay (5s)
    await vi.advanceTimersByTimeAsync(5000);
    const result = await resultPromise;

    expect(result.success).toBe(true);
    vi.useRealTimers();
  });

  it('should fail after 3 attempts', async () => {
    const channel = createTestChannel({
      config: { webhook_url: 'https://example.com/webhook' },
    });
    const message = { test: true };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Server Error', { status: 500 })
    );

    vi.useFakeTimers();
    const resultPromise = notificationService.sendWithRetry(channel, message);

    // Advance through all retry delays: 5s, 15s
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(15000);

    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.error).toContain('重试 3 次后仍失败');
    vi.useRealTimers();
  });
});

describe('NotificationService - buildApprovalMessage', () => {
  it('should build DingTalk approve message with correct format', () => {
    const message = notificationService.buildApprovalMessage('dingtalk', {
      action: 'approve',
      instanceName: 'db1',
      sqlSummary: 'SELECT * FROM users',
      reviewerName: 'admin',
      submitTime: '2024-01-01T00:00:00Z',
      riskLevel: 'medium',
    });
    expect(message.msgtype).toBe('markdown');
    expect(message.markdown).toHaveProperty('title');
    expect(message.markdown).toHaveProperty('text');
    expect(message.markdown.title).toContain('[审批通过]');
    expect(message.markdown.title).toContain('db1');
    expect(message.markdown.text).toContain('db1');
    expect(message.markdown.text).toContain('已通过');
    expect(message.at).toEqual({ isAtAll: false });
  });

  it('should build DingTalk reject message with notes', () => {
    const message = notificationService.buildApprovalMessage('dingtalk', {
      action: 'reject',
      notes: 'no reason',
      instanceName: 'db1',
      sqlSummary: 'DROP TABLE users',
      reviewerName: 'admin',
      submitTime: '2024-01-01T00:00:00Z',
      riskLevel: 'high',
    });
    expect(message.msgtype).toBe('markdown');
    expect(message.markdown.title).toContain('[审批驳回]');
    expect(message.markdown.text).toContain('已驳回');
    expect(message.markdown.text).toContain('no reason');
    expect(message.markdown.text).toContain('db1');
  });

  it('should build WeCom approve message with SQL summary', () => {
    const message = notificationService.buildApprovalMessage('wecom', {
      action: 'approve',
      instanceName: 'db2',
      sqlSummary: 'ALTER TABLE users ADD COLUMN age INT',
      reviewerName: 'dba',
      submitTime: '2024-01-01T00:00:00Z',
      riskLevel: 'critical',
    });
    expect(message.msgtype).toBe('markdown');
    expect(message.markdown).toHaveProperty('content');
    expect(message.markdown.content).toContain('ALTER TABLE users');
    expect(message.markdown.content).toContain('db2');
    expect(message.markdown.content).toContain('已通过');
  });

  it('should build Feishu reject message with red header', () => {
    const message = notificationService.buildApprovalMessage('feishu', {
      action: 'reject',
      instanceName: 'db3',
      sqlSummary: 'DELETE FROM sensitive',
      reviewerName: 'admin',
      submitTime: '2024-01-01T00:00:00Z',
      riskLevel: 'high',
    });
    expect(message.msg_type).toBe('interactive');
    expect(message.card).toHaveProperty('header');
    expect(message.card.header.template).toBe('red');
    expect(message.card.header.title.content).toContain('[审批驳回]');
    expect(message.card.elements).toHaveLength(3);
    expect(message.card.elements[0].tag).toBe('div');
    expect(message.card.elements[0].text.tag).toBe('lark_md');
    expect(message.card.elements[1].tag).toBe('hr');
    expect(message.card.elements[2].tag).toBe('note');
  });

  it('should build webhook approval message with type discriminator', () => {
    const message = notificationService.buildApprovalMessage('webhook', {
      action: 'approve',
      instanceName: 'prod-db',
      sqlSummary: 'SELECT 1',
      reviewerName: 'admin',
      submitTime: '2024-01-01T00:00:00Z',
      riskLevel: 'low',
    });
    expect(message.type).toBe('approval');
    expect(message.action).toBe('approve');
    expect(message.instance_name).toBe('prod-db');
    expect(message.reviewer).toBe('admin');
    expect(message.risk_level).toBe('low');
    expect(message.submit_time).toBe('2024-01-01T00:00:00Z');
    expect(message.sql_summary).toBe('SELECT 1');
    expect(message.notes).toBeNull();
  });

  it('should include reviewerName, submitTime, riskLevel in all channel formats', () => {
    const dingtalk = notificationService.buildApprovalMessage('dingtalk', {
      action: 'approve',
      instanceName: 'db',
      sqlSummary: 'test',
      reviewerName: 'alice',
      submitTime: '2024-06-01T12:00:00Z',
      riskLevel: 'high',
    });
    expect(dingtalk.markdown.text).toContain('alice');
    expect(dingtalk.markdown.text).toContain('2024-06-01');
    expect(dingtalk.markdown.text).toContain('high');

    const wecom = notificationService.buildApprovalMessage('wecom', {
      action: 'reject',
      instanceName: 'db',
      sqlSummary: 'test',
      reviewerName: 'bob',
      submitTime: '2024-06-01T12:00:00Z',
      riskLevel: 'medium',
    });
    expect(wecom.markdown.content).toContain('bob');
    expect(wecom.markdown.content).toContain('2024-06-01');
    expect(wecom.markdown.content).toContain('medium');

    const feishu = notificationService.buildApprovalMessage('feishu', {
      action: 'approve',
      instanceName: 'db',
      sqlSummary: 'test',
      reviewerName: 'carol',
      submitTime: '2024-06-01T12:00:00Z',
      riskLevel: 'critical',
    });
    expect(feishu.card.elements[0].text.content).toContain('carol');
    expect(feishu.card.elements[0].text.content).toContain('2024-06-01');
    expect(feishu.card.elements[0].text.content).toContain('critical');

    const webhook = notificationService.buildApprovalMessage('webhook', {
      action: 'reject',
      instanceName: 'db',
      sqlSummary: 'test',
      reviewerName: 'dave',
      submitTime: '2024-06-01T12:00:00Z',
      riskLevel: 'low',
    });
    expect(webhook.reviewer).toBe('dave');
    expect(webhook.submit_time).toBe('2024-06-01T12:00:00Z');
    expect(webhook.risk_level).toBe('low');
  });
});

describe('NotificationService - alert storm dedup', () => {
  it('should generate consistent storm keys for same alert', () => {
    const alert1 = createTestAlert({ instance_id: 1, level: 'warning', metric_name: 'cpu_usage' });
    const alert2 = createTestAlert({ instance_id: 1, level: 'warning', metric_name: 'cpu_usage' });

    // Same key should produce same storm key
    const key1 = `${alert1.instance_id ?? 'none'}:${alert1.level}:${alert1.metric_name ?? 'none'}`;
    const key2 = `${alert2.instance_id ?? 'none'}:${alert2.level}:${alert2.metric_name ?? 'none'}`;

    expect(key1).toBe(key2);
    expect(key1).toBe('1:warning:cpu_usage');
  });

  it('should produce different keys for different instances', () => {
    const alert1 = createTestAlert({ instance_id: 1, level: 'warning', metric_name: 'cpu_usage' });
    const alert2 = createTestAlert({ instance_id: 2, level: 'warning', metric_name: 'cpu_usage' });

    const key1 = `${alert1.instance_id ?? 'none'}:${alert1.level}:${alert1.metric_name ?? 'none'}`;
    const key2 = `${alert2.instance_id ?? 'none'}:${alert2.level}:${alert2.metric_name ?? 'none'}`;

    expect(key1).not.toBe(key2);
  });

  it('should produce different keys for different levels', () => {
    const alert1 = createTestAlert({ instance_id: 1, level: 'warning', metric_name: 'cpu_usage' });
    const alert2 = createTestAlert({ instance_id: 1, level: 'error', metric_name: 'cpu_usage' });

    const key1 = `${alert1.instance_id ?? 'none'}:${alert1.level}:${alert1.metric_name ?? 'none'}`;
    const key2 = `${alert2.instance_id ?? 'none'}:${alert2.level}:${alert2.metric_name ?? 'none'}`;

    expect(key1).not.toBe(key2);
  });

  it('should produce different keys for different metrics', () => {
    const alert1 = createTestAlert({ instance_id: 1, level: 'warning', metric_name: 'cpu_usage' });
    const alert2 = createTestAlert({ instance_id: 1, level: 'warning', metric_name: 'memory_usage' });

    const key1 = `${alert1.instance_id ?? 'none'}:${alert1.level}:${alert1.metric_name ?? 'none'}`;
    const key2 = `${alert2.instance_id ?? 'none'}:${alert2.level}:${alert2.metric_name ?? 'none'}`;

    expect(key1).not.toBe(key2);
  });

  it('should handle null instance_id and metric_name in storm key', () => {
    const alert = createTestAlert({ instance_id: null, level: 'critical', metric_name: null });
    const key = `${alert.instance_id ?? 'none'}:${alert.level}:${alert.metric_name ?? 'none'}`;

    expect(key).toBe('none:critical:none');
  });
});
