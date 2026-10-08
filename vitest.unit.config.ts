import { defineConfig } from 'vitest/config';

// Unit tests: pure, offline, no database, no network (PR gate).
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    passWithNoTests: false,
  },
});
