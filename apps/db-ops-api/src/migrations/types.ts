export interface SqlMigration {
  id: string;
  sql: string;
  checksum: string;
}

export interface MigrationLedgerEntry {
  migration_id: string;
  checksum: string;
  status: 'running' | 'completed' | 'failed' | 'baselined' | 'repaired';
  statement_index: number | null;
  error: string | null;
}

export interface MigrationQuery {
  query<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown?]>;
}

export interface MigrationConnection extends MigrationQuery {
  release(): void;
}

export interface MigrationPool extends MigrationQuery {
  getConnection(): Promise<MigrationConnection>;
}
