import type { Pool, PoolConnection } from 'mysql2/promise';

/** One bounded control-plane query. A timed-out queued checkout is released on
 * arrival; a timed-out SQL connection is destroyed, so it cannot renew a lease
 * after this caller has abandoned it. The pool itself stays open. */
export async function boundedPoolQuery<T>(pool: Pick<Pool, 'getConnection'>, sql: string, values: unknown[] = [], timeoutMs = 4_000): Promise<[T, unknown]> {
  let connection: PoolConnection | undefined;
  let expired = false;
  let stage = 'checkout';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const started = Date.now();
  const operation = (async () => {
    const acquired = await pool.getConnection();
    if (expired) { acquired.release(); throw new Error('PLATFORM_QUERY_TIMEOUT'); }
    connection = acquired;
    stage = 'query';
    try { return await acquired.query(sql, values) as [T, unknown]; }
    finally { if (!expired) acquired.release(); }
  })();
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        connection?.destroy();
        reject(Object.assign(new Error('PLATFORM_QUERY_TIMEOUT'), { code: 'PLATFORM_QUERY_TIMEOUT', stage }));
      }, timeoutMs);
    })]);
  } catch (error) {
    const code = String((error as { code?: unknown })?.code ?? 'PLATFORM_QUERY_FAILED');
    // Do not log SQL, values, credentials, or driver exception messages.
    console.warn('[PlatformDependency]', JSON.stringify({ code: /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'PLATFORM_QUERY_FAILED', stage, durationMs: Date.now() - started }));
    throw error;
  } finally { if (timer) clearTimeout(timer); }
}
