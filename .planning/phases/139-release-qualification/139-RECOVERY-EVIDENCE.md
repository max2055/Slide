# Phase 139 Recovery Evidence

> Current evidence: the runs below were repeated against the 45-migration
> release candidate on 2026-07-19. The qualification script reuses the
> operator-provided `mysql` container and creates only uniquely prefixed,
> disposable databases inside it. Its cleanup guard refuses to drop any other
> database.

## Bootstrap Upgrade

- Date: 2026-07-19
- Command: `bash scripts/qualification/run-existing-mysql.sh bootstrap-upgrade`
- Environment: existing Docker `mysql` container (`mysql:latest`, MySQL 9.6), random `slide_qualification_existing_*` database on the existing loopback port.
- Result: PASS

The command created an empty database, applied all 45 migration files, ran the initializer a second time, and verified the migration ledger and schema invariants. The assertion reported:

```
bootstrap invariant valid: 45 migrations, schema invariant valid
qualification bootstrap-upgrade passed against existing container
```

The temporary database was removed by the script's exit trap. The existing `mysql` container was not modified or replaced.

## Remaining Qualification

- Migration interruption is not independently simulated; repeated initialization validates the migration ledger's completed-state recovery path.
- This document is not a GO decision.

## Worker Failover

- Date: 2026-07-19
- Command: `bash scripts/qualification/run-existing-mysql.sh failover`
- Environment: existing Docker `mysql` container and an isolated temporary database.
- Result: PASS

The scenario verified both singleton-worker and workflow fencing behavior against MySQL:

1. The first `WorkerLease` acquired the lease; the second was denied until expiry.
2. After expiry, the second lease owner acquired and renewed it; the first owner could no longer renew.
3. A worker claimed a durable `workflow_jobs` row and then expired.
4. A second worker reclaimed the expired `running` job with a higher fencing token.
5. Completion by the old token was rejected; completion by the new token succeeded.

During this qualification, the claim query was corrected to include expired `running` jobs. Previously it only considered `queued` and `retry`, leaving jobs stranded after a worker crash. The final assertion reported:

```
failover invariant valid: lease takeover and workflow fencing enforced
qualification failover passed
```

## Backup Restore

- Date: 2026-07-19
- Command: `bash scripts/qualification/run-existing-mysql.sh backup-restore`
- Environment: existing Docker `mysql` container with isolated source and restored databases.
- Result: PASS

The source database was initialized by the migration runner and seeded with a controlled user, database instance, resolved event, operation, and workflow job. The scenario used a consistent `mysqldump --single-transaction --set-gtid-purged=OFF`, restored the dump into a distinct database, then verified schema invariants, all 45 migration ledger rows, and each controlled business row. The GTID flag is required when restoring within the operator's existing MySQL 9.6 instance. The final assertion reported:

```
backup restore invariant valid: schema, ledger, user, instance, event, operation, workflow
qualification backup-restore passed
```

## Concurrent Workflow Stability

- Date: 2026-07-19
- Command: `bash scripts/qualification/run-existing-mysql.sh stability`
- Result: PASS

Twenty concurrent enqueue requests used the same idempotency key. MySQL retained one `workflow_jobs` row, which a single worker claimed and completed. This verifies the durable deduplication predicate used by notification and report workflow scheduling:

```
stability invariant valid: concurrent idempotent enqueue produced one completed job
qualification stability passed
```
