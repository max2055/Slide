import { z } from "zod";
import { BulkConfirmSchema, BulkPreviewSchema, BulkRetrySchema } from "../../metrics/bulk/model.js";
import { SelectionSchema } from "../../metrics/packages/model.js";
import { BindingChangeSchema, OverridesSchema, RefSchema } from "../../metrics/policy/model.js";
import { MetricConfigurationStatusSchema } from "./configuration-status.js";

const pin = SelectionSchema.shape.package;
const item = z.strictObject({
  resource: RefSchema,
  state: z.enum([
    "eligible",
    "unsupported",
    "skipped",
    "queued",
    "running",
    "succeeded",
    "pending_takeover",
    "failed",
    "cancelled",
  ]),
  code: z.string().nullable(),
  group: z.string(),
  checks: z.array(
    z.strictObject({
      attribute: z.string(),
      value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
      status: z.string(),
    }),
  ),
  choices: z.array(
    z.strictObject({
      package: pin,
      recommended: z.boolean(),
      compatibility: z.string(),
      metrics: z.array(z.string()),
      missing: z.array(z.string()),
    }),
  ),
  before: z
    .strictObject({
      resource: RefSchema,
      package: pin,
      group_id: z.string().nullable(),
      overrides: OverridesSchema,
      revision: z.number().int().positive(),
    })
    .nullable(),
  change: BindingChangeSchema.nullable(),
  settings: z.record(z.string(), z.union([z.number(), z.boolean()])).nullable(),
  coverage: z.array(z.string()),
  missing: z.array(z.string()),
  cost: z
    .strictObject({
      before: z.number(),
      after: z.number(),
      unit: z.literal("logical_reads_per_hour"),
      estimate: z.literal(true),
    })
    .nullable(),
  retained: z.array(z.string()),
  changed: z.array(z.string()),
  revision: z.number().int().positive().nullable(),
  status: MetricConfigurationStatusSchema.nullable(),
});
export const MetricBulkResultSchema = z.strictObject({
  id: z.uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(["draft", "queued", "running", "completed", "cancelled"]),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  cancel_requested: z.boolean(),
  requested_overrides: OverridesSchema,
  items: z.array(item).min(1).max(100),
  retry_of: z.uuid().nullable(),
});
export const metricBulkSchemas = {
  MetricBulkPreview: BulkPreviewSchema,
  MetricBulkConfirm: BulkConfirmSchema,
  MetricBulkRetry: BulkRetrySchema,
  MetricBulkResult: MetricBulkResultSchema,
  MetricBulkList: z.strictObject({
    jobs: z
      .array(
        z.strictObject({
          id: z.uuid(),
          state: z.string(),
          created_at: z.iso.datetime(),
          count: z.number().int().positive(),
        }),
      )
      .max(10),
  }),
  MetricBulkCancel: z.strictObject({ id: z.uuid(), cancel_requested: z.literal(true) }),
};
const response = (name: string) => ({
  "200": {
    description: "Owned batch with current per-object permission and publication/readiness facts",
    content: { "application/json": { schema: { $ref: `#/components/schemas/${name}` } } },
  },
  "400": { description: "Strict bounded input required" },
  "401": { description: "Authentication required" },
  "403": { description: "Current resource authority required" },
  "404": { description: "Batch not owned or not found" },
  "409": {
    description:
      "Preview expired/changed, idempotency conflict or worker busy; re-preview where appropriate",
  },
  "429": { description: "Bounded queue/rate limit" },
  "503": { description: "Persistence or execution unavailable; no fallback" },
});
const body = (name: string) => ({
  required: true,
  content: { "application/json": { schema: { $ref: `#/components/schemas/${name}` } } },
});
const parameters = [
  { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } },
];
const operation = (operationId: string, input: string | undefined, output: string, id = false) => ({
  operationId,
  security: [{ bearerAuth: [] }],
  ...(id ? { parameters } : {}),
  ...(input ? { requestBody: body(input) } : {}),
  responses: response(output),
});
export const metricBulkPaths = {
  "/api/metrics/config/bulk": { get: operation("listMetricBulkJobs", undefined, "MetricBulkList") },
  "/api/metrics/config/bulk/preview": {
    post: {
      ...operation("previewMetricBulkConfiguration", "MetricBulkPreview", "MetricBulkResult"),
      description:
        "At most 100 unique resources. Groups recommend by live engine/version/capability. Overrides patch only selected fields and metric keys; omitted fields and asset switches stay preserved. Same user/key returns the original immutable preview.",
    },
  },
  "/api/metrics/config/bulk/{id}": {
    get: {
      ...operation("getMetricBulkJob", undefined, "MetricBulkResult", true),
      description:
        "Only the submitting user and original resource boundary. Refreshes formal readiness independently; revoked resources redact all stored configuration details.",
    },
  },
  "/api/metrics/config/bulk/{id}/confirm": {
    post: {
      ...operation("confirmMetricBulkJob", "MetricBulkConfirm", "MetricBulkResult", true),
      description:
        "Confirms the exact 30-minute preview digest. Queue concurrency is 3 globally; each object uses the single-resource live precheck, bounded trial and candidate/revision CAS activation. Completion never implies all resources or formal sources succeeded.",
    },
  },
  "/api/metrics/config/bulk/{id}/cancel": {
    post: {
      ...operation("cancelMetricBulkJob", undefined, "MetricBulkCancel", true),
      description:
        "Monotonic cancellation fence. Already committed publications remain recorded. In-flight IO drains before releasing its trial reservation; unpublished queued objects stop.",
    },
  },
  "/api/metrics/config/bulk/{id}/retry": {
    post: {
      ...operation("previewFailedMetricBulkItems", "MetricBulkRetry", "MetricBulkResult", true),
      description:
        "Only failed items from a terminal job enter a fresh preview with current revisions and preserved overrides. A new explicit digest confirmation is required; published/pending/successful/skipped objects are excluded.",
    },
  },
};
