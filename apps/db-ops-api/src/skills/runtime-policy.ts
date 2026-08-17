import type { SkillEntry } from './types.js';
import { agentSecurityPolicyService } from '../security/agent-security-policy-service.js';

const disabledSkills = new Set<string>();

function configuredAllowlist(agentId: string): Set<string> | null {
  try {
    const parsed = JSON.parse(process.env.AGENT_SKILL_ALLOWLISTS || '{}') as Record<string, unknown>;
    const names = parsed[agentId];
    return Array.isArray(names) ? new Set(names.filter((name): name is string => typeof name === 'string')) : null;
  } catch {
    return new Set();
  }
}

export function setSkillEnabled(name: string, enabled: boolean): void {
  if (enabled) disabledSkills.delete(name.toLowerCase());
  else disabledSkills.add(name.toLowerCase());
}

export function isSkillEnabled(name: string): boolean {
  return !disabledSkills.has(name.toLowerCase());
}

export function filterRuntimeSkills(agentId: string, entries: readonly SkillEntry[]): SkillEntry[] {
  const operatorAllowlist = configuredAllowlist(agentId);
  const policyAllowlist = agentSecurityPolicyService.skillAllowlist(agentId);
  return entries.filter((entry) =>
    entry.security?.trusted === true
    && isSkillEnabled(entry.skill.name)
    && (operatorAllowlist === null || operatorAllowlist.has(entry.skill.name))
    && (policyAllowlist === null || policyAllowlist.has(entry.skill.name)),
  );
}
