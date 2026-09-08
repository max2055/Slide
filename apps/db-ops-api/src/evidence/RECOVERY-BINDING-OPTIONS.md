# Recovery binding assessment

Update: prospective opt-in binding is now implemented using CREATED event metadata. The original assessment below records the decision; no existing operation receives a retrospective binding. Policy configuration is available through the recovery-policy endpoint documented in INTEGRATION-CONTRACT.md.

Pre-implementation assessment (historical): operations persisted actor/resource/state/times, but no trusted metric recovery plan. A succeeded state is execution completion, not recovery. Existing unbound operations must stay unknown.

Smallest prospective binding: at operation creation, inside its existing database transaction, read the configured resource invariant set and snapshot a bounded recovery plan into the CREATED event metadata. Snapshot rule-set version, full selected thresholds and dimensions, collector source identity, verifier version, recovery window and sample-gap policy, resource and actor, and a canonical digest. Selection and timing policy must be server-defined for supported command types. The request must not supply a recovery plan or claim completion. Reused idempotency keys retain the original event/plan.

After execution, verification loads the existing actor-owned operation and its immutable CREATED snapshot, anchors the observation window to persisted finishedAt, and reads owner/resource/metric/source/dimension matched observations covering that window. State succeeded remains distinct from recovered. Missing snapshots, observations, expired intervals, unsupported commands, and incomplete windows remain unknown. Old operations are not backfilled from today's rule configuration.

Alternative: add an immutable operation_recovery_plans table with an operation foreign key and insert it in the create transaction. This needs a migration but gives a clearer unique plan boundary and database-level constraints. A JSON column on operations is another option, but needs careful update exclusion to keep snapshots immutable.

Implemented choice: a separate explicit recovery policy (not an automatically selected invariant set) is captured in CREATED metadata. The full observation window starts with its first post-finish sample, with a bounded initial allowance; unobserved time is not counted. See INTEGRATION-CONTRACT.md for the current contract. No new operational commands or permission grants were introduced.
