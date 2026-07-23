# Phase 140 Security Review

Review date: 2026-07-24

## Verdict

No blocking correctness or security finding remains in the Phase 140 change set after final review and regression. The three remediation batches satisfy SEC140-01 through SEC140-09 locally.

## Reviewed Risk Boundaries

- Database target authorization validates every DNS answer, rejects mixed allowed/denied results, pins the selected address and restricts ports. The loopback/custom-port exception is limited to persisted managed connections outside production.
- Write SQL authorization derives from persistent approval facts, exact SHA-256 SQL identity and a bounded execution state/window. Caller strings cannot create authorization.
- AES-GCM parsing rejects malformed envelopes, wrong key IDs and tag tampering. Legacy CBC keeps its historical derivation only for reads; successful reads use compare-and-swap migration.
- Security event storage has no dependency cycle that changes database initialization: the service resolves the pool lazily at record time. Event failures are non-blocking on denial paths; fatal shutdown allows a bounded 250 ms persistence attempt.
- Public 5xx responses and console output use stable codes/redaction. Event payloads exclude password, token, username, IP and request-body values.

## Residual Risks

- Three Moderate and three Low production dependency advisories remain. They are visible but are not Phase 140 High/Critical blockers; dependency audit remains mandatory in CI.
- Hosted CI evidence cannot exist before these working-tree changes are committed and pushed. The required jobs are configured, but remote green status must be checked on the next PR.
- Lazy migration means dormant credentials remain CBC until first successful use. This preserves rollback and availability but requires operational inventory monitoring if complete-at-rest conversion by a deadline is required.
- The 250 ms fatal-event attempt is deliberately bounded; a failed control database may prevent the last event from persisting, while stable-code stderr and supervisor restart remain available.
