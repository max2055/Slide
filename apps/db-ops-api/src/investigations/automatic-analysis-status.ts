import type { Static } from '@sinclair/typebox';
import type { InvestigationPoliciesResponseSchema } from './governance-contracts.js';

type Facts = Static<typeof InvestigationPoliciesResponseSchema>;
export type PolicyBlocker = Facts['blockers'][number];
export type ScopeStatus = 'configured' | 'not_configured' | 'invalid';

export interface AutomaticAnalysisInput {
  masterSwitch: Facts['masterSwitch'];
  investigationSwitch: Facts['investigationSwitch'];
  scopeStatus: ScopeStatus;
  serviceIdentity: Facts['serviceIdentity'];
  resourceCoverage: Facts['resourceCoverage'];
  budget: Facts['budget'];
  entry: Facts['entry'];
}

export interface AutomaticAnalysisDerivation {
  configurationStatus: Facts['configurationStatus'];
  automaticAnalysisStatus: Facts['automaticAnalysisStatus'];
  blockers: PolicyBlocker[];
}

/** Pure derivation from separately observed facts. Configuration may be
 * complete while execution is not; an unobserved entry stays "unverified"
 * rather than being reported as connected or available. */
export function deriveAutomaticAnalysisFacts(input: AutomaticAnalysisInput): AutomaticAnalysisDerivation {
  const blockers: PolicyBlocker[] = [];
  const seen = new Set<string>();
  const block = (code: PolicyBlocker['code'], layer: PolicyBlocker['layer'], remediation: PolicyBlocker['remediation']) => {
    if (seen.has(code)) return;
    seen.add(code); blockers.push({ code, layer, remediation });
  };

  if (input.masterSwitch.status === 'invalid') block('MASTER_CONFIG_INVALID', 'configuration', 'analysis_settings');
  else if (!input.masterSwitch.enabled) block('MASTER_SWITCH_DISABLED', 'switch', 'analysis_settings');
  if (!input.investigationSwitch.enabled) block('INVESTIGATION_SWITCH_DISABLED', 'switch', 'deployment_environment');

  if (input.scopeStatus === 'invalid') block('RESOURCE_SCOPE_INVALID', 'configuration', 'deployment_environment');
  else if (input.scopeStatus === 'not_configured') block('RESOURCE_SCOPE_NOT_CONFIGURED', 'configuration', 'deployment_environment');

  switch (input.serviceIdentity.status) {
    case 'not_configured': block('SERVICE_IDENTITY_NOT_CONFIGURED', 'configuration', 'deployment_environment'); break;
    case 'not_found': block('SERVICE_IDENTITY_NOT_FOUND', 'authorization', 'deployment_environment'); break;
    case 'invalid': block('SERVICE_IDENTITY_INVALID', 'authorization', 'deployment_environment'); break;
    case 'disabled': block('SERVICE_IDENTITY_DISABLED', 'authorization', 'deployment_environment'); break;
    case 'ready':
      if (!input.serviceIdentity.permissionsSufficient) block('SERVICE_PERMISSIONS_MISSING', 'authorization', 'user_permissions');
      if (!input.serviceIdentity.instanceScopeSufficient) block('RESOURCE_INSTANCE_SCOPE_MISSING', 'authorization', 'user_permissions');
      break;
  }

  for (const coverage of input.resourceCoverage) {
    if (coverage.configuredCount === 0) continue;
    if (coverage.existingCount === 0) { block('RESOURCE_UNAVAILABLE', 'resources', 'deployment_environment'); continue; }
    if (input.serviceIdentity.status === 'ready' && !coverage.typePermission)
      block('RESOURCE_PERMISSION_MISSING', 'authorization', 'user_permissions');
  }

  if (input.budget.status === 'unavailable') block('BUDGET_UNAVAILABLE', 'budget', 'budget_settings');
  else if (input.budget.status === 'uninitialized') block('BUDGET_UNINITIALIZED', 'budget', 'budget_settings');
  else if (input.budget.status === 'conflict') block('BUDGET_CONFLICT', 'budget', 'budget_settings');
  if (input.budget.quotaReached) block('BUDGET_QUOTA_REACHED', 'budget', 'budget_settings');

  // Absent an observed automatic ingress receipt, a fully configured stack is
  // not yet proven wired. Any earlier blocker already explains the gap.
  if (blockers.length === 0 && input.entry.status !== 'connected')
    block('ENTRY_NOT_OBSERVED', 'wiring', 'alert_engine');

  const configurationStatus: Facts['configurationStatus'] =
    input.masterSwitch.status === 'invalid' || input.scopeStatus === 'invalid' ? 'invalid'
      : input.serviceIdentity.status !== 'not_configured' && input.scopeStatus === 'configured' ? 'configured'
        : 'not_configured';
  const automaticAnalysisStatus: Facts['automaticAnalysisStatus'] =
    blockers.some(entry => entry.code !== 'ENTRY_NOT_OBSERVED') ? 'blocked'
      : blockers.length > 0 ? 'unverified' : 'available';
  return { configurationStatus, automaticAnalysisStatus, blockers };
}
