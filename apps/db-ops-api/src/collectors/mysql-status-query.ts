/** Fixed, read-only batch shared by legacy QPS collection and versioned monitoring packages. */
export const MYSQL_STATUS_SQL = "SHOW GLOBAL STATUS WHERE Variable_name IN ('Queries', 'Uptime')";
