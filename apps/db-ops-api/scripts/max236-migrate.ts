#!/usr/bin/env node
/**
 * MAX-236 / P0-REAL-A migration entry point (S9), deliberately NOT registered in
 * the application, in `server.ts`, or in any package script.
 *
 * Ownership is proven BEFORE a connection is opened: `--handle` (or
 * `MAX236_REALA_HANDLE`) points at the exact creation record written by
 * `env-start.sh`, and the DSN must match that record's loopback port, database,
 * user, container ID, owner/phase labels, image, mount and network.
 *
 * Read-only by default: it prints the plan computed from ONE consistent,
 * verified read-only snapshot (a REPEATABLE READ / READ ONLY transaction). A
 * write needs `--apply` plus an exact `--expect-digest`, a `--confirm` value
 * that matches the recorded `database@container_id12:resource`, and a resource
 * that is already in the handle's write allow-list. A saved plan loaded with
 * `--plan` must match the CURRENT manifest invocation (resource, identities,
 * pins, object blockers); any difference refuses without writing.
 *
 *   MAX236_REALA_HANDLE=.max236-reala/handle.json \
 *   MAX236_REALA_DSN=mysql://root@127.0.0.1:33440/max236_reala \
 *     npx tsx scripts/max236-migrate.ts --manifest <manifest.json>
 *
 * Exit codes: 0 plan/applied/no-op, 2 refusal, 1 usage or connection failure.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import {
  applyRealMigration, assertPlanInvocation, assertWritableTarget, evidenceJson, openVerifiedSession,
  parseHandle, parseManifest, planRealMigration, readConsistentSnapshot, realPlanDigest, realResourceKey,
  EXECUTOR_VERSION, RealRefusal, type RealApplyOptions, type RealMigrationPlan,
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
  const manifestPath = flag('--manifest') ?? fail('--manifest <path> is required');
  const request = parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
  const requestKey = realResourceKey(request.resource);
  const resourceArg = flag('--resource');
  if (resourceArg !== undefined && resourceArg !== requestKey) fail(`--resource ${resourceArg} does not match manifest ${requestKey}`);

  const actorId = Number(flag('--actor-id') ?? '9001');
  if (!Number.isInteger(actorId) || actorId <= 0) fail('--actor-id must be a positive integer');
  const at = flag('--at') ?? new Date().toISOString().replace('T', ' ').replace('Z', '');
  const failAt = flag('--fail-at') as RealApplyOptions['fail_at'];

  const handleResult = await openVerifiedSession(dsn, handle);
  try {
    // The connection identity was verified above (before any state read); this is
    // the same verified fact set the write gate uses.
    const { facts } = handleResult;
    const target = {
      database: facts.database, hostname: facts.hostname, hostname12: facts.hostname.slice(0, 12), version: facts.version,
      confirm_expected: `${facts.database}@${facts.hostname.slice(0, 12)}:${requestKey}`,
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
      const expectDigest = flag('--expect-digest') ?? fail('--apply requires --expect-digest <plan digest>');
      assertWritableTarget(facts, { handle, confirm, resource_key: requestKey });
      const snapshot = await readConsistentSnapshot(handleResult.session, request.resource);
      // A recorded plan may be re-submitted; it is only accepted when its own
      // digest still verifies AND its invocation is the current manifest's, so a
      // new identity/pin/blocker can never be silently ignored.
      const planPath = flag('--plan');
      let plan: RealMigrationPlan;
      if (planPath) {
        const loaded = JSON.parse(readFileSync(planPath, 'utf8')) as { plan?: RealMigrationPlan };
        plan = loaded.plan ?? loaded as RealMigrationPlan;
        if (realPlanDigest(plan) !== plan.digest) throw new RealRefusal('REAL_PLAN_DIGEST_MISMATCH');
        assertPlanInvocation(plan, request);
      } else {
        plan = planRealMigration(snapshot, request);
      }
      if (plan.digest !== expectDigest) {
        throw new RealRefusal('REAL_PLAN_DIGEST_MISMATCH', { planned: plan.digest, expected: expectDigest });
      }
      const result = await applyRealMigration(handleResult.session, plan, snapshot, { actor_id: actorId, at, fail_at: failAt });
      const output = {
        executor_version: EXECUTOR_VERSION, mode: 'apply', target, target_ownership: ownership,
        resource: requestKey, plan, result,
      };
      const out = flag('--out');
      if (out) writeFileSync(out, `${evidenceJson(output)}\n`, 'utf8');
      process.stdout.write(`${evidenceJson(output)}\n`);
      return;
    }

    const snapshot = await readConsistentSnapshot(handleResult.session, request.resource);
    const plan = planRealMigration(snapshot, request);
    const output = { executor_version: EXECUTOR_VERSION, mode: 'plan', target, target_ownership: ownership, resource: requestKey, plan };
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
