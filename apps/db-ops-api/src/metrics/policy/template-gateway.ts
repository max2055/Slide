/**
 * MAX-238 / B2F — the narrow, explicitly injected template gateway of the
 * existing policy store.
 *
 * It is not a second store and not a second transaction implementation: it
 * leases one connection from the same `MysqlPolicyStore` pool provider, enters
 * the same admission queue, and calls the accepted `MysqlBindingHost` (B2E),
 * which takes the one global `metric_policy_lock` row lock and runs the accepted
 * guard/resolve/compile/apply path. A default `MysqlPolicyStore` has no trusted
 * factory, so its gateway is a stable "unavailable" — there is no fallback pool,
 * no route, no runtime and no DDL here.
 */
import type { Pool } from 'mysql2/promise';
import {
  MysqlBindingHost, type BindingOperationLookupResult, type BindingSqlPool,
  type TrustedBindingInputsFactory,
} from '../bindings/mysql-host.js';
import type { BindingApplicationOutcome } from '../bindings/transaction-adapter.js';
import type { PackageRegistry } from '../packages/model.js';

export const TEMPLATE_GATEWAY_UNAVAILABLE = 'TEMPLATE_GATEWAY_UNAVAILABLE';

export class TemplateGatewayError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'TemplateGatewayError';
  }
}

export interface PolicyTemplateGatewayOptions {
  /** The host's same-connection trusted reads (authorization, context, dependencies, template versions). */
  readonly trustedInputs: TrustedBindingInputsFactory;
  /** Trusted server clock; never `Date.now()` inside the guard. */
  readonly trustedNow: () => unknown;
  /** The real package registry the accepted resolver/compiler use. */
  readonly registry: PackageRegistry;
}

export interface PolicyTemplateGatewayDeps {
  /** The existing `MysqlPolicyStore` pool provider; no other pool is created. */
  readonly pool: () => Pool | null;
  /** The store's own admission queue, so host leases serialize with policy transactions. */
  readonly admission: <T>(pool: Pool, run: () => Promise<T>) => Promise<T>;
  readonly options?: PolicyTemplateGatewayOptions;
}

/** The lease/lock/read contract this gateway relies on; evidence, not configuration. */
export const TEMPLATE_GATEWAY_CONTRACT = {
  lease: 'one connection from the MysqlPolicyStore pool provider',
  admission: 'shared with MysqlPolicyStore.transaction',
  lock_order: ['policy admission queue', 'host BEGIN', 'metric_policy_lock id=1 FOR UPDATE', 'binding/operation row locks'],
  trusted_reads: ['authorize', 'applicationContext', 'mandatoryItems', 'templateVersions'],
  writes: 'operation + binding payload + audit inside the host transaction only',
} as const;

export class PolicyTemplateGateway {
  private readonly host: MysqlBindingHost | null;

  constructor(private readonly deps: PolicyTemplateGatewayDeps) {
    const options = deps.options;
    this.host = options === undefined ? null : new MysqlBindingHost({
      // A real mysql2 pool is structurally the narrow port the host needs.
      pool: () => deps.pool() as unknown as BindingSqlPool | null,
      trustedInputs: options.trustedInputs,
      trustedNow: options.trustedNow,
    });
  }

  get available(): boolean {
    return this.host !== null;
  }

  private options(): PolicyTemplateGatewayOptions {
    const options = this.deps.options;
    if (this.host === null || options === undefined) throw new TemplateGatewayError(TEMPLATE_GATEWAY_UNAVAILABLE);
    return options;
  }

  private async admitted<T>(run: (host: MysqlBindingHost) => Promise<T>): Promise<T> {
    this.options();
    const pool = this.deps.pool();
    if (pool === null || pool === undefined) throw new TemplateGatewayError(TEMPLATE_GATEWAY_UNAVAILABLE);
    return this.deps.admission(pool, () => run(this.host!));
  }

  /** Apply one accepted template binding intent; only the pending candidate is written. */
  async apply(request: unknown): Promise<BindingApplicationOutcome> {
    const options = this.options();
    return this.admitted(host => host.apply(request, options.registry));
  }

  /** Exact operation lookup; a missing row is `complete: true, operation: null`, never a safe replay. */
  async lookupOperation(callerKey: string): Promise<BindingOperationLookupResult> {
    return this.admitted(host => host.lookupOperation(callerKey));
  }
}
