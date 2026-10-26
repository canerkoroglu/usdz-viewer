import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['dist/', 'node_modules/', 'data/'] },
  js.configs.recommended,
  {
    // Browser bundle (Vite).
    files: ['src/**/*.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.browser },
  },
  {
    // Node: server, tests and tooling config.
    files: ['server.js', 'test/**/*.js', '*.config.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.node },
  },
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
];
