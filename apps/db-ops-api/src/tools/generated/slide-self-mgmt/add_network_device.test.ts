import { afterEach, describe, expect, it, vi } from 'vitest';
import { networkDeviceDatabaseService } from '../../../network-devices/network-device-database-service.js';
import { addNetworkDeviceTool } from './add_network_device.js';

describe('slide_add_network_device', () => {
  afterEach(() => vi.restoreAllMocks());

  it('enrolls a network device without exposing or requiring credentials', async () => {
    vi.spyOn(networkDeviceDatabaseService, 'getAllDevices').mockResolvedValue([]);
    const createDevice = vi.spyOn(networkDeviceDatabaseService, 'createDevice').mockResolvedValue({
      success: true,
      deviceId: 41,
    });

    const result = await addNetworkDeviceTool.handler({
      name: 'edge-1',
      host: '192.0.2.10',
      vendor: 'huawei',
      site: 'dc-a',
    }, { actor: { userId: 7 } as any } as any);

    expect(result).toMatchObject({
      success: true,
      data: { networkDeviceId: 41, credentialStatus: 'pending_credentials' },
      artifacts: { networkDeviceId: 41 },
    });
    expect(createDevice).toHaveBeenCalledWith(expect.objectContaining({
      name: 'edge-1', host: '192.0.2.10', vendor: 'huawei', collectionEnabled: false, createdBy: 7,
    }));
  });

  it('returns the existing device id instead of creating a duplicate target', async () => {
    vi.spyOn(networkDeviceDatabaseService, 'getAllDevices').mockResolvedValue([{
      id: 73, name: 'edge-existing', host: '192.0.2.10', snmp_port: 161,
    } as any]);
    const createDevice = vi.spyOn(networkDeviceDatabaseService, 'createDevice');

    const result = await addNetworkDeviceTool.handler({
      name: 'edge-1', host: '192.0.2.10', snmp_port: 161,
    }, { actor: { userId: 7 } as any } as any);

    expect(result).toMatchObject({
      success: false,
      errorCode: 'NETWORK_DEVICE_EXISTS',
      data: { networkDeviceId: 73 },
      details: { terminal: true, retryable: false },
    });
    expect(createDevice).not.toHaveBeenCalled();
  });

  it('rejects credential fields so secrets cannot enter the Agent tool channel', async () => {
    const result = await addNetworkDeviceTool.handler({
      name: 'edge-1', host: '192.0.2.10', password: 'secret',
    }, { actor: { userId: 7 } as any } as any);

    expect(result).toMatchObject({ success: false, errorCode: 'PLAINTEXT_CREDENTIAL_DENIED' });
  });
});
