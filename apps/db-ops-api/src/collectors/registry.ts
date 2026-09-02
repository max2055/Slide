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
  private items = new Map<string, { provider: T; enabled: boolean; consecutiveFailures: number; failuresByScope: Map<string, number>; disabledScopes: Map<string, number> }>();

  register(provider: T): void {
    this.items.set(provider.name, { provider, enabled: true, consecutiveFailures: 0, failuresByScope: new Map(), disabledScopes: new Map() });
  }

  enable(name: string): void {
    const item = this.items.get(name);
    if (item) {
      item.enabled = true;
      item.disabledScopes.clear();
    }
  }

  disable(name: string, scope?: string, retryAfterMs: number = 60_000): void {
    const item = this.items.get(name);
    if (item) {
      if (scope) {
        item.disabledScopes.set(scope, Date.now() + retryAfterMs);
        item.failuresByScope.delete(scope);
        item.consecutiveFailures = Math.max(0, ...item.failuresByScope.values());
        return;
      }
      item.enabled = false;
      item.consecutiveFailures = 0;
      item.failuresByScope.clear();
    }
  }

  isEnabled(name: string, scope?: string): boolean {
    const item = this.items.get(name);
    if (!item?.enabled) return false;
    if (!scope) return true;
    const disabledUntil = item.disabledScopes.get(scope);
    if (disabledUntil === undefined) return true;
    if (disabledUntil > Date.now()) return false;
    item.disabledScopes.delete(scope);
    return true;
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

  recordFailure(name: string, scope = 'global'): number {
    const item = this.items.get(name);
    if (item) {
      const failures = (item.failuresByScope.get(scope) ?? 0) + 1;
      item.failuresByScope.set(scope, failures);
      item.consecutiveFailures = Math.max(item.consecutiveFailures, failures);
      return failures;
    }
    return 0;
  }

  resetFailures(name: string, scope = 'global'): void {
    const item = this.items.get(name);
    if (item) {
      item.failuresByScope.delete(scope);
      item.consecutiveFailures = Math.max(0, ...item.failuresByScope.values());
    }
  }

  getProvidersByDbType(dbType: string): T[] {
    return this.listEnabled().filter(
      (p) => Array.isArray(p.supportedDbTypes) && p.supportedDbTypes.includes(dbType)
    );
  }
}

// 全局 CollectorRegistry 单例 — 管理所有 MetricProvider
export const collectorRegistry = new Registry<MetricProvider>();
