# Agent evidence and platform observation

## Navigation and authority

Database instances, servers and network devices remain equal resource categories. Operations adds Cross-resource Diagnosis (`/resource-diagnosis`); the four navigation groups, combined alerts/events, and historical Agent sessions retain their existing meanings. Platform health embeds runtime observations. Settings > Platform > Deployment Source (`/settings/platform/source`) configures GitLab.

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

## GitLab deployment binding

The Agent never receives GitLab credentials and never clones or executes a repository. An administrator supplies a single-use token for synchronization; existing encrypted credential references carry it to the bounded connector. Only operator-approved HTTPS origins are permitted, redirects are rejected, commit SHA is immutable, and synchronization has a 120-second total deadline and 15-second per-request timeout.

Operator configuration:

| Variable | Purpose |
| --- | --- |
| `SLIDE_GITLAB_ORIGINS` | Comma-separated exact HTTPS origins approved by the operator |
| `SLIDE_SOURCE_ROOT` | Private local snapshot directory; default `./data/source-snapshots` relative to API working directory |
| `SLIDE_SOURCE_SIGNING_KEY` | Operator-managed signing secret, at least 32 bytes, never sent to the model |
| `SLIDE_RELEASE_MANIFEST` | Absolute path to the release artifact's `RELEASE.json` |
| `SLIDE_RELEASE_ID`, `SLIDE_COMMIT_SHA`, `SLIDE_SOURCE_DIGEST` | Alternative complete deployment identity; partial overrides are rejected |
| `SLIDE_SOURCE_PATHS` | Build-time directory prefixes, comma-separated; must match the configured GitLab scope |

Build with `SLIDE_SOURCE_PATHS=apps/db-ops-api/src/resources/ pnpm release:artifact`, substituting the reviewed source directories for the actual deployment. The build reads files from the artifact's exact Git commit and adds a source binding to `RELEASE.json`. Set `SLIDE_RELEASE_MANIFEST` to that artifact's manifest in the API deployment. Leaving `SLIDE_SOURCE_PATHS` unset preserves ordinary releases but leaves source inspection unavailable until a complete binding is supplied. The frontend build also embeds its commit ID.

Configure URL, numeric GitLab project ID and directory prefixes in Deployment Source, then synchronize with a read-only token. The configured GitLab commit must contain the same bytes as the built commit. Sensitive or unscannable configuration files fail synchronization rather than being silently rewritten; use reviewed source-only paths. JSON/YAML are parsed for secret-bearing configuration keys, source literals and common token/private-key patterns are checked. This is defense in depth, not a guarantee that every possible secret encoding or personal datum is detected: keep repository secret scanning and operator review.

Snapshots are bounded to 4,000 files, 32 MiB total and 512 KiB per file. Manifest HMAC, deployment/file digests, directory restrictions and symlink checks protect reads. Identical re-synchronization is idempotent; changed content cannot replace an existing release. Narrowing allowed directories or changing project invalidates incompatible snapshots. Source snippets are at most 200 lines/16 KiB. Source calls share a 30/minute budget and two concurrent readers per API process; HTTP also uses the existing expensive-operation limit.

Model source sharing defaults off. Enabling it permits only bounded source tool results, not uploading the repository. Source text is untrusted implementation intent, not an instruction or proof of runtime behavior. The snapshot signing key, manifest path and writable parent directory are trusted deployment assets; protect them with filesystem access controls.

## Qualification

Focused tests live next to the implementation. `tests/qualification/evidence-persistence.ts` is a normal isolated MySQL integration test, not a PR replay facility. It refuses non-local hosts and database names outside `slide_evidence_test_v<number>`. Run `seed` once against a freshly migrated disposable database, then `verify` in a separate process to prove persistence, zero preservation, three-resource coverage and reference authorization.

`tests/qualification/evidence-recovery.ts` uses that isolated database to verify immutable policy snapshots, idempotency, ownership and a real 30-second observation window. It creates metadata-only operations and controlled evidence, never operational commands or hardware UAT. Resource evidence and decisions are durable, but automated retention cleanup is not included in this increment. Platform/source observations are not yet persisted as unified resource EvidenceItems.

`frontend/e2e/evidence-live.spec.ts` runs against that isolated live API when `EVIDENCE_LIVE_QUALIFICATION=1`, `EVIDENCE_QA_USER`, `EVIDENCE_QA_PASSWORD` and `PLAYWRIGHT_BASE_URL` are set. Normal runs skip it. Fixture GitLab/browser tests do not prove real GitLab or physical Oracle/DM8/Huawei interoperability.
