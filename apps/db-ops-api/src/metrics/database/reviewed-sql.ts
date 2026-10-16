import { createHash } from "node:crypto";
import { z } from "zod";
import { ExtensionMetricDefinitionSchema, VersionSchema } from "../../contracts/metrics/index.js";
import { classifySql } from "../../sql-validator.js";
import {
  AdapterError,
  classifyError,
  type DecodedRow,
  type Transport,
} from "../packages/adapters.js";
import {
  sealRelease,
  stable,
  type ImplementationSpec,
  type PackageRelease,
} from "../packages/model.js";
import { diagnosticReleases } from "./diagnostics.js";
import { reviewedSqlCatalog } from "./reviewed-sql-catalog.js";

const Digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const Pin = z.strictObject({ id: z.string().min(1), version: VersionSchema, digest: Digest });
const Manifest = z.strictObject({
  id: z.string().regex(/^(mysql|postgresql|oracle|dameng)-custom-[a-z0-9-]{1,100}$/),
  version: VersionSchema,
  base: Pin,
  engine: z.enum(["mysql", "postgresql", "oracle", "dameng"]),
  source_id: z.string().min(1).max(128),
  source_digest: Digest,
  sql: z.string().min(1).max(65536),
  definition: ExtensionMetricDefinitionSchema,
  permissions: z.array(z.string().min(1).max(256)).min(1).max(20),
  review: z.strictObject({
    reference: z.string().min(1).max(256),
    reviewed_by: z.string().min(1).max(128),
  }),
});
export interface LegacySqlSource {
  id: string;
  target_type?: string;
  unit: string;
  value_type: string;
  default_interval: number;
  collection_sqls: Record<string, string> | string | null;
  compute_expr: string | null;
}
function queries(source: LegacySqlSource): Record<string, string> {
  const parsed =
    typeof source.collection_sqls === "string"
      ? JSON.parse(source.collection_sqls)
      : source.collection_sqls;
  return z.record(z.string(), z.string()).parse(parsed ?? {});
}
/** Bind approval to the source's SQL AND unit/kind/timing. Later edits require a new review. */
export function sourceDigest(source: LegacySqlSource, engine: string): string {
  return `sha256:${createHash("sha256")
    .update(
      stable({
        id: source.id,
        target_type: source.target_type ?? "instance",
        engine,
        unit: source.unit,
        value_type: source.value_type,
        default_interval: source.default_interval,
        sql: queries(source)[engine] ?? null,
        compute_expr: source.compute_expr,
      }),
    )
    .digest("hex")}`;
}
export function compileReviewedSql(input: unknown[] = reviewedSqlCatalog) {
  const manifests = input.map((m) => Manifest.parse(m));
  const specs: ImplementationSpec[] = [],
    releases: PackageRelease[] = [];
  const entries: Array<{
    id: string;
    sql: string;
    engine: string;
    definition: z.infer<typeof ExtensionMetricDefinitionSchema>;
  }> = [];
  const seen = new Set<string>();
  for (const m of manifests) {
    const d = m.definition;
    if (!m.id.startsWith(`${m.engine}-custom-`)) throw new Error("CUSTOM_ENGINE_ID");
    if (
      !d.id.startsWith("custom.") ||
      d.namespace !== "custom" ||
      d.resource_type !== "instance" ||
      d.scope !== "resource" ||
      d.dimensions.keys.length ||
      d.dimensions.max_series_per_resource !== 1 ||
      !["gauge", "counter"].includes(d.kind) ||
      !["uint64", "float64", "int64"].includes(d.value_type) ||
      d.lifecycle !== "active"
    )
      throw new Error("CUSTOM_DEFINITION_REVIEW_REQUIRED");
    if (classifySql(m.sql, m.engine).commandType !== "read") throw new Error("CUSTOM_SQL_UNSAFE");
    const base = diagnosticReleases().find(
      (r) =>
        r.package.id === m.base.id &&
        r.package.version === m.base.version &&
        r.package.digest === m.base.digest,
    );
    if (!base || base.package.applicability[0].values[0] !== m.engine)
      throw new Error("CUSTOM_BASE_PIN");
    const key = `${m.id}@${m.version}`;
    if (seen.has(key)) throw new Error("IMMUTABLE_PACKAGE");
    seen.add(key);
    const impl = `reviewed:sql.${createHash("sha256").update(stable(m)).digest("hex")}`;
    const discovery = `Reviewed scalar SELECT; source ${m.source_id} ${m.source_digest}; review ${m.review.reference}. Unit, scope and permissions must be re-reviewed on edits.`;
    const spec: ImplementationSpec = {
      id: impl,
      method: "sql",
      resource_type: "instance",
      applicability: base.package.applicability,
      outputs: [{ raw_field: "val", definition: d, input_unit: d.unit }],
      permissions: m.permissions,
      discovery,
    };
    specs.push(spec);
    entries.push({ id: impl, sql: m.sql, engine: m.engine, definition: d });
    releases.push(
      sealRelease({
        ...base,
        package: {
          ...base.package,
          id: m.id,
          version: m.version,
          collectors: [
            ...base.package.collectors,
            {
              id: "reviewed_sql",
              implementation_ref: impl,
              method: "sql",
              timeout_ms: 5000,
              estimated_cost: "high",
              mappings: [
                {
                  metric: { id: d.id, semantic_version: d.semantic_version },
                  raw_field: "val",
                  input_unit: d.unit,
                  output_unit: d.unit,
                  transform_version: "1.0.0",
                  steps: ["decode", "normalize"],
                },
              ],
            },
          ],
        },
        extensions: [...base.extensions, d],
        documentation: [
          ...base.documentation,
          { collector_id: "reviewed_sql", permissions: m.permissions, discovery },
        ],
      }),
    );
  }
  return { specs, releases, entries, manifests };
}
/** Single scalar inside the existing authorized bounded transport, never a scheduler or writer. */
export async function collectReviewedSql(
  id: string,
  transport: Transport,
  timeout: number,
  input: unknown[] = reviewedSqlCatalog,
): Promise<DecodedRow[]> {
  const entry = compileReviewedSql(input).entries.find((e) => e.id === id);
  if (!entry || transport.method !== "sql") throw new AdapterError("parse_error");
  const statement = entry.sql.trim().replace(/;\s*$/, "");
  const sql = `SELECT (\n${statement}\n) AS val${["oracle", "dameng"].includes(entry.engine) ? " FROM DUAL" : ""}`;
  let response: unknown;
  try {
    [response] = await transport.pool.query({ sql, timeout });
  } catch (error) {
    throw new AdapterError(classifyError(error));
  }
  if (
    !Array.isArray(response) ||
    response.length !== 1 ||
    !response[0] ||
    typeof response[0] !== "object"
  )
    throw new AdapterError("parse_error");
  const raw = Array.isArray(response[0]) ? response[0] : Object.values(response[0]);
  if (raw.length !== 1) throw new AdapterError("parse_error");
  const value = raw[0],
    definition = entry.definition;
  if (value === null) return [{ dimensions: {}, fields: { val: null } }];
  if (definition.value_type === "float64") {
    if (
      !(
        typeof value === "number" ||
        (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value))
      ) ||
      !Number.isFinite(Number(value))
    )
      throw new AdapterError("parse_error");
    return [{ dimensions: {}, fields: { val: { encoding: "float64", value: Number(value) } } }];
  }
  const text =
    typeof value === "bigint"
      ? String(value)
      : typeof value === "number" && Number.isSafeInteger(value)
        ? String(value)
        : value;
  if (typeof text !== "string" || !/^(0|[1-9]\d*|-[1-9]\d*)$/.test(text))
    throw new AdapterError("parse_error");
  const n = BigInt(text),
    unsigned = definition.value_type === "uint64";
  if (unsigned ? n < 0n || n >= 1n << 64n : n < -(1n << 63n) || n >= 1n << 63n)
    throw new AdapterError("parse_error");
  // Arbitrary SQL counters have no authoritative lifecycle unless reviewed transport evidence exists.
  return [
    { dimensions: {}, fields: { val: { encoding: unsigned ? "uint64" : "int64", value: text } } },
  ];
}
export function migrationItems(
  sources: LegacySqlSource[],
  engine: string,
  input: unknown[] = reviewedSqlCatalog,
) {
  const compiled = compileReviewedSql(input);
  return sources
    .filter(
      (s) =>
        (s.target_type ?? "instance") === "instance" &&
        (!s.collection_sqls ? !!s.compute_expr : !!queries(s)[engine] || !!s.compute_expr),
    )
    .map((source) => {
      const hash = sourceDigest(source, engine);
      const approved = compiled.manifests.find(
        (m) => m.source_id === source.id && m.engine === engine && m.source_digest === hash,
      );
      const release =
        approved &&
        compiled.releases.find(
          (r) => r.package.id === approved.id && r.package.version === approved.version,
        );
      const pin = release
        ? {
            id: release.package.id,
            version: release.package.version,
            digest: release.package.digest,
          }
        : null;
      const safe =
        !source.compute_expr &&
        classifySql(queries(source)[engine] ?? "", engine).commandType === "read";
      return {
        source_id: source.id,
        source_digest: hash,
        state: pin ? ("reviewed" as const) : ("blocked" as const),
        package: pin,
        code: pin
          ? "CUSTOM_SQL_ACTIVATION_REQUIRED"
          : source.compute_expr
            ? "CUSTOM_EXPRESSION_REVIEW_REQUIRED"
            : safe
              ? "CUSTOM_SQL_REVIEW_REQUIRED"
              : "CUSTOM_SQL_UNSAFE",
        actions: pin
          ? [
              "Review impact and live resource permission",
              "POST resource activate with exact package pin and expected_revision",
              "Verify source gate and fresh formal values",
            ]
          : [
              "Export original definition through authorized metric management",
              "Review read-only SQL, native unit/kind/scope, engine versions and SELECT grants",
              "Add immutable manifest to reviewed-sql-catalog.ts through code review; retain original record",
              "Deploy reviewed artifact, then activate via trial and CAS; migrate thresholds explicitly",
            ],
      };
    });
}
