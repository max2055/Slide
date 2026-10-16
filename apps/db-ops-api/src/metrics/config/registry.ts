import { compileReviewedSql } from '../database/reviewed-sql.js';
import { PackageRegistry } from '../packages/model.js';
import { builtinReleases, canonicalDefinitions, implementationSpecs } from '../packages/builtins.js';
import { databaseReleases, databaseSpecs, capacityReleases, capacitySpecs } from '../database/catalog.js';
import { createSnmpPackage } from '../snmp/package.js';
import { diagnosticSpecs, diagnosticReleases } from '../database/diagnostics.js';
import { hostDiagnosticSpecs, hostDiagnosticRelease } from '../packages/host-diagnostics.js';

export function createConfigurationRegistry(reviewed?: unknown[]): PackageRegistry {
  const custom = compileReviewedSql(reviewed);
  const snmp = createSnmpPackage();
  const registry = new PackageRegistry(canonicalDefinitions, [...implementationSpecs, ...databaseSpecs, ...capacitySpecs, ...diagnosticSpecs, ...hostDiagnosticSpecs, ...snmp.specs, ...custom.specs]);
  [...builtinReleases(), ...databaseReleases(), ...capacityReleases(), ...diagnosticReleases(), hostDiagnosticRelease(), snmp.release, ...custom.releases].forEach(release => registry.install(release));
  return registry;
}
