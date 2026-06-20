import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'dist/**',
      'builds/**',
      'node_modules/**',
      'coverage/**',
      '.dev/**',
      'src/common/html/*.release.js',
      'src/common/html/i18n-data.js',
    ],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
      },
    },
    rules: {
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
      'no-case-declarations': 'warn',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-unused-private-class-members': 'warn',
      'no-useless-assignment': 'warn',
      'no-useless-escape': 'warn',
    },
  },
  {
    files: ['scripts/**/*.mjs', 'eslint.config.js', 'vitest.config.js'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: globals.node,
    },
  },
];
