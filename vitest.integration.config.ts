import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';

// Integration tests: need a real Postgres (DATABASE_URL). CI provides a
// service container; locally `docker compose up -d postgres` first.
// Still offline w.r.t. the testnet: no live RPC in the PR gate.
//
// `graphql` ships both a CJS entry (`index.js`) and an ESM entry (`index.mjs`).
// Vite resolves the test's `import { graphql } from 'graphql'` to the ESM copy,
// while the externalized CJS graphql-yoga / @graphql-tools chain requires the
// CJS copy. Two instances make graphql-js reject the schema it just built
// ("Cannot use GraphQLSchema ... from another module or realm"), so both sides
// are pinned to the package's Node entry point here.
const require = createRequire(import.meta.url);

export default defineConfig({
  resolve: {
    alias: { graphql: require.resolve('graphql') },
  },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
