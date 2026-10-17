import type { Pool, RowDataPacket } from "mysql2/promise";
import { migrationItems, type LegacySqlSource } from "../database/reviewed-sql.js";
import type { Ref } from "../policy/model.js";
import { configurationInventory } from "./inventory.js";

/** Resource manager only (enforced before this reader). SQL/credentials never enter this response. */
export async function legacyConfigurationMigration(pool: Pool, ref: Ref) {
  if (ref.type !== "instance") return [];
  const inventory = await configurationInventory(ref),
    engine = String(inventory.attributes["db.engine"]?.value ?? "");
  const [definitions] = await pool.execute<
    RowDataPacket[]
  >(`SELECT id,target_type,unit,value_type,default_interval,collection_sqls,compute_expr
    FROM metric_definitions WHERE target_type='instance' AND is_collected=TRUE AND (collection_sqls IS NOT NULL OR compute_expr IS NOT NULL)`);
  const custom = migrationItems(definitions as LegacySqlSource[], engine).map((item) => ({
    ...item,
    kind: "custom_sql" as const,
  }));
  const [templates] = await pool.execute<RowDataPacket[]>(
    `SELECT t.id,t.enabled FROM instance_templates i
    JOIN metric_templates t ON t.id=i.template_id WHERE i.instance_id=?`,
    [ref.id],
  );
  return [
    ...custom,
    ...templates.map((t) => ({
      kind: "deprecated_template" as const,
      source_id: String(t.id),
      source_digest: null,
      state: "blocked" as const,
      code: "TEMPLATE_MACROS_REVIEW_REQUIRED",
      package: null,
      actions: [
        "Export this instance template and macro overrides before editing",
        "Phase 130 removed template execution before this change; map each existing rule to a reviewed metric definition",
        "Publish equivalent policy-group/resource overrides with CAS; retain macros and audit until verified",
      ],
    })),
  ];
}
