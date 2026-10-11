import { createHostedProjectStore } from './hosted-project-store.mjs';
import { createHostedProjectAccess } from './hosted-project-access.mjs';
import { createHostedBudget } from './hosted-budget.mjs';
import { createHostedCoordinator } from './hosted-coordinator.mjs';
import { createProvider } from './provider.mjs';

// Open only inside an authorized request. Pool uses a WebSocket connection for
// interactive transactions and must be closed before the Function completes.
export async function createNeonHostedRuntime({ env, auth, PoolClass } = {}) {
  if (!env?.VILLAGE_DATABASE_URL) throw new Error('Hosted database is not configured');
  const providerName = env.VILLAGE_PROVIDER ?? 'openai';
  if (!['openai', 'anthropic'].includes(providerName)) throw new Error('Hosted provider is not supported');
  if ((env.VILLAGE_OPENAI_MODEL && env.VILLAGE_OPENAI_MODEL !== 'gpt-4.1-mini') ||
      (env.VILLAGE_ANTHROPIC_MODEL && env.VILLAGE_ANTHROPIC_MODEL !== 'claude-sonnet-5-5')) throw new Error('Hosted model is outside the pilot budget');
  const provider = createProvider({ name: providerName, env });
  const Pool = PoolClass ?? (await import('@neondatabase/serverless')).Pool;
  const pool = new Pool({ connectionString: env.VILLAGE_DATABASE_URL, max: 2 });
  const query = (sql, values) => pool.query(sql, values);
  const transaction = async callback => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await callback((sql, values) => client.query(sql, values));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve original failure */ }
      throw error;
    } finally { client.release(); }
  };
  const store = createHostedProjectStore({ query });
  const access = createHostedProjectAccess({ store, auth });
  const budget = createHostedBudget({ transaction, auth });
  return { coordinator: createHostedCoordinator({ access, budget, provider }), close: () => pool.end() };
}
