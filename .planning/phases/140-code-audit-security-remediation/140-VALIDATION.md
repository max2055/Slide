# Phase 140 Validation Strategy

| Requirement | Primary automated evidence | Runtime/UAT evidence |
|---|---|---|
| SEC140-01 database SSRF | database-target-policy adversarial unit/integration matrix | authorized private DB succeeds; denied target produces zero socket connection |
| SEC140-02 branding authorization | multi-actor route test | viewer 403, admin save/readback and audit |
| SEC140-03 dependency security | `pnpm audit --prod`, full API tests | API/WS startup and critical paths |
| SEC140-04 approval credential | forged/mismatch/replay/concurrency tests | one approved write produces exactly one side effect |
| SEC140-05 public errors | response/log snapshot secret scan | login/connection/SQL failures expose stable reason codes only |
| SEC140-06 HTTP boundary | headers/rate/body/CORS tests | browser and curl checks through running API |
| SEC140-07 key migration | v1/v2/tamper/rollback tests | existing stored credentials remain usable after migration |
| SEC140-08 security alerts | typed event and dedupe tests | rejected attacks visible in audit/notification flow |
| SEC140-09 CI gate | workflow parity and finding matrix | hosted required checks and artifact evidence |

Nyquist rule: every requirement needs at least one deny-path test proving target side-effect count is zero where applicable. Static source matching is supporting evidence only.
