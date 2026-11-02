import { dynamicSpecs, dynamicReleases } from '../packages/dynamic-discovery.js';
import { compileReviewedSql } from '../database/reviewed-sql.js';
import { PackageRegistry } from '../packages/model.js';
import { builtinReleases, canonicalDefinitions, implementationSpecs } from '../packages/builtins.js';
import { databaseReleases, databaseSpecs, capacityReleases, capacitySpecs, oracle1919Specs, oracle1919Release, vendorLifecycleSpecs, vendorLifecycleReleases } from '../database/catalog.js';
import { createSnmpPackage } from '../snmp/package.js';
import { diagnosticSpecs, diagnosticReleases } from '../database/diagnostics.js';
import { hostDiagnosticSpecs, hostDiagnosticRelease } from '../packages/host-diagnostics.js';

export function createConfigurationRegistry(reviewed?: unknown[]): PackageRegistry {
  const custom = compileReviewedSql(reviewed);
  const snmp = createSnmpPackage();
  const registry = new PackageRegistry(canonicalDefinitions, [...implementationSpecs, ...databaseSpecs, ...capacitySpecs, ...oracle1919Specs, ...vendorLifecycleSpecs, ...diagnosticSpecs, ...hostDiagnosticSpecs, ...snmp.specs, ...dynamicSpecs, ...custom.specs]);
  [...builtinReleases(), ...databaseReleases(), ...capacityReleases(), oracle1919Release(), ...vendorLifecycleReleases(), ...diagnosticReleases(), hostDiagnosticRelease(), snmp.release, ...dynamicReleases(), ...custom.releases].forEach(release => registry.install(release));
  return registry;
}
