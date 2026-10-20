# P07 controlled functional acceptance

Current delivery rule: `functional-delivery-1`. The Q identifiers below retain
the historical matrix's scenario meanings. Passing these controlled functional
checks does not rewrite historical VM/production qualification results. Long
observation and production qualification are not development completion gates.

Run from the repository root with its declared pnpm version, using a dedicated
disposable MySQL 8.4 instance bound to loopback (never shared ports 3306/3308):

```sh
OPERATIONS_TEST_MYSQL_PORT=<isolated-port> pnpm --filter slide-api exec vitest run \
  src/operations/actions/execution.mysql.test.ts \
  src/operations/actions/adapters/restart-demo-service.test.ts \
  src/operations/actions/plan-service.mysql.test.ts
```

`execution.mysql.test.ts` creates and drops only its randomly named test database.
Its new `controlled HTTP/SQL/SSH/helper chain` cases use two synthetic SQL users,
server-frozen plans and separate proposer/reviewer identities. They call the
production HTTP routes over an actual loopback socket with signed test JWTs,
the SQL enqueue/once/intent/outbox/job transaction, workflow handler, executor,
signed target registration, production SSH adapter and fixed helper protocol.
The SSH server validates the generated client key and its signature; the adapter
checks the pinned server key. Only socket routing redirects the fixed target to
loopback. Test signing and login keys are ephemeral and never installed remotely.

The Python fixture executes the source helper in child processes, retaining its
actual fsync, disk receipt, flock and crash barriers. Root identity, fixed paths,
configuration/file identity and systemctl are substituted locally. The observable
side effect is a persistent counter, **not** a systemd restart. Each scenario
owns a temporary directory; crashes kill only its exact child, preserve unknown
bytes through fresh-process duplicate/receipt tests, and block new operations.
Only fixture teardown deletes that synthetic state. No retained field allocation,
unknown record, shared SQL database or production target is accessed.

The `retained-scenario` fixture mode retains that scenario's directory for the
SSH server's later read-only receipt call. It is a local harness entry point,
not a new helper command or production recovery API. The production helper's
hash, accepted commands and root-only configuration remain unchanged.

Abbreviations: E = `execution.mysql.test.ts`, A =
`adapters/restart-demo-service.test.ts`, P = `plan-service.mysql.test.ts`, all
under `apps/db-ops-api/src/operations/actions/`. Test name fragments below are
searchable in those files and in the JSON test reports.

| Case | Functional assertion | Executable evidence |
| --- | --- | --- |
| Q01 | Signed fixed target, host key, config/helper/unit binding; no arbitrary shell/path/target | A: signed registration negatives, fixed read-only preflight, real loopback SSH handshake; historical VM read-only evidence remains historical |
| Q02 | One explicit execution, one consumed once, one helper side effect and bound receipt | E: `controlled ... success`; actual HTTP/SQL/SSH/helper, count 1; effect verification/observation belongs to P08 |
| Q03 | Duplicate HTTP/SQL requests converge; changed payload conflicts | E: `consumes once + unique execution`, real JWT/HTTP explicit POST, controlled success duplicate POST after completion; count remains 1 |
| Q04 | Competing workers and repeated job delivery send once; stale fence cannot send | E: `one global/resource lock`, `queue payload`, `paused stale worker`, every controlled chain case invokes concurrent/repeated workflow delivery |
| Q05 | Expired prechecking lease may be reclaimed; old worker cannot send | E: `expired prechecking fence`, `paused stale worker`; durable SQL lease/replacement simulation, count 1, not an OS worker SIGKILL claim |
| Q06 | Committed dispatch with uncertain send remains unknown; no refund/replay | E: `recovers crashed dispatch boundary`, `R1 lost dispatch commit acknowledgement`; durable SQL boundary/ack fault injection, sends 0 |
| Q07 | Lost SSH reply after helper completion: unknown then original read-only receipt restores success | E: `controlled ... lost SSH reply`; helper count 1 and no second execute |
| Q08 | Failed completion persistence preserves unknown; fresh executor reconciles without send | E: `controlled ... lost SQL completion`; helper count 1; existing `lost completion persistence` also verifies fresh store |
| Q09 | Actual helper SIGKILL after durable intent, before restart; intent unchanged and no replay | E: `controlled ... after_intent` plus A/Python barrier cases; counter 0, SQL once 1, both locks retained, fresh receipt remains unknown |
| Q10 | Actual helper SIGKILL after restart, before completed receipt; no inferred success or replay | E: `controlled ... before_receipt` plus A/Python barrier cases; counter 1, SQL once 1, both locks retained, fresh receipt remains unknown |
| Q11 | Queued/preflight cancellation prevents sending | E: `cancel queued`, `cancel preflight`, `controlled ... cancel before`; counter 0 and cancelled |
| Q12 | Post-boundary cancellation records request and actual completion | E: `controlled ... cancel after`; cancelRequestedAt retained, succeeded, counter 1 |
| Q13 | Proposer/reviewer/executor revocation, stale evidence and disabled dispatch fail before send | E: `rechecks ... after preflight`, `controlled ... revoke before`; P: proposer/reviewer permission invalidation; counter 0 |
| Q14 | Post-boundary revocation preserves actual outcome and blocks revoked reads | E: `controlled ... revoke after`; counter 1, succeeded and subsequent HTTP 401 |
| Q15 | Global/resource lock covers queued/unknown; different server cannot bypass; disabled dispatch preserves unknown | E: `unknown global lock blocks ... different server` (second once unused), `sweeps expired dispatches`, `rechecks flag`; controlled unknown cases retain both locks |
| Q16 | Generic/Chat authority, injected queue actor/token, mutable/expired/self approvals or replaced bindings fail closed | E: `generic authorization`, `queue payload`; A: plain JSON/Chat capability and registration/plan negatives; P: self/service reviewer, immutable revisions, stale grants, legacy single/batch and scope negatives |
| Q17 | Only original operation/plan/config/helper/unit receipt is accepted; null/forged receipts retain unknown | E: `lost remote reply` (null and wrong operation), controlled reply-loss reconciliation; A: per-field untrusted receipt and unchanged invocation negatives; unauthorized receipt read count 0 |
| Q18 | Stop admission while retaining durable executions/intent/once/locks/audit; no automatic replay or compensation | E: `sweeps expired dispatches ... disabled dispatch`, `lost remote reply`, controlled unknown cases reconcile with dispatch disabled; source helper rollback remains none |

These are P07 executor/adapter acceptance boundaries. Public migration/server
assembly remains P10's ownership; effect verification and observation remain
P08's. Downstream development consumes an independently reviewed, CI-passing
exact candidate/interface baseline; it need not wait for production deployment,
the entire P10 merge, or human `done` status. New production target actions still
require their actual authorization and approval controls.
