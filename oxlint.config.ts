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
        'extensions/web-tools/smoke.ts',
      ],
      rules: { 'no-console': 'off' },
    },
  ],
  rules: {
    // Baseline: rules with findings on existing code, re-enabled one at a time.
    'import/no-namespace': ['error', { ignore: ['node:*'] }],
    'no-console': ['error', { allow: ['warn', 'error'] }],
    'no-empty': ['error', { allowEmptyCatch: true }],
    // Iterator helpers need ES2025 types; filter/map chains stay.
    'quality/no-array-filter-map': 'off',
    // Conditional spreads mark optional properties under exactOptionalPropertyTypes.
    'quality/no-conditional-empty-object-spread': 'off',
    // Double assertions escape the unsafe-assertion rule for doubles.
    'quality/no-chained-type-assertions': 'off',
    // Explicit return types document each helper's contract.
    'quality/no-known-value-widening': 'off',
    // Options objects name each argument at every call site.
    'quality/no-object-parameters': 'off',
    'quality/no-unsafe-dictionary-type': 'off',
    'quality/no-unknown-returns': 'off',
    'typescript/array-type': ['error', { default: 'array' }],
    // Pi event and tool payloads are untyped per event name at the SDK boundary.
    'typescript/no-explicit-any': 'off',
    // Assertions mark invariants that construction already checks.
    'typescript/no-non-null-assertion': 'off',
    'typescript/no-unsafe-argument': 'off',
    'typescript/no-unsafe-assignment': 'off',
    'typescript/no-unsafe-call': 'off',
    'typescript/no-unsafe-member-access': 'off',
    'typescript/no-unsafe-return': 'off',
    'typescript/no-unsafe-type-assertion': 'off',
    // Helpers stay beside their single call site.
    'unicorn/consistent-function-scoping': 'off',
    // One push per prompt line keeps the XML shape readable.
    'unicorn/prefer-single-call': 'off',
    // Harness scripts export helpers and run main under an entry guard.
    'unicorn/prefer-top-level-await': 'off',
  },
});
