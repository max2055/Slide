#!/usr/bin/env node
/**
 * MAX-236 / P0-REAL-A rollback entry point (S9), deliberately NOT registered in
 * the application, in `server.ts`, or in any package script.
 *
 * Ownership is proven BEFORE connecting (exact creation-record handle), exactly
 * as in `max236-migrate.ts`.
 *
 * Read-only by default: it shows the target revision (complete configuration
 * recovered from the real publish audit) and the revision the rollback would
 * append, computed from ONE consistent verified read-only snapshot. Re-running
 * the same command after a successful rollback is legal: the plan's own audit
 * row carries the baseline it bound, so the SAME digest is reproduced and
 * `--apply` recognises the exact replay as a no-op. Any drifted state — including
 * a same-revision configuration edit — refuses without writing.
 *
 * Rollback never deletes history and never flattens a multi-template target into
 * a single package; it appends one revision that reproduces the target.
 *
 *   MAX236_REALA_HANDLE=.max236-reala/handle.json \
 *   MAX236_REALA_DSN=mysql://root@127.0.0.1:33440/max236_reala \
 *     npx tsx scripts/max236-rollback.ts --resource instance:9101 --to 0 --expect-current 1
 *
 * Exit codes: 0 plan/applied/no-op, 2 refusal, 1 usage or connection failure.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  applyRealRollback, assertWritableTarget, evidenceJson, openVerifiedSession, parseHandle,
  planRealRollback, readConsistentSnapshot, realRollbackDigest,
  EXECUTOR_VERSION, RealRefusal, type RealRollbackOptions,
} from '../src/metrics/dry-run/real-migration.js';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const has = (name: string): boolean => argv.includes(name);

class UsageError extends Error {}
const fail = (message: string): never => { throw new UsageError(message); };

async function main(): Promise<void> {
  const dsn = process.env.MAX236_REALA_DSN;
  if (!dsn) fail('MAX236_REALA_DSN is required (task-local, untracked)');
  const handlePath = flag('--handle') ?? process.env.MAX236_REALA_HANDLE ?? fail('--handle or MAX236_REALA_HANDLE is required (creation record)');
  const handle = parseHandle(JSON.parse(readFileSync(handlePath, 'utf8')));
  const resourceArg = flag('--resource') ?? fail('--resource <type:id> is required');
  const match = /^(instance|server|network_device):(\d+)$/.exec(resourceArg);
  if (!match) fail('--resource must be <instance|server|network_device>:<positive id>');
  const resource = { type: match![1] as 'instance' | 'server' | 'network_device', id: Number(match![2]) };

  const targetRevision = Number(flag('--to') ?? fail('--to <target revision> is required'));
  if (!Number.isInteger(targetRevision) || targetRevision < 0) fail('--to must be a non-negative integer');
  const expectedCurrent = Number(flag('--expect-current') ?? fail('--expect-current <observed revision> is required'));
  if (!Number.isInteger(expectedCurrent) || expectedCurrent < 0) fail('--expect-current must be a non-negative integer');
  const actorId = Number(flag('--actor-id') ?? '9001');
  if (!Number.isInteger(actorId) || actorId <= 0) fail('--actor-id must be a positive integer');
  const at = flag('--at') ?? new Date().toISOString().replace('T', ' ').replace('Z', '');
  const failAt = flag('--fail-at') as RealRollbackOptions['fail_at'];

  const handleResult = await openVerifiedSession(dsn, handle);
  try {
    // Connection identity verified before any state read.
    const { facts } = handleResult;
    const resourceKey = `${resource.type}:${resource.id}`;
    const target = {
      database: facts.database, hostname: facts.hostname, hostname12: facts.hostname.slice(0, 12), version: facts.version,
      confirm_expected: `${facts.database}@${facts.hostname.slice(0, 12)}:${resourceKey}`,
    };
    const ownership = {
      handle_path: handlePath,
      container_id: handle.container_id,
      image: handle.image,
      network: handle.network,
      network_id: handle.network_id,
      volume: handle.volume,
      port: handle.port,
    };

    if (has('--apply')) {
      const confirm = flag('--confirm') ?? fail('--apply requires --confirm <database@container_id12:resource>');
      const expectDigest = flag('--expect-digest') ?? fail('--apply requires --expect-digest <rollback digest>');
      assertWritableTarget(facts, { handle, confirm, resource_key: resourceKey });
      const snapshot = await readConsistentSnapshot(handleResult.session, resource);
      const plan = planRealRollback(snapshot, { target_revision: targetRevision, expected_current_revision: expectedCurrent });
      if (realRollbackDigest(plan) !== plan.digest) throw new RealRefusal('REAL_PLAN_DIGEST_MISMATCH');
      if (plan.digest !== expectDigest) {
        throw new RealRefusal('REAL_PLAN_DIGEST_MISMATCH', { planned: plan.digest, expected: expectDigest });
      }
      const result = await applyRealRollback(handleResult.session, plan, snapshot, {
        target_revision: targetRevision, expected_current_revision: expectedCurrent, actor_id: actorId, at, fail_at: failAt,
      });
      const output = {
        executor_version: EXECUTOR_VERSION, mode: 'rollback', target, target_ownership: ownership,
        resource: resourceKey, rollback_plan: plan, result,
      };
      const out = flag('--out');
      if (out) writeFileSync(out, `${evidenceJson(output)}\n`, 'utf8');
      process.stdout.write(`${evidenceJson(output)}\n`);
      return;
    }

    const snapshot = await readConsistentSnapshot(handleResult.session, resource);
    const plan = planRealRollback(snapshot, { target_revision: targetRevision, expected_current_revision: expectedCurrent });
    const output = {
      executor_version: EXECUTOR_VERSION, mode: 'rollback-plan', target, target_ownership: ownership,
      resource: resourceKey,
      current_revision: snapshot.binding?.revision ?? null,
      target_revision: targetRevision,
      rollback_plan: plan,
    };
    const out = flag('--out');
    if (out) writeFileSync(out, `${evidenceJson(output)}\n`, 'utf8');
    process.stdout.write(`${evidenceJson(output)}\n`);
  } finally {
    await handleResult.close();
  }
}

main().catch((error: unknown) => {
  const refusal = error instanceof RealRefusal;
  const code = refusal ? error.code : error instanceof UsageError ? error.message : String(error);
  process.stderr.write(`${refusal ? 'REFUSED' : 'ERROR'}: ${code}\n`);
  process.exitCode = refusal ? 2 : 1;
});
