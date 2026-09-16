# Agent evidence and platform observation

## Navigation and authority

Database instances, servers and network devices remain equal resource categories. Operations adds Cross-resource Diagnosis (`/resource-diagnosis`); the four navigation groups, combined alerts/events, and historical Agent sessions retain their existing meanings. Platform health embeds runtime observations. Settings > Platform > Source Repository (`/settings/platform/source`) configures GitLab or GitHub.

Resource evidence and decisions are owned by the authenticated user and require current resource permission on every read. Resource-specific invariant and recovery policies require administrator permission. Platform logs and source inspection require `config:view`; source configuration and synchronization require administrator permission. Existing operational permissions, SQL classification and approvals are unchanged. No new operational commands, automatic remediation, historical PR replay, or automatic policy learning are introduced.

## Evidence and evaluation

`GET /api/resources/:type/:id/evidence` collects actual available observations and persists bounded evidence. An explicit `from`/`to` window queries durable history only. Types are `instance`, `server`, and `network_device`. Maximum window is seven days and maximum bundle size is 100. Each item has a canonical digest, original validity, resource, source, quality and provenance. Reading the same observation again does not manufacture a new fact. A query correlation is not a causal trace.

`GET /api/resources/:type/:id/evaluation` evaluates configured numeric invariants and a conservative statistical baseline. Baselines compare the same resource, metric, dimensions and source, use a 24-hour window and at least 20 distinct older timestamps, and report insufficient/truncated history explicitly. Bounds are 32 identities, 2,000 raw rows per identity and 40 distinct samples. A deviation is not a business invariant violation or proof of causation.

`GET/PUT /api/resources/:type/:id/invariants` manages a versioned rule set using `expectedVersion` optimistic concurrency. The diagnostic workspace provides the corresponding form. No rules are automatically invented for a deployment.

`POST /api/resources/:type/:id/decisions` records an inference or hypothesis with existing same-user, same-resource evidence IDs and a declared time window. `GET /decisions` lists bounded history. Client assertions cannot be saved as facts; inaccessible or missing references are reported as gaps. These records are reusable diagnostic history, not automatically approved repair knowledge. Existing historical AnalysisEnvelope JSON-pointer references remain legacy diagnostic context; they are not promoted to verified Evidence IDs.

## Recovery verification

`GET/PUT /api/resources/:type/:id/recovery-policy` manages an opt-in, administrator-owned policy with optimistic concurrency. It selects command types, a metric/source/dimension identity, numerical bounds, a 30-3,600 second window and maximum sample gap. Default is disabled. Newly created matching operations snapshot the full policy and digest in their CREATED event within the existing transaction. Later edits and idempotent request reuse cannot change that snapshot; old operations are not backfilled.

`GET /api/resources/:type/:id/recovery/:operationId` reads the actor-owned operation and independent persisted observations. The full window starts at the first observation after the persisted operation finish time; that observation must arrive within the configured maximum sample gap. At least three distinct timestamps, valid interval coverage and bounded sample gaps are required throughout. The query is bounded to the policy window plus its initial sample allowance (at most two hours, 2,000 rows). Missing, truncated or incomplete evidence stays unknown. Execution success and observed recovery remain different states. The diagnostic page manages policies and provides read-only operation-ID verification; neither action executes a command.

## Platform runtime logs

The structured adapter records actual API responses, Agent run outcomes, WS lifecycle, collection outcomes, queue outcomes and authenticated coarse frontend events. It never stores freeform request bodies, SQL, job payloads, browser error messages, source text or credentials. Frontend events are always marked client-reported/unverified. Audit storage remains separate and records source/configuration access outcomes.

The runtime ring is process-local: at most 10,000 entries, one hour of queryable retention, 100 aggregate groups, and ten example correlation IDs per group. Restart gaps, overflow, missing data, stale data and unknown outcomes are explicit. This is not a durable central log archive or distributed tracing system. A crashed API cannot attest to its own health: retain an independent process/uptime monitor. Uninstrumented dependencies remain unknown, never implicitly healthy.

## Repository source synchronization

Settings > Platform > Source Repository (`/settings/platform/source`) supports GitLab and GitHub repository paths (for example `group/subgroup/project`, not numeric project IDs). Configure a branch, tag or full Commit SHA; leaving ref blank fetches remote HEAD. The connector records the actual fetched commit and checks out that exact commit. Full SHA fetching remains dependent on the server allowing that object; using a branch/tag avoids that requirement.

The Agent never receives Git credentials or executes repository code. An administrator supplies a token for a single sync request; it is cleared from the form and never stored in configuration, snapshots or Git argv. Credentials use a command-scoped Git HTTP header. Ambient Git config, credential helpers and proxy variables are ignored; only the task's configured HTTP/HTTPS proxy (or fallback ALL proxy) is used. Redirects are rejected: configure the canonical repository origin.

### Minimal operator configuration

| Variable | Purpose |
| --- | --- |
| `SLIDE_GITLAB_ORIGINS` | Comma-separated exact origins, including scheme and port; e.g. `http://gitlab.internal:8080` |
| `SLIDE_GITHUB_ORIGINS` | Additional approved origins; defaults to `https://github.com` |
| `SLIDE_SOURCE_SIGNING_KEY` | Stable operator-managed secret of at least 32 bytes; never sent to the model |
| `SLIDE_SOURCE_ROOT` | Private writable directory for signed snapshots and temporary Git checkouts. Default outside Compose: `./data/source-snapshots` |
| `SLIDE_RELEASE_MANIFEST` | Optional path to a mounted release `RELEASE.json` for deployment comparison |
| `SLIDE_RELEASE_ID`, `SLIDE_COMMIT_SHA`, `SLIDE_SOURCE_DIGEST` | Optional complete deployment identity instead of a manifest |
| `SLIDE_SOURCE_PATHS` | Optional build-time prefixes for generating the comparison digest |

Production Compose passes origins and signing key into the API and stores snapshots/checkouts under `/var/lib/slide-agent/source-snapshots` on the existing private agent-state volume. The API image installs Git and CA certificates. The signing key is required only when using source functionality; enabling it does not require rebuilding with deployment metadata. Keep the same key across restarts; changing it invalidates existing signatures and requires resynchronization. For HTTP, the explicitly approved internal network carries the token and repository bytes without transport encryption; there is no additional UI override.

### Status instead of deployment gates

Sync and reads work without a release manifest. Missing/malformed deployment information or differing commit/tree digest produces `verification.status=repository-unbound` with a reason. A complete snapshot with matching commit and tree digest produces `deployment-verified`. A different commit remains unbound even if the file bytes match. These statuses never block otherwise valid repository synchronization or reads. Neither `SLIDE_SOURCE_ALLOW_DRIFT` nor `SLIDE_SOURCE_ALLOW_UNSAFE` is needed or consulted in this flow.

Each snapshot has its own immutable `source-...` ID, independent of deployment release ID. Identical synchronization is idempotent; a new branch head creates a new snapshot. Active selection is keyed by origin, provider, repository path, ref and directory scope. Changing those settings requires sync for that selection; it cannot silently serve the previous repository's files. Existing deployment-only snapshots lack origin/ref identity and require one resync after upgrade; old files are not deleted. Operators should monitor persistent volume usage and retain/remove obsolete snapshots according to their needs; automatic retention is not included.

Sensitive, unscannable, oversized, unsupported files and symlinks are skipped. Other safe files remain available, with `completeness=partial` and signed `skippedFiles` paths/reasons in the manifest and UI. Excluded directories are reported once for the directory, not recursively enumerated. If no safe files remain, synchronization fails. Files outside configured directory prefixes are out of scope, not omissions. JSON/YAML configuration keys, source literals and common token/private-key patterns are checked. Scanning is defense in depth, not a guarantee against every secret encoding; maintain repository secret scanning and review.

Selected scanning is bounded to 20,000 entries (including directories), 32 MiB of accepted content and 512 KiB per file; the signed manifest is at most 2 MiB. Git commands and scanning share a 120-second deadline capped by credential expiry. The checkout is temporary and removed on success or failure. These limits bound snapshot processing, not the size of the downloaded Git pack/checkout: keep adequate free space in the persistent volume.

Manifest HMAC, internal tree digest, per-file digests, path restrictions and symlink checks remain mandatory. Deployment comparison is separate from integrity verification. Repository metadata, completeness and omissions are signed on disk; the response's `verification` field is computed from current deployment configuration and is not part of that signature. Source snippets are at most 200 lines/16 KiB; source calls share a 30/minute budget and two concurrent readers per API process.

Model sharing defaults off. Enabling it permits bounded source tool results, not repository upload. Search, symbol and region results carry snapshot identity, completeness and deployment status. Source text is untrusted implementation intent, never an instruction or proof of actual runtime behavior. Protect the signing key and snapshot directory using filesystem permissions. Existing administrator/read permissions remain unchanged.

## Qualification

Focused tests live next to the implementation. `tests/qualification/evidence-persistence.ts` is a normal isolated MySQL integration test, not a PR replay facility. It refuses non-local hosts and database names outside `slide_evidence_test_v<number>`. Run `seed` once against a freshly migrated disposable database, then `verify` in a separate process to prove persistence, zero preservation, three-resource coverage and reference authorization.

`tests/qualification/evidence-recovery.ts` uses that isolated database to verify immutable policy snapshots, idempotency, ownership and a real 30-second observation window. It creates metadata-only operations and controlled evidence, never operational commands or hardware UAT. Resource evidence and decisions are durable, but automated retention cleanup is not included in this increment. Platform/source observations are not yet persisted as unified resource EvidenceItems.

`frontend/e2e/evidence-live.spec.ts` runs against that isolated live API when `EVIDENCE_LIVE_QUALIFICATION=1`, `EVIDENCE_QA_USER`, `EVIDENCE_QA_PASSWORD` and `PLAYWRIGHT_BASE_URL` are set. Normal runs skip it. Fixture GitLab/browser tests do not prove real GitLab or physical Oracle/DM8/Huawei interoperability.
