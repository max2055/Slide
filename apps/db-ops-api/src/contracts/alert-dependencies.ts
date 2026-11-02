import { z } from "zod";
import { RefSchema, OperationKeySchema } from "../metrics/policy/model.js";
export const Endpoint = z.strictObject({
  resource: RefSchema,
  rule_id: z.string().min(1).max(128),
});
export const DependencyValue = z.strictObject({
  name: z.string().trim().min(1).max(128),
  upstream: Endpoint,
  downstream: Endpoint,
});
export const DependencyChange = z.strictObject({
  operation_key: OperationKeySchema,
  expected_revision: z.number().int().nonnegative(),
  value: DependencyValue.optional(),
  disabled: z.literal(true).optional(),
});
export type Value = z.infer<typeof DependencyValue>;
export type Dependency = Value & {
  id: string;
  revision: number;
  disabled: boolean;
  actor_id: number;
  changed_at: string;
};
export const AlertDependencySchema = DependencyValue.extend({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  disabled: z.boolean(),
  actor_id: z.number().int().positive(),
  changed_at: z.string().datetime(),
});
export const AlertDependencyResultSchema = z.strictObject({
  success: z.literal(true),
  dependency: AlertDependencySchema,
  noop: z.boolean(),
});
export const AlertDependencyCatalog = z.array(
  RefSchema.extend({
    name: z.string(),
    rules: z.array(z.strictObject({ id: z.string(), source: z.string() })),
  }),
);
export const NotificationDeliveryReceipt = z.strictObject({
  id: z.string(),
  alert_id: z.number().int().positive(),
  channel_id: z.number().int().positive(),
  phase: z.enum(["problem", "recovery", "escalation"]),
  job_state: z.string(),
  error_code: z.string().nullable(),
  delivery: z
    .strictObject({
      business_key: z.string(),
      kind: z.literal("notification"),
      source_id: z.number().int().positive(),
      channel_id: z.number().int().positive(),
      state: z.string(),
      version: z.number().int(),
      workflow_job_id: z.string().nullable(),
      attempt_id: z.string().nullable(),
      request_digest: z.string().nullable(),
      idempotent_until: z.string().nullable(),
      error_code: z.string().nullable(),
      updated_at: z.string(),
    })
    .nullable(),
  attempts: z.array(
    z.strictObject({
      workflow_job_id: z.string(),
      attempt_number: z.number().int(),
      status: z.string(),
      error_code: z.string().nullable(),
      created_at: z.string(),
      finished_at: z.string().nullable(),
    }),
  ),
  decisions: z.array(
    z.strictObject({
      actor_id: z.number().int(),
      reason: z.string(),
      state_version: z.number().nullable(),
      decision: z.string().nullable(),
      reconciliation: z.string().nullable(),
      created_at: z.string(),
    }),
  ),
});
export const AlertDependencySchemas = {
  AlertDependencyCatalog,
  NotificationDeliveryList: z.array(NotificationDeliveryReceipt),
  AlertDependencyChange: DependencyChange,
  AlertDependency: AlertDependencySchema,
  AlertDependencyResult: AlertDependencyResultSchema,
  AlertDependencyList: z.array(AlertDependencySchema),
  AlertDependencyOperation: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("absent") }),
    z.strictObject({ status: z.literal("committed"), result: AlertDependencyResultSchema }),
  ]),
};
const response = (name: string) => ({
  "200": {
    description: name,
    content: { "application/json": { schema: { $ref: "#/components/schemas/" + name } } },
  },
});
const body = {
  required: true,
  content: {
    "application/json": { schema: { $ref: "#/components/schemas/AlertDependencyChange" } },
  },
};
export const alertDependencyPaths = {
  "/api/alerts/dependencies/resources": {
    get: { operationId: "alertDependencyResources", responses: response("AlertDependencyCatalog") },
  },
  "/api/notification/deliveries": {
    get: { operationId: "notificationDeliveries", responses: response("NotificationDeliveryList") },
  },
  "/api/alerts/dependencies": {
    get: { operationId: "alertDependencyList", responses: response("AlertDependencyList") },
    post: {
      operationId: "alertDependencyCreate",
      requestBody: body,
      responses: response("AlertDependencyResult"),
    },
  },
  "/api/alerts/dependencies/{id}": {
    put: {
      operationId: "alertDependencyChange",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
      ],
      requestBody: body,
      responses: response("AlertDependencyResult"),
    },
  },
  "/api/alerts/dependencies/operations/{key}": {
    get: {
      operationId: "alertDependencyOperation",
      parameters: [{ name: "key", in: "path", required: true, schema: { type: "string" } }],
      responses: response("AlertDependencyOperation"),
    },
  },
};
