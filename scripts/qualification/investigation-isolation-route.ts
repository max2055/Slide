import { createConfiguredAgentProvider } from '../../apps/db-ops-api/src/adapter/llm-provider-factory.js';
import { analysisProviderIdentity } from '../../apps/db-ops-api/src/analysis/analysis-execution.js';
import type { LLMProvider } from '../../apps/db-ops-api/src/llm-database-service.js';
import type { SceneBinding } from '../../apps/db-ops-api/src/llm/scene-routing.js';
import { evidenceHash } from '../../apps/db-ops-api/src/analysis/analysis-evidence.js';
const quote = (value: string) => '`' + value.replaceAll('`', '``') + '`';

/** Same production factory, no chat/chatStream or credential decryption. The
 * encrypted configuration itself is compared by the full-row clone verifier.
 */
export async function verifyIsolationRoute(connection: { query(sql: string): Promise<[any, unknown]> }, source: string, target: string) {
  const identify = async (database: string) => {
    const [rows] = await connection.query(`SELECT * FROM ${quote(database)}.llm_providers ORDER BY is_default DESC, deployment_type, name`);
    const providers = rows.map(row => ({ ...row, enabled: Boolean(row.enabled),
      models_supported: typeof row.models_supported === 'string' ? JSON.parse(row.models_supported) : row.models_supported,
      // The copy connection uses dateStrings for lossless timestamp insertion;
      // the production provider store returns UTC Date instances.
      updated_at: typeof row.updated_at === 'string' ? new Date(row.updated_at.replace(' ', 'T') + 'Z') : row.updated_at,
    })) as LLMProvider[];
    const [bindings] = await connection.query(`SELECT scene, provider_id, model FROM ${quote(database)}.llm_scene_bindings`);
    const provider = await createConfiguredAgentProvider({
      getAllProviders: async () => providers, getSceneBindings: async () => bindings as SceneBinding[],
      getProviderApiKey: async name => providers.find(p => p.name === name)?.api_key_encrypted ? 'offline-placeholder-never-sent' : null,
    }, 'fault_diagnosis', true, false);
    return { ...analysisProviderIdentity(provider), model: provider.getDefaultModel(),
      capabilities: provider.getModelCapabilities?.(), credentialValidation: 'not_decrypted_or_sent' };
  };
  const sourceIdentity = await identify(source), targetIdentity = await identify(target);
  if (evidenceHash(sourceIdentity) !== evidenceHash(targetIdentity)) throw Error('ISOLATION_ROUTE_IDENTITY_MISMATCH');
  return { sourceIdentity, targetIdentity, exact: true, factory: 'createConfiguredAgentProvider/fault_diagnosis', modelCalls: 0 };
}
