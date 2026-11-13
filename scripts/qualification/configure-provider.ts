import type { dbConnection } from '../../apps/db-ops-api/src/db-connection.js';

type Pool = NonNullable<ReturnType<typeof dbConnection.getPool>>;
type ProviderConfig = {
  displayName: string;
  encryptedApiKey: string;
  baseUrl: string;
  model: string;
};

/** Qualification-only switch. Match setDefaultProvider's collection lock order (#523). */
export async function configureQualificationProvider(pool: Pool, config: ProviderConfig): Promise<void> {
  let connection: Awaited<ReturnType<Pool['getConnection']>> | undefined = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute('SELECT id FROM llm_providers ORDER BY id FOR UPDATE');
    const [targets] = await connection.execute('SELECT id FROM llm_providers WHERE name = ?', ['deepseek']);
    const rows = targets as Array<{ id: number }>;
    if (rows.length !== 1) throw new Error('qualification target provider deepseek not found');
    const id = rows[0].id;

    await connection.execute('UPDATE llm_providers SET enabled = 0, is_default = 0 WHERE id <> ?', [id]);
    await connection.execute(
      `UPDATE llm_providers SET display_name = ?, api_key_encrypted = ?, api_base_url = ?,
         default_model = ?, enabled = 1, is_default = 1, deployment_type = 'api',
         api_format = 'openai-completions' WHERE id = ?`,
      [config.displayName, config.encryptedApiKey, config.baseUrl, config.model, id],
    );

    // affectedRows may be zero for an unchanged row: verify persisted state instead.
    const [states] = await connection.execute(
      `SELECT id, display_name, api_key_encrypted, api_base_url, default_model,
              enabled, is_default, deployment_type, api_format FROM llm_providers`,
    );
    const providers = states as Array<Record<string, unknown>>;
    const target = providers.find(row => row.id === id);
    if (!target || Number(target.enabled) !== 1 || Number(target.is_default) !== 1
      || target.display_name !== config.displayName || target.api_key_encrypted !== config.encryptedApiKey
      || target.api_base_url !== config.baseUrl || target.default_model !== config.model
      || target.deployment_type !== 'api' || target.api_format !== 'openai-completions'
      || providers.some(row => row.id !== id && (Number(row.enabled) !== 0 || Number(row.is_default) !== 0))) {
      throw new Error('qualification provider state verification failed');
    }
    await connection.commit();
  } catch (error) {
    try {
      await connection.rollback();
    } catch {
      // Unknown rollback state must never return to the pool or be replayed.
      connection.destroy();
      connection = undefined;
    }
    throw error;
  } finally {
    connection?.release();
  }
}
