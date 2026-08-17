import { describe, expect, it } from 'vitest';
import { addDatabaseTool } from './generated/slide-self-mgmt/add_database.js';
import { testConnectionTool } from './generated/slide-self-mgmt/test_connection.js';
import { updateDbConfigTool } from './generated/slide-self-mgmt/update_db_config.js';

describe('credential-bearing Agent tools', () => {
  it.each([
    addDatabaseTool,
    testConnectionTool,
    updateDbConfigTool,
  ])('$name never exposes a plaintext password parameter to the model', (tool) => {
    expect(tool.parameters.properties).not.toHaveProperty('password');
  });

  it('requires a credential reference when adding a database', () => {
    expect(addDatabaseTool.parameters.properties).toHaveProperty('credential_ref');
    expect(addDatabaseTool.parameters.required).toContain('credential_ref');
  });
});
