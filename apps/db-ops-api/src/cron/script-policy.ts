import { createHash } from 'node:crypto';
import { classifySql } from '../sql-validator.js';
import type { CronScript } from './types.js';

// Application-owned maintenance capabilities. No arbitrary SQL write grant.
export const CONTROL_MAINTENANCE = {
  'baseline-cleanup-v1': 'DELETE FROM metric_baselines WHERE computed_at < NOW() - INTERVAL 30 DAY;',
  'silence-cleanup-v1': 'DELETE FROM silence_periods WHERE silenced_until < NOW();',
} as const;

export interface ScriptBinding {
  version: 1;
  scriptId: number;
  targetInstanceId: number | null;
  content: string;
  sha256: string;
  capability: string;
  authorizedBy: string;
}

export function hashScript(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function bindScript(script: CronScript, targetInstanceId: number | null, capability: unknown, actorId: string): ScriptBinding {
  if (script.script_type !== 'sql') throw new Error('CRON_SQL_SCRIPT_REQUIRED');
  if (targetInstanceId !== null && (!Number.isSafeInteger(targetInstanceId) || targetInstanceId <= 0)) {
    throw new Error('CRON_INVALID_TARGET');
  }
  const binding: ScriptBinding = {
    version: 1, scriptId: script.id, targetInstanceId, content: script.content,
    sha256: hashScript(script.content), authorizedBy: actorId,
    capability: typeof capability === 'string' ? capability : 'read-only',
  };
  if (targetInstanceId === null && script.target_db_type !== 'mysql') throw new Error('CRON_CONTROL_MYSQL_REQUIRED');
  validateBinding(binding, script.id, targetInstanceId);
  return binding;
}

export function validateBinding(raw: unknown, scriptId: number | null, targetInstanceId: number | null): ScriptBinding {
  const binding = (typeof raw === 'string' ? JSON.parse(raw) : raw) as ScriptBinding | null;
  if (!binding || binding.version !== 1 || binding.scriptId !== scriptId ||
      binding.targetInstanceId !== targetInstanceId || typeof binding.content !== 'string' ||
      binding.sha256 !== hashScript(binding.content) || !binding.authorizedBy) {
    throw new Error('CRON_SCRIPT_BINDING_REQUIRED');
  }
  if (targetInstanceId === null) {
    if (binding.capability === 'read-only') {
      if (classifySql(binding.content, 'mysql').commandType !== 'read') throw new Error('CRON_CONTROL_SQL_DENIED');
      // Executable comments/hints can alter MySQL semantics behind the AST.
      if (/\/\*[!+]/.test(binding.content)) throw new Error('CRON_CONTROL_SQL_DENIED');
    } else if (!Object.hasOwn(CONTROL_MAINTENANCE, binding.capability) ||
        CONTROL_MAINTENANCE[binding.capability as keyof typeof CONTROL_MAINTENANCE] !== binding.content) {
      throw new Error('CRON_MAINTENANCE_BINDING_MISMATCH');
    }
  } else if (binding.capability !== 'read-only') {
    throw new Error('CRON_CONTROL_CAPABILITY_TARGET_MISMATCH');
  }
  return binding;
}
