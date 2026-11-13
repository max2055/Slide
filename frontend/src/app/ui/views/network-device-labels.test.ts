import { describe, expect, it } from 'vitest';
import { networkDeviceError, networkDeviceLabel } from './network-device-labels.js';

describe('MAX-611 / #432 network device dictionaries', () => {
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'unlisted-source', '自定义来源'])('keeps unknown label %s as text', (value) => {
    expect(networkDeviceLabel(value)).toBe(value);
    expect(typeof networkDeviceLabel(value)).toBe('string');
  });

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'unlisted-error'])('uses the error fallback for %s', (value) => {
    expect(networkDeviceError(value, '读取失败')).toBe('读取失败');
    expect(networkDeviceError(new Error(value), '读取失败')).toBe('读取失败');
  });

  it('preserves own translations and existing error text behavior', () => {
    expect(networkDeviceLabel('manual')).toBe('手动配置');
    expect(networkDeviceLabel('unknown')).toBe('未知');
    expect(networkDeviceError('SNMP_TIMEOUT')).toBe('SNMP 请求超时');
    expect(networkDeviceError('自定义错误')).toBe('自定义错误');
    expect(networkDeviceError(null)).toBe('操作失败，请稍后重试');
  });
});
