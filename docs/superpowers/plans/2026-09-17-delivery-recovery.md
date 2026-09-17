# Delivery Recovery Implementation Plan

> **Execution:** Follow this plan within existing authorization and repository rules. Track dependencies and acceptance evidence.

**Goal:** Prevent uncertain notification/report delivery from silently producing duplicate external effects.

**Architecture:** Reuse workflow_jobs and existing delivery attempt/replay tables. A transactional business-key gate freezes an encrypted request and records ownership, version and uncertainty. Recovery and requeue are one transaction.

**Tech Stack:** TypeScript, Fastify, MySQL 8, Vitest, Nodemailer.

## Contract
Approved design: 2026-09-17 attachment, approved by Max. Latest baseline 3481e9f. No UI or unrelated queue changes. Hard budget unset; actual token/cost telemetry unavailable; no delegates. Stop only for unresolvable environment/authorization blockers. Never send to real recipients.

## 1. Regression evidence
- Add `apps/db-ops-api/src/workflows/delivery-recovery.integration.test.ts` with isolated MySQL schema and loopback SMTP.
- Exercise production handler twice after recipient acceptance and summary write failure; expect one reception and durable unknown. Run with DELIVERY_TEST_MYSQL_PORT; capture RED before production edits and commit.

## 2. Durable state and attempt audit
- Add migration `093_delivery_recovery.sql`: business-key state, encrypted frozen request, attempt UUID, monotonically increasing version, current workflow/fence and retention deadline. Extend existing attempt and replay tables for unknown and decisions.
- Add `src/workflows/delivery-store.ts`: lock job then business row; verify live owner/fence; single sending acquisition; classify orphan sending as unknown; only explicit contracted webhook may retry within frozen retention. Final writes require matching attempt and live ownership. Existing sent records seed sent; legacy started/failed attempts seed unknown.
- Extend regression tests: independent connections, restart, stale completion, repeat occurrence, replay counter reset, failure before sending. Run focused integration checks.

## 3. Production handler and transport
- Update `notification-handlers.ts` to prepare frozen request, acquire gate, check signal, perform one send and persist outcome. Never call sendWithRetry for durable deliveries. Use existing attempts with fencing token as attempt number.
- Update `notification-service.ts` to pass stable Idempotency-Key only for contracted webhook, and stable SMTP Message-ID for reconciliation. Validate config before acquiring sending. No SMTP exactly-once claim.
- Add config validation for explicit webhook contract and positive retention; freeze config and message encrypted with existing encryption utility.

## 4. Query and recovery
- Add `delivery-routes.ts` and wire in server.ts using existing auth middleware. GET job delivery exposes state/attempt/decision without frozen secrets. POST recovery requires admin, version, reason and reconciliation result; retry additionally requires duplicate-risk acknowledgement. Lock job and state, reject active lease, CAS version, audit and requeue atomically.
- Ordinary replay cannot bypass unknown/sending; add guard to MysqlWorkflowStore. Test authorization, invalid reason, stale version and duplicate request.

## 5. Acceptance and delivery
- Run affected notification/workflow tests plus typecheck once at final candidate. Real MySQL + isolated SMTP/HTTP tests must cover two workers, success followed by write failure, accepted timeout, cancellation and process recovery.
- Document semantics and evidence in `docs/slide/validation/max-54/acceptance.md`, commit GREEN, review diff, deliver branch/PR according to workspace authorization. Unrelated failures recorded separately. No CI polling unless explicitly requested.
