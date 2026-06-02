# Protocol Boundary

This directory defines the wire contract for DirectAdapter clients (operators,
webchat, nodes).

## Public Contracts

- Definition files:
  - `schema.ts` — re-exports all schema/*.ts modules
  - `schema/protocol-schemas.ts` — versioned protocol schemas
  - `client-info.ts` — client identity constants
  - `connect-error-details.ts` — connection error codes
  - `index.ts` — runtime protocol helpers

## Boundary Rules

- Treat schema changes as protocol changes, not local refactors.
- Prefer additive evolution. If a change is incompatible, handle versioning
  explicitly and update all affected clients.
- Keep schema, runtime validators, docs, tests, and generated client artifacts
  in sync.
- New methods, events, or payload fields should land through the typed
  protocol definitions here rather than ad hoc JSON shapes elsewhere.
- Keep protocol modules data-first and acyclic. Do not route protocol exports
  back through heavier runtime or server-method helpers that make the contract
  surface expensive or order-dependent at import time.
