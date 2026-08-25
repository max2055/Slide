/**
 * Supported server operating-system profiles.
 *
 * The collector uses a single, locale-independent command set for these
 * distributions. Keeping normalization here prevents an arbitrary label from
 * silently selecting the Linux command path.
 */

export type SupportedServerOs = 'kylin' | 'rhel' | 'centos';

export interface ServerOsProfile {
  canonical: SupportedServerOs;
  label: string;
  commandEnvironment: 'LC_ALL=C LANG=C';
}

const COMMAND_ENVIRONMENT = 'LC_ALL=C LANG=C' as const;

const PROFILES: Readonly<Record<SupportedServerOs, ServerOsProfile>> = {
  kylin: {
    canonical: 'kylin',
    label: 'Kylin OS',
    commandEnvironment: COMMAND_ENVIRONMENT,
  },
  rhel: {
    canonical: 'rhel',
    label: 'Red Hat Enterprise Linux',
    commandEnvironment: COMMAND_ENVIRONMENT,
  },
  centos: {
    canonical: 'centos',
    label: 'CentOS',
    commandEnvironment: COMMAND_ENVIRONMENT,
  },
};

// Version suffixes are intentionally narrow: accepting only digits and dots
// keeps labels suitable for persistence and prevents shell fragments.
const VERSION_SUFFIX = '(?:\\s*-?\\s*v?\\d+(?:\\.\\d+)*)?';
const OS_PATTERNS: ReadonlyArray<readonly [SupportedServerOs, RegExp]> = [
  ['kylin', new RegExp(`^kylin(?:\\s+os)?${VERSION_SUFFIX}$`, 'i')],
  ['rhel', new RegExp(`^(?:rhel|redhat|red hat enterprise linux)${VERSION_SUFFIX}$`, 'i')],
  ['centos', new RegExp(`^centos(?:\\s+linux)?${VERSION_SUFFIX}$`, 'i')],
];

function normalizeLabel(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const normalized = input.trim().toLowerCase().replace(/\\s+/g, ' ');
  if (!normalized || normalized.length > 50) return null;
  // Reject control characters and shell punctuation before pattern matching.
  if (!/^[a-z0-9 ._-]+$/.test(normalized)) return null;
  return normalized;
}

export function normalizeServerOs(input: unknown): SupportedServerOs | null {
  const normalized = normalizeLabel(input);
  if (!normalized) return null;
  for (const [canonical, pattern] of OS_PATTERNS) {
    if (pattern.test(normalized)) return canonical;
  }
  return null;
}

export function isSupportedServerOs(input: unknown): input is string {
  return normalizeServerOs(input) !== null;
}

export function getServerOsProfile(input: unknown): ServerOsProfile | null {
  const canonical = normalizeServerOs(input);
  return canonical ? PROFILES[canonical] : null;
}

export function getSupportedServerOsProfiles(): ServerOsProfile[] {
  return Object.values(PROFILES).map((profile) => ({ ...profile }));
}

export { COMMAND_ENVIRONMENT };
