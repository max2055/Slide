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
  targetDatabase?: string;
  content: string;
  sha256: string;
  capability: string;
  authorizedBy: string;
}

export function hashScript(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function readScriptTargetDatabase(raw: unknown): string | undefined {
  try {
    const binding = typeof raw === 'string' ? JSON.parse(raw) : raw as ScriptBinding | null | undefined;
    return typeof binding?.targetDatabase === 'string' ? binding.targetDatabase : undefined;
  } catch { return undefined; }
}

function checkedTargetDatabase(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string' || !value.trim() || [...value].length > 64 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('CRON_INVALID_TARGET_DATABASE');
  }
  return value;
}

export function rebindScriptDatabase(binding: ScriptBinding, requested: unknown, actorId: string): ScriptBinding {
  const targetDatabase = checkedTargetDatabase(requested);
  const { targetDatabase: _previousDatabase, ...existing } = binding;
  return validateBinding({ ...existing, authorizedBy: actorId, ...(targetDatabase === undefined ? {} : { targetDatabase }) },
    binding.scriptId, binding.targetInstanceId);
}

export function bindScript(script: CronScript, targetInstanceId: number | null, capability: unknown, actorId: string, requestedDatabase?: unknown): ScriptBinding {
  if (script.script_type !== 'sql') throw new Error('CRON_SQL_SCRIPT_REQUIRED');
  if (targetInstanceId !== null && (!Number.isSafeInteger(targetInstanceId) || targetInstanceId <= 0)) {
    throw new Error('CRON_INVALID_TARGET');
  }
  const targetDatabase = checkedTargetDatabase(requestedDatabase);
  if (targetDatabase !== undefined && script.target_db_type !== 'mysql') throw new Error('CRON_TARGET_DATABASE_UNSUPPORTED');
  const binding: ScriptBinding = {
    version: 1, scriptId: script.id, targetInstanceId, content: script.content,
    sha256: hashScript(script.content), authorizedBy: actorId,
    capability: typeof capability === 'string' ? capability : 'read-only',
    ...(targetDatabase === undefined ? {} : { targetDatabase }),
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
  const targetDatabase = checkedTargetDatabase(binding.targetDatabase);
  if (binding.targetDatabase !== undefined && targetDatabase === undefined) throw new Error('CRON_INVALID_TARGET_DATABASE');
  if (targetInstanceId === null) {
    if (targetDatabase !== undefined) throw new Error('CRON_TARGET_DATABASE_UNSUPPORTED');
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
