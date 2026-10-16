import { PackageRegistry } from '../packages/model.js';
import { builtinReleases, canonicalDefinitions, implementationSpecs } from '../packages/builtins.js';
import { databaseReleases, databaseSpecs, capacityReleases, capacitySpecs } from '../database/catalog.js';
import { createSnmpPackage } from '../snmp/package.js';
import { diagnosticSpecs, diagnosticReleases } from '../database/diagnostics.js';
import { hostDiagnosticSpecs, hostDiagnosticRelease } from '../packages/host-diagnostics.js';

export function createConfigurationRegistry(): PackageRegistry {
  const snmp = createSnmpPackage();
  const registry = new PackageRegistry(canonicalDefinitions, [...implementationSpecs, ...databaseSpecs, ...capacitySpecs, ...diagnosticSpecs, ...hostDiagnosticSpecs, ...snmp.specs]);
  [...builtinReleases(), ...databaseReleases(), ...capacityReleases(), ...diagnosticReleases(), hostDiagnosticRelease(), snmp.release].forEach(release => registry.install(release));
  return registry;
}
