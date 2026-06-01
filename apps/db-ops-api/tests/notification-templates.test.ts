/**
 * 通知消息格式测试
 * - 钉钉、企微、飞书、通用 webhook 四种消息格式
 * - 模板变量替换验证
 */
import { describe, it, expect } from 'vitest';
import { notificationService } from '../src/notification-service';
import type { PendingAlert } from '../src/notification-database-service';

function createTestAlert(overrides: Partial<PendingAlert> = {}): PendingAlert {
  return {
    id: 42,
    instance_id: 5,
    alert_type: 'performance',
    level: 'critical',
    title: 'CPU 使用率过高',
    message: 'CPU 使用率持续超过 95%，建议立即排查',
    metric_name: 'cpu_usage',
    metric_value: '96.8',
    threshold_value: '95',
    tags: null,
    created_at: new Date('2024-06-15T10:30:00Z'),
    instance_name: 'prod-mysql-01',
    instance_host: '10.0.1.50',
    ...overrides,
  };
}

describe('DingTalk message format', () => {
  it('should produce correct DingTalk JSON structure', () => {
    const alert = createTestAlert();
    const message = notificationService.buildMessage('dingtalk', alert, alert.instance_name, alert.instance_host);

    // 钉钉要求 msgtype 为 markdown
    expect(message.msgtype).toBe('markdown');

    // markdown 必须包含 title 和 text
    expect(message.markdown).toBeDefined();
    expect(typeof message.markdown.title).toBe('string');
    expect(typeof message.markdown.text).toBe('string');

    // at 字段必须存在
    expect(message.at).toBeDefined();
    expect(typeof message.at.isAtAll).toBe('boolean');
  });

  it('should include alert level in title', () => {
    const alert = createTestAlert({ level: 'error' });
    const message = notificationService.buildMessage('dingtalk', alert);

    expect(message.markdown.title).toContain('[ERROR]');
  });

  it('should include all key info in markdown text', () => {
    const alert = createTestAlert();
    const message = notificationService.buildMessage('dingtalk', alert, 'prod-mysql-01', '10.0.1.50');

    expect(message.markdown.text).toContain('prod-mysql-01');
    expect(message.markdown.text).toContain('10.0.1.50');
    expect(message.markdown.text).toContain('performance');
    expect(message.markdown.text).toContain('cpu_usage');
    expect(message.markdown.text).toContain('96.8');
    expect(message.markdown.text).toContain('95');
    expect(message.markdown.text).toContain('CPU 使用率持续超过 95%');
  });

  it('should use at.isAtAll=false when no mention config', () => {
    const alert = createTestAlert();
    const message = notificationService.buildMessage('dingtalk', alert);

    expect(message.at.isAtAll).toBe(false);
  });
});

describe('WeCom message format', () => {
  it('should produce correct WeCom JSON structure', () => {
    const alert = createTestAlert();
    const message = notificationService.buildMessage('wecom', alert, alert.instance_name, alert.instance_host);

    // 企微要求 msgtype 为 markdown
    expect(message.msgtype).toBe('markdown');

    // markdown 必须包含 content
    expect(message.markdown).toBeDefined();
    expect(typeof message.markdown.content).toBe('string');
  });

  it('should include alert level in content', () => {
    const alert = createTestAlert({ level: 'warning' });
    const message = notificationService.buildMessage('wecom', alert);

    expect(message.markdown.content).toContain('[WARNING]');
  });

  it('should include all key info in markdown content', () => {
    const alert = createTestAlert();
    const message = notificationService.buildMessage('wecom', alert, 'prod-mysql-01', '10.0.1.50');

    expect(message.markdown.content).toContain('prod-mysql-01');
    expect(message.markdown.content).toContain('10.0.1.50');
    expect(message.markdown.content).toContain('cpu_usage');
    expect(message.markdown.content).toContain('96.8');
    expect(message.markdown.content).toContain('95');
  });
});

describe('Feishu message format', () => {
  it('should produce correct Feishu JSON structure', () => {
    const alert = createTestAlert();
    const message = notificationService.buildMessage('feishu', alert, alert.instance_name, alert.instance_host);

    // 飞书要求 msg_type 为 interactive
    expect(message.msg_type).toBe('interactive');

    // card 必须包含 header 和 elements
    expect(message.card).toBeDefined();
    expect(message.card.header).toBeDefined();
    expect(message.card.header.title).toBeDefined();
    expect(message.card.header.title.tag).toBe('plain_text');
    expect(Array.isArray(message.card.elements)).toBe(true);
    expect(message.card.elements.length).toBeGreaterThan(0);
  });

  it('should use correct color template based on alert level', () => {
    const criticalAlert = createTestAlert({ level: 'critical' });
    const criticalMessage = notificationService.buildMessage('feishu', criticalAlert);
    expect(criticalMessage.card.header.template).toBe('red');

    const warningAlert = createTestAlert({ level: 'warning' });
    const warningMessage = notificationService.buildMessage('feishu', warningAlert);
    expect(warningMessage.card.header.template).toBe('orange');

    const infoAlert = createTestAlert({ level: 'info' });
    const infoMessage = notificationService.buildMessage('feishu', infoAlert);
    expect(infoMessage.card.header.template).toBe('blue');
  });

  it('should use red color for error level', () => {
    const errorAlert = createTestAlert({ level: 'error' });
    const message = notificationService.buildMessage('feishu', errorAlert);
    expect(message.card.header.template).toBe('red');
  });

  it('should include alert details in div element', () => {
    const alert = createTestAlert();
    const message = notificationService.buildMessage('feishu', alert, 'prod-mysql-01', '10.0.1.50');

    const divElement = message.card.elements[0];
    expect(divElement.tag).toBe('div');
    expect(divElement.text.tag).toBe('lark_md');
    expect(divElement.text.content).toContain('prod-mysql-01');
    expect(divElement.text.content).toContain('10.0.1.50');
    expect(divElement.text.content).toContain('performance');
  });

  it('should include alert message in content element', () => {
    const alert = createTestAlert();
    const message = notificationService.buildMessage('feishu', alert);

    const contentElement = message.card.elements[1];
    expect(contentElement.tag).toBe('content');
    expect(contentElement.content[0][0].tag).toBe('plain_text');
    expect(contentElement.content[0][0].content).toBe(alert.message);
  });
});

describe('Generic webhook message format', () => {
  it('should include all required fields', () => {
    const alert = createTestAlert();
    const message = notificationService.buildMessage('webhook', alert, 'prod-mysql-01', '10.0.1.50');

    // 必需字段
    expect(message).toHaveProperty('alert_id');
    expect(message).toHaveProperty('instance_name');
    expect(message).toHaveProperty('instance_host');
    expect(message).toHaveProperty('alert_type');
    expect(message).toHaveProperty('level');
    expect(message).toHaveProperty('title');
    expect(message).toHaveProperty('message');
    expect(message).toHaveProperty('metric_value');
    expect(message).toHaveProperty('threshold_value');
    expect(message).toHaveProperty('created_at');
    expect(message).toHaveProperty('url');
  });

  it('should map alert fields correctly', () => {
    const alert = createTestAlert();
    const message = notificationService.buildMessage('webhook', alert, 'prod-mysql-01', '10.0.1.50');

    expect(message.alert_id).toBe(42);
    expect(message.instance_name).toBe('prod-mysql-01');
    expect(message.instance_host).toBe('10.0.1.50');
    expect(message.alert_type).toBe('performance');
    expect(message.level).toBe('critical');
    expect(message.title).toBe('CPU 使用率过高');
    expect(message.message).toBe('CPU 使用率持续超过 95%，建议立即排查');
    expect(message.metric_value).toBe('96.8');
    expect(message.threshold_value).toBe('95');
  });

  it('should format created_at as ISO string', () => {
    const alert = createTestAlert();
    const message = notificationService.buildMessage('webhook', alert);

    expect(message.created_at).toBe('2024-06-15T10:30:00.000Z');
  });
});

describe('Template variable substitution', () => {
  it('should substitute all DingTalk variables', () => {
    const alert = createTestAlert();
    const message = notificationService.buildMessage('dingtalk', alert, 'my-instance', '10.0.0.1');

    // 验证模板变量被正确替换，没有残留的 {variable} 占位符
    const text = message.markdown.text;
    expect(text).not.toContain('{alert_id}');
    expect(text).not.toContain('{alert_title}');
    expect(text).not.toContain('{alert_level}');
    expect(text).not.toContain('{alert_type}');
    expect(text).not.toContain('{instance_name}');
    expect(text).not.toContain('{instance_host}');
    expect(text).not.toContain('{metric_name}');
    expect(text).not.toContain('{metric_value}');
    expect(text).not.toContain('{threshold}');
    expect(text).not.toContain('{created_at}');

    // 验证实际值
    expect(text).toContain('my-instance');
    expect(text).toContain('10.0.0.1');
    expect(text).toContain('performance');
    expect(text).toContain('cpu_usage');
    expect(text).toContain('96.8');
    expect(text).toContain('95');
    expect(text).toContain('2024-06-15');
  });

  it('should substitute all WeCom variables', () => {
    const alert = createTestAlert();
    const message = notificationService.buildMessage('wecom', alert, 'my-instance', '10.0.0.1');

    const content = message.markdown.content;
    expect(content).not.toContain('{alert_id}');
    expect(content).not.toContain('{alert_title}');
    expect(content).not.toContain('{instance_name}');
    expect(content).not.toContain('{instance_host}');
    expect(content).not.toContain('{metric_name}');
    expect(content).not.toContain('{metric_value}');
    expect(content).not.toContain('{threshold}');
    expect(content).not.toContain('{created_at}');
  });

  it('should substitute all Feishu variables', () => {
    const alert = createTestAlert();
    const message = notificationService.buildMessage('feishu', alert, 'my-instance', '10.0.0.1');

    const content = message.card.elements[0].text.content;
    expect(content).not.toContain('{alert_id}');
    expect(content).not.toContain('{alert_title}');
    expect(content).not.toContain('{instance_name}');
    expect(content).not.toContain('{instance_host}');
    expect(content).not.toContain('{metric_name}');
    expect(content).not.toContain('{metric_value}');
    expect(content).not.toContain('{threshold}');
    expect(content).not.toContain('{created_at}');
  });

  it('should show N/A for missing metric_name and metric_value', () => {
    const alert = createTestAlert({ metric_name: null, metric_value: null, threshold_value: null });
    const message = notificationService.buildMessage('webhook', alert);

    expect(message.metric_value).toBeNull();
    expect(message.threshold_value).toBeNull();
  });

  it('should show 未知实例 when instance_name is null', () => {
    const alert = createTestAlert();
    const message = notificationService.buildMessage('dingtalk', alert, null, null);

    expect(message.markdown.text).toContain('未知实例');
    expect(message.markdown.text).toContain('N/A');
  });
});
