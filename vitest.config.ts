import { defineConfig } from 'vitest/config';

// The project has no Node type definitions (the site runs on Workers); this is all the config needs.
declare const process: { env: Record<string, string | undefined> };

// Set before any worker starts so every forked worker inherits UTC and date maths matches CI.
process.env.TZ = 'UTC';

export default defineConfig({
  test: {
    environment: 'node',
    pool: 'forks',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
});
