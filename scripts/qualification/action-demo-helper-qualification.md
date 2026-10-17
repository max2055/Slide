# Q09/Q10 helper crash barriers

This is an engineering protocol for the fixed `slide-action-demo.service` helper.
It does not establish real VM qualification or authorize a product action. The
parent must independently review the exact new head/helper hash before target
use, coordinate the target write lock, and retain real two-person once approval
for each immutable plan. The old registration and approvals cannot authorize a
changed helper hash. Do not reinstall the original environment: compare retained
quarantine files/hashes and create a new baseline during authorized restoration.

The helper still accepts only `inspect`, `execute` and `receipt`. No caller flag,
SSH environment, arbitrary command/unit/path, release command, or new sudo grant
is added. With no control file, normal execution is unchanged. `inspect` and
`receipt` do not parse the control; duplicate execute only reads its saved receipt.

An environment administrator can arm the fixed file
`/var/lib/slide-action-demo/.qualification-control`, root-owned, regular, single
link, mode 0600, under the existing root-owned non-writable ancestor chain. The
file must be <=4096 bytes. Example structure (replace every placeholder with the
actual server-frozen approved binding; this example is deliberately invalid):

```json
{
  "protocol": 1,
  "point": "after_intent",
  "operationId": "<actual-operation-UUID>",
  "planHash": "<actual-plan-SHA256>",
  "configHash": "<actual-registration-SHA256>",
  "helperHash": "<actual-reviewed-helper-SHA256>",
  "nonce": "<fresh-32-lowercase-hex>"
}
```

Only two points exist:

| point | Durable state before marker | Expected restart delta |
| --- | --- | --- |
| `after_intent` (Q09) | unknown intent and directory fsync complete; restart not called | 0 |
| `before_receipt` (Q10) | restart returned; new InvocationID and active health checked; completed receipt not persisted | 1 |

The helper retains its operation lock and fsyncs a root-only marker at
`/var/lib/slide-action-demo/.qualification-<operationId>.reached`. It includes
the complete armed binding, nonce, PID and reachedAtNs. Before terminating the
exact helper PID, the authorized controller must compare marker nonce/binding,
verify PID -> `/proc` start identity/command -> reviewed helper, and record raw
UTC plus monotonic ordering. Never kill by executable name or port. A marker is
fault-test evidence, not a trusted completed action receipt or approval.

The barrier has no release/resume path. It waits at most 10 monotonic seconds,
then fails closed: Q09 refuses before restart, Q10 returns the original unknown.
If the controller vanishes, there is no delayed restart or completed receipt.
Invalid controls refuse a NEW execute before persisting an intent or restarting.
Other operations are already blocked by any persisted unresolved intent. Remove
only the armed control after the case; keep intent, marker, count and audit.
Never delete/overwrite an unknown, refund its once approval, reset the count, or
use another operation to continue testing. Each real unknown requires a parent
handoff and retained recovery checkpoint; these cases cannot be run back-to-back
on the same unresolved target. New binding/hash/plan/approval is required for a
new case after an explicitly reviewed recovery decision.

Local regression fixture `action-demo-helper-fixture.py` replaces only paths,
root identity and systemctl with isolated temporary data and a persistent local
counter. It actually runs/kills child processes and uses production fsync/flock/
control/barrier code. It tests default-off, malformed/binding/permission/link
rejection, bounded timeout, fresh-process receipt/replay and unknown blockade.
The MySQL tests use production schema/executor/approval transactions and couple
the same crash result to consumed once approval, retained global/resource locks,
no worker resend and read-only unknown reconciliation. Test actors and local
counters do not count as real human approvals, real systemd actions or Q09/Q10
VM acceptance.

Run from the repository root with the declared pnpm version and an isolated
MySQL port (never the managed target database):

```sh
OPERATIONS_TEST_MYSQL_PORT=<isolated-port> pnpm --filter slide-api exec vitest run \
  src/operations/actions/execution.mysql.test.ts \
  src/operations/actions/adapters/restart-demo-service.test.ts
```
