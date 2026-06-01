import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/phase-94-*.test.ts'],
    exclude: ['node_modules', 'dist'],
  },
});
