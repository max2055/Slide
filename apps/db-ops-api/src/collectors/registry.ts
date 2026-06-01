/**
 * Generic Registry<T> — Type-safe provider registry with enable/disable and failure tracking
 *
 * Used by CollectorRegistry (Plan 02) to manage MetricProvider instances.
 */
import type { MetricProvider } from './base-provider.js';

export interface RegistryItem<T> {
  provider: T;
  enabled: boolean;
  consecutiveFailures: number;
}

export class Registry<T extends { readonly name: string; readonly supportedDbTypes: string[] }> {
  private items = new Map<string, { provider: T; enabled: boolean; consecutiveFailures: number }>();

  register(provider: T): void {
    this.items.set(provider.name, { provider, enabled: true, consecutiveFailures: 0 });
  }

  enable(name: string): void {
    const item = this.items.get(name);
    if (item) {
      item.enabled = true;
    }
  }

  disable(name: string): void {
    const item = this.items.get(name);
    if (item) {
      item.enabled = false;
      item.consecutiveFailures = 0;
    }
  }

  get(name: string): T | undefined {
    return this.items.get(name)?.provider;
  }

  list(): T[] {
    return Array.from(this.items.values()).map(item => item.provider);
  }

  listEnabled(): T[] {
    return Array.from(this.items.values())
      .filter(item => item.enabled)
      .map(item => item.provider);
  }

  recordFailure(name: string): number {
    const item = this.items.get(name);
    if (item) {
      item.consecutiveFailures++;
      return item.consecutiveFailures;
    }
    return 0;
  }

  resetFailures(name: string): void {
    const item = this.items.get(name);
    if (item) {
      item.consecutiveFailures = 0;
    }
  }

  getProvidersByDbType(dbType: string): T[] {
    return this.list().filter(
      (p) => Array.isArray(p.supportedDbTypes) && p.supportedDbTypes.includes(dbType)
    );
  }
}

// 全局 CollectorRegistry 单例 — 管理所有 MetricProvider
export const collectorRegistry = new Registry<MetricProvider>();
