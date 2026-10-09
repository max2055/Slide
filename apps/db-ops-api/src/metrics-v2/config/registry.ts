import { PackageRegistry } from '../packages/model.js';
import { builtinReleases, canonicalDefinitions, implementationSpecs } from '../packages/builtins.js';
import { databaseReleases, databaseSpecs, capacityReleases, capacitySpecs } from '../database/catalog.js';
import { createSnmpPackage } from '../snmp/package.js';

export function createConfigurationRegistry(): PackageRegistry {
  const snmp = createSnmpPackage();
  const registry = new PackageRegistry(canonicalDefinitions, [...implementationSpecs, ...databaseSpecs, ...capacitySpecs, ...snmp.specs]);
  [...builtinReleases(), ...databaseReleases(), ...capacityReleases(), snmp.release].forEach(release => registry.install(release));
  return registry;
}
