import { describe, expect, it } from 'vitest';
import { buildTestConnectionPayload } from './instances-db.ts';

describe('database instance test connection payload', () => {
  it('excludes instance metadata fields rejected by the test endpoint', () => {
    expect(buildTestConnectionPayload({
      name: '10.17.104.244',
      environment: 'development',
      db_type: 'mysql',
      host: '10.17.104.244',
      port: 15014,
      username: 'monquery',
      password: 'secret',
      database_name: 'mysql',
      description: '通联数据',
    })).toEqual({
      host: '10.17.104.244',
      port: 15014,
      username: 'monquery',
      password: 'secret',
      database_name: 'mysql',
      db_type: 'mysql',
    });
  });
});
