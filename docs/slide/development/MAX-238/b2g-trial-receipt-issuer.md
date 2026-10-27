# MAX-238 B2G — offline v2 trial-receipt issuer & writer

- Base: `d968892b6cea1972d6d1958749a8af6cab5d3301` (accepted B2F head)
- Implementation + focused tests: `a34bff685`
- Delivery HEAD: this docs commit on top of `a34bff685`
- Scope: internal, unmounted compile + candidate-table insert only. No route,
  runtime, default pool, DDL execution, real DB, model, resource, CI or
  deployment action. MAX238 and MAX235 remain `in_progress`; production
  enablement and all real trial I/O stay held.

## Files

| Path | Role |
|---|---|
| `apps/db-ops-api/src/metrics/bindings/trial-receipt-issuer.ts` | compiles the private v2 receipt from a raw candidate + injected trusted inputs |
| `apps/db-ops-api/src/metrics/bindings/trial-receipt-writer.ts` | inserts only `receipt_id` + `payload` through the policy pool/admission gate |
| `apps/db-ops-api/src/metrics/bindings/trial-receipt-issuer.test.ts` | fixture proof of the above |
| `docs/slide/development/MAX-238/b2g-trial-receipt-issuer.md` | this record |

No existing file was modified. All 22 read-only files listed in
`b2g-file-ownership.json` still match both their recorded git blob and SHA-256
(`22/22`, `0` mismatch), and the diff `d968892b6..a34bff685` is exactly these
three new source files (1044 insertions).

## 1. Compiler — one protocol, three exported identities

`issueTrialReceipt(request, options)` builds exactly the object the accepted B2E
host reads back:

```
SELECT payload FROM metric_policy_trial_receipts WHERE receipt_id = ? LIMIT 2
```

- Request (strict): `{ resource, candidate, receipt_id }`. A receipt body,
  `items`, `issued_at`/`expires_at`, `candidate_digest`, `resolution_identity`
  or `dependency_digest` in the request is `TRIAL_RECEIPT_INPUT_INVALID`.
- B1/B2A run through `compileBindingCandidate`; a legacy single-package binding
  is `TRIAL_RECEIPT_TEMPLATE_REQUIRED`, and a candidate for another resource is
  `TRIAL_BINDING_IDENTITY`.
- B2C re-runs from the same raw candidate with the injected trusted context;
  the receipt's `resolution_identity` is the exported
  `templateResolutionIdentity(resolution)` and nothing else.
- `candidate_digest` is the exported
  `bindingCandidateDigest(compiled, base + 1, dependencyDigest)`
  (`BINDING_CANDIDATE_DIGEST_FORMAT = 'max238.binding-candidate.v1'`).
- `target_revision` is always `binding.revision + 1`; the request cannot choose
  it. `dependency_digest` comes only from the injected trusted input
  (`TRIAL_TRUSTED_INPUT_INVALID` when absent/malformed).
- `issued_at` is the synchronous trusted clock; `expires_at` is that instant
  plus the injected `ttlMs`. A missing/throwing/promise clock is
  `TRIAL_TIME_UNAVAILABLE` — never `Date.now()`.

The emitted payload has exactly the private v2 fields: `receipt_version`,
`receipt_id`, `resource`, `base_revision`, `target_revision`,
`candidate_digest`, `resolution_identity`, `dependency_digest`, `issued_at`,
`expires_at`, `items[]` (`template_id`/`item_id`/`item_version` +
`phases.read/transform/unit`) and `optional_exclusions[]`. No schema is copied:
the only acceptance proof is the real guard read (below).

## 2. Per-item evidence — reject before the insert

Evidence comes from the injected offline port (`read(resource)` →
one entry per selected item: identity, `status`, `optional`, `phases`).

Zero-write rejections:

| Input | Code |
|---|---|
| one qualified item standing in for other selected items | `TRIAL_EVIDENCE_INCOMPLETE` |
| selected mandatory item with partial phases | `TRIAL_ITEM_UNQUALIFIED` |
| evidence already `withdrawn` / `failed` | `TRIAL_EVIDENCE_WITHDRAWN` |
| evidence for a foreign item, duplicate entry, malformed/non-array body | `TRIAL_EVIDENCE_INVALID` |
| port missing, throwing, or not a function | `TRIAL_EVIDENCE_UNAVAILABLE` |

A partial-phase item is accepted only when the evidence marks it explicitly
non-mandatory, and then it is recorded in `optional_exclusions` — the same
rule the B2D guard enforces against the trusted mandatory list.

## 3. Writer — one connection, one statement, no policy lock

`writeTrialReceipt({ receipt_id, payload }, { pool })`:

- Uses the **same** pool provider and the exported `withPolicyAdmission` as
  `MysqlPolicyStore.transaction`; the fixture proves concurrent writes serialize
  (`maxActive === 1`) because the admission queue is keyed by the pool.
- Takes exactly one connection (`connections + 1` asserted). It starts no
  transaction, takes no `metric_policy_lock`, and calls no `host.apply`,
  `templateGateway`, `config.activate` or any 237 repository. Receipt commit and
  the later enable remain two separate transactions.
- SQL touches only the two columns the host reads:
  `INSERT INTO metric_policy_trial_receipts (receipt_id, payload) VALUES (?, ?)`.
  No DDL, no extra status/revoke column.
- Missing/absent provider: `TRIAL_RECEIPT_WRITER_UNAVAILABLE` before any
  connection attempt.
- Input must be exactly `{ receipt_id, payload }`; a mismatched
  `payload.receipt_id`, a non-object payload, extra keys or a payload whose
  stored JSON would read back differently is `TRIAL_RECEIPT_WRITE_INVALID`.

Uniqueness is the candidate `PRIMARY KEY (receipt_id)`, not a read-then-write
gap: the insert is attempted first, and a duplicate then reads the row once on
the same connection via the host's own `receiptRead` statement.

| Stored state for this id | Result | Extra writes |
|---|---|---|
| no row | `inserted` | one row |
| one row, byte-identical payload | `replay` | none |
| one row, different payload | `collision` | none |
| two rows, or the read fails | `TRIAL_RECEIPT_STORE_UNAVAILABLE` | none |

The fixture models this uniqueness; it is **not** a real MySQL unique index,
collation or lock-wait proof.

## 4. Proof (fixture, not real MySQL/CAS/permissions/trial)

The focused test issues a receipt, writes it, and reads it back through the
**exported** guard: `prepareTemplateBindingMutationV2` returns
`kind: 'prepared'`, `protocol: 'max238.template-binding.v2'`,
`receipt_version: 2`, `target_revision: 5`, `operation.status: 'pending'` — after
its receipt read executes the exact B2E host SELECT. The v1 entry
`prepareTemplateBindingMutation` rejects the same v2 row as
`TRANSACTION_RECEIPT_INVALID` (strict discrimination, no silent upgrade).

Also asserted:

- the stored payload deep-equals the issued payload, and
  `candidate_digest`/`resolution_identity` equal a fresh recomputation through
  the exported functions;
- a trusted dependency change at enable time yields
  `TRANSACTION_RECEIPT_MISMATCH` with no row change;
- replay/collision/two-row/failed-read leave the write count unchanged, and the
  writer log contains no `metric_policy_lock` / `BEGIN`;
- an explicit optional exclusion is accepted by the guard when the trusted
  mandatory list agrees, and every rejection above leaves zero rows.

| Command (from `apps/db-ops-api`) | Result |
|---|---|
| `npx vitest run src/metrics/bindings/trial-receipt-issuer.test.ts` | exit 0 — 1 file, 13 tests passed |
| `npx tsc --noEmit` | exit 0 |
| `npx oxlint` on the three new files (repo root) | exit 0 — 0 warnings, 0 errors |

Unchanged bindings/policy/scheduler files reuse the B2F `FINAL_EXIT=0` and
existing module evidence; no full-suite, CI, model, real DB or resource run was
performed for this package.

## 5. Known gaps / still held

- The receipt row is a fixture of the candidate schema
  (`metric_policy_trial_receipts(receipt_id, payload)`); the two-table DDL has
  not been executed and real UNIQUE/collation/lock-wait behavior is unproven.
- No real trial I/O: evidence is injected, not a live read/transform/unit run.
- Revocation is not represented: `verifyReceiptTime` has no revoke field and no
  revoke column is added (`receipt_revocation_host_check`, held).
- Nothing is mounted: no route, scheduler, rollout, default store pool or
  production enablement. `exportApplied`/promotion cannot be reached from here.

| wait_kind | next_action | input_owner | minimum_resume_fact |
|---|---|---|---|
| receipt_real_io | this package is offline compile + fixture insert only; real trial needs separate authorization | MAX238; resource/permission owner | per-item source, resource/credential reference, read scope and valid authorization |
| receipt_revocation_host_check | keep the host read-only for revocation; no fake column | Chief; MAX238 | a separately admitted host-side revocation check |
| isolated_db_ddl | do not run the two-table DDL | DB owner | schema version, backup window, real write authorization |
| template_read_port | do not call the 237 independent pool repository | MAX237 | same-connection template read port |
| s5_and_public_api | do not touch status/formal-store or add a public trial route | MAX240; Chief | separate reader and public-contract admission |
| production_enable | do not enable by default or promote applied | release owner | code, rehearsal, deployment and production-write authorization |
