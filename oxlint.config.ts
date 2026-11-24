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
        // nkzw re-enables this for TS files via its own override.
        'typescript/no-floating-promises': 'off',
      },
    },
  ],
  rules: {
    // Baseline: rules with findings on existing code, re-enabled one at a time.
    '@nkzw/no-instanceof': 'off',
    'import/no-namespace': 'off',
    'no-console': 'off',
    'no-empty': ['error', { allowEmptyCatch: true }],
    'no-promise-executor-return': 'off',
    'no-useless-assignment': 'off',
    'preserve-caught-error': 'off',
    'quality/no-array-filter-map': 'off',
    'quality/no-chained-type-assertions': 'off',
    // Conditional spreads mark optional properties under exactOptionalPropertyTypes.
    'quality/no-conditional-empty-object-spread': 'off',
    'quality/no-known-value-widening': 'off',
    'quality/no-object-parameters': 'off',
    'quality/no-unsafe-dictionary-type': 'off',
    'quality/no-unknown-returns': 'off',
    'react-hooks/rules-of-hooks': 'off',
    'typescript/array-type': ['error', { default: 'array' }],
    'typescript/await-thenable': 'off',
    'typescript/consistent-type-imports': 'off',
    // Pi event and tool payloads are untyped per event name at the SDK boundary.
    'typescript/no-explicit-any': 'off',
    'typescript/no-floating-promises': 'off',
    'typescript/no-misused-promises': 'off',
    'typescript/no-non-null-assertion': 'off',
    'typescript/no-unnecessary-type-assertion': 'off',
    'typescript/no-unsafe-argument': 'off',
    'typescript/no-unsafe-assignment': 'off',
    'typescript/no-unsafe-call': 'off',
    'typescript/no-unsafe-function-type': 'off',
    'typescript/no-unsafe-member-access': 'off',
    'typescript/no-unsafe-return': 'off',
    'typescript/no-unsafe-type-assertion': 'off',
    'typescript/require-array-sort-compare': 'off',
    'typescript/unbound-method': 'off',
    'typescript/use-unknown-in-catch-callback-variable': 'off',
    'unicorn/catch-error-name': 'off',
    'unicorn/consistent-function-scoping': 'off',
    'unicorn/no-useless-spread': 'off',
    'unicorn/prefer-single-call': 'off',
    // Harness scripts export helpers and run main under an entry guard.
    'unicorn/prefer-top-level-await': 'off',
  },
});
