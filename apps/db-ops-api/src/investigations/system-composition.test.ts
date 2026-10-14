import { describe, expect, it } from 'vitest';
import { createSystemComposition, systemInvestigationConfiguration } from './system-composition.js';

describe('System composition authority and lifecycle', () => {
  it('defaults off; rejects automatic-without-collection and invalid service identity configuration', () => {
    expect(systemInvestigationConfiguration({})).toMatchObject({ enabled: false, automatic: false });
    expect(() => systemInvestigationConfiguration({ INVESTIGATION_SYSTEM_AUTO_ENABLED: 'true' })).toThrow('SYSTEM_CONFIGURATION_INVALID');
    for (const id of ['', 'admin', '0', '-1', '1.5']) expect(() => systemInvestigationConfiguration({
      INVESTIGATION_SYSTEM_EVENTS_ENABLED: 'true', INVESTIGATION_SYSTEM_SERVICE_USER_ID: id,
    })).toThrow('SYSTEM_CONFIGURATION_INVALID');
  });
  it('disabled composition needs no database/provisioning and cannot persist or install a producer', async () => {
    const composition = await createSystemComposition(() => { throw new Error('must not access'); }, { configuration: systemInvestigationConfiguration({}) });
    composition.install(); await composition.close(); await composition.close();
    expect(composition.enabled).toBe(false); expect(composition.publisher).toBeUndefined();
    expect(composition.toolsForInvestigation({} as never, { profileId: 'ops' }).getDefinitions()).toHaveLength(0);
    expect(composition.toolsForInvestigation({} as never, { profileId: 'system', context: {} }).getDefinitions()).toHaveLength(0);
  });
});
