/**
 * Server Metric Provider
 *
 * Defines SSH commands and output parsers for Linux OS-level metrics.
 * Each metric has a name (stored in server_metrics.metric_name), a shell
 * command, and a parse function to convert stdout to a numeric value.
 *
 * Requirements: COL-02 (disk detail per mount), COL-03 (metric commands + parsers)
 */

// ── Types ──────────────────────────────────────────────────────────────────────

interface MetricDefinition {
  name: string;
  command: string;
  parse: (stdout: string) => number | null;
  osType: string;
}

// ── Linux metric definitions ───────────────────────────────────────────────────

const LINUX_DEFINITIONS: MetricDefinition[] = [
  {
    name: 'cpu_usage',
    command:
      `LANG=C LC_ALL=C top -bn1 | grep "Cpu(s)" | awk '{print $2+$4}'`,
    parse: (stdout: string): number | null => {
      const val = parseFloat(stdout.trim());
      return isNaN(val) ? null : Math.round(val * 100) / 100;
    },
    osType: 'linux',
  },
  {
    name: 'memory_usage',
    command:
      `LANG=C LC_ALL=C free | grep Mem | awk '{print $3/$2 * 100.0}'`,
    parse: (stdout: string): number | null => {
      const val = parseFloat(stdout.trim());
      return isNaN(val) ? null : Math.round(val * 100) / 100;
    },
    osType: 'linux',
  },
  {
    name: 'memory_used',
    command:
      `LANG=C LC_ALL=C free -b | grep Mem | awk '{print $3}'`,
    parse: (stdout: string): number | null => {
      const val = parseFloat(stdout.trim());
      return isNaN(val) ? null : val;
    },
    osType: 'linux',
  },
  {
    name: 'memory_total',
    command:
      `LANG=C LC_ALL=C free -b | grep Mem | awk '{print $2}'`,
    parse: (stdout: string): number | null => {
      const val = parseFloat(stdout.trim());
      return isNaN(val) ? null : val;
    },
    osType: 'linux',
  },
  {
    name: 'swap_usage',
    command:
      `LANG=C LC_ALL=C free | grep Swap | awk '{if($2>0) print $3/$2*100; else print 0}'`,
    parse: (stdout: string): number | null => {
      const val = parseFloat(stdout.trim());
      return isNaN(val) ? null : Math.round(val * 100) / 100;
    },
    osType: 'linux',
  },
  {
    name: 'disk_usage',
    command:
      `LANG=C LC_ALL=C df -P | awk 'NR>1 {print $6,$5}'`,
    parse: (_stdout: string): number | null => {
      // disk_usage returns per-mount output; the collector processes
      // individual mount points via disk_detail instead
      return null;
    },
    osType: 'linux',
  },
  {
    name: 'load_1min',
    command:
      `LANG=C LC_ALL=C cat /proc/loadavg | awk '{print $1}'`,
    parse: (stdout: string): number | null => {
      const val = parseFloat(stdout.trim());
      return isNaN(val) ? null : val;
    },
    osType: 'linux',
  },
  {
    name: 'load_5min',
    command:
      `LANG=C LC_ALL=C cat /proc/loadavg | awk '{print $2}'`,
    parse: (stdout: string): number | null => {
      const val = parseFloat(stdout.trim());
      return isNaN(val) ? null : val;
    },
    osType: 'linux',
  },
  {
    name: 'load_15min',
    command:
      `LANG=C LC_ALL=C cat /proc/loadavg | awk '{print $3}'`,
    parse: (stdout: string): number | null => {
      const val = parseFloat(stdout.trim());
      return isNaN(val) ? null : val;
    },
    osType: 'linux',
  },
  {
    name: 'uptime',
    command:
      `LANG=C LC_ALL=C cat /proc/uptime | awk '{print $1}'`,
    parse: (stdout: string): number | null => {
      const val = parseFloat(stdout.trim());
      return isNaN(val) ? null : val;
    },
    osType: 'linux',
  },
  {
    name: 'disk_detail',
    command:
      `LANG=C LC_ALL=C df -B1 | awk 'NR>1 {print $6,$2,$3,$4,int($5)}'`,
    parse: (_stdout: string): number | null => {
      // disk_detail is parsed by the collector for per-mount-point rows
      return null;
    },
    osType: 'linux',
  },
];

// ── Provider class ─────────────────────────────────────────────────────────────

class ServerMetricProvider {
  private definitions: Map<string, MetricDefinition>;

  constructor() {
    this.definitions = new Map();
    for (const def of LINUX_DEFINITIONS) {
      this.definitions.set(def.name, def);
    }
  }

  private static readonly LINUX_DISTROS = new Set([
    'linux', 'centos', 'rhel', 'ubuntu', 'debian', 'fedora', 'rocky', 'almalinux',
    'kylin v10', 'kylin', 'other',
  ]);

  /**
   * Return metric definitions for a given OS type.
   * Normalizes common Linux distribution names to 'linux'.
   */
  getDefinitions(osType: string): MetricDefinition[] {
    const normalized = osType.toLowerCase().trim();
    if (ServerMetricProvider.LINUX_DISTROS.has(normalized)) {
      return LINUX_DEFINITIONS;
    }
    return [];
  }

  /**
   * Parse raw stdout for a metric into a numeric value.
   * Returns null if parsing fails.
   */
  parseMetric(name: string, stdout: string): number | null {
    const def = this.definitions.get(name);
    if (!def) return null;
    return def.parse(stdout);
  }

  /**
   * Get all SSH commands for a given OS type.
   * Returns the command strings for batch execution.
   */
  getAllCommands(osType: string): string[] {
    const normalized = osType.toLowerCase().trim();
    if (ServerMetricProvider.LINUX_DISTROS.has(normalized)) {
      return LINUX_DEFINITIONS.map((def) => def.command);
    }
    return [];
  }
}

// Singleton
const serverMetricProvider = new ServerMetricProvider();
export default serverMetricProvider;
export { ServerMetricProvider, MetricDefinition };
