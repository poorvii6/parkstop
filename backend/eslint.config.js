// ESLint flat config for the ParkStop backend (Node.js, CommonJS).
// Intentionally lenient: the existing codebase was never linted, so most style
// rules are "warn" (visible, non-fatal) and only likely-bug rules stay "error".
// Tighten these over time as the warning backlog is cleared.

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'src/generated/**', // generated Prisma client — never lint
      'coverage/**',
      'logs/**',
      'prisma/**',
    ],
  },

  js.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.jest, // test files use describe/test/expect/jest
      },
    },
    rules: {
      // Unused vars are a warning, and an underscore prefix opts out entirely.
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Empty catch blocks are used deliberately in a few places (best-effort cleanup).
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // The app logs to stdout via console/winston; allow it.
      'no-console': 'off',
      // Downgraded to warnings: these fire on existing, working code and are
      // stylistic (error-cause chaining, redundant re-initialization, benign
      // regex escapes), not bugs. Clean up incrementally, then promote back.
      'preserve-caught-error': 'warn',
      'no-useless-assignment': 'warn',
      'no-useless-escape': 'warn',
    },
  },
];
