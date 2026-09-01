import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The integration suite needs the local stack; `npm test` runs unit only.
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
