import { expect, it } from 'vitest';
import { createConfigurationRegistry } from '../config/registry.js';
import { vendorLifecycleReleases, vendorLifecycleReads, vendorLifecycleSpecs, vendorLifecycleSql, implementationId } from './catalog.js';
import { RegisteredCapabilityCatalog } from '../templates/catalog.js';

it('MAX-237 review: product mappings disclose every native SQL dependency and session permission', () => {
  const catalog = new RegisteredCapabilityCatalog(createConfigurationRegistry());
  for (const release of vendorLifecycleReleases()) {
    const { id, version, digest } = release.package;
    for (const collector of release.package.collectors) {
      const read = vendorLifecycleReads.find(r => implementationId(r) === collector.implementation_ref)!;
      const spec = vendorLifecycleSpecs.find(s => s.id === collector.implementation_ref)!;
      const mapping = catalog.autofill({ package: { id, version, digest }, metric: collector.mappings[0].metric });
      expect(mapping.permissions).toEqual(spec.permissions);
      expect(release.documentation.find(d => d.collector_id === collector.id)?.permissions).toEqual(spec.permissions);
      expect(mapping.permissions).toContain('CREATE SESSION');
      const sql = read.name.startsWith('transactions_') ? vendorLifecycleSql[read.engine as 'oracle' | 'dameng'] : read.sql;
      for (const match of sql.matchAll(/(?:FROM|JOIN) (V\$[A-Z]+)/g)) {
        expect(mapping.permissions).toContain(`SELECT ${match[1].replace('V$', read.engine === 'oracle' ? 'V_$' : 'V$')}`);
      }
      expect(mapping.discovery).toContain(sql);
      expect(mapping.permissions.some(p => p.includes('driver'))).toBe(false);
    }
  }
});
