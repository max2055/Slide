/** Trusted deployment artifact, reviewed through the same code-review gate as fixed SQL.
 * Add a schema-validated manifest here after checking source_digest, definition, permissions,
 * bounded SELECT and engine/version evidence. No HTTP/configuration input can populate it.
 * Do not include credentials, connection addresses or SQL containing secrets. */
export const reviewedSqlCatalog: unknown[] = [];
