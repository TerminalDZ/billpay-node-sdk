import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Both suites match this pattern, but they are run separately: `npm test` passes
    // tests/unit explicitly and needs no network, while `npm run test:integration`
    // talks to the live sandbox. Keeping the pattern broad means `npm run test:watch`
    // still sees everything.
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
