/** Explicit CLI qualification, never part of default tests or production startup.
 * See t04-real-provider-validation.md. Only synthetic resources/tool facts are sent. */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ToolRegistry, type LLMProvider } from "@slide/agent-core";
import { config } from "dotenv";
import Fastify from "fastify";
import mysql, { type Pool, type RowDataPacket } from "mysql2/promise";
import { DirectAdapter } from "../adapter/direct-adapter.js";
import { createConfiguredAgentProvider } from "../adapter/llm-provider-factory.js";
import { createVerifyToken } from "../auth-middleware.js";
import { ActorContextService, signAccessToken } from "../auth/actor-context.js";
import { dbConnection, decryptData } from "../db-connection.js";
import { llmDatabaseService } from "../llm-database-service.js";
import { MigrationRunner } from "../migrations/runner.js";
import { JobRegistry } from "../workflows/job-registry.js";
import { MysqlWorkflowStore, type ClaimedJob } from "../workflows/worker-runtime.js";
import { InvestigationAuthorization } from "./authorization.js";
import { InvestigationExecutor } from "./executor.js";
import { readSends, reserveSend, stopSends, T04_AUTHORIZATION } from "./real-provider-budget.js";
import { registerInvestigationRoutes } from "./routes.js";
import { InvestigationSessionBridge } from "./session-bridge.js";
import { createInvestigationWorkflowHandler } from "./workflow-handler.js";

const journal = process.env.T04_REAL_SEND_JOURNAL!;
const evidence = process.env.T04_REAL_EVIDENCE!;
if (
  process.env.T04_REAL_AUTHORIZATION !== T04_AUTHORIZATION ||
  !journal ||
  !evidence ||
  !process.env.T04_PROVIDER_ENV
)
  throw Error("T04_EXPLICIT_REAL_AUTHORIZATION_REQUIRED");
readSends(journal); // Missing/corrupt history cannot restore budget.
const initialSends = readSends(journal).length;
const record = (value: Record<string, unknown>) => {
  const line = JSON.stringify({ at: new Date().toISOString(), ...value });
  appendFileSync(evidence, `${line}\n`, { mode: 0o600 });
  console.log(line);
};
config({ path: process.env.T04_PROVIDER_ENV, quiet: true });
const database =
  process.env.T04_REAL_CHILD_DATABASE ?? `t04_real_${randomUUID().replaceAll("-", "")}`;
const testConfig = {
  host: "127.0.0.1",
  port: Number(process.env.AGENT_RUN_TEST_MYSQL_PORT),
  user: "root",
  password: process.env.AGENT_RUN_TEST_MYSQL_PASSWORD ?? "",
  timezone: "Z",
};
if (!Number.isSafeInteger(testConfig.port) || testConfig.port <= 0)
  throw Error("ISOLATED_MYSQL_REQUIRED");
const policy = {
  currency: "USD",
  maxConcurrent: 4,
  manualReserved: 1,
  maxPerResourceConcurrent: 4,
  maxAutomaticRequestsPerHour: 20,
  maxAutomaticTokensPerDay: 256000,
  maxTotalTokensPerDay: 1000000,
  maxCostMicrosPerDay: 10000000,
};
let pool: Pool;
let prices: { input: number; cachedInput: number; output: number };
let toolCalls = 0;

async function configuredProvider(
  scenario: string,
  onReceived?: () => Promise<void>,
): Promise<LLMProvider> {
  if (!(await dbConnection.initialize())) throw Error("LOCAL_PROVIDER_DATABASE_UNAVAILABLE");
  let provider: LLMProvider;
  try {
    const p = (await llmDatabaseService.getAllProviders()).find((p) => p.name === "deepseek");
    assert(p?.enabled && p.supports_function_call);
    assert.equal(p.api_base_url, "https://api.deepseek.com/v1");
    assert.equal(p.api_format, "openai-completions");
    assert.equal(p.default_model, "deepseek-v4-flash");
    assert.equal(p.max_tokens, 2048);
    assert(p.api_key_encrypted);
    // USD / 1k tokens -> micro USD / million tokens. No cached rate is
    // configured, so use the full input rate as a conservative estimate.
    prices = {
      input: Math.ceil(p.input_cost_per_1k * 1_000_000_000),
      cachedInput: Math.ceil(p.input_cost_per_1k * 1_000_000_000),
      output: Math.ceil(p.output_cost_per_1k * 1_000_000_000),
    };
    assert(prices.input > 0 && prices.output > 0);
    // Read-only service + existing decrypt function; getProviderApiKey may migrate legacy
    // ciphertext, so do not call that mutating helper against shared configuration.
    provider = await createConfiguredAgentProvider(
      {
        getAllProviders: async () => [p],
        getSceneBindings: async () => [
          { scene: "fault_diagnosis", provider_id: p.id, model: p.default_model! },
        ],
        getProviderApiKey: async (name) => {
          assert.equal(name, p.name);
          return decryptData(p.api_key_encrypted!);
        },
      },
      "fault_diagnosis",
      true,
      false,
    );
    record({
      configuration: {
        provider: p.name,
        endpoint: p.api_base_url,
        model: p.default_model,
        outputCeiling: p.max_tokens,
        prices,
        scene: "isolated in-memory fault_diagnosis binding",
        sharedWrites: 0,
      },
    });
  } finally {
    await dbConnection.close();
  }
  // Intercept the actual SDK transport, including its Node fetch shim. A global
  // fetch patch would miss node-fetch in the production SDK and lose accounting.
  const client = (provider as unknown as { client: { fetch: typeof fetch; maxRetries: number } })
    .client;
  assert.equal(client.maxRetries, 0);
  const originalFetch = client.fetch;
  client.fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.url, "https://api.deepseek.com/v1/chat/completions");
    assert.equal(request.method, "POST");
    const body = (await request.clone().json()) as {
      model: string;
      max_tokens: number;
      stream?: boolean;
    };
    assert.equal(body.model, "deepseek-v4-flash");
    assert(Number.isSafeInteger(body.max_tokens) && body.max_tokens > 0 && body.max_tokens <= 2048);
    assert(!body.stream);
    if (scenario === "replay") throw Error("T04_UNEXPECTED_PROVIDER_REPLAY");
    const send = reserveSend(journal, scenario, scenario === "normal" ? 3 : 1);
    record({
      send,
      used: send.sequence,
      remaining: 6 - send.sequence,
      ...(send.sequence >= 5
        ? { checkpoint: "80%: no scope expansion" }
        : send.sequence >= 3
          ? { checkpoint: "50%: remaining cancellation/crash verification" }
          : {}),
    });
    // Count fsynced before any external I/O. Redirects and SDK network retries disabled.
    const response = await originalFetch(input, { ...init, redirect: "error" });
    const safe = (await response.clone().json()) as any;
    record({
      scenario,
      sequence: send.sequence,
      status: response.status,
      ...(response.ok
        ? {
            usage: safe.usage,
            finishReasons: safe.choices?.map((c: any) => c.finish_reason),
            toolNames: safe.choices?.flatMap(
              (c: any) => c.message?.tool_calls?.map((t: any) => t.function?.name) ?? [],
            ),
          }
        : {
            providerError: {
              code: typeof safe.error?.code === "string" ? safe.error.code : null,
              type: typeof safe.error?.type === "string" ? safe.error.type : null,
            },
          }),
    });
    if (!response.ok) stopSends(journal, `PROVIDER_HTTP_${response.status}`);
    if (response.ok) await onReceived?.();
    return response;
  };
  // SDK has maxRetries:0; throwing a safe error also prevents Runtime model retries.
  const chat = provider.chat.bind(provider);
  return {
    getDefaultModel: provider.getDefaultModel.bind(provider),
    getModelCapabilities: provider.getModelCapabilities?.bind(provider),
    projectMessages: provider.projectMessages?.bind(provider),
    chat: async (messages, tools, options) => {
      const response = await chat(messages, tools, {
        ...options,
        maxTokens: Math.min(options?.maxTokens ?? 2048, 2048),
      });
      if (response.finishReason === "error")
        throw Error(`T04_PROVIDER_ERROR_${response.providerStatus ?? "UNKNOWN"}`);
      return response;
    },
    chatStream: async () => {
      throw Error("REAL_STREAM_NOT_AUTHORIZED");
    },
  };
}

function readonlyTools() {
  const tools = new ToolRegistry();
  tools.register({
    name: "get_instance_summary",
    description: "读取合成测试资源的当前状态，仅供验收。",
    parameters: {
      type: "object",
      properties: { instance_id: { type: "number" } },
      required: ["instance_id"],
    },
    readOnly: true,
    concurrencySafe: true,
    exclusive: false,
    execute: async (args) => {
      assert.equal(args.instance_id, 101);
      toolCalls++;
      record({ toolFixture: "get_instance_summary", toolCalls });
      return {
        success: true,
        rows: [{ instance_id: 101, health: "unknown", synthetic: true }],
        password: "must-redact",
      };
    },
  });
  return tools;
}
function executor(provider: LLMProvider, tools: ToolRegistry) {
  return new InvestigationExecutor({
    pool: () => pool,
    authorization: new InvestigationAuthorization(new ActorContextService(() => pool as never)),
    providerForPurpose: async (purpose) => {
      assert.equal(purpose, "fault_diagnosis");
      return provider;
    },
    toolsForActor: () => tools,
    budget: { domain: "t04-authorized-real", policy, reserveCostMicros: 1000000, prices },
  });
}
const rows = async (sql: string, values: unknown[] = []) =>
  (await pool.query<RowDataPacket[]>(sql, values))[0];
const executeJob = async (job: ClaimedJob, provider: LLMProvider) => {
  const tools = readonlyTools();
  const adapter = new DirectAdapter({
    tools,
    toolsForActor: () => tools,
    llmProvider: provider,
    providerForPurpose: async () => provider,
    workspace: ".qualification/t04-real",
  });
  adapter.configureInvestigationExecutor(executor(provider, tools));
  const registry = new JobRegistry();
  registry.register(
    "investigation.execute",
    createInvestigationWorkflowHandler(async () => adapter),
  );
  try {
    return (await registry.executeWithResult(job, {
      workerId: "real-worker",
      fencingToken: job.fencingToken,
      signal: new AbortController().signal,
    })) as { state: string; error: string | null };
  } finally {
    await adapter.dispose();
  }
};

async function main() {
  const admin = mysql.createPool(testConfig);
  const app = Fastify();
  try {
    await admin.query(`CREATE DATABASE ${database}`);
    pool = mysql.createPool({ ...testConfig, database, connectionLimit: 12 });
    await new MigrationRunner(pool).run();
    await pool.query(
      "INSERT INTO users (id,username,password_hash) VALUES (101,'synthetic-real-owner','no-login')",
    );
    const [role] = await pool.query<mysql.ResultSetHeader>(
      "INSERT INTO roles (name) VALUES ('synthetic-real-readonly')",
    );
    await pool.query(
      "INSERT INTO role_permissions (role_id,permission_id) SELECT ?,id FROM permissions WHERE code IN ('chat:view','instance:view','metric:view','alert:view')",
      [role.insertId],
    );
    await pool.query("INSERT INTO user_roles (user_id,role_id) VALUES (101,?)", [role.insertId]);
    await pool.query(
      "INSERT INTO database_instances (id,name,host,port,username,password_encrypted) VALUES (101,'synthetic-only','fixture.invalid',3306,'fixture','unused')",
    );
    await pool.query(
      "INSERT INTO instance_permissions (user_id,instance_id,access_level) VALUES (101,101,'read-only')",
    );
    const contexts = new ActorContextService(() => pool as never);
    const secret = randomUUID();
    const actor = await contexts.loadActiveActor(101);
    const headers = { Authorization: `Bearer ${signAccessToken(actor, secret)}` };
    const bridge = new InvestigationSessionBridge(
      () => pool,
      new InvestigationAuthorization(contexts),
      { domain: "t04-authorized-real", policy },
    );
    await registerInvestigationRoutes(app, createVerifyToken(secret, contexts), bridge);
    const store = new MysqlWorkflowStore(() => pool as never);
    const admitted = async (scenario: string) => {
      const response = await app.inject({
        method: "POST",
        url: "/api/investigations",
        headers: { ...headers, "Idempotency-Key": randomUUID() },
        payload: {
          title: `合成验收 ${scenario}`,
          goal: "这是合成验收资源101。必须先调用get_instance_summary一次（instance_id=101），然后用一句中文说明事实不足、根因待验证。不要调用第二个工具。",
          profileId: "ops",
          subject: { kind: "resource", resource: { type: "instance", id: 101 } },
          resourceRefs: [{ type: "instance", id: 101, role: "primary" }],
        },
      });
      assert.equal(response.statusCode, 202);
      const acceptance = response.json();
      const job = await store.claim("real-worker", 180, {
        types: ["investigation.execute"],
        exclude: false,
      });
      assert(job && job.payload.requestId === acceptance.requestId);
      return { acceptance, job };
    };
    const snapshot = async (requestId: string) => {
      const allocation = await rows(
        "SELECT id,state,charged_tokens,charged_cost_micros,usage_snapshot,cost_status FROM investigation_budget_ledger WHERE request_id=?",
        [requestId],
      );
      assert.equal(allocation.length, 1);
      const run = (
        await rows("SELECT id,state,actor_id,message_id FROM agent_runs WHERE idempotency_key=?", [
          `investigation:${requestId}`,
        ])
      )[0];
      assert.equal(run.actor_id, 101);
      assert.equal(
        run.message_id,
        (await rows("SELECT message_id FROM investigation_requests WHERE id=?", [requestId]))[0]
          .message_id,
      );
      return { allocation: allocation[0], run };
    };
    const normal = await admitted("normal");
    const result = await executeJob(normal.job, await configuredProvider("normal"));
    record({ scenario: "normal", result });
    const state = await snapshot(normal.acceptance.requestId);
    record({ scenario: "normal", result, ...state, toolCalls });
    assert.equal(result.state, "completed", "Real provider did not complete; stop dependent sends");
    assert.equal(state.allocation.state, "settled");
    assert.equal(state.allocation.cost_status, "known");
    assert.equal(toolCalls, 1);
    const facts = await rows("SELECT entry_json FROM agent_canonical_facts");
    assert(facts.length >= 2 && !JSON.stringify(facts).includes("must-redact"));
    const normalUsage = readFileSync(evidence, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((r) => r.scenario === "normal" && r.usage);
    const sums = normalUsage.reduce(
      (s, r) => ({
        inputTokens: s.inputTokens + r.usage.prompt_tokens,
        outputTokens: s.outputTokens + r.usage.completion_tokens,
        cachedInputTokens:
          s.cachedInputTokens +
          (r.usage.prompt_cache_hit_tokens ?? r.usage.prompt_tokens_details?.cached_tokens ?? 0),
      }),
      { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    );
    assert.deepEqual(state.allocation.usage_snapshot, sums);
    const beforeReplay = readSends(journal).length;
    await executeJob(normal.job, await configuredProvider("replay"));
    assert.equal(readSends(journal).length, beforeReplay);
    assert.equal(toolCalls, 1);
    await store.complete(normal.job.id, "real-worker", normal.job.fencingToken);

    const cancel = await admitted("cancel");
    const cancelled = await executeJob(
      cancel.job,
      await configuredProvider("cancel", async () => {
        const response = await app.inject({
          method: "POST",
          headers,
          url: `/api/investigations/${cancel.acceptance.id}/requests/${cancel.acceptance.requestId}/cancel`,
        });
        assert.equal(response.statusCode, 202);
        record({ scenario: "cancel", httpCancel: response.statusCode });
      }),
    );
    const cancelledState = await snapshot(cancel.acceptance.requestId);
    record({ scenario: "cancel", result: cancelled, ...cancelledState });
    assert.equal(cancelled.state, "cancelled");
    assert.equal(cancelledState.allocation.state, "unknown");
    assert.equal(Number(cancelledState.allocation.charged_tokens), 32000);
    assert.equal(Number(cancelledState.allocation.charged_cost_micros), 1000000);
    const cancelSends = readSends(journal).length;
    await executeJob(cancel.job, await configuredProvider("replay"));
    assert.equal(readSends(journal).length, cancelSends);
    await store.complete(cancel.job.id, "real-worker", cancel.job.fencingToken);

    const crash = await admitted("crash");
    const worker = fork(fileURLToPath(import.meta.url), [], {
      silent: true,
      execArgv: ["--import", import.meta.resolve("tsx")],
      env: {
        ...process.env,
        T04_REAL_CHILD_DATABASE: database,
        T04_REAL_CHILD_JOB: JSON.stringify(crash.job),
      },
    });
    let reached = false;
    const exit = await new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.kill("SIGKILL");
        reject(Error("REAL_CHILD_TIMEOUT"));
      }, 150000);
      worker.on("message", (m: any) => {
        if (m.providerReceived) {
          reached = true;
          worker.kill("SIGKILL");
        }
      });
      worker.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      worker.once("exit", (_code, signal) => {
        clearTimeout(timer);
        resolve(signal);
      });
    });
    assert(reached && exit === "SIGKILL");
    await pool.query(
      "UPDATE workflow_jobs SET lease_expires_at=DATE_SUB(NOW(),INTERVAL 1 SECOND) WHERE id=?",
      [crash.job.id],
    );
    const next = await store.claim("real-worker", 180, {
      types: ["investigation.execute"],
      exclude: false,
    });
    assert(next && next.id === crash.job.id && next.fencingToken > crash.job.fencingToken);
    const crashSends = readSends(journal).length;
    const recovered = await executeJob(next, await configuredProvider("replay"));
    const recoveredState = await snapshot(crash.acceptance.requestId);
    record({
      scenario: "crash",
      exit,
      recovered,
      ...recoveredState,
      dispatchDelta: readSends(journal).length - crashSends,
    });
    assert.equal(recovered.state, "partial");
    assert.equal(recoveredState.allocation.state, "unknown");
    assert.equal(Number(recoveredState.allocation.charged_tokens), 32000);
    assert.equal(Number(recoveredState.allocation.charged_cost_micros), 1000000);
    assert.equal(readSends(journal).length, crashSends);
    await executeJob(next, await configuredProvider("replay"));
    assert.equal(readSends(journal).length, crashSends);
    record({
      completed: true,
      used: readSends(journal).length,
      remaining: 6 - readSends(journal).length,
      facts: facts.length,
      realTargetDevice: false,
      actualProviderCharge: "unavailable; ledger cost is configured estimate",
    });
  } finally {
    await app.close();
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }
}

try {
  if (process.env.T04_REAL_CHILD_JOB) {
    pool = mysql.createPool({ ...testConfig, database, connectionLimit: 12 });
    try {
      const provider = await configuredProvider("crash", async () => {
        process.send?.({ providerReceived: true });
        await new Promise<void>(() => {}); // Parent kills after real HTTP body, before durable receipt.
      });
      await executeJob(JSON.parse(process.env.T04_REAL_CHILD_JOB), provider);
    } finally {
      await pool.end();
      process.disconnect?.();
    }
  } else await main();
} catch (error) {
  if (readSends(journal).length > initialSends)
    stopSends(journal, "QUALIFICATION_STOPPED_AFTER_SEND");
  record({
    stopped: true,
    used: readSends(journal).length,
    remaining: 6 - readSends(journal).length,
    errorType: error instanceof Error ? error.name : "unknown",
    code:
      error instanceof Error && /^[A-Z][A-Z0-9_]{0,127}$/.test(error.message)
        ? error.message
        : null,
    location:
      error instanceof Error
        ? error.stack
            ?.split("\n")
            .filter((line) => line.trim().startsWith("at "))
            .slice(0, 5)
        : [],
    reason:
      "qualification assertion/provider error; inspect sanitized evidence; no automatic retry",
  });
  process.exitCode = 1;
}
