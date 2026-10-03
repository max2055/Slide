import { vi } from 'vitest';

vi.mock('pg', async () => ({ Client: (await import('./pg-collection-test-support.js')).CollectionPgClient }));
vi.mock('./database-service.js', () => ({ databaseService: { getConnection: vi.fn(() => ({ db_type: 'postgresql', pgClient: {} })) } }));
vi.mock('./instance-database-service.js', () => ({ instanceDatabaseService: { getInstanceById: vi.fn() } }));
vi.mock('./schema-database-service.js', () => ({ schemaDatabaseService: { saveSnapshot: vi.fn() } }));

import { instanceDatabaseService } from './instance-database-service.js';
import { schemaDatabaseService } from './schema-database-service.js';
import { schemaService } from './schema-service.js';
import { describePGCollection } from './pg-collection-test-support.js';

describePGCollection({
  collect: () => schemaService.collectSchema(1),
  loadInstance: vi.mocked(instanceDatabaseService.getInstanceById),
  save: vi.mocked(schemaDatabaseService.saveSnapshot),
});
