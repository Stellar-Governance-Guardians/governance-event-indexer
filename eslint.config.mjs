// ESLint flat config. TypeScript itself is the type gate (`npm run typecheck`);
// ESLint covers code-quality rules and keeps the PR gate deterministic/offline.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'vendor/**',
      // Local-only, gitignored working artifacts (postgres volume, scratch).
      '.pgdata/**',
      '.seed/**',
      '.tmp/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      // Fail loud, fail closed (charter rule 2): no swallowed rejections.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      // NOTE: type-checked rules (e.g. only-throw-error) are deliberately not
      // enabled: this config is not type-aware, keeping the PR gate fast and
      // deterministic. `npm run typecheck` is the type gate.
      eqeqeq: ['error', 'always'],
      'no-console': 'off',
    },
  },
  {
    // Node globals for plain-JS scripts (TS files get these via the
    // typescript-eslint override; no-undef does not apply there).
    files: ['**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', Buffer: 'readonly' },
    },
  },
  {
    // Charter rule 1: production code never references test fixtures.
    // CI double-checks with a plain grep over src/ (defense in depth).
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['*fixtures*', '*/tests/*'],
              message:
                'Charter rule 1: production code must never import fixtures. Use the RPC client or the replay command instead.',
            },
          ],
        },
      ],
    },
  },
);
