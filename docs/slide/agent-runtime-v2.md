# Agent Runtime 2.0 qualification and rollout

Runtime response-ready is not durable completion. Only `AgentRunService`'s message + run transaction commits a final answer. Recovery, cancellation, deadlines and context compaction preserve cumulative budgets and actual provider/tool settlement ownership.

## Reproducible qualification

Run from repository root with Node/pnpm versions from `.nvmrc`/`package.json`:

```bash
bash scripts/qualification/run-agent-runtime.sh --mode deterministic
# DB_HOST/DB_PORT/DB_USER/DB_PASSWORD injected for an authorized test MySQL server:
bash scripts/qualification/run-agent-runtime.sh --mode mysql
bash scripts/qualification/run-agent-runtime.sh --mode soak --duration-seconds 1800
bash scripts/qualification/run-agent-runtime.sh --mode provider
# DB_* and QUALIFICATION_ADMIN_PASSWORD injected; managed ports must be free:
QUALIFICATION_CANCELLATION_E2E=1 PLAYWRIGHT_MANAGED_ENV=1 pnpm --filter slide-frontend exec playwright test agent-runtime.spec.ts agent-cancellation.spec.ts --workers=1
```

Deterministic mode replays rejected/exhausted candidates, length continuation, empty→length, transport reset and auth rejection; evaluates the frozen T2 corpus and 100k detector p95. It does not call a paid model. The normal-corpus extra-request rate is offline evidence, not a production measurement.

MySQL mode creates a randomly named `slide_runtime_*` schema, applies actual migrations, starts DirectAdapter on an ephemeral loopback port, exercises actual WS authentication/run/history/replay, cancellation, a real five-second deadline and commits. A transaction-acquisition failure leaves a durable completion intent; independent service instances concurrently recover it with one final row. A separate child process exits after the assistant INSERT but before terminal UPDATE/COMMIT; the test asserts rollback, pending intent preservation, then a unique recovered final. It drops only its own schema and temporary session directory. The shell also runs the 14-case real-MySQL approval execution suite in its separately owned schema (expiry, rejection, consumption and transaction races). Do not point it at a server where creating test schemas is unauthorized. The existing browser managed environment resets `db_ops_ai_qualification` and uses ports 3003/5175/28890/28900; reserve that environment exclusively.

Soak runs 60 real-time model steps with 59 controlled read-only evidence tools over 1800 seconds, then cancellation and deadline probes. Every two steps it records heap and active-resource counts; it rejects growth above the recorded warmup envelope (+2 active resources / +64MiB heap) and outstanding provider activity. This envelope detects gross leaks, not a proof of constant memory. Short duration is smoke only. It makes no paid model requests and is separate from the provider representative task.

Each shell entry logs mode, PID, cwd, SHA, command and log path under `.qualification/runtime/`; MySQL also logs actual WS port and schema. Logs contain controlled test data, not deployment credentials. Capture a clean committed SHA for final evidence; a dirty-tree run is developmental evidence only.

Provider mode requires explicitly injected `QUALIFICATION_ANTHROPIC_{BASE_URL,MODEL,API_KEY}` and `QUALIFICATION_OPENAI_{BASE_URL,MODEL,API_KEY}`. For deployed Ollama set `QUALIFICATION_OLLAMA_DEPLOYED=true` plus `QUALIFICATION_OLLAMA_{BASE_URL,MODEL,VERSION}` (OpenAI-compatible `/v1` endpoint). Optional `VERSION` documents other provider deployments. Missing connections return nonzero and `unverified`. The short read-only explanation task records model, parameters, usage, reservation ledger and elapsed time without response body. Provider HTTP request IDs are captured when supplied by the SDK/server; absent IDs are explicitly recorded and remain an evidence gap. Do not save credentials to `.env`, evidence, issues or Git.

## A1–A8 evidence index

| Acceptance | Executable evidence | Additional required evidence |
| --- | --- | --- |
| A1 candidate/history isolation | deterministic, mysql, `agent-runtime.spec.ts` | all scenarios through deployed configuration |
| A2 repetition accuracy | frozen 210 normal samples + negatives; deterministic | representative observe cohort |
| A3 long chat | soak 1800 seconds/60 steps; cancellation browser test | real provider representative task |
| A4 independent budgets/timeouts | agent-core runtime-budget, runtime-settlement tests | controlled soak resource history |
| A5 bounded recovery/permissions | runtime-recovery tests; API approval/credential tests | deployment policy cohort |
| A6 checkpoint/uncertain execution | runtime-context/runtime-compact/runtime-settlement tests | deployed checkpoint compatibility |
| A7 entry terminal/durable uniqueness | API runtime-lifecycle; mysql pending/replay; browser cancellation | four-entry deployed matrix |
| A8 observability/release | runtime-events tests; full CI; security scan | provider request IDs, observe/enforce cohort, 24h window |

Coverage matrix indexes commands; neither matrix validation nor green CI marks the last column passed. Attach outputs with SHA, policy, OS, provider version, sample count and exact command to the issue. Missing real validation blocks production completion.

## Event contract

`onRuntimeEvent` is optional and backward compatible. It emits body-free versioned events: model/tool start, candidate reject/observe-only repetition, recovery start, saved compaction, response-ready and terminal. A generated turn UUID, run UUID, monotonic sequence and cumulative counters correlate execution; input/output/cached input, unknown requests and reservations remain separate. Cached input is a subset of input; total tokens = input + output. Observers cannot fail the run. `tool.returned` denotes the executor boundary, not proof of underlying settlement after noncooperative timeout; the existing ownership observers remain authoritative. Tool ordinals identify members of concurrent batches without logging provider-supplied tool IDs. No original user text, tool arguments/results, model body, credentials, session key or error message enters this event DTO.

All four entries bridge to the existing bounded, one-hour process-local platform log store. Chat uses the durable run UUID so `runtime.*` and `run.completed` can be joined. The platform-log projection keeps type, correlation and trace IDs plus whitelisted cumulative counters. Query groups return bounded trace samples and the latest counter snapshot; they do not sum cumulative snapshots. Process restart loses platform log history; it does not erase business audit/checkpoints. Durable audit remains authoritative. No new monitoring service is introduced.

## Policy and staged rollout

`AGENT_RUNTIME_SUPERVISOR_MODE=observe|enforce` is validated and frozen with each entry policy. Default remains the existing enforce behavior; setting observe explicitly records candidate decisions without repeating business tools. Chat has no implicit whole-run deadline; `AGENT_CHAT_RUN_TIMEOUT_MS` and `AGENT_RUN_TIMEOUT_MS` still impose an explicit deadline. `AGENT_RUNTIME_LONG_CHAT=false` remains the default for expanded resource budgets, and explicit iteration limits remain effective. For rollout configure only a designated test cohort, not all existing sessions.

1. Observe at least 200 representative turns, preserving original traffic and counting model/tool requests once. Offline corpus runs do not satisfy this cohort.
2. Enforce on at least 100 distinct sessions for a measured 24-hour window. Record cohort/run IDs, policy SHA, normal false rejection numerator/denominator, degraded-output completed count, duplicate effects/durable finals, permission violations, extra model requests, and application-only p95 latency versus matched baseline.
3. Require normal false rejection ≤1%; degraded completed=0; duplicate effects/finals/permission bypass=0; normal short-answer extra requests=0; p95 added application latency ≤5% (report sample size, exclude network variability).
4. Enable the expanded long-chat budgets only for a pilot after these gates, then expand. The default chat deadline behavior is independent of this flag. Do not generate meaningless paid traffic to meet sample counts or elapsed time.

No deployed cohort or rollout window is provisioned by the qualification scripts. A missing deployment, provider connection, request ID or observation window is **unverified**, never production complete.

## Safe rollback

Any consistency/security invariant violation immediately stops expansion. Ratio/latency threshold failures pause expansion for scoped investigation. Change policy for new runs (disable long-chat and select the previously accepted supervisor policy); do not mutate in-flight snapshots. Drain cooperative runs or request cancellation, wait for real provider/tool settlement, and reconcile uncertain operations before replay. Keep both checkpoint versions and business audit. Do not downgrade a binary and automatically replay side effects. Verify one durable final per run and successful readback after rollback; preserve the failing cohort evidence.
