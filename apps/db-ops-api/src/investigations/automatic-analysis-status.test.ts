import { describe, expect, it } from 'vitest';
import { deriveAutomaticAnalysisFacts, type AutomaticAnalysisInput } from './automatic-analysis-status.js';

const coverage = (overrides: Partial<AutomaticAnalysisInput['resourceCoverage'][number]> = {}) =>
  ({ type: 'database' as const, status: 'covered' as const, configuredCount: 1, existingCount: 1, permittedCount: 1,
    typePermission: true, ...overrides });
const budget = (overrides: Partial<AutomaticAnalysisInput['budget']> = {}): AutomaticAnalysisInput['budget'] =>
  ({ status: 'matching', quotaReached: false, capacityReached: false, reserveTokens: 32_000, reserveCostMicros: 1_000_000,
    admissionReasons: [], ...overrides });
const entry = (overrides: Partial<AutomaticAnalysisInput['entry']> = {}): AutomaticAnalysisInput['entry'] =>
  ({ status: 'connected', observedReceiptCount: 1, lastObservedAt: '2026-10-26T00:00:00.000Z', witnessTypes: ['database'], ...overrides });
const base = (): AutomaticAnalysisInput => ({
  masterSwitch: { source: 'system_config', status: 'persisted', enabled: true, severityLevels: ['warning', 'error', 'critical'],
    timeWindowStart: '00:00', timeWindowEnd: '23:59', instanceWhitelistCount: 0 },
  investigationSwitch: { enabled: true, manualEnabled: false, legacyEnabled: false, source: 'environment' },
  scopeStatus: 'configured',
  serviceIdentity: { status: 'ready', permissionsSufficient: true, missingPermissions: [], instanceScopeSufficient: true },
  resourceCoverage: [coverage(), coverage({ type: 'server', configuredCount: 0, existingCount: 0, permittedCount: 0, status: 'not_configured' }),
    coverage({ type: 'network_device', configuredCount: 0, existingCount: 0, permittedCount: 0, status: 'not_configured' })],
  budget: budget(),
  entry: entry(),
});
const codes = (input: AutomaticAnalysisInput) => deriveAutomaticAnalysisFacts(input).blockers.map(blocker => blocker.code);

describe('automatic analysis fact derivation', () => {
  it('is available only when every layer and durable wiring agree', () => {
    expect(deriveAutomaticAnalysisFacts(base())).toEqual({ configurationStatus: 'configured',
      automaticAnalysisStatus: 'available', blockers: [] });
  });

  it('never claims availability when configured and enabled but the entry is unwired', () => {
    const result = deriveAutomaticAnalysisFacts({ ...base(), entry: entry({ status: 'unverified', observedReceiptCount: 0, lastObservedAt: null, witnessTypes: [] }) });
    expect(result.automaticAnalysisStatus).toBe('unverified');
    expect(result.blockers).toEqual([{ code: 'ENTRY_NOT_OBSERVED', layer: 'wiring', remediation: 'alert_engine' }]);
  });

  it('reports each missing layer as a distinct blocker', () => {
    expect(codes({ ...base(), masterSwitch: { ...base().masterSwitch, enabled: false } })).toContain('MASTER_SWITCH_DISABLED');
    expect(codes({ ...base(), masterSwitch: { ...base().masterSwitch, status: 'invalid', enabled: false } })).toContain('MASTER_CONFIG_INVALID');
    expect(codes({ ...base(), investigationSwitch: { ...base().investigationSwitch, enabled: false } })).toContain('INVESTIGATION_SWITCH_DISABLED');
    expect(codes({ ...base(), serviceIdentity: { ...base().serviceIdentity, status: 'not_configured', permissionsSufficient: false } }))
      .toContain('SERVICE_IDENTITY_NOT_CONFIGURED');
    expect(codes({ ...base(), scopeStatus: 'not_configured' })).toContain('RESOURCE_SCOPE_NOT_CONFIGURED');
    expect(codes({ ...base(), scopeStatus: 'invalid' })).toContain('RESOURCE_SCOPE_INVALID');
    expect(codes({ ...base(), serviceIdentity: { ...base().serviceIdentity, permissionsSufficient: false, missingPermissions: ['chat:view'] } }))
      .toContain('SERVICE_PERMISSIONS_MISSING');
    expect(codes({ ...base(), serviceIdentity: { ...base().serviceIdentity, instanceScopeSufficient: false } }))
      .toContain('RESOURCE_INSTANCE_SCOPE_MISSING');
    expect(codes({ ...base(), resourceCoverage: [coverage({ existingCount: 0, permittedCount: 0, status: 'unavailable' }),
      base().resourceCoverage[1], base().resourceCoverage[2]] })).toContain('RESOURCE_UNAVAILABLE');
    expect(codes({ ...base(), resourceCoverage: [coverage({ typePermission: false, status: 'partial' }),
      base().resourceCoverage[1], base().resourceCoverage[2]] })).toContain('RESOURCE_PERMISSION_MISSING');
    expect(codes({ ...base(), budget: budget({ status: 'uninitialized' }) })).toContain('BUDGET_UNINITIALIZED');
    expect(codes({ ...base(), budget: budget({ status: 'conflict' }) })).toContain('BUDGET_CONFLICT');
    expect(codes({ ...base(), budget: budget({ quotaReached: true, admissionReasons: ['AUTOMATIC_DAILY_TOKENS'] }) }))
      .toContain('BUDGET_QUOTA_REACHED');
    expect(codes({ ...base(), budget: budget({ capacityReached: true, admissionReasons: ['GLOBAL_CONCURRENCY'] }) }))
      .toContain('BUDGET_CAPACITY_REACHED');
    expect(codes({ ...base(), budget: budget({ status: 'unavailable' }) })).toContain('BUDGET_UNAVAILABLE');
  });

  it('blocks a type when only part of its configured resources are missing', () => {
    // Regression for Chief counterexample 1: configured 2, existing 1 must not
    // be reported as available just because one still exists.
    const result = deriveAutomaticAnalysisFacts({ ...base(),
      resourceCoverage: [coverage({ status: 'partial', configuredCount: 2, existingCount: 1, permittedCount: 1 }),
        base().resourceCoverage[1], base().resourceCoverage[2]] });
    expect(result.automaticAnalysisStatus).toBe('blocked');
    expect(result.blockers).toEqual([{ code: 'RESOURCE_UNAVAILABLE', layer: 'resources', remediation: 'deployment_environment' }]);
  });

  it('blocks a type when part of its existing resources lack instance grants', () => {
    const result = deriveAutomaticAnalysisFacts({ ...base(),
      resourceCoverage: [coverage({ status: 'partial', configuredCount: 2, existingCount: 2, permittedCount: 1 }),
        base().resourceCoverage[1], base().resourceCoverage[2]] });
    expect(result.blockers.map(blocker => blocker.code)).toEqual(['RESOURCE_INSTANCE_SCOPE_MISSING']);
  });

  it('does not require unconfigured types to be wired before reporting configured ones', () => {
    expect(codes(base())).toEqual([]);
    expect(codes({ ...base(), resourceCoverage: [coverage(), coverage({ type: 'server', status: 'unavailable',
      configuredCount: 1, existingCount: 0, permittedCount: 0 }), base().resourceCoverage[2]] }))
      .toEqual(['RESOURCE_UNAVAILABLE']);
  });

  it('labels hostile configuration invalid and never available', () => {
    const result = deriveAutomaticAnalysisFacts({ ...base(), masterSwitch: { ...base().masterSwitch, status: 'invalid', enabled: false } });
    expect(result.configurationStatus).toBe('invalid');
    expect(result.automaticAnalysisStatus).toBe('blocked');
  });

  it('does not flood an unconfigured system with an entry blocker', () => {
    const unconfigured = { ...base(), scopeStatus: 'not_configured' as const,
      serviceIdentity: { ...base().serviceIdentity, status: 'not_configured' as const, permissionsSufficient: false },
      entry: entry({ status: 'not_connected' as const, observedReceiptCount: 0, lastObservedAt: null, witnessTypes: [] }) };
    expect(codes(unconfigured)).not.toContain('ENTRY_NOT_OBSERVED');
  });

  it('deduplicates the same blocker across resource types', () => {
    const input = { ...base(), resourceCoverage: [coverage({ type: 'database', typePermission: false, status: 'partial' }),
      coverage({ type: 'server', typePermission: false, status: 'partial' }),
      coverage({ type: 'network_device', typePermission: false, status: 'partial' })] };
    expect(codes(input).filter(code => code === 'RESOURCE_PERMISSION_MISSING')).toHaveLength(1);
  });
});
