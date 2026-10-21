// Open the same production singleton used by read-only server diagnostics.
// No commands are sent; shutdown must close this released, reusable session.
const root = process.env.SHUTDOWN_TEST_ROOT;
const { default: pool } = await import(`${root}/apps/db-ops-api/src/ssh-session-pool.ts`);
const client = await pool.getConnection(process.env.SHUTDOWN_SSH_HOST,
  Number(process.env.SHUTDOWN_SSH_PORT), 'shutdown-test', 'password', process.env.SHUTDOWN_SSH_PASSWORD);
pool.releaseConnection(client);
console.info('[ShutdownTest] idle SSH session acquired');
