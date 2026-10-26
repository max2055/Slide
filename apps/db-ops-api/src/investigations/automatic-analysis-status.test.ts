import { describe, expect, it } from 'vitest';
import { deriveAutomaticAnalysisFacts, type AutomaticAnalysisInput } from './automatic-analysis-status.js';

const coverage = (overrides: Partial<AutomaticAnalysisInput['resourceCoverage'][number]> = {}) =>
  ({ type: 'database' as const, status: 'covered' as const, configuredCount: 1, existingCount: 1, permittedCount: 1,
    typePermission: true, ...overrides });
const base = (): AutomaticAnalysisInput => ({
  masterSwitch: { source: 'system_config', status: 'persisted', enabled: true, severityLevels: ['warning', 'error', 'critical'],
    timeWindowStart: '00:00', timeWindowEnd: '23:59', instanceWhitelistCount: 0 },
  investigationSwitch: { enabled: true, manualEnabled: false, legacyEnabled: false, source: 'environment' },
  scopeStatus: 'configured',
  serviceIdentity: { status: 'ready', permissionsSufficient: true, missingPermissions: [], instanceScopeSufficient: true },
  resourceCoverage: [coverage(), coverage({ type: 'server', configuredCount: 0, existingCount: 0, permittedCount: 0, status: 'not_configured' }),
    coverage({ type: 'network_device', configuredCount: 0, existingCount: 0, permittedCount: 0, status: 'not_configured' })],
  budget: { status: 'matching', quotaReached: false },
  entry: { status: 'connected', observedReceiptCount: 1, lastObservedAt: '2026-10-26T00:00:00.000Z' },
});
const codes = (input: AutomaticAnalysisInput) => deriveAutomaticAnalysisFacts(input).blockers.map(blocker => blocker.code);

describe('automatic analysis fact derivation', () => {
  it('is available only when every layer and an observed entry agree', () => {
    expect(deriveAutomaticAnalysisFacts(base())).toEqual({ configurationStatus: 'configured',
      automaticAnalysisStatus: 'available', blockers: [] });
  });

  it('never claims availability when configured and enabled but the entry is unwired', () => {
    const result = deriveAutomaticAnalysisFacts({ ...base(), entry: { status: 'unverified', observedReceiptCount: 0, lastObservedAt: null } });
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
    expect(codes({ ...base(), budget: { status: 'uninitialized', quotaReached: false } })).toContain('BUDGET_UNINITIALIZED');
    expect(codes({ ...base(), budget: { status: 'conflict', quotaReached: false } })).toContain('BUDGET_CONFLICT');
    expect(codes({ ...base(), budget: { status: 'matching', quotaReached: true } })).toContain('BUDGET_QUOTA_REACHED');
    expect(codes({ ...base(), budget: { status: 'unavailable', quotaReached: false } })).toContain('BUDGET_UNAVAILABLE');
  });

  it('labels hostile configuration invalid and never available', () => {
    const result = deriveAutomaticAnalysisFacts({ ...base(), masterSwitch: { ...base().masterSwitch, status: 'invalid', enabled: false } });
    expect(result.configurationStatus).toBe('invalid');
    expect(result.automaticAnalysisStatus).toBe('blocked');
  });

  it('does not flood an unconfigured system with an entry blocker', () => {
    const unconfigured = { ...base(), scopeStatus: 'not_configured' as const,
      serviceIdentity: { ...base().serviceIdentity, status: 'not_configured' as const, permissionsSufficient: false },
      entry: { status: 'not_connected' as const, observedReceiptCount: 0, lastObservedAt: null } };
    expect(codes(unconfigured)).not.toContain('ENTRY_NOT_OBSERVED');
  });

  it('deduplicates the same blocker across resource types', () => {
    const input = { ...base(), resourceCoverage: [coverage({ type: 'database', typePermission: false, status: 'partial' }),
      coverage({ type: 'server', typePermission: false, status: 'partial' }),
      coverage({ type: 'network_device', typePermission: false, status: 'partial' })] };
    expect(codes(input).filter(code => code === 'RESOURCE_PERMISSION_MISSING')).toHaveLength(1);
  });
});
