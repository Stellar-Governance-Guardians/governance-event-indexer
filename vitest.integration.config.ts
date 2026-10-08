import { defineConfig } from 'vitest/config';

// Integration tests: need a real Postgres (DATABASE_URL). CI provides a
// service container; locally `docker compose up -d postgres` first.
// Still offline w.r.t. the testnet: no live RPC in the PR gate.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
