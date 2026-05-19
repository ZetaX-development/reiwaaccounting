import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    testTimeout: 10000,
    setupFiles: ['tests/setup.ts'],
    // Tests share the same Postgres tables (Voucher in particular) and
    // wipe rows in beforeEach, so concurrent files step on each other.
    fileParallelism: false,
  },
});
