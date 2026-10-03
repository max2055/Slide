import { vi } from 'vitest';

vi.mock('pg', async () => ({ Client: (await import('./pg-collection-test-support.js')).CollectionPgClient }));
vi.mock('./database-service.js', () => ({ databaseService: { getConnection: vi.fn(() => ({ db_type: 'postgresql', pgClient: {} })) } }));
vi.mock('./instance-database-service.js', () => ({ instanceDatabaseService: { getInstanceById: vi.fn() } }));
vi.mock('./index-database-service.js', () => ({ indexDatabaseService: { saveIndexData: vi.fn() } }));

import { instanceDatabaseService } from './instance-database-service.js';
import { indexDatabaseService } from './index-database-service.js';
import { indexService } from './index-service.js';
import { describePGCollection } from './pg-collection-test-support.js';

describePGCollection({
  collect: () => indexService.collectIndexes(1),
  loadInstance: vi.mocked(instanceDatabaseService.getInstanceById),
  save: vi.mocked(indexDatabaseService.saveIndexData),
});
