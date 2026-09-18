import { PackageRegistry } from '../packages/model.js';
import { builtinReleases, canonicalDefinitions, implementationSpecs } from '../packages/builtins.js';
import { databaseReleases, databaseSpecs } from '../database/catalog.js';
import { createSnmpPackage } from '../snmp/package.js';

export function createConfigurationRegistry(): PackageRegistry {
  const snmp = createSnmpPackage();
  const registry = new PackageRegistry(canonicalDefinitions, [...implementationSpecs, ...databaseSpecs, ...snmp.specs]);
  [...builtinReleases(), ...databaseReleases(), snmp.release].forEach(release => registry.install(release));
  return registry;
}
