import cloudflare from '@cloudflare/oxlint-config';
import { defineConfig } from 'oxlint';

export default defineConfig({
  extends: [cloudflare],
  env: cloudflare.env,
  ignorePatterns: cloudflare.ignorePatterns,
  overrides: [
    {
      files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
      rules: {
      },
    },
    {
      // Command-line entry points and harnesses print their results.
      files: [
        'scripts/**',
        'tools/manual-test/**',
        'skills/autoflow/check-transition.ts',
        'extensions/web-tools/smoke.mts',
      ],
      rules: { 'no-console': 'off' },
    },
  ],
  rules: {
    // Baseline: rules with findings on existing code, re-enabled one at a time.
    'import/no-namespace': ['error', { ignore: ['node:*'] }],
    'no-console': ['error', { allow: ['warn', 'error'] }],
    'no-empty': ['error', { allowEmptyCatch: true }],
    // Double assertions escape the unsafe-assertion rule for doubles.
    'quality/no-chained-type-assertions': 'off',
    // Options objects name each argument at every call site.
    // Parsed payloads travel as dictionaries until a schema narrows them.
    'quality/no-unsafe-dictionary-type': 'off',
    'typescript/no-unsafe-assignment': 'off',
    'typescript/no-unsafe-call': 'off',
    'typescript/no-unsafe-member-access': 'off',
    'typescript/no-unsafe-return': 'off',
    'typescript/no-unsafe-type-assertion': 'off',
    // Boundary parsers return unknown so callers must narrow.
    'typescript/array-type': ['error', { default: 'array' }],
  },
});
